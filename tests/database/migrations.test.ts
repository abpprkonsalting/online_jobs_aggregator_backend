import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDbDriver, IDbConnection, QueryResult } from '../../src/database/IDbDriver'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { JobRepository } from '../../src/persistence/JobRepository'

// Mock in-memory driver for testing
class MockConnection implements IDbConnection {
  async query<T extends RowDataPacket[]>(sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
    if (sql.includes('information_schema.COLUMNS')) {
      if (sql.includes('working_mode')) {
        return { rows: [] as T, fields: [] }  // working_mode doesn't exist
      }
      if (sql.includes('content_hash')) {
        return { rows: [] as T, fields: [] }  // content_hash doesn't exist
      }
      if (sql.includes('code_id')) {
        return { rows: [{ COLUMN_NAME: 'code_id' }] as T, fields: [] }  // code_id already exists
      }
    }
    return { rows: [] as T, fields: [] }
  }

  async execute(_sql: string, _params?: unknown[]): Promise<ResultSetHeader> {
    return { 
      affectedRows: 1, 
      insertId: 'mock-id', 
      info: '', 
      serverStatus: 2, 
      warningStatus: 0,
      changedRows: 0 
    } as ResultSetHeader
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
  async release(): Promise<void> {}
}

class MockDriver implements IDbDriver {
  private conn = new MockConnection()

  async getConnection(): Promise<IDbConnection> {
    return this.conn
  }

  async query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.conn.query(sql, params)
  }

  async execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
    return this.conn.execute(sql, params)
  }

  async transaction<T>(fn: (conn: IDbConnection) => Promise<T>): Promise<T> {
    return fn(this.conn)
  }

  async close(): Promise<void> {}

  getPoolStats(): { total: number; idle: number; active: number } {
    return { total: 10, idle: 10, active: 0 }
  }
}

const mockDriver = new MockDriver()

// Create a single mocked repo instance that will be returned by createJobRepository
const mockedRepo = new JobRepository(mockDriver)

vi.mock('../../src/database/db', () => ({
  getDriver: () => mockDriver,
  createJobRepository: () => mockedRepo,
}))

vi.mock('../../src/utils/auth', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
}))

import { ensureDatabase, seedAdminUser } from '../../src/database/migrations'
import { createJobRepository } from '../../src/database/db'
import { hashPassword } from '../../src/utils/auth'

describe('database initialization and admin seeding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset repo mocks
    vi.spyOn(mockedRepo, 'getUserByEmail').mockReset()
    vi.spyOn(mockedRepo, 'createUser').mockReset()
  })

  it('creates schema tables and adds working_mode when the migration is absent', async () => {
    const querySpy = vi.spyOn(mockDriver, 'query')
    await ensureDatabase()

    const sqlStatements = querySpy.mock.calls.map(([sql]) => String(sql))
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS sources'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS job_categories'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS category_keywords'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS notification_history'))).toBe(true)
    expect(sqlStatements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS job_source_aliases'))).toBe(true)
    expect(sqlStatements).toContain('ALTER TABLE users ADD COLUMN notification_opt_in TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active')
    expect(sqlStatements).toContain(
      "ALTER TABLE sources ADD COLUMN working_mode ENUM('passive','proactive','both') NOT NULL DEFAULT 'both' AFTER type",
    )
  })

  it('does not add working_mode a second time when the column already exists', async () => {
    vi.spyOn(mockDriver, 'query').mockImplementation(async (sql: string) => {
      if (sql.includes('information_schema.COLUMNS') && sql.includes('working_mode')) {
        return { rows: [{ COLUMN_NAME: 'working_mode' }], fields: [] }
      }
      if (sql.includes('information_schema.COLUMNS') && sql.includes('code_id')) {
        return { rows: [{ COLUMN_NAME: 'code_id' }], fields: [] }
      }
      return { rows: [], fields: [] }
    })

    await ensureDatabase()

    const querySpy = vi.spyOn(mockDriver, 'query')
    expect(querySpy.mock.calls.some(([sql]) => String(sql).startsWith('ALTER TABLE sources'))).toBe(false)
  })

  it('does not re-create an admin account that already exists', async () => {
    vi.spyOn(mockDriver, 'query').mockResolvedValueOnce({ rows: [{ id: 'admin-existing' }], fields: [] })
    vi.spyOn(mockedRepo, 'getUserByEmail').mockResolvedValue({ id: 'admin-existing' })

    await seedAdminUser('admin@example.test', 'password')

    expect(mockedRepo.getUserByEmail).toHaveBeenCalledWith('admin@example.test')
    expect(hashPassword).not.toHaveBeenCalled()
  })

  it('hashes and creates the configured admin when it is missing', async () => {
    vi.spyOn(mockDriver, 'query').mockResolvedValueOnce({ rows: [], fields: [] })
    vi.spyOn(mockedRepo, 'getUserByEmail').mockResolvedValue(null)
    const createUserSpy = vi.spyOn(mockedRepo, 'createUser').mockResolvedValue('admin-1')

    await seedAdminUser('admin@example.test', 'secure-password', 'admin')

    expect(mockedRepo.getUserByEmail).toHaveBeenCalledWith('admin@example.test')
    expect(hashPassword).toHaveBeenCalledWith('secure-password')
    expect(createUserSpy).toHaveBeenCalledWith('admin@example.test', 'hashed-password', 'admin')
  })
})
