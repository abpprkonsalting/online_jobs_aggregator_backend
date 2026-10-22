import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, hashPassword, getUserByEmail, createUser } = vi.hoisted(() => ({
  query: vi.fn(),
  hashPassword: vi.fn(),
  getUserByEmail: vi.fn(),
  createUser: vi.fn(),
}))

vi.mock('../../src/database/db', () => ({ query }))
vi.mock('../../src/utils/auth', () => ({ hashPassword }))
vi.mock('../../src/persistence/JobRepository', () => ({
  default: class {
    getUserByEmail = getUserByEmail
    createUser = createUser
  },
}))

import { ensureDatabase, seedAdminUser } from '../../src/database/migrations'

describe('database initialization and admin seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.COLUMNS')) return []
      return []
    })
    hashPassword.mockResolvedValue('hashed-password')
    getUserByEmail.mockResolvedValue(null)
    createUser.mockResolvedValue('admin-1')
  })

  it('creates schema tables and adds working_mode when the migration is absent', async () => {
    await ensureDatabase()

    const sqlStatements = query.mock.calls.map(([sql]) => String(sql))
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS sources'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS job_categories'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS category_keywords'))).toBe(true)
    expect(sqlStatements).toContain(
      "ALTER TABLE sources ADD COLUMN working_mode ENUM('passive','proactive','both') NOT NULL DEFAULT 'both' AFTER type",
    )
  })

  it('does not add working_mode a second time when the column already exists', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.COLUMNS')) return [{ COLUMN_NAME: 'working_mode' }]
      return []
    })

    await ensureDatabase()

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('ALTER TABLE sources'))).toBe(false)
  })

  it('does not re-create an admin account that already exists', async () => {
    getUserByEmail.mockResolvedValue({ id: 'admin-existing' })

    await seedAdminUser('admin@example.test', 'password')

    expect(getUserByEmail).toHaveBeenCalledWith('admin@example.test')
    expect(hashPassword).not.toHaveBeenCalled()
    expect(createUser).not.toHaveBeenCalled()
  })

  it('hashes and creates the configured admin when it is missing', async () => {
    await seedAdminUser('admin@example.test', 'secure-password', 'admin')

    expect(hashPassword).toHaveBeenCalledWith('secure-password')
    expect(createUser).toHaveBeenCalledWith('admin@example.test', 'hashed-password', 'admin')
  })
})
