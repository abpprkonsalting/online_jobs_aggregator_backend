import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { JobRepository } from '../../src/persistence/JobRepository'

const {
  adapterFetch,
  adapterFetchByKeywords,
  transformRun,
  logger,
  adapterContexts,
} = vi.hoisted(() => ({
  adapterFetch: vi.fn(),
  adapterFetchByKeywords: vi.fn(),
  transformRun: vi.fn(),
  adapterContexts: [] as Array<{ source: { id: string } }>,
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../src/utils/logger', () => ({ logger }))
vi.mock('../../src/utils/rate-limiter', () => ({
  createRateLimiter: vi.fn(() => ({ acquire: vi.fn(), reset: vi.fn() })),
}))
vi.mock('../../src/sources/rezi/ReziJobSource', () => ({
  ReziJobSource: class {
    constructor(ctx: { source: { id: string } }) {
      adapterContexts.push(ctx)
    }
    fetch = adapterFetch
    fetchByKeywords = adapterFetchByKeywords
    cleanup = async () => undefined
  },
}))
vi.mock('../../src/transform/engine', () => ({
  TransformEngine: class {
    run = transformRun
  },
}))

const sourceRows = (...modes: Array<'passive' | 'proactive' | 'both'>) =>
  modes.map((working_mode, index) => ({
    id: `source-${index + 1}`,
    name: `Source ${index + 1}`,
    type: 'api',
    working_mode,
    config: {},
    enabled: 1,
  }))

function pair(sourceId: string, areaId: string) {
  return {
    source_id: sourceId,
    source_name: `Source ${sourceId.slice(-1)}`,
    geographic_area_id: areaId,
    area_name: `Area ${areaId}`,
    area_definition: { bbox: [0, 0, 1, 1], zoom: 1 },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number, timeoutMs = 2000) {
  const start = Date.now()
  while (mock.mock.calls.length < count && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (mock.mock.calls.length < count) {
    throw new Error(`Timed out waiting for ${count} calls, got ${mock.mock.calls.length}`)
  }
}

describe('JobOrchestrator', () => {
  let repo: JobRepository
  let orchestrator: InstanceType<(typeof import('../../src/orchestrator/JobOrchestrator'))['JobOrchestrator']>

  beforeEach(async () => {
    vi.resetModules()
    process.env.POLL_INTERVAL_MS = '5'
    process.env.MAX_CONCURRENT_SOURCES = '2'
    process.env.MAX_RETRIES = '1'
    process.env.RETRY_DELAY_MS = '5'
    process.env.FETCH_TIMEOUT_MS = '100'

    vi.clearAllMocks()
    adapterContexts.length = 0
    adapterFetch.mockResolvedValue({ rawJobs: [], metadata: { fixture: true }, warnings: [] })
    adapterFetchByKeywords.mockResolvedValue({ rawJobs: [], metadata: { keywords: [] }, warnings: [] })
    transformRun.mockResolvedValue({
      jobsFound: 0,
      jobsSavedNew: 0,
      jobsSavedUpdated: 0,
      warnings: [],
    })

    repo = new JobRepository()
    vi.spyOn(repo, 'listSources').mockResolvedValue([])
    vi.spyOn(repo, 'listSourceGeographicAreas').mockResolvedValue([])
    vi.spyOn(repo, 'listActiveUnifiedKeywords').mockResolvedValue([])
    vi.spyOn(repo, 'createFetchRun').mockResolvedValue('fetch-run-1')
    vi.spyOn(repo, 'updateFetchRun').mockResolvedValue()
    vi.spyOn(repo, 'updateSourceTimestamps').mockResolvedValue()
    vi.spyOn(repo, 'updateSourceGeoAreaTimestamps').mockResolvedValue()

    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)
  })

  afterEach(async () => {
    await orchestrator?.stop()
    delete process.env.POLL_INTERVAL_MS
    delete process.env.MAX_CONCURRENT_SOURCES
    delete process.env.MAX_RETRIES
    delete process.env.RETRY_DELAY_MS
    delete process.env.FETCH_TIMEOUT_MS
  })

  async function stopOrchestrator() {
    await orchestrator.stop()
  }

  it('runs exactly one work item per tick, no overlapping fetches', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    adapterFetch.mockResolvedValue({
      rawJobs: [{ obfuscated_id: 7 }],
      metadata: { area: 'area-1' },
      warnings: ['adapter notice'],
    })
    transformRun.mockResolvedValue({
      jobsFound: 1,
      jobsSavedNew: 1,
      jobsSavedUpdated: 0,
      warnings: [],
    })

    await orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(adapterFetch).toHaveBeenCalledTimes(1)
    expect(adapterFetch.mock.calls[0][0]).toMatchObject({ id: 'area-1' })
    expect(transformRun).toHaveBeenCalledWith([{ obfuscated_id: 7 }])

    // Next tick runs the same item again (round-robin with single item)
    await waitForCalls(adapterFetch, 2)
    expect(adapterFetch).toHaveBeenCalledTimes(2)

    await stopOrchestrator()
  })

  it('never runs two fetches concurrently; busy ticks are skipped', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    const pending = deferred<{ rawJobs: unknown[]; warnings: string[] }>()
    adapterFetch.mockReturnValue(pending.promise)
    transformRun.mockResolvedValue({ jobsFound: 0, jobsSavedNew: 0, jobsSavedUpdated: 0, warnings: [] })

    // Start without awaiting - the first tick will run the fetch and pause on the pending promise
    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(adapterFetch).toHaveBeenCalledTimes(1)

    // Wait a bit - no new calls because fetch is in-flight
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(adapterFetch).toHaveBeenCalledTimes(1)

    pending.resolve({ rawJobs: [], warnings: [] })
    await waitForCalls(adapterFetch, 2)
    expect(adapterFetch).toHaveBeenCalledTimes(2)

    await stopOrchestrator()
    await startPromise
  })

  it('rotates deterministically across passive pairs and proactive batches', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive', 'proactive', 'both'))
    repo.listSourceGeographicAreas.mockResolvedValue([
      pair('source-1', 'area-a'),
      pair('source-1', 'area-b'),
      pair('source-3', 'area-c'),
    ])
    repo.listActiveUnifiedKeywords.mockResolvedValue(['typescript', 'node'])
    adapterFetch.mockResolvedValue({ rawJobs: [], metadata: {}, warnings: [] })
    adapterFetchByKeywords.mockResolvedValue({ rawJobs: [], metadata: {}, warnings: [] })
    transformRun.mockResolvedValue({ jobsFound: 0, jobsSavedNew: 0, jobsSavedUpdated: 0, warnings: [] })

    await orchestrator.start()

    // Drain all 5 eligible items (3 passive + 2 proactive) - one per tick
    await waitForCalls(adapterFetch, 3, 3000)
    await waitForCalls(adapterFetchByKeywords, 2, 3000)

    await stopOrchestrator()

    // Check only the first call per item (first rotation)
    expect(adapterFetch.mock.calls.map(([area]) => area.id).slice(0, 3)).toEqual(['area-a', 'area-b', 'area-c'])
    expect(adapterFetchByKeywords).toHaveBeenCalledTimes(2)
    expect(adapterFetchByKeywords.mock.calls.map(([keywords]) => keywords)).toEqual([
      ['typescript', 'node'],
      ['typescript', 'node'],
    ])
    // 5 work items: 2 from source-1, 1 from source-2, 2 from source-3
    expect(adapterContexts.map((c) => c.source.id).sort()).toEqual(['source-1', 'source-1', 'source-2', 'source-3', 'source-3'])
  })

  it('defers a failed item while other eligible items keep running', async () => {
    process.env.POLL_INTERVAL_MS = '50'
    process.env.MAX_RETRIES = '0'
    process.env.RETRY_DELAY_MS = '2000'
    process.env.FETCH_TIMEOUT_MS = '60000'
    vi.resetModules()
    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)

    repo.listSources.mockResolvedValue(sourceRows('passive', 'passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'bad'), pair('source-1', 'good')])
    repo.createFetchRun.mockResolvedValue('run-x')
    repo.updateFetchRun.mockResolvedValue()
    repo.updateSourceTimestamps.mockResolvedValue()
    repo.updateSourceGeoAreaTimestamps.mockResolvedValue()
    let badCalls = 0
    adapterFetch.mockImplementation(async (area) => {
      if (area.id === 'bad') {
        badCalls++
        throw new Error('down')
      }
      return { rawJobs: [], warnings: [] }
    })
    transformRun.mockResolvedValue({ jobsFound: 0, jobsSavedNew: 0, jobsSavedUpdated: 0, warnings: [] })

    await orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(badCalls).toBe(1)

    // Wait for several ticks - bad stays deferred (~2s backoff), good keeps running
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(badCalls).toBe(1)
    expect(adapterFetch.mock.calls.length).toBeGreaterThan(1)

    await stopOrchestrator()
  })

  it('honors Retry-After by deferring only the affected item', async () => {
    process.env.POLL_INTERVAL_MS = '50'
    process.env.MAX_RETRIES = '0'
    process.env.RETRY_DELAY_MS = '2000'
    process.env.FETCH_TIMEOUT_MS = '60000'
    vi.resetModules()
    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)

    repo.listSources.mockResolvedValue(sourceRows('passive', 'passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'limited'), pair('source-1', 'open')])
    repo.createFetchRun.mockResolvedValue('run-y')
    repo.updateFetchRun.mockResolvedValue()
    repo.updateSourceTimestamps.mockResolvedValue()
    repo.updateSourceGeoAreaTimestamps.mockResolvedValue()
    let limitedCalls = 0
    adapterFetch.mockImplementation(async (area) => {
      if (area.id === 'limited') {
        limitedCalls++
        const err: Error & { retryAfterMs?: number } = new Error('rate limited')
        err.retryAfterMs = 5000
        throw err
      }
      return { rawJobs: [], warnings: [] }
    })
    transformRun.mockResolvedValue({ jobsFound: 0, jobsSavedNew: 0, jobsSavedUpdated: 0, warnings: [] })

    await orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(limitedCalls).toBe(1)

    // limited is deferred for Retry-After (5s); open keeps running
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(limitedCalls).toBe(1)
    expect(adapterFetch.mock.calls.length).toBeGreaterThan(1)

    await stopOrchestrator()
  })

  it('retries a failed passive fetch within a cycle and records success on a later attempt', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    adapterFetch
      .mockRejectedValueOnce(new Error('temporary error'))
      .mockResolvedValueOnce({ rawJobs: [], warnings: [] })

    await orchestrator.start()
    await waitForCalls(adapterFetch, 2)

    expect(adapterFetch).toHaveBeenCalledTimes(2)
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success',
      jobsFound: 0,
    }))
  })

  it('marks a fetch run failed after retries are exhausted', async () => {
    process.env.MAX_RETRIES = '0'
    vi.resetModules()
    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    adapterFetch.mockRejectedValue(new Error('upstream unavailable'))

    await orchestrator.start()
    await waitForCalls(adapterFetch, 1)

    expect(adapterFetch).toHaveBeenCalledTimes(1)
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fetch-run-1',
      status: 'failed',
      errorMessage: 'upstream unavailable',
      jobsFound: 0,
    }))
  })

  it('waits for the in-flight cycle on graceful shutdown', async () => {
    repo.listSources.mockResolvedValue(sourceRows('both'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    repo.listActiveUnifiedKeywords.mockResolvedValue(['typescript'])
    const pending = deferred<{ rawJobs: unknown[]; warnings: string[] }>()
    adapterFetch.mockReturnValue(pending.promise)

    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 1)

    const stopPromise = stopOrchestrator()
    let stopped = false
    void stopPromise.then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stopped).toBe(false)

    pending.resolve({ rawJobs: [], warnings: [] })
    await Promise.all([startPromise, stopPromise])

    expect(stopped).toBe(true)
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
    expect(adapterFetchByKeywords).not.toHaveBeenCalled()
  })

  it('runs passive fetches and proactive keywords for the appropriate sources', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive', 'proactive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    repo.listActiveUnifiedKeywords.mockResolvedValue(['typescript'])
    adapterFetch.mockResolvedValue({ rawJobs: [{ obfuscated_id: 8 }], metadata: {}, warnings: [] })
    adapterFetchByKeywords.mockResolvedValue({ rawJobs: [{ obfuscated_id: 9 }], metadata: {}, warnings: [] })
    transformRun.mockResolvedValue({ jobsFound: 1, jobsSavedNew: 1, jobsSavedUpdated: 0, warnings: [] })

    await orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(adapterFetch).toHaveBeenCalledOnce()
    expect(adapterFetchByKeywords).not.toHaveBeenCalled()

    await waitForCalls(adapterFetchByKeywords, 1)
    expect(adapterFetchByKeywords).toHaveBeenCalledOnce()
    expect(adapterFetchByKeywords).toHaveBeenCalledWith(['typescript'])

    await stopOrchestrator()
  })
})