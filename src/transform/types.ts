export interface TransformFieldMapping {
  source: string
  transform: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'entity_lookup'
}

export interface TransformEntityConfig {
  table: string
  matchBy: string[]
  sourceArray?: string
  parent?: { fromEntity: string; column: string }
  fields: Record<string, TransformFieldMapping>
}

export interface TransformConfig {
  name: string
  version: string
  description?: string
  entities: Record<string, TransformEntityConfig>
}

export interface TransformResult {
  jobsFound: number
  jobsSavedNew: number
  jobsSavedUpdated: number
  newJobIds: string[]
  warnings: string[]
  entities: Array<{
    entity: string
    table: string
    matchBy: Record<string, unknown>
    data: Record<string, unknown>
  }>
}

export interface TransformContext {
  sourceId: string
  jobId: string
  repo: any
  logger: any
}
