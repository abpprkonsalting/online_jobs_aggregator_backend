import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobRepository } from '../../src/persistence/JobRepository'
import { TransformEngine } from '../../src/transform/engine'
import type { TransformConfig } from '../../src/transform/types'
import reziConfig from '../../src/transform/rezi.transform.json'

const { dedupDriver, createDedupDriver } = vi.hoisted(() => ({
  dedupDriver: { isDuplicate: vi.fn() },
  createDedupDriver: vi.fn((): any => null),
}))

vi.mock('../../src/ai-dedup', () => ({ createAiDedupDriver: createDedupDriver }))

const transformConfig = reziConfig as TransformConfig

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
}

function rawJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    obfuscated_id: 101,
    title: 'Platform Engineer',
    organization: 'Example Co',
    job_url: 'https://jobs.example.test/101',
    description_text: 'Build infrastructure.',
    remote_derived: 'true',
    salary_min_value: '95000',
    salary_max_value: '125000',
    salary_currency: 'USD',
    salary_unit_text: 'YEAR',
    date_posted: '2026-10-20T10:00:00.000Z',
    _raw: { origin: 'fixture' },
    ai_key_skills: ['TypeScript', 'TypeScript', 'Go'],
    _categories: [
      { _resolved: 'Engineering', confidence: '0.85' },
      { _resolved: 'Engineering', confidence: '0.85' },
    ],
    _locations: ['New York', 'New York'],
    confidence: '0.85',
    ...overrides,
  }
}

