import { JobRepository } from '../persistence/JobRepository'
import { logger } from '../utils/logger'
import { getConfig } from '../config'
import { createRateLimiter } from '../utils/rate-limiter'
import type { GeographicArea, JobSourceContext, SourceConfig } from '../sources/base/JobSource'

export interface TriggerOptions {
  sourceId?: string
  geographicAreaId?: string
}

interface RunningCycle {
  key: string
  sourceId: string
  areaId: string
  promise: Promise<void>
}

export class JobOrchestrator {
  private repo: JobRepository
  private config = getConfig()
  private runningCycles = new Map<string, RunningCycle>()
  private stop$ = false
  private sources = new Map<string, SourceConfig>()
  private rateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>()

  constructor(repo?: JobRepository) {
    this.repo = repo ?? new JobRepository()
  }

  async start(): Promise<void> {
    logger.info('JobOrchestrator started', {
      pollIntervalMs: this.config.pollIntervalMs,
      maxConcurrentSources: this.config.maxConcurrentSources,
      maxRetries: this.config.maxRetries,
      retryDelayMs: this.config.retryDelayMs,
      fetchTimeoutMs: this.config.fetchTimeoutMs,
      stalledThresholdMs: this.config.stalledThresholdMs,
    })

    // Main poll loop: run immediately, then every POLL_INTERVAL_MS
    await this.runCycle()

    const interval = setInterval(async () => {
      if (this.stop$) {
        clearInterval(interval)
        return
      }
      await this.runCycle().catch((err) => {
        logger.error('Orchestrator cycle error', err)
      })
    }, this.config.pollIntervalMs)

    // Keep the interval from holding the process open
    if (interval.unref) interval.unref()
  }

  async stop(): Promise<void> {
    logger.info('Stopping orchestrator...')
    this.stop$ = true

    // Await in-flight cycles with a bounded wait
    if (this.runningCycles.size > 0) {
      logger.info(`Awaiting ${this.runningCycles.size} in-flight cycle(s)`, {
        cycleKeys: Array.from(this.runningCycles.keys()),
      })
      await Promise.all(Array.from(this.runningCycles.values()).map((c) => c.promise))
    }

    logger.info('Orchestrator stopped')
  }

  triggerFetch(opts: TriggerOptions = {}): void {
    void this.runCycle(opts).catch((err) => {
      logger.error('Manual trigger fetch failed', err)
    })
  }

  private async runCycle(opts?: TriggerOptions): Promise<void> {
    const sources = await this.loadSources(opts?.sourceId)
    if (sources.length === 0) {
      logger.debug('No enabled sources found, skipping cycle')
      return
    }

    const pairs = await this.repo.listSourceGeographicAreas()
    if (pairs.length === 0) {
      logger.debug('No enabled source-geographic-area pairs found, skipping cycle')
      return
    }

    // Filter pairs by source if triggered manually
    const relevantPairs = opts?.sourceId
      ? pairs.filter((p) => p.source_id === opts.sourceId && (!opts.geographicAreaId || p.geographic_area_id === opts.geographicAreaId))
      : pairs

    if (relevantPairs.length === 0) {
      logger.debug('No relevant source-area pairs for this cycle')
      return
    }

    // Respect concurrency limit
    const semaphore = new Semaphore(this.config.maxConcurrentSources)

    const tasks = relevantPairs.map((pair) =>
      semaphore.acquire().then(() =>
        this.runPairCycle(pair).finally(() => semaphore.release())
      )
    )

    await Promise.allSettled(tasks)
  }

  private async runPairCycle(pair: {
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }): Promise<void> {
    const cycleKey = `${pair.source_id}:${pair.geographic_area_id}`

    // Skip if already running for this pair
    if (this.runningCycles.has(cycleKey)) {
      logger.debug(`Cycle already running for ${cycleKey}, skipping`)
      return
    }

    const source = this.sources.get(pair.source_id)
    if (!source) {
      logger.error(`Source ${pair.source_id} not found in config`)
      return
    }

    const clock = () => new Date()
    const loggerChild = this.childLogger(pair.source_id, pair.geographic_area_id)
    const rateLimiter = this.getRateLimiter(source)

    const ctx: JobSourceContext = {
      source,
      logger: loggerChild,
      rateLimiter,
      clock,
    }

    const cyclePromise = this.executeCycle(pair, ctx)

    this.runningCycles.set(cycleKey, {
      key: cycleKey,
      sourceId: pair.source_id,
      areaId: pair.geographic_area_id,
      promise: cyclePromise,
    })

    try {
      await cyclePromise
    } finally {
      this.runningCycles.delete(cycleKey)
    }
  }

