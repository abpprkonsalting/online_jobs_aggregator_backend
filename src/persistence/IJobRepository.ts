export interface JobRecord {
  id: string
  source_id: string
  external_id: string
  title: string
  organization?: string | null
  job_url: string
  description_text?: string | null
  allow_remote?: boolean | null
  salary_min?: number | null
  salary_max?: number | null
  salary_currency?: string | null
  salary_unit?: string | null
  date_posted?: Date | null
  posted_at?: Date | null
  raw_data?: Record<string, unknown> | null
  fetched_at?: Date | null
  content_hash?: string | null
}

export interface FetchRunData {
  sourceId: string | null
  status: 'running' | 'success' | 'failed'
  startedAt: Date
  jobsFound?: number
  jobsSavedNew?: number
  jobsSavedUpdated?: number
  errorMessage?: string | null
  metadata?: Record<string, unknown> | null
  warnings?: string[] | null
}

export interface FetchRunUpdate {
  id: string
  status?: 'running' | 'success' | 'failed'
  finishedAt?: Date | null
  jobsFound?: number
  jobsSavedNew?: number
  jobsSavedUpdated?: number
  errorMessage?: string | null
  metadata?: Record<string, unknown> | null
  warnings?: string[] | null
}

export interface SourceData {
  id: string
  name: string
  type: 'api' | 'scrape' | 'hybrid'
  working_mode: 'passive' | 'proactive' | 'both'
  config: Record<string, unknown>
  enabled?: boolean
}

export interface GeographicAreaData {
  id: string
  name: string
  definition: Record<string, unknown>
  enabled?: boolean
}

export interface SkillData {
  id: string
  name: string
  slug: string
}

export interface CategoryData {
  id: string
  name: string
  slug: string
  description?: string | null
}

export interface CountryData {
  id: string
  name: string
  code?: string | null
}

export interface CityData {
  id: string
  country_id: string
  name: string
}

export interface KeywordData {
  id: string
  name: string
  slug: string
  category_id?: string | null
  enabled?: boolean
}

export interface CategoryKeywordData {
  category_id: string
  keyword_id: string
  weight?: number | null
  enabled?: boolean
}

export interface LocationData {
  city_id?: string | null
  raw_text?: string | null
}

export interface UserCategoryData {
  user_id: string
  category_id: string
  enabled?: boolean
}

export interface FindJobsWithFiltersParams {
  limit?: number
  offset?: number
  sort?: string
  sortDir?: 'asc' | 'desc'
  sorts?: Array<{ field: string; dir: 'asc' | 'desc' }>
  categoryIds?: string[]
  skillIds?: string[]
  cityIds?: string[]
  countryIds?: string[]
  sourceId?: string
  allowRemote?: boolean
  salaryMin?: number
  salaryMax?: number
  organization?: string
  location?: string
  search?: string
  userId?: string
}

export interface FindJobsWithFiltersResult {
  jobs: any[]
  total: number
}

export interface IJobRepository {
  // Users
  getUserByEmail(email: string): Promise<any | null>
  createUser(email: string, passwordHash: string, role: 'admin' | 'user'): Promise<string>
  getUserById(id: string): Promise<any | null>
  updateUserRole(id: string, role: 'admin' | 'user'): Promise<void>
  deactivateUser(id: string): Promise<void>
  updateUserLastLogin(id: string): Promise<void>
  listUsers(): Promise<any[]>
  listUserCategories(userId: string): Promise<any[]>
  createUserCategory(userId: string, categoryId: string): Promise<void>
  deleteUserCategory(userId: string, categoryId: string): Promise<void>

  // Auth tokens
  createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void>
  getRefreshTokenByUser(userId: string): Promise<any | null>
  revokeRefreshToken(tokenId: string): Promise<void>

  // Jobs - legacy and new
  findJobs(): Promise<any[]>
  findJobsWithFilters(params: FindJobsWithFiltersParams): Promise<FindJobsWithFiltersResult>
  findJobIdsByCategories(categoryIds: string[]): Promise<string[]>
  getJobDetails(jobId: string): Promise<any | null>
  getJobWithDetails(jobId: string): Promise<any | null>
  upsertJob(data: JobRecord): Promise<{ id: string; isNew: boolean }>
  upsertJobsBatch(data: JobRecord[]): Promise<{ jobsNew: number; jobsUpdated: number; jobIds: Map<string, string>; newJobIds: string[] }>
  findCrossSourceCandidates(data: JobRecord): Promise<JobRecord[]>
  linkJobSourceAlias(sourceId: string, externalId: string, jobId: string): Promise<void>

