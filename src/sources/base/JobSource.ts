import type { Logger } from '../../utils/logger.types'
import type { RateLimiter } from '../../utils/rate-limiter'

export interface GeographicArea {
  id: string
  name: string
  definition: Record<string, unknown>
}

export interface FetchRunMetrics {
  jobsFound: number
  [key: string]: unknown
}

export interface FetchResult {
  rawJobs: unknown[]
  metrics: FetchRunMetrics
  metadata?: Record<string, unknown>
  warnings?: string[]
}

export interface SourceConfig {
  id: string
  name: string
  type: 'api' | 'scrape' | 'hybrid'
  working_mode: 'passive' | 'proactive' | 'both'
  config: Record<string, unknown>
  enabled: boolean
  last_run_at?: Date | null
}

export interface JobSourceContext {
  source: SourceConfig
  logger: Logger
  rateLimiter: RateLimiter
  clock: () => Date
}

export abstract class JobSource {
  constructor(protected ctx: JobSourceContext) {}
  abstract fetch(geographicArea: GeographicArea): Promise<FetchResult>
  fetchByKeywords?(keywords: string[]): Promise<FetchResult>
  cleanup?(): Promise<void>
}
