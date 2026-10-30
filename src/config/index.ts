import dotenv from 'dotenv'

dotenv.config()

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (Number.isNaN(n)) throw new Error(`Invalid numeric value for ${name}: ${raw}`)
  return n
}

function strList(name: string): string[] {
  const raw = process.env[name] ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

interface Config {
  nodeEnv: string
  port: number
  databaseUrl: string
  dbDialect: 'mysql' | 'sqlite'
  sourcesConfigPath: string
  enabledSources: string[]
  pollIntervalMs: number
  maxRetries: number
  retryDelayMs: number
  apiTimeoutMs: number
  fetchTimeoutMs: number
  stalledThresholdMs: number
  logLevel: string
  logDir: string
  loggers: string[]
  cacheDir: string
  jwtSecret: string
  jwtAccessExpiresIn: string
  jwtRefreshExpiresIn: string
  cookieDomain: string
  adminEmail: string
  adminPassword: string
  dbPoolLimit: number
  googleMapsApiKey: string
  notificationChannels: string[]
  smtpHost: string
  smtpPort: number
  smtpUsername: string
  smtpPassword: string
  smtpFromEmail: string
  openAiApiKey: string
  aiDedupProvider: string
  aiDedupModel: string
}

let cachedConfig: Config | null = null

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig

  cachedConfig = {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: num('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    dbDialect: (process.env.DB_DIALECT ?? 'mysql') as 'mysql' | 'sqlite',
    sourcesConfigPath: process.env.SOURCES_CONFIG_PATH ?? './config/sources.json',
    enabledSources: strList('ENABLED_SOURCES'),
    pollIntervalMs: num('POLL_INTERVAL_MS', 5000),
    maxRetries: num('MAX_RETRIES', 3),
    retryDelayMs: num('RETRY_DELAY_MS', 60000),
    apiTimeoutMs: num('API_TIMEOUT_MS', 30000),
    fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 1800000),
    stalledThresholdMs: num('STALLED_THRESHOLD_MS', 3600000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    logDir: process.env.LOG_DIR ?? './logs',
    loggers: strList('LOGGERS'),
    cacheDir: process.env.CACHE_DIR ?? './cache',
    jwtSecret: required('JWT_SECRET'),
    jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
    cookieDomain: process.env.COOKIE_DOMAIN ?? '',
    adminEmail: required('ADMIN_EMAIL'),
    adminPassword: required('ADMIN_PASSWORD'),
    dbPoolLimit: num('DB_POOL_LIMIT', 10),
    googleMapsApiKey: required('GOOGLE_MAPS_API_KEY'),
    notificationChannels: (process.env.NOTIFICATION_CHANNELS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    smtpPort: num('SMTP_PORT', 465),
    smtpUsername: process.env.SMTP_USERNAME ?? '',
    smtpPassword: process.env.SMTP_PASSWORD ?? '',
    smtpFromEmail: process.env.SMTP_FROM_EMAIL ?? '',
    openAiApiKey: process.env.OPENAI_API_KEY ?? '',
    aiDedupProvider: process.env.AI_DEDUP_PROVIDER ?? 'openai',
    aiDedupModel: process.env.AI_DEDUP_MODEL ?? 'gpt-4o-mini',
  }
  return cachedConfig
}

export type { Config }
