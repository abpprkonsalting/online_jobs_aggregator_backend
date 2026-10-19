import { Pool } from 'mysql2/promise'
import { query } from './db'

export async function ensureDatabase(): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sources (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      type ENUM('api','scrape','hybrid') NOT NULL,
      config JSON NOT NULL,
      enabled TINYINT(1) DEFAULT 1,
      last_run_at DATETIME NULL,
      next_run_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS geographic_areas (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      definition JSON NOT NULL,
      enabled TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS source_geographic_areas (
      source_id CHAR(36) NOT NULL,
      geographic_area_id CHAR(36) NOT NULL,
      enabled TINYINT(1) DEFAULT 1,
      last_run_at DATETIME NULL,
      next_run_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (source_id, geographic_area_id),
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      FOREIGN KEY (geographic_area_id) REFERENCES geographic_areas(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS fetch_runs (
      id CHAR(36) PRIMARY KEY,
      source_id CHAR(36) NULL,
      status ENUM('running','success','failed') NOT NULL,
      started_at DATETIME NOT NULL,
      finished_at DATETIME NULL,
      jobs_found INT DEFAULT 0,
      jobs_saved_new INT DEFAULT 0,
      jobs_saved_updated INT DEFAULT 0,
      error_message TEXT NULL,
      metadata JSON NULL,
      warnings JSON NULL,
      created_at DATETIME NOT NULL,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS countries (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      code VARCHAR(10) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cities (
      id CHAR(36) PRIMARY KEY,
      country_id CHAR(36) NOT NULL,
      name VARCHAR(150) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (country_id) REFERENCES countries(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS jobs (
      id CHAR(36) PRIMARY KEY,
      source_id CHAR(36) NOT NULL,
      external_id VARCHAR(100) NOT NULL,
      title VARCHAR(500) NOT NULL,
      organization VARCHAR(255) NULL,
      job_url TEXT NOT NULL,
      description_text LONGTEXT NULL,
      allow_remote TINYINT(1) NULL,
      salary_min DECIMAL(12,2) NULL,
      salary_max DECIMAL(12,2) NULL,
      salary_currency VARCHAR(10) NULL,
      salary_unit VARCHAR(50) NULL,
      date_posted DATETIME NULL,
      posted_at DATETIME NULL,
      raw_data JSON NULL,
      fetched_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
      UNIQUE KEY unique_source_external (source_id, external_id),
      INDEX idx_posted (posted_at, date_posted),
      INDEX idx_org_remote (organization, allow_remote)
    )`,
    `CREATE TABLE IF NOT EXISTS skills (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      description TEXT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS job_skills (
      job_id CHAR(36) NOT NULL,
      skill_id CHAR(36) NOT NULL,
      PRIMARY KEY (job_id, skill_id),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS job_categories (
      job_id CHAR(36) NOT NULL,
      category_id CHAR(36) NOT NULL,
      classification_confidence DECIMAL(3,2) NULL,
      PRIMARY KEY (job_id, category_id),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS locations (
      id CHAR(36) PRIMARY KEY,
      job_id CHAR(36) NOT NULL,
      city_id CHAR(36) NULL,
      raw_text VARCHAR(255) NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (city_id) REFERENCES cities(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','user') NOT NULL DEFAULT 'user',
      is_active TINYINT(1) DEFAULT 1,
      last_login_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      INDEX idx_users_email (email)
    )`,
    `CREATE TABLE IF NOT EXISTS refresh_tokens (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