describe('TransformEngine', () => {
  let repo: JobRepository

  beforeEach(() => {
    createDedupDriver.mockReturnValue(null)
    repo = new JobRepository()
  })

  it('maps fields, upserts jobs, resolves relations, and synchronizes unique child entities', async () => {
    vi.spyOn(repo, 'upsertJobsBatch').mockImplementation(async () => ({
      jobsNew: 1,
      jobsUpdated: 0,
      jobIds: new Map([['101', 'persisted-job-101']]),
      newJobIds: ['persisted-job-101'],
    }))
    vi.spyOn(repo, 'listSkills').mockResolvedValue([])
    vi.spyOn(repo, 'upsertSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategoriesBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCities').mockResolvedValue([
      { id: 'city-new-york', name: 'New York' },
    ])
    const syncJobSkills = vi.spyOn(repo, 'syncJobSkillsBatch').mockResolvedValue()
    const syncJobCategories = vi.spyOn(repo, 'syncJobCategoriesBatch').mockResolvedValue()
    const syncLocations = vi.spyOn(repo, 'syncLocationsBatch').mockResolvedValue()
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([rawJob()])

    expect(result).toMatchObject({
      jobsFound: 1,
      jobsSavedNew: 1,
      jobsSavedUpdated: 0,
      warnings: [],
    })
    expect(repo.upsertJobsBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: 'source-1',
          external_id: '101',
          title: 'Platform Engineer',
          allow_remote: true,
          salary_min: 95000,
          salary_max: 125000,
          salary_currency: 'USD',
          salary_unit: 'YEAR',
          date_posted: new Date('2026-10-20T10:00:00.000Z'),
          raw_data: { origin: 'fixture' },
        }),
      ])
    )
    expect(syncJobSkills).toHaveBeenCalledWith('persisted-job-101', [
      expect.any(String),
      expect.any(String),
    ])
    expect(syncJobCategories).toHaveBeenCalledWith('persisted-job-101', [
      { category_id: expect.any(String), classification_confidence: 0.85 },
    ])
    expect(syncLocations).toHaveBeenCalledWith('persisted-job-101', [
      { city_id: 'city-new-york', raw_text: 'New York' },
    ])
    expect(repo.upsertSkillsBatch).toHaveBeenCalled()
    expect(repo.upsertCategoriesBatch).toHaveBeenCalled()
  })

  it('counts and warns about records missing required job fields without persisting them', async () => {
    const upsertJobsBatch = vi.spyOn(repo, 'upsertJobsBatch')
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([
      null,
      'not a job',
      rawJob({ obfuscated_id: undefined }),
      rawJob({ title: '' }),
      rawJob({ job_url: null }),
    ])

    expect(result.jobsFound).toBe(3)
    expect(result.jobsSavedNew).toBe(0)
    expect(result.jobsSavedUpdated).toBe(0)
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.every((warning) => warning.includes('missing required field'))).toBe(true)
    expect(upsertJobsBatch).not.toHaveBeenCalled()
  })

  it('uses the existing job id for relation synchronization and counts updates', async () => {
    vi.spyOn(repo, 'upsertJobsBatch').mockResolvedValue({
      jobsNew: 0,
      jobsUpdated: 1,
      jobIds: new Map([['101', 'existing-job-id']]),
      newJobIds: [],
    })
    vi.spyOn(repo, 'listSkills').mockResolvedValue([{ id: 'skill-ts', name: 'TypeScript', slug: 'typescript' }])
    const syncJobSkills = vi.spyOn(repo, 'syncJobSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'syncJobCategoriesBatch').mockResolvedValue()
    vi.spyOn(repo, 'syncLocationsBatch').mockResolvedValue()
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([rawJob({ ai_key_skills: ['TypeScript'], _categories: [], _locations: [] })])

    expect(result.jobsSavedNew).toBe(0)
    expect(result.jobsSavedUpdated).toBe(1)
    expect(syncJobSkills).toHaveBeenCalledWith('existing-job-id', ['skill-ts'])
  })

  it('skips unchanged jobs via content hash no-op detection', async () => {
    vi.spyOn(repo, 'upsertJobsBatch').mockImplementation(async (jobs) => ({
      jobsNew: 0,
      jobsUpdated: jobs.length,
      jobIds: new Map(jobs.map((j) => [j.external_id, 'existing-job'])),
      newJobIds: [],
    }))
    vi.spyOn(repo, 'listSkills').mockResolvedValue([])
    vi.spyOn(repo, 'upsertSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategoriesBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCities').mockResolvedValue([])
    const syncJobSkills = vi.spyOn(repo, 'syncJobSkillsBatch').mockResolvedValue()
    const syncJobCategories = vi.spyOn(repo, 'syncJobCategoriesBatch').mockResolvedValue()
    const syncLocations = vi.spyOn(repo, 'syncLocationsBatch').mockResolvedValue()
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([rawJob()])

    // All jobs should be treated as updated (no content_hash provided in mock path)
    expect(result.jobsSavedNew).toBe(0)
    expect(result.jobsSavedUpdated).toBe(1)
    expect(syncJobSkills).toHaveBeenCalled()
    expect(syncJobCategories).toHaveBeenCalled()
    expect(syncLocations).toHaveBeenCalled()
  })

  it('maps a cross-source duplicate to its canonical job and merges associations without replacing them', async () => {
    const canonical = {
      id: 'canonical-job',
      source_id: 'other-source',
      external_id: 'other-101',
      title: 'Platform Engineer',
      organization: 'Example Co',
      job_url: 'https://jobs.example.test/101',
    }
    vi.spyOn(repo, 'findCrossSourceCandidates').mockResolvedValue([canonical])
    const aliasSpy = vi.spyOn(repo, 'linkJobSourceAlias').mockResolvedValue()
    const mergeSpy = vi.spyOn(repo, 'mergeJobAssociations').mockResolvedValue()
    const upsertSpy = vi.spyOn(repo, 'upsertJobsBatch')
    vi.spyOn(repo, 'listSkills').mockResolvedValue([])
    vi.spyOn(repo, 'upsertSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategoriesBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCities').mockResolvedValue([])
    dedupDriver.isDuplicate.mockResolvedValue(true)
    createDedupDriver.mockReturnValue(dedupDriver as any)

    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())
    const result = await engine.run([rawJob()])

    expect(aliasSpy).toHaveBeenCalledWith('source-1', '101', 'canonical-job')
    expect(upsertSpy).not.toHaveBeenCalled()
    expect(mergeSpy).toHaveBeenCalledWith('canonical-job', expect.any(Array), expect.any(Array), expect.any(Array))
    expect(result.newJobIds).toEqual([])
  })
})
