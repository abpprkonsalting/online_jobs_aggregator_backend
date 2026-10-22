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

async function waitForCalls(mock: ReturnType<typeof vi.fn>, count: number) {
  for (let index = 0; index < 100 && mock.mock.calls.length < count; index++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('JobOrchestrator', () => {
  let repo: JobRepository
  let orchestrator: InstanceType<(typeof import('../../src/orchestrator/JobOrchestrator'))['JobOrchestrator']>

  beforeEach(async () => {
    vi.resetModules()
    process.env.POLL_INTERVAL_MS = '1000'
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

  afterEach(() => {
    delete process.env.POLL_INTERVAL_MS
    delete process.env.MAX_CONCURRENT_SOURCES
    delete process.env.MAX_RETRIES
    delete process.env.RETRY_DELAY_MS
    delete process.env.FETCH_TIMEOUT_MS
  })

  async function stopAfterInitialCycle(startPromise: Promise<void>) {
    await startPromise
    await orchestrator.stop()
  }

  it('runs passive area fetches, transforms results, and finalizes fetch-run timestamps', async () => {
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

    await stopAfterInitialCycle(orchestrator.start())

    expect(adapterFetch).toHaveBeenCalledWith(expect.objectContaining({ id: 'area-1', name: 'Area area-1' }))
    expect(adapterContexts[0].source.id).toBe('source-1')
    expect(transformRun).toHaveBeenCalledWith([{ obfuscated_id: 7 }])
    expect(repo.createFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-1',
      status: 'running',
    }))
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fetch-run-1',
      status: 'success',
      jobsFound: 1,
      jobsSavedNew: 1,
      metadata: { area: 'area-1' },
      warnings: ['adapter notice'],
    }))
    expect(repo.updateSourceTimestamps).toHaveBeenCalledWith(
      'source-1',
      expect.any(Date),
      expect.any(Date),
    )
    expect(repo.updateSourceGeoAreaTimestamps).toHaveBeenCalledWith(
      'source-1',
      'area-1',
      expect.any(Date),
      expect.any(Date),
    )
    expect(adapterFetchByKeywords).not.toHaveBeenCalled()
  })

  it('runs proactive keywords only for proactive-enabled sources', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive', 'proactive'))
    repo.listActiveUnifiedKeywords.mockResolvedValue(['typescript', 'node'])
    adapterFetchByKeywords.mockResolvedValue({
      rawJobs: [{ obfuscated_id: 8 }],
      metadata: { keywords: ['typescript', 'node'] },
      warnings: [],
    })

    await stopAfterInitialCycle(orchestrator.start())

    expect(adapterFetch).not.toHaveBeenCalled()
    expect(adapterFetchByKeywords).toHaveBeenCalledOnce()
    expect(adapterFetchByKeywords).toHaveBeenCalledWith(['typescript', 'node'])
    expect(adapterContexts[0].source.id).toBe('source-2')
    expect(repo.createFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'source-2',
      status: 'running',
    }))
  })

  it('does not fetch areas for sources configured as proactive-only', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive', 'proactive'))
    repo.listSourceGeographicAreas.mockResolvedValue([
      pair('source-1', 'area-passive'),
      pair('source-2', 'area-proactive'),
    ])

    await stopAfterInitialCycle(orchestrator.start())

    expect(adapterFetch).toHaveBeenCalledOnce()
    expect(adapterFetch.mock.calls[0][0]).toMatchObject({ id: 'area-passive' })
  })

  it('retries failed passive fetches and records success after a later attempt', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    adapterFetch
      .mockRejectedValueOnce(new Error('temporary error'))
      .mockResolvedValueOnce({ rawJobs: [], warnings: [] })

    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(adapterFetch).toHaveBeenCalledOnce()
    await waitForCalls(adapterFetch, 2)
    await stopAfterInitialCycle(startPromise)

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

    await stopAfterInitialCycle(orchestrator.start())

    expect(adapterFetch).toHaveBeenCalledOnce()
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'fetch-run-1',
      status: 'failed',
      errorMessage: 'upstream unavailable',
      jobsFound: 0,
    }))
    expect(repo.updateSourceGeoAreaTimestamps).toHaveBeenCalledWith(
      'source-1',
      'area-1',
      expect.any(Date),
      null,
    )
  })

  it('isolates failed area pairs so another pair can complete successfully', async () => {
    process.env.MAX_RETRIES = '0'
    process.env.MAX_CONCURRENT_SOURCES = '1'
    vi.resetModules()
    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([
      pair('source-1', 'bad'),
      pair('source-1', 'good'),
    ])
    repo.createFetchRun
      .mockResolvedValueOnce('run-failed')
      .mockResolvedValueOnce('run-success')
    adapterFetch.mockImplementation(async (area) => {
      if (area.id === 'bad') throw new Error('bad area')
      return { rawJobs: [], warnings: [] }
    })

    await stopAfterInitialCycle(orchestrator.start())

    expect(adapterFetch.mock.calls.map(([area]) => area.id)).toEqual(['bad', 'good'])
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-failed',
      status: 'failed',
    }))
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      id: 'run-success',
      status: 'success',
    }))
  })

  it('waits for an in-flight area cycle before stopping', async () => {
    repo.listSources.mockResolvedValue(sourceRows('both'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    repo.listActiveUnifiedKeywords.mockResolvedValue(['typescript'])
    const pendingFetch = deferred<{ rawJobs: unknown[]; warnings: string[] }>()
    adapterFetch.mockReturnValue(pendingFetch.promise)

    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    expect(adapterFetch).toHaveBeenCalledOnce()
    const stopPromise = orchestrator.stop()
    let stopped = false
    void stopPromise.then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(stopped).toBe(false)

    pendingFetch.resolve({ rawJobs: [], warnings: [] })
    await Promise.all([startPromise, stopPromise])

    expect(stopped).toBe(true)
    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
    expect(adapterFetchByKeywords).not.toHaveBeenCalled()
  })

  it('enforces the configured concurrency limit across area pairs', async () => {
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([
      pair('source-1', 'area-1'),
      pair('source-1', 'area-2'),
      pair('source-1', 'area-3'),
    ])
    const pending = [
      deferred<{ rawJobs: unknown[]; warnings: string[] }>(),
      deferred<{ rawJobs: unknown[]; warnings: string[] }>(),
      deferred<{ rawJobs: unknown[]; warnings: string[] }>(),
    ]
    adapterFetch.mockImplementation((_ctx, area) => {
      const index = Number(area.id.slice(-1)) - 1
      return pending[index].promise
    })

    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 2)

    pending[0].resolve({ rawJobs: [], warnings: [] })
    await waitForCalls(adapterFetch, 3)

    pending[1].resolve({ rawJobs: [], warnings: [] })
    pending[2].resolve({ rawJobs: [], warnings: [] })
    await stopAfterInitialCycle(startPromise)
  })

  it('marks a timed-out fetch as failed without database access', async () => {
    process.env.MAX_RETRIES = '0'
    process.env.FETCH_TIMEOUT_MS = '10'
    vi.resetModules()
    const { JobOrchestrator } = await import('../../src/orchestrator/JobOrchestrator')
    orchestrator = new JobOrchestrator(repo)
    repo.listSources.mockResolvedValue(sourceRows('passive'))
    repo.listSourceGeographicAreas.mockResolvedValue([pair('source-1', 'area-1')])
    adapterFetch.mockReturnValue(new Promise(() => {}))

    const startPromise = orchestrator.start()
    await waitForCalls(adapterFetch, 1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await stopAfterInitialCycle(startPromise)

    expect(repo.updateFetchRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      errorMessage: 'Fetch timed out after 10ms',
    }))
  })
})
