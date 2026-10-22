import { JobRepository } from '../persistence/JobRepository'
import { EntityResolver } from './resolver'
import type { TransformConfig, TransformResult } from './types'

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

      // 2. Upsert job
      const upsertResult = await this.repo.upsertJob(jobRecord as any)
      if (upsertResult.isNew) jobsSavedNew++
      else jobsSavedUpdated++

      const actualJobId = upsertResult.id
      jobRecord.id = actualJobId

      // 3. Process child entities
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
            const skillId = await this.resolver.resolveSkill(skillName)
            if (!skillId) continue
            rows.push({
              table: childConfig.table,
              matchBy: { job_id: actualJobId, skill_id: skillId },
              data: { job_id: actualJobId, skill_id: skillId },
            })
          } else if (childName === 'job_categories') {
            const categoryName = String(resolvedValue)
            const categoryId = await this.resolver.resolveCategory(categoryName)
            if (!categoryId) continue
            if (rows.some((row) => row.matchBy.category_id === categoryId)) continue
            rows.push({
              table: childConfig.table,
              matchBy: { job_id: actualJobId, category_id: categoryId },
              data: {
                job_id: actualJobId,
                category_id: categoryId,
                classification_confidence: childData.classification_confidence ?? null,
              },
            })
          } else if (childName === 'locations') {
            const rawText = String(childData.raw_text ?? resolvedValue)
            const cityId = await this.resolver.resolveCity(rawText)
            if (rows.some((row) => row.data.city_id === (cityId ?? null) && row.data.raw_text === rawText)) continue
            rows.push({
              table: childConfig.table,
              matchBy: { job_id: actualJobId },
              data: { job_id: actualJobId, city_id: cityId ?? null, raw_text: rawText },
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

      allEntities.push({
        entity: 'jobs',
        table: jobEntity.table,
        matchBy: { source_id: this.sourceId, external_id: jobRecord.external_id },
        data: jobRecord,
      })
    }

    // 4. Sync child tables per job
    const jobSkillsMap = new Map<string, string[]>()
    const jobCategoriesMap = new Map<string, Array<{ category_id: string; classification_confidence?: number | null }>>()
    const jobLocationsMap = new Map<string, Array<{ city_id?: string | null; raw_text?: string | null }>>()

    for (const ent of allEntities) {
      if (ent.entity === 'job_skills') {
        const skillId = ent.matchBy.skill_id as string
        const jobId = ent.data.job_id as string
        const arr = jobSkillsMap.get(jobId) ?? []
        if (!arr.includes(skillId)) arr.push(skillId)
        jobSkillsMap.set(jobId, arr)
      } else if (ent.entity === 'job_categories') {
        const jobId = ent.data.job_id as string
        const arr = jobCategoriesMap.get(jobId) ?? []
        arr.push({
          category_id: ent.data.category_id as string,
          classification_confidence: ent.data.classification_confidence as number | null,
        })
        jobCategoriesMap.set(jobId, arr)
      } else if (ent.entity === 'locations') {
        const jobId = ent.data.job_id as string
        const arr = jobLocationsMap.get(jobId) ?? []
        arr.push({ city_id: ent.data.city_id as string | null, raw_text: ent.data.raw_text as string | null })
        jobLocationsMap.set(jobId, arr)
      }
    }

    const upsertedJobIds = new Set<string>()
    for (const ent of allEntities) {
      if (ent.entity === 'jobs') {
        upsertedJobIds.add(ent.data.id as string)
      }
    }

    for (const jobId of upsertedJobIds) {
      const skills = jobSkillsMap.get(jobId) ?? []
      await this.repo.syncJobSkills(jobId, skills)

      const categories = jobCategoriesMap.get(jobId) ?? []
      await this.repo.syncJobCategories(jobId, categories)

      const locations = jobLocationsMap.get(jobId) ?? []
      await this.repo.syncLocations(jobId, locations)
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
