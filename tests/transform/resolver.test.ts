import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobRepository } from '../../src/persistence/JobRepository'
import { EntityResolver } from '../../src/transform/resolver'

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
    repo = new JobRepository()
  })

  it('resolves existing entities by name or slug and caches results', async () => {
    const listSkills = vi.spyOn(repo, 'listSkills').mockResolvedValue([
      { id: 'skill-1', name: 'TypeScript', slug: 'typescript' },
    ])
    const listCategories = vi.spyOn(repo, 'listCategories').mockResolvedValue([
      { id: 'category-1', name: 'Engineering', slug: 'engineering' },
    ])
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
    vi.spyOn(repo, 'upsertSkill').mockResolvedValue()
    vi.spyOn(repo, 'listCategories').mockResolvedValue([])
    vi.spyOn(repo, 'upsertCategory').mockResolvedValue()
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

    expect(repo.upsertSkill).toHaveBeenCalledWith({
      id: skillId,
      name: '  C++ Engineer  ',
      slug: 'c-engineer',
    })
    expect(repo.upsertCategory).toHaveBeenCalledWith({
      id: categoryId,
      name: 'Data Science',
      slug: 'data-science',
      description: 'Role category',
    })
    expect(repo.upsertSkill).toHaveBeenCalledOnce()
    expect(repo.upsertCategory).toHaveBeenCalledOnce()
  })

  it('resolves and caches a city with its country relationship', async () => {
    vi.spyOn(repo, 'listCities').mockResolvedValue([])
    vi.spyOn(repo, 'listCountries').mockResolvedValue([
      { id: 'country-1', name: 'United States', code: 'US' },
    ])
    vi.spyOn(repo, 'upsertCity').mockResolvedValue()
    const resolver = new EntityResolver({
      repo,
      sourceId: 'source-1',
      logger: createLogger(),
      cache: new Map(),
    })

    const cityId = await resolver.resolveCity('Austin', 'United States')
    await expect(resolver.resolveCity('Austin', 'United States')).resolves.toBe(cityId)

    expect(repo.upsertCity).toHaveBeenCalledWith({
      id: cityId,
      country_id: 'country-1',
      name: 'Austin',
    })
    expect(repo.upsertCity).toHaveBeenCalledOnce()
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
