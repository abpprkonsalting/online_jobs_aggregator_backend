import { createPool, Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { IDbDriver, IDbConnection, QueryResult } from './IDbDriver'

class MySqlConnection implements IDbConnection {
  constructor(private conn: PoolConnection) {}

  async query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const [rows, fields] = await this.conn.query<T>(sql, params)
    return { rows, fields }
  }

  async execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
    const [result] = await this.conn.query<ResultSetHeader>(sql, params)
    return result as ResultSetHeader
  }

  async beginTransaction(): Promise<void> {
    await this.conn.beginTransaction()
  }

  async commit(): Promise<void> {
    await this.conn.commit()
  }

  async rollback(): Promise<void> {
    await this.conn.rollback()
  }

  async release(): Promise<void> {
    this.conn.release()
  }
}

export class MySqlDriver implements IDbDriver {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async getConnection(): Promise<IDbConnection> {
    const conn = await this.pool.getConnection()
    return new MySqlConnection(conn)
  }

  async query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const [rows, fields] = await this.pool.query<T>(sql, params)
    return { rows, fields }
  }

  async execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
    const [result] = await this.pool.query<ResultSetHeader>(sql, params)
    return result as ResultSetHeader
  }

  async transaction<T>(fn: (conn: IDbConnection) => Promise<T>): Promise<T> {
    const conn = await this.getConnection()
    try {
      await conn.beginTransaction()
      const result = await fn(conn)
      await conn.commit()
      return result
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      await conn.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  getPoolStats(): { total: number; idle: number; active: number } {
    const total = this.pool.config.connectionLimit ?? 10
    return { total, idle: 0, active: 0 }
  }
}

export function createMySqlDriver(pool: Pool): IDbDriver {
  return new MySqlDriver(pool)
}