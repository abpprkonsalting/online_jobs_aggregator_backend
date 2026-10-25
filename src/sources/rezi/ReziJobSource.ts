import { JobSource, JobSourceContext, FetchResult, GeographicArea } from '../base/JobSource'
import {
  fetchPmtilesJobIds,
  computeTileRange,
  PMTilesSourceConfig,
} from './pmtiles'
import { UpstreamRateLimitError, UpstreamTransientError, isRetryableError } from './errors'

const DETAILS_BATCH_SIZE = 50
const DETAILS_ROWS_PER_PAGE = 12
const MAX_PAGES_PER_BATCH = 10
const MAX_DETAILS_IDS_PER_CYCLE = 500
const MAX_TILES_PER_CYCLE = 100

export interface NormalizedReziJob {
  obfuscated_id?: string | number
  title?: string
  organization?: string | null
  job_url?: string
  description_text?: string | null
  remote_derived?: boolean
  salary_min_value?: number | null
  salary_max_value?: number | null
  salary_currency?: string | null
  salary_unit_text?: string | null
  date_posted?: string | number | null
  ai_key_skills?: unknown[]
  _categories?: unknown[]
  _locations?: unknown[]
  confidence?: number | null
  _raw?: Record<string, unknown>
  [key: string]: unknown
}

export interface SearchResponse {
  jobs: unknown[]
  total_pages?: number
  total?: number
}

export class ReziJobSource extends JobSource {
  constructor(ctx: JobSourceContext) {
    super(ctx)
  }

