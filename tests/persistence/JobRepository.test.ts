import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IDbDriver, IDbConnection, QueryResult } from '../../src/database/IDbDriver'
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise'

// Mock in-memory driver for testing
class MockConnection implements IDbConnection {
  async query<T extends RowDataPacket[]>(_sql: string, _params?: unknown[]): Promise<QueryResult<T>> {
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

vi.mock('../../src/database/db', () => ({
  getDriver: () => mockDriver,
  createJobRepository: () => new (require('../../src/persistence/JobRepository')).JobRepository(mockDriver),
}))

import { JobRepository } from '../../src/persistence/JobRepository'

describe('JobRepository persistence contracts', () => {
  let repo: JobRepository

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new JobRepository(mockDriver)
  })

  it('updates an existing job using its persisted id and parameterized values', async () => {
    vi.spyOn(mockDriver, 'query').mockResolvedValueOnce({ rows: [{ id: 'existing-job', content_hash: null }], fields: [] })
    vi.spyOn(mockDriver, 'execute').mockResolvedValue({ affectedRows: 1, insertId: 'existing-job', info: '', serverStatus: 2, warningStatus: 0, changedRows: 0 })
    
    const job = {
      id: 'new-generated-id',
      source_id: 'source-1',
      external_id: 'external-1',
      title: 'Updated title',
      job_url: 'https://jobs.example.test/1',
      raw_data: { fixture: true },
    }

    await expect(repo.upsertJob(job)).resolves.toEqual({ id: 'existing-job', isNew: false })
  })

  it('inserts a new job with serialized raw data and reports the generated id', async () => {
    vi.spyOn(mockDriver, 'query').mockResolvedValueOnce({ rows: [], fields: [] })
    vi.spyOn(mockDriver, 'execute').mockResolvedValue({ affectedRows: 1, insertId: 'new-job', info: '', serverStatus: 2, warningStatus: 0, changedRows: 0 })
    
    const job = {
      id: 'new-job',
      source_id: 'source-1',
      external_id: 'external-1',
      title: 'New Job',
      job_url: 'https://jobs.example.test/2',
      raw_data: { fixture: true },
    }

    await expect(repo.upsertJob(job)).resolves.toEqual({ id: 'new-job', isNew: true })
  })
})