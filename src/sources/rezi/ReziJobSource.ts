import { JobSource, JobSourceContext, FetchResult, GeographicArea } from '../base/JobSource'
import {
  fetchPmtilesJobIds,
  computeTileRange,
  PMTilesSourceConfig,
} from './pmtiles'

const DETAILS_BATCH_SIZE = 50
const DETAILS_ROWS_PER_PAGE = 12

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
    const { logger, rateLimiter } = this.ctx
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

    // ─── STEP 1: Fetch obfuscated_ids from PMTiles tiles ───
    let jobIdsResult
    try {
      await rateLimiter.acquire()
      jobIdsResult = await fetchPmtilesJobIds(
        config,
        [minLon, minLat, maxLon, maxLat],
        zoom,
        abortController.signal
      )
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
      warnings
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
      },
      warnings
    )
  }

  /**
   * Proactive path: fetch jobs by keyword using the Search API → Details API.
   * No geographic area is required — the search endpoint returns jobs matching
   * the query across all locations.
   */
  async fetchByKeywords(keywords: string[]): Promise<FetchResult> {
    const { logger, rateLimiter } = this.ctx
    const config = this.ctx.source.config as PMTilesSourceConfig

    const searchApiUrl = config.searchApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/search'
    const detailsApiUrl = config.detailsApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/details'

    const abortController = new AbortController()
    const warnings: string[] = []

    // Step 1: Search → collect obfuscated_ids
    let obfuscatedIds: number[] = []
    for (const keyword of keywords) {
      try {
        await rateLimiter.acquire()
        const response = await fetch(searchApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: keyword }),
          signal: abortController.signal,
        })

        if (!response.ok) {
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
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Search API for "${keyword}" error: ${message}`)
      }
    }

    logger.info(`Rezi keyword search complete`, {
      keywords,
      obfuscatedIds: obfuscatedIds.length,
    })

    if (obfuscatedIds.length === 0) {
      return {
        rawJobs: [],
        metrics: { jobsFound: 0, obfuscatedIdsFound: 0 },
        metadata: { keywords, obfuscatedIdsCount: 0, detailsApiUrl },
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
      warnings
    )

    return this.buildFetchResult(
      logger,
      detailsResult,
      { keywords, obfuscatedIdsCount: obfuscatedIds.length, detailsApiUrl },
      warnings
    )
  }

  private async fetchDetailsBatch(
    config: PMTilesSourceConfig,
    obfuscatedIds: number[],
    rateLimiter: any,
    abortController: AbortController,
    logger: any,
    warnings: string[]
  ): Promise<{ rawJobs: unknown[]; warnings: string[] }> {
    const detailsApiUrl = config.detailsApiUrl || 'https://api.rezi.ai/v1/search-engine/maps/jobs/details'
    const rawJobs: unknown[] = []

    // The details API treats obfuscated_ids as a pool and paginates the result set
    // via page/rows_per_page (confirmed by HAR: page 1 != page 2 for same ID list).
    // We therefore paginate each batch until a page returns fewer than rows_per_page.
    for (let i = 0; i < obfuscatedIds.length; i += DETAILS_BATCH_SIZE) {
      const batch = obfuscatedIds.slice(i, i + DETAILS_BATCH_SIZE)
      let page = 1

      while (true) {
        try {
          await rateLimiter.acquire()

          const response = await fetch(`${detailsApiUrl}?page=${page}&rows_per_page=${DETAILS_ROWS_PER_PAGE}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ obfuscated_ids: batch }),
            signal: abortController.signal,
          })

          if (!response.ok) {
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