  async fetch(geographicArea: GeographicArea): Promise<FetchResult> {
    const { logger, rateLimiter, clock } = this.ctx
    const config = this.ctx.source.config as PMTilesSourceConfig

    const definition = geographicArea.definition as {
      bbox?: [number, number, number, number]
      zoom?: number
    } | null

    if (!definition || !definition.bbox || definition.zoom === undefined) {
      const warning = `Geographic area ${geographicArea.name} has no bbox/zoom definition`
      logger.warn(warning)
      return {
        rawJobs: [],
        metrics: { jobsFound: 0 },
        metadata: { area: geographicArea.id, warning },
        warnings: [warning],
      }
    }

    const [minLon, minLat, maxLon, maxLat] = definition.bbox
    const zoom = definition.zoom

    const abortController = new AbortController()

    let upstreamRequests = 0
    let upstreamResponses = 0

    // ─── STEP 1: Fetch obfuscated_ids from PMTiles tiles ───
    let jobIdsResult
    try {
      await rateLimiter.acquire()
      upstreamRequests++
      jobIdsResult = await fetchPmtilesJobIds(
        config,
        [minLon, minLat, maxLon, maxLat],
        zoom,
        abortController.signal
      )
      upstreamResponses++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Rezi PMTiles fetch failed for ${geographicArea.name}`, { error: message })
      return {
        rawJobs: [],
        metrics: { jobsFound: 0 },
        metadata: { area: geographicArea.id },
        warnings: [message],
      }
    }

    const obfuscatedIds = jobIdsResult.obfuscatedIds
    const warnings: string[] = [...jobIdsResult.warnings]

    logger.info(`Rezi PMTiles fetch complete for ${geographicArea.name}`, {
      area: geographicArea.id,
      tilesFetched: jobIdsResult.tilesFetched,
      obfuscatedIds: obfuscatedIds.length,
    })

    // Bound the number of IDs processed per cycle
    if (obfuscatedIds.length > MAX_DETAILS_IDS_PER_CYCLE) {
      const limited = obfuscatedIds.slice(0, MAX_DETAILS_IDS_PER_CYCLE)
      warnings.push(`Limited details fetch to ${MAX_DETAILS_IDS_PER_CYCLE} IDs (had ${obfuscatedIds.length})`)
      obfuscatedIds.length = 0
      obfuscatedIds.push(...limited)
    }

    if (obfuscatedIds.length === 0) {
      return {
        rawJobs: [],
        metrics: { jobsFound: 0, obfuscatedIdsFound: 0, tilesFetched: jobIdsResult.tilesFetched },
        metadata: {
          area: geographicArea.id,
          bbox: [minLon, minLat, maxLon, maxLat],
          zoom,
          tilesFetched: jobIdsResult.tilesFetched,
          obfuscatedIdsCount: 0,
          upstreamRequests,
          upstreamResponses,
        },
        warnings,
      }
    }

    // ─── STEP 2: Fetch full job details in batches via the Details API ───
    const detailsResult = await this.fetchDetailsBatch(
      config,
      obfuscatedIds,
      rateLimiter,
      abortController,
      logger,
      (req, res) => {
        upstreamRequests += req
        upstreamResponses += res
      }
    )

    return this.buildFetchResult(
      logger,
      detailsResult,
      {
        area: geographicArea.id,
        bbox: [minLon, minLat, maxLon, maxLat],
        zoom,
        tilesFetched: jobIdsResult.tilesFetched,
        obfuscatedIdsCount: obfuscatedIds.length,
        detailsApiUrl: config.detailsApiUrl,
        upstreamRequests,
        upstreamResponses,
      },
      warnings
    )
  }

  async fetchByKeywords(keywords: string[]): Promise<FetchResult> {
    const { logger, rateLimiter, clock } = this.ctx
    const config = this.ctx.source.config as PMTilesSourceConfig

    const searchApiUrl = config.searchApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/search'
    const detailsApiUrl = config.detailsApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/details'

    const abortController = new AbortController()
    const warnings: string[] = []

    let upstreamRequests = 0
    let upstreamResponses = 0

    // Step 1: Search → collect obfuscated_ids
    let obfuscatedIds: number[] = []
    for (const keyword of keywords) {
      try {
        await rateLimiter.acquire()
        upstreamRequests++
        const response = await fetch(searchApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: keyword }),
          signal: abortController.signal,
        })
        upstreamResponses++

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After')
          const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000
          throw new UpstreamRateLimitError(retryAfterMs, `Search API rate limited for "${keyword}"`)
        }

        if (!response.ok) {
          if (response.status >= 500) {
            throw new UpstreamTransientError(response.status, `Search API ${response.status} for "${keyword}"`)
          }
          warnings.push(`Search API for "${keyword}" failed: HTTP ${response.status}`)
          continue
        }

        const data = (await response.json()) as any
        const roles = data.data?.roles ?? {}
        for (const roleName of Object.keys(roles)) {
          const features = roles[roleName]?.locations?.features ?? []
          for (const feature of features) {
            const id = feature?.properties?.id
            if (id != null && !obfuscatedIds.includes(id)) {
              obfuscatedIds.push(id)
            }
          }
        }
      } catch (err) {
        if (isRetryableError(err)) throw err
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Search API for "${keyword}" error: ${message}`)
      }
    }

    logger.info(`Rezi keyword search complete`, {
      keywords,
      obfuscatedIds: obfuscatedIds.length,
    })

    // Bound the number of IDs processed per cycle
    if (obfuscatedIds.length > MAX_DETAILS_IDS_PER_CYCLE) {
      const limited = obfuscatedIds.slice(0, MAX_DETAILS_IDS_PER_CYCLE)
      warnings.push(`Limited details fetch to ${MAX_DETAILS_IDS_PER_CYCLE} IDs (had ${obfuscatedIds.length})`)
      obfuscatedIds.length = 0
      obfuscatedIds.push(...limited)
    }

    if (obfuscatedIds.length === 0) {
      return {
        rawJobs: [],
        metrics: { jobsFound: 0, obfuscatedIdsFound: 0 },
        metadata: { keywords, obfuscatedIdsCount: 0, detailsApiUrl, upstreamRequests, upstreamResponses },
        warnings,
      }
    }

    // Step 2: Details API in batches
    const detailsResult = await this.fetchDetailsBatch(
      config,
      obfuscatedIds,
      rateLimiter,
      abortController,
      logger,
      (req, res) => {
        upstreamRequests += req
        upstreamResponses += res
      }
    )

    return this.buildFetchResult(
      logger,
      detailsResult,
      { keywords, obfuscatedIdsCount: obfuscatedIds.length, detailsApiUrl, upstreamRequests, upstreamResponses },
      warnings
    )
  }

  private async fetchDetailsBatch(
    config: PMTilesSourceConfig,
    obfuscatedIds: number[],
    rateLimiter: any,
    abortController: AbortController,
    logger: any,
    countUpstream: (req: number, res: number) => void
  ): Promise<{ rawJobs: unknown[]; warnings: string[] }> {
    const detailsApiUrl = config.detailsApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/details'
    const rawJobs: unknown[] = []
    const warnings: string[] = []

    for (let i = 0; i < obfuscatedIds.length; i += DETAILS_BATCH_SIZE) {
      const batch = obfuscatedIds.slice(i, i + DETAILS_BATCH_SIZE)
      let page = 1

      while (true) {
        if (page > MAX_PAGES_PER_BATCH) {
          warnings.push(`Max pages per batch (${MAX_PAGES_PER_BATCH}) reached for batch ${Math.floor(i / DETAILS_BATCH_SIZE) + 1}`)
          break
        }

        try {
          await rateLimiter.acquire()
          countUpstream(1, 0)

          const response = await fetch(`${detailsApiUrl}?page=${page}&rows_per_page=${DETAILS_ROWS_PER_PAGE}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ obfuscated_ids: batch }),
            signal: abortController.signal,
          })
          countUpstream(0, 1)

          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After')
            const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000
            throw new UpstreamRateLimitError(retryAfterMs, `Details API rate limited batch ${Math.floor(i / DETAILS_BATCH_SIZE) + 1} page ${page}`)
          }

          if (!response.ok) {
            if (response.status >= 500) {
              throw new UpstreamTransientError(response.status, `Details API ${response.status} batch ${Math.floor(i / DETAILS_BATCH_SIZE) + 1} page ${page}`)
            }
            warnings.push(`Details API batch ${Math.floor(i / DETAILS_BATCH_SIZE) + 1} page ${page} failed: HTTP ${response.status}`)
            break
          }

          const data = (await response.json()) as any
          const jobs = data.jobs ?? data.data?.jobs ?? []

          if (!Array.isArray(jobs) || jobs.length === 0) {
            break
          }

          for (const job of jobs) {
            if (job && typeof job === 'object') {
              rawJobs.push(job)
            }
          }

          if (jobs.length < DETAILS_ROWS_PER_PAGE) {
            break
          }

          page++
        } catch (err) {
          if (isRetryableError(err)) throw err
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`Details API batch ${Math.floor(i / DETAILS_BATCH_SIZE) + 1} page ${page} error: ${message}`)
          break
        }
      }
    }

    return { rawJobs, warnings }
  }

  private buildFetchResult(
    logger: any,
    detailsResult: { rawJobs: unknown[]; warnings: string[] },
    metadata: Record<string, unknown>,
    existingWarnings: string[]
  ): FetchResult {
    const allWarnings = [...existingWarnings, ...detailsResult.warnings]
    const normalizedJobs: unknown[] = []

    for (const rawJob of detailsResult.rawJobs) {
      const normalized = this.normalizeJob(rawJob as any)
      if (normalized) {
        normalizedJobs.push(normalized)
      }
    }

    logger.info(`Rezi fetch complete`, {
      rawJobs: normalizedJobs.length,
      warnings: allWarnings.length,
      ...metadata,
    })

    return {
      rawJobs: normalizedJobs,
      metrics: {
        jobsFound: normalizedJobs.length,
        ...metadata,
      },
      metadata,
      warnings: allWarnings,
    }
  }

  cleanup?(): Promise<void> {
    return Promise.resolve()
  }

  private normalizeJob(raw: any): NormalizedReziJob | null {
    const externalId = raw.obfuscated_id
    if (externalId == null) {
      return null
    }

    const title = raw.title
    if (!title) {
      return null
    }

    const jobUrl = raw.job_url
    if (!jobUrl) {
      return null
    }

    const normalized: NormalizedReziJob = {
      obfuscated_id: externalId,
      title: String(title),
      organization: raw.organization ?? null,
      job_url: String(jobUrl),
      description_text: raw.description_text ?? null,
      remote_derived: Boolean(raw.remote_derived),
      salary_min_value: raw.salary_min_value != null ? Number(raw.salary_min_value) : null,
      salary_max_value: raw.salary_max_value != null ? Number(raw.salary_max_value) : null,
      salary_currency: raw.salary_currency ?? null,
      salary_unit_text: raw.salary_unit_text ?? null,
      date_posted: raw.date_posted != null ? raw.date_posted : null,
      ai_key_skills: Array.isArray(raw.ai_key_skills) ? raw.ai_key_skills : [],
      _categories: Array.isArray(raw._categories) ? raw._categories : [],
      _locations: Array.isArray(raw._locations) ? raw._locations : [],
      confidence: raw.confidence != null ? Number(raw.confidence) : null,
      _raw: raw,
    }

    return normalized
  }
}