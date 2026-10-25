import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobRepository } from '../../src/persistence/JobRepository'
import { EntityResolver } from '../../src/transform/resolver'

const { query, execute } = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('../../src/database/db', () => ({ query, execute }))

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
}

describe('EntityResolver', () => {
  let repo: JobRepository

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new JobRepository()
    query.mockResolvedValue([])
    execute.mockResolvedValue({})
  })

  it('resolves existing entities by name or slug and caches results', async () => {
    const listSkills = vi.spyOn(repo, 'listSkills').mockResolvedValue([
      { id: 'skill-1', name: 'TypeScript', slug: 'typescript' },
    ])
    const listCategories = vi.spyOn(repo, 'listCategories').mockResolvedValue([
      { id: 'category-1', name: 'Engineering', slug: 'engineering' },
    ])
    vi.spyOn(repo, 'upsertSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'upsertCategoriesBatch').mockResolvedValue()
    const resolver = new EntityResolver({
      repo,
      sourceId: 'source-1',
      logger: createLogger(),
      cache: new Map(),
    })

    await expect(resolver.resolveSkill('TypeScript')).resolves.toBe('skill-1')
    await expect(resolver.resolveSkill('TypeScript')).resolves.toBe('skill-1')
    await expect(resolver.resolveCategory('Engineering')).resolves.toBe('category-1')
    await expect(resolver.resolveCategory('Engineering')).resolves.toBe('category-1')

    expect(listSkills).toHaveBeenCalledOnce()
    expect(listCategories).toHaveBeenCalledOnce()
  })

  it('creates normalized entities once and caches them for subsequent lookups', async () => {
    vi.spyOn(repo, 'listSkills').mockResolvedValue([])
    vi.spyOn(repo, 'upsertSkillsBatch').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategoriesBatch').mockResolvedValue()
    const resolver = new EntityResolver({
      repo,
      sourceId: 'source-1',
      logger: createLogger(),
      cache: new Map(),
    })

    const skillId = await resolver.resolveSkill('  C++ Engineer  ')
    const categoryId = await resolver.resolveCategory('Data Science', 'Role category')
    await expect(resolver.resolveSkill('  C++ Engineer  ')).resolves.toBe(skillId)
    await expect(resolver.resolveCategory('Data Science', 'ignored on cache hit')).resolves.toBe(categoryId)

    expect(repo.upsertSkillsBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        name: '  C++ Engineer  ',
        slug: 'c-engineer',
      }),
    ])
    expect(repo.upsertCategoriesBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Data Science',
        slug: 'data-science',
        description: 'Role category',
      }),
    ])
    expect(repo.upsertSkillsBatch).toHaveBeenCalledOnce()
    expect(repo.upsertCategoriesBatch).toHaveBeenCalledOnce()
  })

  it('resolves and caches a city with its country relationship', async () => {
    vi.spyOn(repo, 'listCities').mockResolvedValue([])
    vi.spyOn(repo, 'listCountries').mockResolvedValue([
      { id: 'country-1', name: 'United States', code: 'US' },
    ])
    vi.spyOn(repo, 'upsertCitiesBatch').mockResolvedValue()
    const resolver = new EntityResolver({
      repo,
      sourceId: 'source-1',
      logger: createLogger(),
      cache: new Map(),
    })

    const cityId = await resolver.resolveCity('Austin', 'United States')
    await expect(resolver.resolveCity('Austin', 'United States')).resolves.toBe(cityId)

    expect(cityId).toBeDefined()
    expect(repo.upsertCitiesBatch).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Austin', country_id: 'country-1' }),
    ])
    expect(repo.upsertCitiesBatch).toHaveBeenCalledOnce()
  })

  it('does not create a city with a fabricated country when country data is missing', async () => {
    vi.spyOn(repo, 'listCities').mockResolvedValue([])
    const upsertCity = vi.spyOn(repo, 'upsertCity').mockResolvedValue()
    const logger = createLogger()
    const resolver = new EntityResolver({
      repo,
      sourceId: 'source-1',
      logger,
      cache: new Map(),
    })

    await expect(resolver.resolveCity('Unknown City')).resolves.toBeNull()

    expect(upsertCity).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Cannot create city "Unknown City" without a country')
  })
})
