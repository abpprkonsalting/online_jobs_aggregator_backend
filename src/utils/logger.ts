import type { Logger, LogLevel } from './logger.types'

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function levelFromEnv(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return v in LEVELS ? (v as LogLevel) : 'info'
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[levelFromEnv()]
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return ''
  return ` ${JSON.stringify(meta)}`
}

class ConsoleLogger implements Logger {
  private readonly level: LogLevel

  constructor(level?: LogLevel) {
    this.level = level ?? levelFromEnv()
  }

  child(_meta: Record<string, unknown>): Logger {
    return this
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('debug')) console.debug(`[debug]${message}${formatMeta(meta)}`)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('info')) console.info(`[info]${message}${formatMeta(meta)}`)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('warn')) console.warn(`[warn]${message}${formatMeta(meta)}`)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    if (shouldLog('error')) console.error(`[error]${message}${formatMeta(meta)}`)
  }
}

export const logger: Logger = new ConsoleLogger()
export type { LogLevel }