  // Job associations
  syncJobSkills(jobId: string, skillIds: string[]): Promise<void>
  syncJobCategories(jobId: string, categoryPairs: Array<{ category_id: string; classification_confidence?: number | null }>): Promise<void>
  syncLocations(jobId: string, locations: LocationData[]): Promise<void>
  syncJobSkillsBatch(jobId: string, skillIds: string[]): Promise<void>
  syncJobCategoriesBatch(jobId: string, categoryPairs: Array<{ category_id: string; classification_confidence?: number | null }>): Promise<void>
  syncLocationsBatch(jobId: string, locations: LocationData[]): Promise<void>
  mergeJobAssociations(jobId: string, skillIds: string[], categoryPairs: Array<{ category_id: string; classification_confidence?: number | null }>, locations: LocationData[]): Promise<void>

  // Sources
  listSources(): Promise<any[]>
  getSource(id: string): Promise<any | null>
  upsertSource(data: SourceData): Promise<void>
  deleteSource(id: string): Promise<void>
  updateSourceTimestamps(sourceId: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void>
  listSourceGeographicAreas(): Promise<Array<{
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }>>
  updateSourceGeoAreaTimestamps(sourceId: string, areaId: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void>

  // Geographic areas
  listGeographicAreas(): Promise<any[]>
  getGeographicArea(id: string): Promise<any | null>
  upsertGeographicArea(data: GeographicAreaData): Promise<void>
  deleteGeographicArea(id: string): Promise<void>
  linkSourceGeographicArea(data: { source_id: string; geographic_area_id: string; enabled?: boolean }): Promise<void>
  unlinkSourceGeographicArea(sourceId: string, geographicAreaId: string): Promise<void>
  listSourceAreas(sourceId?: string): Promise<any[]>

  // Fetch runs
  createFetchRun(data: FetchRunData): Promise<string>
  updateFetchRun(data: FetchRunUpdate): Promise<void>
  listFetchRuns(sourceId?: string, limit?: number, offset?: number): Promise<any[]>
  getFetchRun(id: string): Promise<any | null>

  // Saved jobs
  getSavedJob(userId: string, jobId: string): Promise<any | null>
  listSavedJobs(userId: string): Promise<any[]>
  createSavedJob(userId: string, jobId: string, status?: string): Promise<void>
  updateSavedJobStatus(userId: string, jobId: string, status: string): Promise<void>
  deleteSavedJob(userId: string, jobId: string): Promise<void>

  // Master data - skills
  listSkills(): Promise<any[]>
  upsertSkill(data: SkillData): Promise<void>
  upsertSkillsBatch(data: SkillData[]): Promise<void>

  // Master data - categories
  listCategories(): Promise<any[]>
  upsertCategory(data: CategoryData): Promise<void>
  upsertCategoriesBatch(data: Array<{ id: string; name: string; slug: string; description: string | null }>): Promise<void>

  // Master data - countries
  listCountries(): Promise<any[]>
  upsertCountry(data: CountryData): Promise<void>
  upsertCountriesBatch(data: Array<{ id: string; name: string; code: string | null }>): Promise<void>

  // Master data - cities
  listCities(countryId?: string): Promise<any[]>
  upsertCity(data: CityData): Promise<void>
  upsertCitiesBatch(data: Array<{ id: string; country_id: string; name: string }>): Promise<void>

  // Master data - keywords
  listKeywords(enabledOnly?: boolean): Promise<any[]>
  upsertKeyword(data: KeywordData): Promise<void>
  deleteKeyword(id: string): Promise<void>
  listCategoryKeywords(categoryId: string): Promise<any[]>
  upsertCategoryKeyword(data: CategoryKeywordData): Promise<void>
  deleteCategoryKeyword(categoryId: string, keywordId: string): Promise<void>
  listAllCategoryKeywords(): Promise<any[]>
  getCategorySubscriberCount(categoryId: string): Promise<number>
  listActiveUnifiedKeywords(): Promise<string[]>

  // Master schema
  getMasterSchema(): Promise<any>

  // Transaction helper
  transactionWithRetry<T>(fn: (conn: any) => Promise<T>, maxRetries?: number): Promise<T>
}
