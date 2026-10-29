import { Pool } from 'mysql2/promise'
import { getDriver } from './db'

export async function ensureDatabase(): Promise<void> {
  const driver = getDriver()
  const statements = [
    `CREATE TABLE IF NOT EXISTS sources (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      code_id VARCHAR(100) UNIQUE NULL,
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
      updated_at DATETIME NOT NULL,
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
      content_hash CHAR(64) NULL,
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
    `CREATE TABLE IF NOT EXISTS keywords (
      id CHAR(36) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      category_id CHAR(36) NULL,
      enabled TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS category_keywords (
      category_id CHAR(36) NOT NULL,
      keyword_id CHAR(36) NOT NULL,
      weight DECIMAL(3,2) NULL,
      enabled TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (category_id, keyword_id),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
      FOREIGN KEY (keyword_id) REFERENCES keywords(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS user_categories (
      user_id CHAR(36) NOT NULL,
      category_id CHAR(36) NOT NULL,
      enabled TINYINT(1) DEFAULT 1,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (user_id, category_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS saved_jobs (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      job_id CHAR(36) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'saved',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      UNIQUE KEY unique_user_job (user_id, job_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    )`
  ]

  for (const sql of statements) {
    await driver.query(sql)
  }

  // Add content_hash column to jobs table if missing
  const existingHashCols = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'jobs' AND COLUMN_NAME = 'content_hash'
  `)
  if (existingHashCols.rows.length === 0) {
    await driver.query(`ALTER TABLE jobs ADD COLUMN content_hash CHAR(64) NULL AFTER fetched_at`)
  }

  // Add working_mode column if missing (idempotent: MySQL has no ADD COLUMN IF NOT EXISTS)
  const existingCols = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sources' AND COLUMN_NAME = 'working_mode'
  `)
  if (existingCols.rows.length === 0) {
    await driver.query(`ALTER TABLE sources ADD COLUMN working_mode ENUM('passive','proactive','both') NOT NULL DEFAULT 'both' AFTER type`)
  }

  const existingCodeIdCol = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sources' AND COLUMN_NAME = 'code_id'
  `)
  if (existingCodeIdCol.rows.length === 0) {
    await driver.query(`ALTER TABLE sources ADD COLUMN code_id VARCHAR(100) UNIQUE NULL AFTER name`)
  }

  // Add enabled and updated_at columns to category_keywords if missing
  const existingEnabledCol = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'category_keywords' AND COLUMN_NAME = 'enabled'
  `)
  if (existingEnabledCol.rows.length === 0) {
    await driver.query(`ALTER TABLE category_keywords ADD COLUMN enabled TINYINT(1) DEFAULT 1 AFTER weight`)
  }
  const existingUpdatedAtCol = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'category_keywords' AND COLUMN_NAME = 'updated_at'
  `)
  if (existingUpdatedAtCol.rows.length === 0) {
    await driver.query(`ALTER TABLE category_keywords ADD COLUMN updated_at DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00' AFTER created_at`)
  }

  const existingActiveTokenCol = await driver.query<any>(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND COLUMN_NAME = 'active_token'
  `)
  if (existingActiveTokenCol.rows.length === 0) {
    await driver.query(`ALTER TABLE refresh_tokens ADD COLUMN active_token CHAR(36) NULL`)
    await driver.query(`UPDATE refresh_tokens SET active_token = user_id WHERE revoked_at IS NULL`)
  }

  const existingActiveTokenIdx = await driver.query<any>(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'refresh_tokens' AND INDEX_NAME = 'idx_refresh_tokens_active_token'
  `)
  if (existingActiveTokenIdx.rows.length === 0) {
    await driver.query(`ALTER TABLE refresh_tokens ADD UNIQUE INDEX idx_refresh_tokens_active_token (active_token)`)
  }

  // Add measured indexes for query performance (idempotent)
  const indexDefinitions: Array<{ table: string; name: string; columns: string }> = [
    // fetch_runs: admin list with source_id filter + created_at ordering
    { table: 'fetch_runs', name: 'idx_fetch_runs_source_created', columns: 'source_id, created_at DESC' },
    { table: 'fetch_runs', name: 'idx_fetch_runs_created', columns: 'created_at DESC' },
    // jobs: organization filter (idx_org_remote is composite, may not be used for organization alone)
    { table: 'jobs', name: 'idx_jobs_organization', columns: 'organization' },
    // jobs: salary range filters
    { table: 'jobs', name: 'idx_jobs_salary_min', columns: 'salary_min' },
    { table: 'jobs', name: 'idx_jobs_salary_max', columns: 'salary_max' },
    // jobs: allow_remote filter (idx_org_remote is composite)
    { table: 'jobs', name: 'idx_jobs_allow_remote', columns: 'allow_remote' },
  ]

  for (const idx of indexDefinitions) {
    const existingIdx = await driver.query<any>(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
    `, [idx.table, idx.name])
    if (existingIdx.rows.length === 0) {
      await driver.query(`ALTER TABLE \`${idx.table}\` ADD INDEX \`${idx.name}\` (${idx.columns})`)
    }
  }
}

export async function seedAdminUser(
  email: string,
  password: string,
  role: 'admin' | 'user' = 'admin'
): Promise<void> {
  const { hashPassword } = await import('../utils/auth')
  const { createJobRepository } = await import('../database/db')
  const repo = createJobRepository()
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
