export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  child(meta: Record<string, unknown>): Logger
}

export interface RateLimiter {
  acquire(): Promise<void>
  reset(): void
}

export interface SourceLoader {
  loadSources(): Promise<SourceConfigRecord[]>
  loadSourceGeographicAreas(): Promise<SourceGeographicAreaRecord[]>
}

export interface SourceConfigRecord {
  id: string
  name: string
  type: 'api' | 'scrape' | 'hybrid'
  config: Record<string, unknown>
  enabled: boolean
  last_run_at?: Date | null
}

export interface SourceGeographicAreaRecord {
  source_id: string
  geographic_area_id: string
  enabled: boolean
  last_run_at?: Date | null
  next_run_at?: Date | null
  geographic_area?: {
    id: string
    name: string
    definition: Record<string, unknown>
    enabled: boolean
  }
}
