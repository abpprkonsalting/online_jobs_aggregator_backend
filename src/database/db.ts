import { createPool, type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise'
import { getConfig } from '../config'
import type { IDbDriver } from './IDbDriver'
import { MySqlDriver } from './MySqlDriver'
import { JobRepository } from '../persistence/JobRepository'

let pool: Pool | null = null
let driver: IDbDriver | null = null

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig()
    pool = createPool({
      uri: config.databaseUrl,
      waitForConnections: true,
      connectionLimit: config.dbPoolLimit,
      maxIdle: Math.min(5, config.dbPoolLimit),
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    })
  }
  return pool as Pool
}

export function getDriver(): IDbDriver {
  if (!driver) {
    driver = new MySqlDriver(getPool())
  }
  return driver
}

export async function query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<T> {
  const { rows } = await getDriver().query<T>(sql, params)
  return rows
}

export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  return getDriver().execute(sql, params)
}

export async function transaction<T>(fn: (conn: any) => Promise<T>): Promise<T> {
  return getDriver().transaction(fn)
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
  driver = null
}

export function createJobRepository(): JobRepository {
  return new JobRepository(getDriver())
}