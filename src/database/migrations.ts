import { Pool } from 'mysql2/promise'
import { query } from './db'

export async function ensureDatabase(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      is_active TINYINT(1) DEFAULT 1,
      last_login_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
  ]
  for (const sql of statements) {
    await query(sql)
  }
}

export async function seedAdminUser(
  email: string,
  password: string,
  role: 'admin' | 'user' = 'admin'
): Promise<void> {
  const { hashPassword } = await import('../utils/auth')
  const JobRepository = (await import('../persistence/JobRepository')).default
  const repo = new JobRepository()
  const existing = await repo.getUserByEmail(email)
  if (existing) return
  const hash = await hashPassword(password)
  await repo.createUser(email, hash, role)
}

export async function ensureDbPool(): Promise<Pool> {
  const { getPool } = await import('./db')
  return getPool()
}

export async function closeDbPool(): Promise<void> {
  const { closePool } = await import('./db')
  return closePool()
}

const migrations = { ensureDatabase, seedAdminUser, ensureDbPool, closeDbPool }
export default migrations
