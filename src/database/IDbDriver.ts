import { RowDataPacket, ResultSetHeader } from 'mysql2/promise'

export interface QueryResult<T extends RowDataPacket[]> {
  rows: T
  fields: any[]
}

export interface IDbConnection {
  query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  execute(sql: string, params?: unknown[]): Promise<ResultSetHeader>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): Promise<void>
}

export interface IDbDriver {
  getConnection(): Promise<IDbConnection>
  query<T extends RowDataPacket[]>(sql: string, params?: unknown[]): Promise<QueryResult<T>>
  execute(sql: string, params?: unknown[]): Promise<ResultSetHeader>
  transaction<T>(fn: (conn: IDbConnection) => Promise<T>): Promise<T>
  close(): Promise<void>
  getPoolStats(): { total: number; idle: number; active: number }
}