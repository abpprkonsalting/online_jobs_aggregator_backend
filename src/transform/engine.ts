import { JobRepository } from '../persistence/JobRepository'
import { EntityResolver } from './resolver'
import type { TransformConfig, TransformResult } from './types'
import crypto from 'crypto'

interface TransformFieldMapping {
  source: string
  transform: string
}

function applyTransform(value: unknown, type: string): unknown {
  if (value === undefined || value === null) {
    return null
  }

  switch (type) {
    case 'string':
      return String(value)
    case 'number': {
      const n = Number(value)
      return Number.isNaN(n) ? null : n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') return value.toLowerCase() === 'true'
      return Boolean(value)
    case 'date': {
      if (value instanceof Date) return value
      const d = new Date(value as string | number)
      return Number.isNaN(d.getTime()) ? null : d
    }
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value)
        } catch {
          return value
        }
      }
      return value
    case 'entity_lookup':
      return value
    default:
      return value
  }
}

function getFieldValue(item: Record<string, unknown>, field: string): unknown {
  return item[field]
}

function asRecord(item: unknown): Record<string, unknown> {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return item as Record<string, unknown>
  }
  return {}
}

function computeContentHash(jobData: Record<string, unknown>): string {
  const stableFields = [
    'title',
    'organization',
    'job_url',
    'description_text',
    'salary_min',
    'salary_max',
    'salary_currency',
    'salary_unit',
    'date_posted',
    'allow_remote',
  ]
  const hashInput = stableFields.map((f) => String(jobData[f] ?? '')).join('|')
  return crypto.createHash('sha256').update(hashInput).digest('hex')
}

interface UpsertBatchResult {
  jobsNew: number
  jobsUpdated: number
  jobIds: Map<string, string> // external_id -> job id
}

export class TransformEngine {
  private repo: JobRepository
  private config: TransformConfig
  private sourceId: string
  private logger: any
  private resolver: EntityResolver

  constructor(repo: JobRepository, config: TransformConfig, sourceId: string, logger: any) {
    this.repo = repo
    this.config = config
    this.sourceId = sourceId
    this.logger = logger
    this.resolver = new EntityResolver({ repo, sourceId, logger, cache: new Map() })
  }