  private async executeCycle(pair: {
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }, ctx: JobSourceContext): Promise<void> {
    const startTime = Date.now()
    const now = ctx.clock()

    // Create fetch_runs row (running)
    const fetchRunId = await this.repo.createFetchRun({
      sourceId: pair.source_id,
      status: 'running',
      startedAt: now,
    })

    logger.info(`Starting fetch cycle for ${pair.source_name} / ${pair.area_name}`, {
      fetchRunId,
      source: pair.source_id,
      area: pair.geographic_area_id,
    })

    const area: GeographicArea = {
      id: pair.geographic_area_id,
      name: pair.area_name,
      definition: pair.area_definition,
    }

    let result: any
    let attempts = 0
    const maxRetries = this.config.maxRetries
    const retryDelay = this.config.retryDelayMs
    const fetchTimeout = this.config.fetchTimeoutMs

    while (attempts <= maxRetries) {
      attempts++

      try {
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`Fetch timed out after ${fetchTimeout}ms`)), fetchTimeout)
        })

        result = await Promise.race([
          this.fetchFromAdapter(ctx, area),
          timeoutPromise,
        ])

        break
      } catch (err) {
        const error = err as Error
        logger.error(`Fetch attempt ${attempts}/${maxRetries + 1} failed for ${pair.source_name}`, {
          fetchRunId,
          error: error.message,
        })

        if (attempts <= maxRetries) {
          await this.sleep(retryDelay)
        } else {
          await this.repo.updateFetchRun({
            id: fetchRunId,
            status: 'failed',
            finishedAt: new Date(),
            errorMessage: error.message,
            jobsFound: 0,
            jobsSavedNew: 0,
            jobsSavedUpdated: 0,
          })
          await this.repo.updateSourceTimestamps(pair.source_id, now, null)
          await this.repo.updateSourceGeoAreaTimestamps(
            pair.source_id,
            pair.geographic_area_id,
            now,
            null
          )
          logger.error(`Fetch cycle failed for ${pair.source_name} / ${pair.area_name} after ${maxRetries + 1} attempts`, {
            fetchRunId,
            error: error.message,
          })
          return
        }
      }
    }

    // Transform + persist via Transform Engine
    const rawJobs: unknown[] = result?.rawJobs ?? []
    const transformWarnings: string[] = result?.warnings ?? []

    let jobsFound = rawJobs.length
    let jobsSavedNew = 0
    let jobsSavedUpdated = 0

    try {
      const { TransformEngine } = await import('../transform/engine')
      const transformConfig = await import('../transform/rezi.transform.json')
      const engine = new TransformEngine(this.repo, transformConfig as any, pair.source_id, logger)
      const transformResult = await engine.run(rawJobs)

      jobsFound = transformResult.jobsFound
      jobsSavedNew = transformResult.jobsSavedNew
      jobsSavedUpdated = transformResult.jobsSavedUpdated
      transformWarnings.push(...transformResult.warnings)
    } catch (err) {
      const error = err as Error
      logger.error(`Transform engine failed for ${pair.source_name}`, {
        fetchRunId,
        error: error.message,
      })
      transformWarnings.push(`Transform engine error: ${error.message}`)
    }

    await this.repo.updateFetchRun({
      id: fetchRunId,
      status: 'success',
      finishedAt: new Date(),
      jobsFound,
      jobsSavedNew,
      jobsSavedUpdated,
      metadata: result?.metadata ?? {},
      warnings: transformWarnings,
    })

    const nextRunAt = new Date(Date.now() + this.config.pollIntervalMs)
    await this.repo.updateSourceTimestamps(pair.source_id, new Date(), nextRunAt)
    await this.repo.updateSourceGeoAreaTimestamps(
      pair.source_id,
      pair.geographic_area_id,
      new Date(),
      nextRunAt
    )

    const duration = Date.now() - startTime
    logger.info(`Fetch cycle completed for ${pair.source_name} / ${pair.area_name}`, {
      fetchRunId,
      jobsFound,
      jobsSavedNew,
      jobsSavedUpdated,
      durationMs: duration,
    })
  }

  private async fetchFromAdapter(ctx: JobSourceContext, area: GeographicArea): Promise<any> {
    const { ReziJobSource } = await import('../sources/rezi/ReziJobSource')
    const adapter = new ReziJobSource(ctx)
    try {
      return await adapter.fetch(area)
    } finally {
      if (adapter.cleanup) {
        await adapter.cleanup().catch((err) => {
          logger.warn('Adapter cleanup failed', { error: err.message })
        })
      }
    }
  }

  private async loadSources(filterSourceId?: string): Promise<SourceConfig[]> {
    const rows = await this.repo.listSources()
    const sources: SourceConfig[] = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
      enabled: Boolean(row.enabled),
      last_run_at: row.last_run_at ?? null,
    }))

    let filtered = sources.filter((s) => s.enabled)
    if (filterSourceId) {
      filtered = filtered.filter((s) => s.id === filterSourceId)
    }

    // Populate the sources map and rate limiters
    for (const source of filtered) {
      this.sources.set(source.id, source)
      if (!this.rateLimiters.has(source.id)) {
        this.rateLimiters.set(source.id, createRateLimiter(source.config))
      }
    }

    return filtered
  }

  private getRateLimiter(source: SourceConfig): ReturnType<typeof createRateLimiter> {
    const existing = this.rateLimiters.get(source.id)
    if (existing) return existing
    const limiter = createRateLimiter(source.config)
    this.rateLimiters.set(source.id, limiter)
    return limiter
  }

  private childLogger(sourceId: string, areaId: string): any {
    return {
      debug: (msg: string, meta?: Record<string, unknown>) =>
        logger.debug(msg, { source_id: sourceId, area_id: areaId, ...meta }),
      info: (msg: string, meta?: Record<string, unknown>) =>
        logger.info(msg, { source_id: sourceId, area_id: areaId, ...meta }),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        logger.warn(msg, { source_id: sourceId, area_id: areaId, ...meta }),
      error: (msg: string, meta?: Record<string, unknown>) =>
        logger.error(msg, { source_id: sourceId, area_id: areaId, ...meta }),
      child: () => this.childLogger(sourceId, areaId),
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

class Semaphore {
  private permits: number
  private queue: Array<() => void> = []

  constructor(concurrency: number) {
    this.permits = Math.max(1, concurrency)
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift()!
      resolve()
    } else {
      this.permits++
    }
  }
}

let singleton: JobOrchestrator | null = null

export function getOrchestrator(): JobOrchestrator {
  if (!singleton) {
    singleton = new JobOrchestrator()
  }
  return singleton
}
