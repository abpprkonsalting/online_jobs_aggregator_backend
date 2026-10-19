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
}

export default JobRepository
