import { JobRepository } from '../persistence/JobRepository'

export interface EntityResolverContext {
  repo: JobRepository
  sourceId: string
  logger: any
  cache: Map<string, string> // lookup key -> entity id
}

export class EntityResolver {
  private repo: JobRepository
  private logger: any
  private cache: Map<string, string>

  constructor(ctx: EntityResolverContext) {
    this.repo = ctx.repo
    this.logger = ctx.logger
    this.cache = ctx.cache ?? new Map()
  }

  private cacheGet(key: string): string | undefined {
    return this.cache.get(key)
  }

  private cacheSet(key: string, id: string): void {
    this.cache.set(key, id)
  }

  async resolveSkill(name: string): Promise<string | null> {
    if (!name) return null
    const key = `skill:${name}`
    const cached = this.cacheGet(key)
    if (cached) return cached

    const skills = await this.repo.listSkills()
    const match = skills.find((s: any) => s.name === name || s.slug === this.slugify(name))
    if (match) {
      this.cacheSet(key, match.id)
      return match.id
    }

    const id = crypto.randomUUID()
    const slug = this.slugify(name)
    await this.repo.upsertSkill({ id, name, slug })
    this.cacheSet(key, id)
    this.logger.debug(`Created skill "${name}" (${slug})`)
    return id
  }

  async resolveCategory(name: string, description?: string | null): Promise<string | null> {
    if (!name) return null
    const key = `category:${name}`
    const cached = this.cacheGet(key)
    if (cached) return cached

    const categories = await this.repo.listCategories()
    const match = categories.find((c: any) => c.name === name || c.slug === this.slugify(name))
    if (match) {
      this.cacheSet(key, match.id)
      return match.id
    }

    const id = crypto.randomUUID()
    const slug = this.slugify(name)
    await this.repo.upsertCategory({ id, name, slug, description })
    this.cacheSet(key, id)
    this.logger.debug(`Created category "${name}" (${slug})`)
    return id
  }

  async resolveCity(name: string, countryName?: string | null): Promise<string | null> {
    if (!name) return null
    const key = `city:${countryName ?? ''}:${name}`
    const cached = this.cacheGet(key)
    if (cached) return cached

    const cities = await this.repo.listCities()
    const match = cities.find((c: any) => c.name === name)
    if (match) {
      this.cacheSet(key, match.id)
      return match.id
    }

    if (!countryName) {
      this.logger.warn(`Cannot create city "${name}" without a country`)
      return null
    }

    // Try to find or create a country
    let countryId: string | null = null
    countryId = await this.resolveCountry(countryName)

    const id = crypto.randomUUID()
    if (!countryId) return null
    await this.repo.upsertCity({ id, country_id: countryId, name })
    this.cacheSet(key, id)
    this.logger.debug(`Created city "${name}"`)
    return id
  }

  async resolveCountry(name: string, code?: string | null): Promise<string | null> {
    if (!name) return null
    const key = `country:${name}`
    const cached = this.cacheGet(key)
    if (cached) return cached

    const countries = await this.repo.listCountries()
    const match = countries.find((c: any) => c.name === name || c.code === code)
    if (match) {
      this.cacheSet(key, match.id)
      return match.id
    }

    const id = crypto.randomUUID()
    await this.repo.upsertCountry({ id, name, code })
    this.cacheSet(key, id)
    this.logger.debug(`Created country "${name}"`)
    return id
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }
}
