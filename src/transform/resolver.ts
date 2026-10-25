import { IJobRepository } from '../persistence/IJobRepository'

export interface EntityResolverContext {
  repo: IJobRepository
  sourceId: string
  logger: any
  cache: Map<string, string> // lookup key -> entity id
}

export class EntityResolver {
  private repo: IJobRepository
  private logger: any
  private cache: Map<string, string>

  // Batch resolution buffers
  private pendingSkills = new Set<string>()
  private pendingCategories = new Map<string, string | null>() // categoryName -> description
  private pendingCities = new Map<string, string>() // cityName -> countryName
  private pendingCountries = new Set<string>()

  // Resolved ID maps
  private skillIds = new Map<string, string>() // skillName -> id
  private categoryIds = new Map<string, string>() // categoryName -> id
  private cityIds = new Map<string, string>() // "country:name" -> id
  private countryIds = new Map<string, string>() // countryName -> id

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

  // Queue skill for batch resolution
  queueSkill(name: string): void {
    if (name) this.pendingSkills.add(name)
  }

  // Queue category for batch resolution
  queueCategory(name: string, description?: string | null): void {
    if (name) this.pendingCategories.set(name, description ?? null)
  }

  // Queue city for batch resolution
  queueCity(name: string, countryName?: string | null): void {
    if (name) {
      this.pendingCities.set(name, countryName ?? '')
      if (countryName) this.queueCountry(countryName)
    }
  }

  // Queue country for batch resolution
  queueCountry(name: string): void {
    if (name) this.pendingCountries.add(name)
  }

  // Resolve all queued entities in batch
  async batchResolveAll(): Promise<void> {
    // Resolve skills
    if (this.pendingSkills.size > 0) {
      await this.resolveSkillsBatch()
    }

    // Resolve categories
    if (this.pendingCategories.size > 0) {
      await this.resolveCategoriesBatch()
    }

    // Resolve countries first (needed for cities)
    if (this.pendingCountries.size > 0) {
      await this.resolveCountriesBatch()
    }

    // Resolve cities
    if (this.pendingCities.size > 0) {
      await this.resolveCitiesBatch()
    }
  }

  private async resolveSkillsBatch(): Promise<void> {
    const names = Array.from(this.pendingSkills)
    this.pendingSkills.clear()
    const existing = await this.repo.listSkills()
    const existingMap = new Map<string, string>()
    for (const s of existing) {
      existingMap.set(s.name, s.id)
      existingMap.set(this.slugify(s.name), s.id)
    }

    const toCreate: Array<{ id: string; name: string; slug: string }> = []
    for (const name of names) {
      const cached = this.cacheGet(`skill:${name}`)
      if (cached) {
        this.skillIds.set(name, cached)
        continue
      }

      const existingId = existingMap.get(name) || existingMap.get(this.slugify(name))
      if (existingId) {
        this.skillIds.set(name, existingId)
        this.cacheSet(`skill:${name}`, existingId)
        continue
      }

      const id = crypto.randomUUID()
      const slug = this.slugify(name)
      toCreate.push({ id, name, slug })
      this.skillIds.set(name, id)
      this.cacheSet(`skill:${name}`, id)
    }

    if (toCreate.length > 0) {
      await this.repo.upsertSkillsBatch(toCreate)
      this.logger.debug(`Created ${toCreate.length} skills in batch`)
    }
  }

  private async resolveCategoriesBatch(): Promise<void> {
    const names = Array.from(this.pendingCategories.keys())
    const categoryDescriptions = new Map(this.pendingCategories)
    this.pendingCategories.clear()
    const existing = await this.repo.listCategories()
    const existingMap = new Map<string, string>()
    for (const c of existing) {
      existingMap.set(c.name, c.id)
      existingMap.set(this.slugify(c.name), c.id)
    }

    const toCreate: Array<{ id: string; name: string; slug: string; description: string | null }> = []
    for (const name of names) {
      const description = categoryDescriptions.get(name) ?? null
      const cached = this.cacheGet(`category:${name}`)
      if (cached) {
        this.categoryIds.set(name, cached)
        continue
      }

      const existingId = existingMap.get(name) || existingMap.get(this.slugify(name))
      if (existingId) {
        this.categoryIds.set(name, existingId)
        this.cacheSet(`category:${name}`, existingId)
        continue
      }

      const id = crypto.randomUUID()
      const slug = this.slugify(name)
      toCreate.push({ id, name, slug, description })
      this.categoryIds.set(name, id)
      this.cacheSet(`category:${name}`, id)
    }

    if (toCreate.length > 0) {
      await this.repo.upsertCategoriesBatch(toCreate)
      this.logger.debug(`Created ${toCreate.length} categories in batch`)
    }
  }

