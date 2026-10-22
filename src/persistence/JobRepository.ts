import { RowDataPacket } from 'mysql2/promise'
import { query, execute } from '../database/db'

export class JobRepository {
  async getUserByEmail(email: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM users WHERE email = ?`, [email])
    return rows.length ? rows[0] : null
  }

  async createUser(email: string, passwordHash: string, role: 'admin' | 'user' = 'user'): Promise<string> {
    const id = crypto.randomUUID()
    const now = new Date()
    await execute(
      `INSERT INTO users (id, email, password_hash, role, is_active, last_login_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
      [id, email, passwordHash, role, now, now]
    )
    return id
  }

  async getUserById(id: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM users WHERE id = ?`, [id])
    return rows.length ? rows[0] : null
  }

  async updateUserRole(id: string, role: 'admin' | 'user'): Promise<void> {
    await execute(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, [role, new Date(), id])
  }

  async deactivateUser(id: string): Promise<void> {
    await execute(`UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?`, [new Date(), id])
  }

  async updateUserLastLogin(id: string): Promise<void> {
    await execute(`UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`, [new Date(), new Date(), id])
  }

  async listUsers(): Promise<any[]> {
    return query<any>(`SELECT id, email, role, is_active, last_login_at, created_at FROM users ORDER BY created_at DESC`)
  }

  async createRefreshToken(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    const id = crypto.randomUUID()
    const now = new Date()
    await execute(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [id, userId, tokenHash, expiresAt, now]
    )
  }

  async getRefreshTokenByUser(userId: string): Promise<any | null> {
    const rows = await query<any>(
      `SELECT * FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [userId]
    )
    return rows.length ? rows[0] : null
  }

  async revokeRefreshToken(tokenId: string): Promise<void> {
    await execute(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`, [new Date(), tokenId])
  }

  async findJobs(): Promise<any[]> {
    return query<any>(`SELECT * FROM jobs ORDER BY posted_at DESC, date_posted DESC`)
  }

  async findJobIdsByCategories(categoryIds: string[]): Promise<string[]> {
    if (categoryIds.length === 0) return []

    const placeholders = categoryIds.map(() => '?').join(', ')
    const rows = await query<Array<{ job_id: string } & RowDataPacket>>(
      `SELECT DISTINCT job_id FROM job_categories WHERE category_id IN (${placeholders})`,
      categoryIds,
    )
    return rows.map((row) => row.job_id)
  }

  async getJobDetails(jobId: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM jobs WHERE id = ?`, [jobId])
    return rows.length ? rows[0] : null
  }

  async listSources(): Promise<any[]> {
    return query<any>(`SELECT * FROM sources ORDER BY name ASC`)
  }

  async listFetchRuns(sourceId?: string): Promise<any[]> {
    if (sourceId) {
      return query<any>(`SELECT * FROM fetch_runs WHERE source_id = ? ORDER BY created_at DESC`, [sourceId])
    }
    return query<any>(`SELECT * FROM fetch_runs ORDER BY created_at DESC`)
  }

  async listCountries(): Promise<any[]> {
    return query<any>(`SELECT * FROM countries ORDER BY name ASC`)
  }

  async listCities(countryId?: string): Promise<any[]> {
    if (countryId) {
      return query<any>(`SELECT * FROM cities WHERE country_id = ? ORDER BY name ASC`, [countryId])
    }
    return query<any>(`SELECT * FROM cities ORDER BY name ASC`)
  }

  async listCategories(): Promise<any[]> {
    return query<any>(`SELECT * FROM categories ORDER BY name ASC`)
  }

  async listSkills(): Promise<any[]> {
    return query<any>(`SELECT * FROM skills ORDER BY name ASC`)
  }

  async getMasterSchema(): Promise<any> {
    const [countries, cities, skills, categories, areas] = await Promise.all([
      this.listCountries(),
      this.listCities(),
      this.listSkills(),
      this.listCategories(),
      query<any>(`SELECT * FROM geographic_areas ORDER BY name ASC`),
    ])
    return { countries, cities, skills, categories, geographic_areas: areas }
  }

  async createFetchRun(data: {
    sourceId: string | null
    status: 'running' | 'success' | 'failed'
    startedAt: Date
    jobsFound?: number
    jobsSavedNew?: number
    jobsSavedUpdated?: number
    errorMessage?: string | null
    metadata?: Record<string, unknown> | null
    warnings?: string[] | null
  }): Promise<string> {
    const id = crypto.randomUUID()
    const now = new Date()
    await execute(
      `INSERT INTO fetch_runs (id, source_id, status, started_at, finished_at, jobs_found, jobs_saved_new, jobs_saved_updated, error_message, metadata, warnings, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.sourceId,
        data.status,
        data.startedAt,
        data.jobsFound ?? 0,
        data.jobsSavedNew ?? 0,
        data.jobsSavedUpdated ?? 0,
        data.errorMessage ?? null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.warnings ? JSON.stringify(data.warnings) : null,
        now,
        now,
      ],
    )
    return id
  }

  async updateFetchRun(data: {
    id: string
    status?: 'running' | 'success' | 'failed'
    finishedAt?: Date | null
    jobsFound?: number
    jobsSavedNew?: number
    jobsSavedUpdated?: number
    errorMessage?: string | null
    metadata?: Record<string, unknown> | null
    warnings?: string[] | null
  }): Promise<void> {
    const fields: string[] = []
    const params: unknown[] = []

    if (data.status !== undefined) {
      fields.push(`status = ?`)
      params.push(data.status)
    }
    if (data.finishedAt !== undefined) {
      fields.push(`finished_at = ?`)
      params.push(data.finishedAt)
    }
    if (data.jobsFound !== undefined) {
      fields.push(`jobs_found = ?`)
      params.push(data.jobsFound)
    }
    if (data.jobsSavedNew !== undefined) {
      fields.push(`jobs_saved_new = ?`)
      params.push(data.jobsSavedNew)
    }
    if (data.jobsSavedUpdated !== undefined) {
      fields.push(`jobs_saved_updated = ?`)
      params.push(data.jobsSavedUpdated)
    }
    if (data.errorMessage !== undefined) {
      fields.push(`error_message = ?`)
      params.push(data.errorMessage)
    }
    if (data.metadata !== undefined) {
      fields.push(`metadata = ?`)
      params.push(data.metadata ? JSON.stringify(data.metadata) : null)
    }
    if (data.warnings !== undefined) {
      fields.push(`warnings = ?`)
      params.push(data.warnings ? JSON.stringify(data.warnings) : null)
    }

    if (fields.length === 0) return

    fields.push(`updated_at = ?`)
    params.push(new Date())
    params.push(data.id)

    await execute(`UPDATE fetch_runs SET ${fields.join(', ')} WHERE id = ?`, params)
  }

  async listSourceGeographicAreas(): Promise<Array<{
    source_id: string
    source_name: string
    geographic_area_id: string
    area_name: string
    area_definition: Record<string, unknown>
  }>> {
    return query<any>(`
      SELECT sga.source_id, s.name AS source_name,
             sga.geographic_area_id, ga.name AS area_name, ga.definition AS area_definition
      FROM source_geographic_areas sga
      JOIN sources s ON s.id = sga.source_id
      JOIN geographic_areas ga ON ga.id = sga.geographic_area_id
      WHERE sga.enabled = 1 AND s.enabled = 1 AND ga.enabled = 1
    `)
  }

  async updateSourceTimestamps(sourceId: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void> {
    await execute(
      `UPDATE sources SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?`,
      [lastRunAt, nextRunAt, new Date(), sourceId]
    )
  }

  async updateSourceGeoAreaTimestamps(sourceId: string, areaId: string, lastRunAt: Date, nextRunAt: Date | null): Promise<void> {
    await execute(
      `UPDATE source_geographic_areas SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE source_id = ? AND geographic_area_id = ?`,
      [lastRunAt, nextRunAt, new Date(), sourceId, areaId]
    )
  }

  async upsertSource(data: {
    id: string
    name: string
    type: 'api' | 'scrape' | 'hybrid'
    working_mode?: 'passive' | 'proactive' | 'both'
    config: Record<string, unknown>
    enabled?: boolean
  }): Promise<void> {
    const now = new Date()
    const enabled = data.enabled ?? 1
    const working_mode = data.working_mode ?? 'both'
    await execute(
      `INSERT INTO sources (id, name, type, working_mode, config, enabled, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), type = VALUES(type), working_mode = VALUES(working_mode), config = VALUES(config), enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [data.id, data.name, data.type, working_mode, JSON.stringify(data.config), enabled, now, now]
    )
  }

  async deleteSource(id: string): Promise<void> {
    await execute(`DELETE FROM sources WHERE id = ?`, [id])
  }

  async upsertJob(data: {
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
  }): Promise<{ id: string; isNew: boolean }> {
    const now = new Date()
    const existing = await query<any>(
      `SELECT id FROM jobs WHERE source_id = ? AND external_id = ?`,
      [data.source_id, data.external_id]
    )

    const params = [
      data.id,
      data.source_id,
      data.external_id,
      data.title,
      data.organization ?? null,
      data.job_url,
      data.description_text ?? null,
      data.allow_remote ?? null,
      data.salary_min ?? null,
      data.salary_max ?? null,
      data.salary_currency ?? null,
      data.salary_unit ?? null,
      data.date_posted ?? null,
      data.posted_at ?? null,
      data.raw_data ? JSON.stringify(data.raw_data) : null,
      data.fetched_at ?? now,
      now,
      now,
    ]

    if (existing.length > 0) {
      await execute(
        `UPDATE jobs
         SET title = ?, organization = ?, job_url = ?, description_text = ?,
             allow_remote = ?, salary_min = ?, salary_max = ?, salary_currency = ?,
             salary_unit = ?, date_posted = ?, posted_at = ?, raw_data = ?,
             fetched_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          data.title, data.organization ?? null, data.job_url, data.description_text ?? null,
          data.allow_remote ?? null, data.salary_min ?? null, data.salary_max ?? null,
          data.salary_currency ?? null, data.salary_unit ?? null, data.date_posted ?? null,
          data.posted_at ?? null, data.raw_data ? JSON.stringify(data.raw_data) : null,
          data.fetched_at ?? now, now, existing[0].id,
        ]
      )
      return { id: existing[0].id, isNew: false }
    }

    await execute(
      `INSERT INTO jobs (id, source_id, external_id, title, organization, job_url, description_text,
       allow_remote, salary_min, salary_max, salary_currency, salary_unit, date_posted, posted_at,
       raw_data, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    )
    return { id: data.id, isNew: true }
  }

  async syncJobSkills(jobId: string, skillIds: string[]): Promise<void> {
    await execute(`DELETE FROM job_skills WHERE job_id = ?`, [jobId])
    if (skillIds.length === 0) return
    const values = skillIds.map((skillId) => `('${jobId}', '${skillId}')`).join(', ')
    await execute(`INSERT INTO job_skills (job_id, skill_id) VALUES ${values}`)
  }

  async syncJobCategories(jobId: string, categoryPairs: Array<{ category_id: string; classification_confidence?: number | null }>): Promise<void> {
    await execute(`DELETE FROM job_categories WHERE job_id = ?`, [jobId])
    if (categoryPairs.length === 0) return
    const values = categoryPairs
      .map((p) => `('${jobId}', '${p.category_id}', ${p.classification_confidence ?? 'NULL'})`)
      .join(', ')
    await execute(`INSERT INTO job_categories (job_id, category_id, classification_confidence) VALUES ${values}`)
  }

  async syncLocations(jobId: string, locations: Array<{ city_id?: string | null; raw_text?: string | null }>): Promise<void> {
    await execute(`DELETE FROM locations WHERE job_id = ?`, [jobId])
    if (locations.length === 0) return
    const values = locations
      .map((loc) => `('${crypto.randomUUID()}', '${jobId}', ${loc.city_id ?? 'NULL'}, ${loc.raw_text != null ? `'${String(loc.raw_text).replace(/'/g, "''")}'` : 'NULL'})`)
      .join(', ')
    await execute(`INSERT INTO locations (id, job_id, city_id, raw_text, created_at, updated_at) VALUES ${values}`)
  }

  async getJobWithDetails(jobId: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM jobs WHERE id = ?`, [jobId])
    if (!rows.length) return null
    const job = rows[0]

    const [skills, categories, locations] = await Promise.all([
      query<any>(`
        SELECT s.id, s.name, s.slug
        FROM job_skills js
        JOIN skills s ON s.id = js.skill_id
        WHERE js.job_id = ?
        ORDER BY s.name ASC
      `, [jobId]),
      query<any>(`
        SELECT jc.category_id, jc.classification_confidence, c.name, c.slug
        FROM job_categories jc
        JOIN categories c ON c.id = jc.category_id
        WHERE jc.job_id = ?
        ORDER BY c.name ASC
      `, [jobId]),
      query<any>(`
        SELECT l.id, l.city_id, l.raw_text, c.name AS city_name, co.id AS country_id, co.name AS country_name
        FROM locations l
        LEFT JOIN cities c ON c.id = l.city_id
        LEFT JOIN countries co ON co.id = c.country_id
        WHERE l.job_id = ?
        ORDER BY l.created_at ASC
      `, [jobId]),
    ])

    return {
      ...job,
      skills,
      categories: categories.map((c: any) => ({
        id: c.category_id,
        name: c.name,
        slug: c.slug,
        classification_confidence: c.classification_confidence,
      })),
      locations,
      days_waiting: job.posted_at
        ? Math.floor((Date.now() - new Date(job.posted_at).getTime()) / (1000 * 60 * 60 * 24))
        : null,
    }
  }

  async upsertSkill(data: { id: string; name: string; slug: string }): Promise<void> {
    const now = new Date()
    await execute(
      `INSERT INTO skills (id, name, slug, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), slug = VALUES(slug), updated_at = VALUES(updated_at)`,
      [data.id, data.name, data.slug, now, now]
    )
  }

  async upsertCategory(data: { id: string; name: string; slug: string; description?: string | null }): Promise<void> {
    const now = new Date()
    await execute(
      `INSERT INTO categories (id, name, slug, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), slug = VALUES(slug), description = VALUES(description), updated_at = VALUES(updated_at)`,
      [data.id, data.name, data.slug, data.description ?? null, now, now]
    )
  }

  async upsertCountry(data: { id: string; name: string; code?: string | null }): Promise<void> {
    const now = new Date()
    await execute(
      `INSERT INTO countries (id, name, code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), code = VALUES(code), updated_at = VALUES(updated_at)`,
      [data.id, data.name, data.code ?? null, now, now]
    )
  }

  async upsertCity(data: { id: string; country_id: string; name: string }): Promise<void> {
    const now = new Date()
    await execute(
      `INSERT INTO cities (id, country_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE country_id = VALUES(country_id), name = VALUES(name), updated_at = VALUES(updated_at)`,
      [data.id, data.country_id, data.name, now, now]
    )
  }

  async upsertGeographicArea(data: {
    id: string
    name: string
    definition: Record<string, unknown>
    enabled?: boolean
  }): Promise<void> {
    const now = new Date()
    const enabled = data.enabled ?? 1
    await execute(
      `INSERT INTO geographic_areas (id, name, definition, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), definition = VALUES(definition), enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [data.id, data.name, JSON.stringify(data.definition), enabled, now, now]
    )
  }

  async linkSourceGeographicArea(data: {
    source_id: string
    geographic_area_id: string
    enabled?: boolean
  }): Promise<void> {
    const now = new Date()
    const enabled = data.enabled ?? 1
    await execute(
      `INSERT INTO source_geographic_areas (source_id, geographic_area_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [data.source_id, data.geographic_area_id, enabled, now, now]
    )
  }

  async unlinkSourceGeographicArea(sourceId: string, geographicAreaId: string): Promise<void> {
    await execute(
      `DELETE FROM source_geographic_areas WHERE source_id = ? AND geographic_area_id = ?`,
      [sourceId, geographicAreaId]
    )
  }

  async getSource(id: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM sources WHERE id = ?`, [id])
    return rows.length ? rows[0] : null
  }

  async listGeographicAreas(): Promise<any[]> {
    return query<any>(`SELECT * FROM geographic_areas ORDER BY name ASC`)
  }

  async getGeographicArea(id: string): Promise<any | null> {
    const rows = await query<any>(`SELECT * FROM geographic_areas WHERE id = ?`, [id])
    return rows.length ? rows[0] : null
  }

  async deleteGeographicArea(id: string): Promise<void> {
    await execute(`DELETE FROM geographic_areas WHERE id = ?`, [id])
  }

  async listSourceAreas(sourceId?: string): Promise<any[]> {
    if (sourceId) {
      return query<any>(`
        SELECT sga.source_id, s.name AS source_name,
               sga.geographic_area_id, ga.name AS area_name, ga.definition AS area_definition,
               sga.enabled, sga.last_run_at, sga.next_run_at
        FROM source_geographic_areas sga
        JOIN sources s ON s.id = sga.source_id
        JOIN geographic_areas ga ON ga.id = sga.geographic_area_id
        WHERE sga.source_id = ?
        ORDER BY ga.name ASC
      `, [sourceId])
    }
    return query<any>(`
      SELECT sga.source_id, s.name AS source_name,
             sga.geographic_area_id, ga.name AS area_name, ga.definition AS area_definition,
             sga.enabled, sga.last_run_at, sga.next_run_at
      FROM source_geographic_areas sga
      JOIN sources s ON s.id = sga.source_id
      JOIN geographic_areas ga ON ga.id = sga.geographic_area_id
      ORDER BY s.name ASC, ga.name ASC
    `)
  }

  // ── User interests (categories) ──
  async listUserCategories(userId: string): Promise<any[]> {
    return query<any>(`
      SELECT c.id, c.name, c.slug, c.description, uc.enabled, uc.created_at
      FROM user_categories uc
      JOIN categories c ON c.id = uc.category_id
      WHERE uc.user_id = ? AND uc.enabled = 1
      ORDER BY c.name ASC
    `, [userId])
  }

  async createUserCategory(userId: string, categoryId: string): Promise<void> {
    const now = new Date()
    await execute(
      `INSERT INTO user_categories (user_id, category_id, enabled, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [userId, categoryId, now, now]
    )
  }

  async deleteUserCategory(userId: string, categoryId: string): Promise<void> {
    await execute(
      `DELETE FROM user_categories WHERE user_id = ? AND category_id = ?`,
      [userId, categoryId]
    )
  }

  // ── Keywords ──
  async listKeywords(enabledOnly?: boolean): Promise<any[]> {
    const where = enabledOnly ? 'WHERE enabled = 1' : ''
    return query<any>(`SELECT * FROM keywords ${where} ORDER BY name ASC`)
  }

  async upsertKeyword(data: { id: string; name: string; slug: string; category_id?: string | null; enabled?: boolean }): Promise<void> {
    const now = new Date()
    const enabled = data.enabled ?? 1
    await execute(
      `INSERT INTO keywords (id, name, slug, category_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), slug = VALUES(slug),
         category_id = VALUES(category_id), enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [data.id, data.name, data.slug, data.category_id ?? null, enabled, now, now]
    )
  }

  async deleteKeyword(id: string): Promise<void> {
    await execute(`DELETE FROM keywords WHERE id = ?`, [id])
  }

  // ── Category ↔ Keyword links ──
  async listCategoryKeywords(categoryId: string): Promise<any[]> {
    return query<any>(`
      SELECT k.id, k.name, k.slug, ck.weight, ck.enabled
      FROM category_keywords ck
      JOIN keywords k ON k.id = ck.keyword_id
      WHERE ck.category_id = ?
      ORDER BY k.name ASC
    `, [categoryId])
  }

  async upsertCategoryKeyword(data: {
    category_id: string
    keyword_id: string
    weight?: number | null
    enabled?: boolean
  }): Promise<void> {
    const now = new Date()
    const weight = data.weight ?? null
    const enabled = data.enabled ?? 1
    await execute(
      `INSERT INTO category_keywords (category_id, keyword_id, weight, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE weight = VALUES(weight), enabled = VALUES(enabled), updated_at = VALUES(updated_at)`,
      [data.category_id, data.keyword_id, weight, enabled, now, now]
    )
  }

  async deleteCategoryKeyword(categoryId: string, keywordId: string): Promise<void> {
    await execute(
      `DELETE FROM category_keywords WHERE category_id = ? AND keyword_id = ?`,
      [categoryId, keywordId]
    )
  }

  // ── Unified keyword resolution for proactive fetch ──
  async listActiveUnifiedKeywords(): Promise<string[]> {
    const rows = await query<any>(`
      SELECT DISTINCT k.name AS keyword
      FROM user_categories uc
      JOIN category_keywords ck ON ck.category_id = uc.category_id
      JOIN keywords k ON k.id = ck.keyword_id AND k.enabled = 1
      WHERE uc.enabled = 1
      ORDER BY k.name ASC
    `)
    return rows.map((r: any) => r.keyword)
  }
}

export default JobRepository
