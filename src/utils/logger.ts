import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import type { Logger, LogLevel } from './logger.types'

// Ensure env vars (LOG_LEVEL, LOG_DIR, LOGGERS) are available regardless of import order.
// dotenv.config() is idempotent and never overwrites already-set environment variables.
dotenv.config()

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

function timestamp(): string {
  return new Date().toISOString()
}

function logDir(): string {
  return process.env.LOG_DIR ?? './logs'
}

function logFilePath(): string {
  return path.join(logDir(), 'app.log')
}

function ensureLogDir(): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true })
  } catch {
    // Best effort; file writes will surface as errors if the dir cannot be created.
  }
}

function appendToFile(line: string): void {
  try {
    ensureLogDir()
    fs.appendFileSync(logFilePath(), line + '\n')
  } catch (err) {
    // Avoid recursing into the logger; fall back to stderr so the failure is visible.
    process.stderr.write(`[log file write failed] ${(err as Error).message}\n`)
  }
}

function logTargets(): string[] {
  const raw = process.env.LOGGERS ?? ''
  let targets: string[]
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      targets = parsed.map((v) => String(v))
    } else {
      targets = [String(parsed)]
    }
  } catch {
    targets = raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return targets.length > 0 ? targets : ['console']
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

class FileLogger implements Logger {
  private readonly level: LogLevel
  private readonly file: string

  constructor(level?: LogLevel) {
    this.level = level ?? levelFromEnv()
    this.file = logFilePath()
    ensureLogDir()
  }

  child(_meta: Record<string, unknown>): Logger {
    return this
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return
    const line = `[${timestamp()}] [${level}]${message}${formatMeta(meta)}`
    appendToFile(line)
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta)
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta)
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta)
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta)
  }
}

class MultiLogger implements Logger {
  private readonly loggers: Logger[]

  constructor(loggers: Logger[]) {
    this.loggers = loggers
  }

  child(meta: Record<string, unknown>): Logger {
    return new MultiLogger(this.loggers.map((l) => l.child(meta)))
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.loggers.forEach((l) => l.debug(message, meta))
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.loggers.forEach((l) => l.info(message, meta))
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.loggers.forEach((l) => l.warn(message, meta))
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.loggers.forEach((l) => l.error(message, meta))
  }
}

function buildLogger(): Logger {
  const targets = logTargets()
  const loggers: Logger[] = []
  for (const target of targets) {
    const name = target.toLowerCase()
    if (name === 'console' || name === 'stdout') {
      loggers.push(new ConsoleLogger())
    } else if (name === 'local' || name === 'file') {
      loggers.push(new FileLogger())
    }
  }
  if (loggers.length === 0) {
    loggers.push(new ConsoleLogger())
  }
  return loggers.length === 1 ? loggers[0] : new MultiLogger(loggers)
}

export const logger: Logger = buildLogger()
export type { LogLevel }