  private async resolveCountriesBatch(): Promise<void> {
    const names = Array.from(this.pendingCountries)
    this.pendingCountries.clear()
    const existing = await this.repo.listCountries()
    const existingMap = new Map<string, string>()
    for (const c of existing) {
      existingMap.set(c.name, c.id)
      if (c.code) existingMap.set(c.code, c.id)
    }

    const toCreate: Array<{ id: string; name: string; code: string | null }> = []
    for (const name of names) {
      const cached = this.cacheGet(`country:${name}`)
      if (cached) {
        this.countryIds.set(name, cached)
        continue
      }

      const existingId = existingMap.get(name)
      if (existingId) {
        this.countryIds.set(name, existingId)
        this.cacheSet(`country:${name}`, existingId)
        continue
      }

      const id = crypto.randomUUID()
      toCreate.push({ id, name, code: null })
      this.countryIds.set(name, id)
      this.cacheSet(`country:${name}`, id)
    }

    if (toCreate.length > 0) {
      await this.repo.upsertCountriesBatch(toCreate)
      this.logger.debug(`Created ${toCreate.length} countries in batch`)
    }
  }

  private async resolveCitiesBatch(): Promise<void> {
    // Group cities by country
    const citiesByCountry = new Map<string, string[]>()
    const citiesWithoutCountry = new Set<string>()
    for (const [cityName, countryName] of this.pendingCities) {
      if (countryName) {
        const list = citiesByCountry.get(countryName) ?? []
        list.push(cityName)
        citiesByCountry.set(countryName, list)
      } else {
        citiesWithoutCountry.add(cityName)
      }
    }
    this.pendingCities.clear()

    const existing = await this.repo.listCities()
    const existingMap = new Map<string, string>()
    for (const c of existing) {
      existingMap.set(`${c.country_id}:${c.name}`, c.id)
      existingMap.set(`__byname__:${c.name}`, c.id)
    }

    const toCreate: Array<{ id: string; country_id: string; name: string }> = []

    // Resolve cities with country
    for (const [countryName, cityNames] of citiesByCountry) {
      const countryId = this.countryIds.get(countryName)
      if (!countryId) {
        this.logger.warn(`Cannot create cities for country "${countryName}": country not resolved`)
        continue
      }

      for (const cityName of cityNames) {
        const key = `${countryId}:${cityName}`
        const cached = this.cacheGet(`city:${countryName}:${cityName}`)
        if (cached) {
          this.cityIds.set(key, cached)
          continue
        }

        const existingId = existingMap.get(key)
        if (existingId) {
          this.cityIds.set(key, existingId)
          this.cityIds.set(`__nocountry__:${cityName}`, existingId)
          this.cacheSet(`city:${countryName}:${cityName}`, existingId)
          continue
        }

        const id = crypto.randomUUID()
        toCreate.push({ id, country_id: countryId, name: cityName })
        this.cityIds.set(key, id)
        this.cityIds.set(`__nocountry__:${cityName}`, id)
        this.cacheSet(`city:${countryName}:${cityName}`, id)
      }
    }

    // Resolve cities without country (lookup by name only)
    for (const cityName of citiesWithoutCountry) {
      const key = `__byname__:${cityName}`
      const existingId = existingMap.get(key)
      if (existingId) {
        const cityKey = `__nocountry__:${cityName}`
        this.cityIds.set(cityKey, existingId)
        continue
      }
      // Cannot create city without country
      this.logger.warn(`Cannot create city "${cityName}" without a country`)
    }

    if (toCreate.length > 0) {
      await this.repo.upsertCitiesBatch(toCreate)
      this.logger.debug(`Created ${toCreate.length} cities in batch`)
    }
  }

  // Get resolved IDs (call after batchResolveAll)
  getSkillId(name: string): string | undefined {
    return this.skillIds.get(name)
  }

  getCategoryId(name: string): string | undefined {
    return this.categoryIds.get(name)
  }

  getCityId(name: string): string | undefined {
    // Check cities queued without country first
    const nocountryKey = `__nocountry__:${name}`
    const nocountryId = this.cityIds.get(nocountryKey)
    if (nocountryId) return nocountryId

    // Need to find the country for this city
    for (const [cityName, countryName] of this.pendingCities) {
      if (cityName === name) {
        const countryId = this.countryIds.get(countryName)
        if (countryId) {
          return this.cityIds.get(`${countryId}:${cityName}`)
        }
      }
    }
    return undefined
  }

  getCountryId(name: string): string | undefined {
    return this.countryIds.get(name)
  }

  // Backward-compatible convenience methods (single-entity resolution)
  async resolveSkill(name: string): Promise<string | null> {
    const cached = this.cacheGet(`skill:${name}`)
    if (cached) return cached
    this.queueSkill(name)
    await this.batchResolveAll()
    return this.getSkillId(name) ?? null
  }

  async resolveCategory(name: string, description?: string | null): Promise<string | null> {
    const cached = this.cacheGet(`category:${name}`)
    if (cached) return cached
    this.queueCategory(name, description)
    await this.batchResolveAll()
    return this.getCategoryId(name) ?? null
  }

  async resolveCountry(name: string, code?: string | null): Promise<string | null> {
    const cached = this.cacheGet(`country:${name}`)
    if (cached) return cached
    this.queueCountry(name)
    await this.batchResolveAll()
    return this.getCountryId(name) ?? null
  }

  async resolveCity(name: string, countryName?: string | null): Promise<string | null> {
    if (!countryName) {
      this.logger.warn(`Cannot create city "${name}" without a country`)
      return null
    }
    const cached = this.cacheGet(`city:${countryName}:${name}`)
    if (cached) return cached
    this.queueCity(name, countryName ?? null)
    await this.batchResolveAll()
    const id = this.getCityId(name)
    return id ?? null
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