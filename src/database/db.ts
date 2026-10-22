import { createPool, type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise'
import { getConfig } from '../config'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    const config = getConfig()
    pool = createPool({
      uri: config.databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 5,
      idleTimeout: 60000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    })
  }
  return pool as Pool
}

export async function query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<T> {
  const [rows] = await getPool().query<T>(sql, params)
  return rows
}

export async function execute(sql: string, params?: unknown[]): Promise<ResultSetHeader> {
  const [result] = await getPool().query<ResultSetHeader>(sql, params)
  return result as ResultSetHeader
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}