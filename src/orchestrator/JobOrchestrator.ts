import fs from 'fs'
import path from 'path'
import { IJobRepository } from '../persistence/IJobRepository'
import { createJobRepository } from '../database/db'
import { logger } from '../utils/logger'
import { getConfig } from '../config'
import { createRateLimiter } from '../utils/rate-limiter'
import { JobSource, type GeographicArea, type JobSourceContext, type SourceConfig } from '../sources/base/JobSource'

type WorkItemKind = 'passive' | 'proactive'

interface WorkItem {
  kind: WorkItemKind
  sourceId: string
  areaId?: string
  keywords?: string[]
  id: string
  pair?: {
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }
}

interface Deferral {
  until: number
  failures: number
}

interface BackoffState {
  failures: number
}

export class JobOrchestrator {
  private repo: IJobRepository
  private config = getConfig()
  private runningCycles = new Map<string, { key: string; sourceId: string; areaId: string; promise: Promise<void> }>()
  private stop$ = false
  private interval: ReturnType<typeof setInterval> | null = null
  private sources = new Map<string, SourceConfig>()
  private rateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>()
  private sourceAdapters = new Map<string, typeof JobSource>()
  private adaptersLoaded = false
  private deferrals = new Map<string, Deferral>()
  private backoff = new Map<string, BackoffState>()
  private rrIndex = 0

  constructor(repo?: IJobRepository) {
    this.repo = repo ?? createJobRepository()
  }

  async start(): Promise<void> {
    // Idempotent: if already running, do nothing
    if (this.interval) return

    this.stop$ = false

    logger.info('JobOrchestrator started', {
      pollIntervalMs: this.config.pollIntervalMs,
      maxRetries: this.config.maxRetries,
      retryDelayMs: this.config.retryDelayMs,
      fetchTimeoutMs: this.config.fetchTimeoutMs,
      stalledThresholdMs: this.config.stalledThresholdMs,
    })

    // Main poll loop: run one work item immediately, then one per POLL_INTERVAL_MS tick.
    if (!this.stop$) await this.tick()
    if (this.stop$) return

    this.interval = setInterval(() => {
      if (this.stop$) {
        if (this.interval) {
          clearInterval(this.interval)
          this.interval = null
        }
        return
      }
      void this.tick().catch((err) => {
        logger.error('Orchestrator tick error', err)
      })
    }, this.config.pollIntervalMs)

    // Keep the interval from holding the process open
    if (this.interval.unref) this.interval.unref()
  }

  async stop(): Promise<void> {
    // Idempotent: if already stopped, do nothing
    if (this.stop$ && !this.interval) return

    logger.info('Stopping orchestrator...')
    this.stop$ = true
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }

    // Await the single in-flight cycle on graceful shutdown
    if (this.runningCycles.size > 0) {
      logger.info(`Awaiting ${this.runningCycles.size} in-flight cycle(s)`, {
        cycleKeys: Array.from(this.runningCycles.keys()),
      })
      await Promise.all(Array.from(this.runningCycles.values()).map((c) => c.promise))
    }