  async run(rawJobs: unknown[]): Promise<TransformResult> {
    let jobsFound = 0
    let jobsSavedNew = 0
    let jobsSavedUpdated = 0
    const warnings: string[] = []
    const allEntities: Array<{ entity: string; table: string; matchBy: Record<string, unknown>; data: Record<string, unknown> }> = []

    // Prepare job records for batch processing
    const jobRecords: Array<{
      record: Record<string, unknown>
      rawJob: unknown
      contentHash: string
    }> = []

    for (const rawJob of rawJobs) {
      if (!rawJob || typeof rawJob !== 'object') continue
      jobsFound++

      const jobEntity = this.config.entities.jobs
      if (!jobEntity) {
        warnings.push('No "jobs" entity defined in transform config')
        continue
      }

      // 1. Map job fields
      const jobData = this.mapFields(asRecord(rawJob), jobEntity.fields)
      const jobId = crypto.randomUUID()
      const now = new Date()

      const jobRecord: Record<string, unknown> = {
        id: jobId,
        source_id: this.sourceId,
        external_id: jobData.external_id,
        title: jobData.title,
        organization: jobData.organization ?? null,
        job_url: jobData.job_url,
        description_text: jobData.description_text ?? null,
        allow_remote: jobData.allow_remote ?? null,
        salary_min: jobData.salary_min ?? null,
        salary_max: jobData.salary_max ?? null,
        salary_currency: jobData.salary_currency ?? null,
        salary_unit: jobData.salary_unit ?? null,
        date_posted: jobData.date_posted ?? null,
        posted_at: jobData.posted_at ?? null,
        raw_data: jobData.raw_data ?? null,
        fetched_at: now,
        created_at: now,
        updated_at: now,
      }

      // Validate required fields
      if (!jobRecord.external_id || !jobRecord.title || !jobRecord.job_url) {
        warnings.push('Skipping job: missing required field (external_id, title, or job_url)')
        continue
      }

      // Compute content hash for no-op detection
      const contentHash = computeContentHash(jobRecord)

      jobRecords.push({ record: jobRecord, rawJob, contentHash })

      // Collect child entities for later batch resolution
      const childEntities = ['job_skills', 'job_categories', 'locations']
      for (const childName of childEntities) {
        const childConfig = this.config.entities[childName]
        if (!childConfig) continue

        const sourceArray = getFieldValue(asRecord(rawJob), childConfig.sourceArray ?? '')
        if (!Array.isArray(sourceArray)) continue

        const rows: Array<{ table: string; matchBy: Record<string, unknown>; data: Record<string, unknown> }> = []

        for (const item of sourceArray) {
          const itemObj = asRecord(item === null || item === undefined ? {} : item)
          const childData = this.mapFields(itemObj, childConfig.fields)

          const resolvedValue = childData._resolved ?? itemObj._resolved ?? item

          if (childName === 'job_skills') {
            const skillName = String(resolvedValue)
            this.resolver.queueSkill(skillName)
            rows.push({
              table: childConfig.table,
              matchBy: { skill_name: skillName },
              data: { skill_name: skillName },
            })
          } else if (childName === 'job_categories') {
            const categoryName = String(resolvedValue)
            if (rows.some((row) => row.matchBy.category_name === categoryName)) continue
            this.resolver.queueCategory(categoryName)
            rows.push({
              table: childConfig.table,
              matchBy: { category_name: categoryName },
              data: {
                category_name: categoryName,
                classification_confidence: childData.classification_confidence ?? null,
              },
            })
          } else if (childName === 'locations') {
            const rawText = String(childData.raw_text ?? resolvedValue)
            if (rows.some((row) => row.data.raw_text === rawText)) continue
            // Cities don't have country info in raw job data; queue without country
            this.resolver.queueCity(rawText, null)
            rows.push({
              table: childConfig.table,
              matchBy: { raw_text: rawText },
              data: { raw_text: rawText },
            })
          }
        }

        allEntities.push(...rows.map((r) => ({
          entity: childName,
          table: r.table,
          matchBy: r.matchBy,
          data: r.data,
        })))
      }
    }

    // Batch upsert jobs with content hash no-op detection
    let upsertResult = { jobsNew: 0, jobsUpdated: 0, jobIds: new Map<string, string>() }
    if (jobRecords.length > 0) {
      upsertResult = await this.repo.upsertJobsBatch(jobRecords.map((jr) => jr.record as any))
    }
    jobsSavedNew = upsertResult.jobsNew
    jobsSavedUpdated = upsertResult.jobsUpdated

    // Build jobId map for child entity sync
    const jobIdMap = upsertResult.jobIds

    // Batch resolve all entity names
    await this.resolver.batchResolveAll()

    // Sync child entities for upserted jobs only
    const upsertedJobIds = new Set<string>()
    for (const extId of jobIdMap.keys()) {
      const jobId = jobIdMap.get(extId)
      if (jobId) upsertedJobIds.add(jobId)
    }

    // Collect child entity data per job
    const jobSkillsMap = new Map<string, string[]>()
    const jobCategoriesMap = new Map<string, Array<{ category_id: string; classification_confidence?: number | null }>>()
    const jobLocationsMap = new Map<string, Array<{ city_id?: string | null; raw_text?: string | null }>>()

    for (const { record, rawJob } of jobRecords) {
      const externalId = record.external_id as string
      const jobId = jobIdMap.get(externalId)
      if (!jobId) continue

      const childEntities = ['job_skills', 'job_categories', 'locations']
      for (const childName of childEntities) {
        const childConfig = this.config.entities[childName]
        if (!childConfig) continue

        const sourceArray = getFieldValue(asRecord(rawJob), childConfig.sourceArray ?? '')
        if (!Array.isArray(sourceArray)) continue

        for (const item of sourceArray) {
          const itemObj = asRecord(item === null || item === undefined ? {} : item)
          const childData = this.mapFields(itemObj, childConfig.fields)
          const resolvedValue = childData._resolved ?? itemObj._resolved ?? item

          if (childName === 'job_skills') {
            const skillName = String(resolvedValue)
            const skillId = this.resolver.getSkillId(skillName)
            if (skillId) {
              const arr = jobSkillsMap.get(jobId) ?? []
              if (!arr.includes(skillId)) arr.push(skillId)
              jobSkillsMap.set(jobId, arr)
            }
          } else if (childName === 'job_categories') {
            const categoryName = String(resolvedValue)
            const categoryId = this.resolver.getCategoryId(categoryName)
            if (categoryId) {
              const arr = jobCategoriesMap.get(jobId) ?? []
              if (!arr.some((c) => c.category_id === categoryId)) {
                arr.push({
                  category_id: categoryId,
                  classification_confidence: Number(childData.classification_confidence) ?? null,
                })
                jobCategoriesMap.set(jobId, arr)
              }
            }
          } else if (childName === 'locations') {
            const rawText = String(childData.raw_text ?? resolvedValue)
            const cityId = this.resolver.getCityId(rawText)
            const arr = jobLocationsMap.get(jobId) ?? []
            const exists = arr.some((loc) => loc.city_id === (cityId ?? null) && loc.raw_text === rawText)
            if (!exists) {
              arr.push({ city_id: cityId ?? null, raw_text: rawText })
              jobLocationsMap.set(jobId, arr)
            }
          }
        }
      }
    }

    // Batch sync child tables
    for (const jobId of upsertedJobIds) {
      const skills = jobSkillsMap.get(jobId) ?? []
      const categories = jobCategoriesMap.get(jobId) ?? []
      const locations = jobLocationsMap.get(jobId) ?? []

      await Promise.all([
        this.repo.syncJobSkillsBatch(jobId, skills),
        this.repo.syncJobCategoriesBatch(jobId, categories),
        this.repo.syncLocationsBatch(jobId, locations),
      ])
    }

    return {
      jobsFound,
      jobsSavedNew,
      jobsSavedUpdated,
      warnings,
      entities: allEntities,
    }
  }

  private mapFields(item: Record<string, unknown>, fields: Record<string, TransformFieldMapping>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [target, mapping] of Object.entries(fields)) {
      const rawValue = getFieldValue(item, mapping.source)
      result[target] = applyTransform(rawValue, mapping.transform)
    }
    return result
  }
}