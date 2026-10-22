import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobRepository } from '../../src/persistence/JobRepository'
import { TransformEngine } from '../../src/transform/engine'
import type { TransformConfig } from '../../src/transform/types'
import reziConfig from '../../src/transform/rezi.transform.json'

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
    repo = new JobRepository()
  })

  it('maps fields, upserts jobs, resolves relations, and synchronizes unique child entities', async () => {
    vi.spyOn(repo, 'upsertJob').mockImplementation(async (job) => ({
      id: job.external_id === '101' ? 'persisted-job-101' : 'persisted-job-other',
      isNew: true,
    }))
    vi.spyOn(repo, 'listSkills').mockResolvedValue([])
    vi.spyOn(repo, 'upsertSkill').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategory').mockResolvedValue()
    vi.spyOn(repo, 'listCities').mockResolvedValue([
      { id: 'city-new-york', name: 'New York' },
    ])
    const syncJobSkills = vi.spyOn(repo, 'syncJobSkills').mockResolvedValue()
    const syncJobCategories = vi.spyOn(repo, 'syncJobCategories').mockResolvedValue()
    const syncLocations = vi.spyOn(repo, 'syncLocations').mockResolvedValue()
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([rawJob()])

    expect(result).toMatchObject({
      jobsFound: 1,
      jobsSavedNew: 1,
      jobsSavedUpdated: 0,
      warnings: [],
    })
    expect(repo.upsertJob).toHaveBeenCalledWith(expect.objectContaining({
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
    }))
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
    expect(repo.upsertSkill).toHaveBeenCalledTimes(2)
    expect(repo.upsertCategory).toHaveBeenCalledOnce()
  })

  it('counts and warns about records missing required job fields without persisting them', async () => {
    const upsertJob = vi.spyOn(repo, 'upsertJob')
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
    expect(upsertJob).not.toHaveBeenCalled()
  })

  it('uses the existing job id for relation synchronization and counts updates', async () => {
    vi.spyOn(repo, 'upsertJob').mockResolvedValue({ id: 'existing-job-id', isNew: false })
    vi.spyOn(repo, 'listSkills').mockResolvedValue([{ id: 'skill-ts', name: 'TypeScript', slug: 'typescript' }])
    const syncJobSkills = vi.spyOn(repo, 'syncJobSkills').mockResolvedValue()
    vi.spyOn(repo, 'syncJobCategories').mockResolvedValue()
    vi.spyOn(repo, 'syncLocations').mockResolvedValue()
    const engine = new TransformEngine(repo, transformConfig, 'source-1', createLogger())

    const result = await engine.run([rawJob({ ai_key_skills: ['TypeScript'], _categories: [], _locations: [] })])

    expect(result.jobsSavedNew).toBe(0)
    expect(result.jobsSavedUpdated).toBe(1)
    expect(syncJobSkills).toHaveBeenCalledWith('existing-job-id', ['skill-ts'])
  })
})