    logger.info('Orchestrator stopped')
  }

  /**
   * Run a proactive fetch cycle for the given keywords across all proactive-enabled sources.
   * Used by the free-text search endpoint to trigger on-demand collection.
   */
  async runProactiveSearch(keywords: string[]): Promise<void> {
    const sources = await this.loadSources()
    if (this.stop$) return

    const proactiveSources = sources.filter(
      (s) => s.working_mode === 'proactive' || s.working_mode === 'both'
    )

    for (const source of proactiveSources) {
      if (this.stop$) return
      const ctx = this.buildCtx({ kind: 'proactive', sourceId: source.id, keywords, id: `search:proactive:${source.id}` })
      await this.runProactiveSourceCycle(source, keywords, ctx)
    }
  }

  /**
   * Trigger an immediate on-demand fetch for a single source, independent of its working_mode.
   * Pauses the regular cycle, runs the source's full fetch cycle (fetch → transform → save),
   * then resumes the regular cycle.
   */
  async triggerSourceFetch(sourceId: string): Promise<void> {
    // Pause the regular cycle (waits for any in-flight cycle to complete)
    await this.stop()

    try {
      const sources = await this.loadSources()
      const source = sources.find((s) => s.id === sourceId)
      if (!source) {
        throw new Error(`Source ${sourceId} not found`)
      }

      const ctx = this.buildCtx({ kind: 'proactive', sourceId: source.id, id: `trigger:${source.id}` })

      if (source.working_mode === 'passive' || source.working_mode === 'both') {
        const pairs = await this.repo.listSourceGeographicAreas()
        const relevantPairs = pairs.filter((p) => p.source_id === sourceId)
        for (const pair of relevantPairs) {
          if (this.stop$) return
          await this.runPairCycle(pair, ctx)
        }
      }

      if (source.working_mode === 'proactive' || source.working_mode === 'both') {
        if (this.stop$) return
        const keywords = await this.repo.listActiveUnifiedKeywords()
        await this.runProactiveSourceCycle(source, keywords, ctx)
      }
    } finally {
      // Resume the regular cycle
      await this.start()
    }
  }

  /** One scheduler tick: if idle, select exactly one eligible work item and run it. */
  private async tick(): Promise<void> {
    if (this.stop$) return
    // Never overlap: skip tick if a cycle is in flight (no queuing, no catch-up).
    if (this.runningCycles.size > 0) return

    const items = await this.buildWorkItems()
    if (items.length === 0) return

    const now = Date.now()
    // Round-robin: walk from the cursor until we find a non-deferred item.
    for (let i = 0; i < items.length; i++) {
      const idx = (this.rrIndex + i) % items.length
      this.rrIndex = (idx + 1) % items.length
      const item = items[idx]
      const deferral = this.deferrals.get(item.id)
      if (deferral && deferral.until > now) continue // still deferred
      if (deferral) this.deferrals.delete(item.id) // expired
      await this.runWorkItem(item)
      return
    }
    // Every eligible item is currently deferred; nothing to do this tick.
  }

  private async buildWorkItems(): Promise<WorkItem[]> {
    const items: WorkItem[] = []

    const sources = await this.loadSources()
    if (this.stop$) return items

    // Passive: one item per (source, geographic area) pair.
    const passiveSources = sources.filter(
      (s) => s.working_mode === 'passive' || s.working_mode === 'both'
    )
    const passiveSourceIds = new Set(passiveSources.map((s) => s.id))
    const pairs = await this.repo.listSourceGeographicAreas()
    const relevantPairs = pairs.filter((pair) => passiveSourceIds.has(pair.source_id))

    for (const pair of relevantPairs) {
      items.push({
        kind: 'passive',
        sourceId: pair.source_id,
        areaId: pair.geographic_area_id,
        id: `passive:${pair.source_id}:${pair.geographic_area_id}`,
        pair,
      })
    }

    // Proactive: one item per proactive-enabled source (batched keywords).
    const keywords = await this.repo.listActiveUnifiedKeywords()
    if (this.stop$) return items
    const proactiveSources = sources.filter(
      (s) => s.working_mode === 'proactive' || s.working_mode === 'both'
    )
    for (const source of proactiveSources) {
      items.push({
        kind: 'proactive',
        sourceId: source.id,
        keywords,
        id: `proactive:${source.id}`,
      })
    }

    return items
  }

  /** Run one work item under the single-active-cycle guard. */
  private async runWorkItem(item: WorkItem): Promise<void> {
    const key = item.id
    const ctx = this.buildCtx(item)

    const cyclePromise =
      item.kind === 'passive'
        ? this.runPairCycle(item.pair!, ctx)
        : this.runProactiveSourceCycle(this.sources.get(item.sourceId)!, item.keywords ?? [], ctx)

    this.runningCycles.set(key, {
      key,
      sourceId: item.sourceId,
      areaId: item.areaId ?? '',
      promise: cyclePromise,
    })

    try {
      await cyclePromise
      // Success clears any backoff/deferral for this item.
      this.deferrals.delete(key)
      this.backoff.delete(key)
    } catch (err) {
      await this.handleItemFailure(key, err)
    } finally {
      this.runningCycles.delete(key)
    }
  }

  private buildCtx(item: WorkItem): JobSourceContext {
    const source = this.sources.get(item.sourceId)
    if (!source) throw new Error(`Source ${item.sourceId} not found in config`)
    const clock = () => new Date()
    const loggerChild = this.childLogger(item.sourceId, item.areaId ?? '')
    const rateLimiter = this.getRateLimiter(source)
    return { source, logger: loggerChild, rateLimiter, clock }
  }

  private async handleItemFailure(key: string, err: unknown): Promise<void> {
    const error = err as Error
    const failures = (this.backoff.get(key)?.failures ?? 0) + 1
    this.backoff.set(key, { failures })

    const retryAfterMs = this.extractRetryAfterMs(error)
    const backoffMs = this.backoffDelayMs(failures)
    const deferMs = retryAfterMs != null ? Math.max(retryAfterMs, backoffMs) : backoffMs

    this.deferrals.set(key, { until: Date.now() + deferMs, failures })

    logger.warn(`Work item deferred after failure`, {
      item: key,
      failures,
      deferMs,
      retryAfterMs,
      backoffMs,
      error: error.message,
    })
  }

  private backoffDelayMs(failures: number): number {
    const exp = Math.min(failures - 1, 6)
    const base = this.config.retryDelayMs * Math.pow(2, exp)
    const jitter = Math.floor(Math.random() * base)
    return Math.min(base + jitter, this.config.fetchTimeoutMs)
  }

  private extractRetryAfterMs(err: Error): number | null {
    const e = err as { retryAfterMs?: number; retryAfter?: number }
    if (typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0) return e.retryAfterMs
    if (typeof e.retryAfter === 'number' && e.retryAfter > 0) return e.retryAfter * 1000
    return null
  }

  private async runPairCycle(pair: {
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }, ctx: JobSourceContext): Promise<void> {
    const cycleKey = `${pair.source_id}:${pair.geographic_area_id}`
    const source = this.sources.get(pair.source_id)
    if (!source) {
      logger.error(`Source ${pair.source_id} not found in config`)
      return
    }

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
        result = await this.withTimeout(this.fetchFromAdapter(ctx, area), fetchTimeout)
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
          throw error
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
      const engine = new TransformEngine(this.repo, transformConfig as any, pair.source_id, ctx.logger)
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

  private async runProactiveSourceCycle(source: SourceConfig, keywords: string[], ctx: JobSourceContext): Promise<void> {
    const cycleKey = `proactive:${source.id}`

    const clock = () => new Date()
    const now = clock()

    // Create fetch_runs row (running)
    const fetchRunId = await this.repo.createFetchRun({
      sourceId: source.id,
      status: 'running',
      startedAt: now,
    })

    logger.info(`Starting proactive fetch cycle for ${source.name}`, {
      fetchRunId,
      source: source.id,
      keywords,
    })

    const startTime = Date.now()
    let result: any
    let attempts = 0
    const maxRetries = this.config.maxRetries
    const retryDelay = this.config.retryDelayMs
    const fetchTimeout = this.config.fetchTimeoutMs

    while (attempts <= maxRetries) {
      attempts++

      try {
        result = await this.withTimeout(
          this.fetchFromAdapterByKeywords(ctx, keywords),
          fetchTimeout,
        )
        break
      } catch (err) {
        const error = err as Error
        logger.error(`Proactive fetch attempt ${attempts}/${maxRetries + 1} failed for ${source.name}`, {
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
          await this.repo.updateSourceTimestamps(source.id, now, null)
          logger.error(`Proactive cycle failed for ${source.name} after ${maxRetries + 1} attempts`, {
            fetchRunId,
            error: error.message,
          })
          throw error
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
      const engine = new TransformEngine(this.repo, transformConfig as any, source.id, ctx.logger)
      const transformResult = await engine.run(rawJobs)

      jobsFound = transformResult.jobsFound
      jobsSavedNew = transformResult.jobsSavedNew
      jobsSavedUpdated = transformResult.jobsSavedUpdated
      transformWarnings.push(...transformResult.warnings)
    } catch (err) {
      const error = err as Error
      logger.error(`Transform engine failed for ${source.name} (proactive)`, {
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

    await this.repo.updateSourceTimestamps(source.id, new Date(), null)

    const duration = Date.now() - startTime
    logger.info(`Proactive fetch cycle completed for ${source.name}`, {
      fetchRunId,
      jobsFound,
      jobsSavedNew,
      jobsSavedUpdated,
      durationMs: duration,
    })
  }

  private async fetchFromAdapter(ctx: JobSourceContext, area: GeographicArea): Promise<any> {
    const AdapterClass = this.sourceAdapters.get(ctx.source.id)
    if (!AdapterClass) {
      throw new Error(`No source adapter registered for source ${ctx.source.id} (${ctx.source.name})`)
    }
    const adapter = new (AdapterClass as new (ctx: JobSourceContext) => JobSource)(ctx)
    try {
      return await adapter.fetch(area)
    } finally {
      if (adapter.cleanup) {
        await adapter.cleanup().catch((err: unknown) => {
          logger.warn('Adapter cleanup failed', { error: (err as Error).message })
        })
      }
    }
  }

  private async fetchFromAdapterByKeywords(ctx: JobSourceContext, keywords: string[]): Promise<any> {
    const AdapterClass = this.sourceAdapters.get(ctx.source.id)
    if (!AdapterClass) {
      throw new Error(`No source adapter registered for source ${ctx.source.id} (${ctx.source.name})`)
    }
    const adapter = new (AdapterClass as new (ctx: JobSourceContext) => JobSource)(ctx)
    if (!adapter.fetchByKeywords) {
      throw new Error(`Source ${ctx.source.id} does not support proactive (keyword) fetch`)
    }
    try {
      return await adapter.fetchByKeywords(keywords)
    } finally {
      if (adapter.cleanup) {
        await adapter.cleanup().catch((err: unknown) => {
          logger.warn('Adapter cleanup failed', { error: (err as Error).message })
        })
      }
    }
  }

  private async loadSources(filterSourceId?: string): Promise<SourceConfig[]> {
    await this.loadSourceAdapters()

    const rows = await this.repo.listSources()
    const sources: SourceConfig[] = rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      working_mode: (row.working_mode ?? 'both') as 'passive' | 'proactive' | 'both',
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
      if (!this.sourceAdapters.has(source.id)) {
        logger.warn(`No source adapter registered for source ${source.id} (${source.name})`)
      }
    }

    return filtered
  }

  /**
   * Register a JobSource adapter class for a given sourceId.
   * Used by tests and by programmatic plugin registration.
   */
  registerAdapter(sourceId: string, AdapterClass: new (ctx: JobSourceContext) => JobSource): void {
    if (this.sourceAdapters.has(sourceId)) {
      logger.warn(`Overwriting existing adapter for sourceId "${sourceId}"`)
    }
    this.sourceAdapters.set(sourceId, AdapterClass)
  }

  /**
   * Walk src/sources/ subdirectory, discover all classes extending JobSource,
   * and register them keyed by derived sourceId (class name minus "JobSource" suffix, lowercased).
   * Only sources with a matching row in the sources table will be instantiated at fetch time.
   */
  private async loadSourceAdapters(): Promise<void> {
    if (this.adaptersLoaded) return
    this.adaptersLoaded = true

    const sourcesDir = path.join(__dirname, '..', 'sources')
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(sourcesDir, { withFileTypes: true })
    } catch {
      logger.warn(`Could not read sources directory: ${sourcesDir}`)
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'base') continue
      const adapterDir = path.join(sourcesDir, entry.name)
      let files: string[]
      try {
        files = fs.readdirSync(adapterDir)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.ts') && !file.endsWith('.js')) continue
        const filePath = path.join(adapterDir, file)
        try {
          const mod = await import(filePath)
          for (const key of Object.keys(mod)) {
            const exported = (mod as any)[key]
            if (
              typeof exported === 'function' &&
              exported.prototype instanceof JobSource &&
              exported !== JobSource
            ) {
              const className = exported.name
              const sourceId = className.replace(/JobSource$/i, '').toLowerCase()
              if (this.sourceAdapters.has(sourceId)) {
                logger.warn(`Duplicate source adapter for ${sourceId}: ${className}, skipping`)
                continue
              }
              this.sourceAdapters.set(sourceId, exported)
              logger.info(`Discovered source adapter: ${className} -> sourceId "${sourceId}"`)
            }
          }
        } catch (err) {
          logger.warn(`Failed to load source adapter from ${filePath}`, { error: (err as Error).message })
        }
      }
    }
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

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`Fetch timed out after ${timeoutMs}ms`)), timeoutMs)
    })

    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      if (timeout) clearTimeout(timeout)
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
