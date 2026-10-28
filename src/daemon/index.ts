import { ensureDatabase, seedAdminUser, closeDbPool } from '../database/migrations'
import { getConfig } from '../config'
import { getOrchestrator } from '../orchestrator/JobOrchestrator'
import { logger } from '../utils/logger'
import { versionLogFields } from '../utils/version'

async function main() {
  const config = getConfig()

  logger.info('Fetcher service starting', {
    ...versionLogFields('map-rezi-fetcher'),
    nodeEnv: config.nodeEnv,
    port: config.port,
    dbDialect: config.dbDialect,
    enabledSources: config.enabledSources,
  })

  await ensureDatabase()
  await seedAdminUser(config.adminEmail, config.adminPassword, 'admin')

  const orchestrator = getOrchestrator()

  // Graceful shutdown on signals
  const signals = ['SIGINT', 'SIGTERM'] as const
  for (const sig of signals) {
    process.on(sig, async () => {
      logger.info(`Received ${sig}, shutting down gracefully...`)
  try {
    await orchestrator.stop()
    await closeDbPool()
    logger.info('Daemon shut down cleanly')
    process.exit(0)
  } catch (err) {
    logger.error('Error during shutdown', { error: (err as Error).message })
    process.exit(1)
  }
    })
  }

  await orchestrator.start()
}

main().catch((e) => {
  logger.error('Daemon failed', { error: (e as Error).message })
  process.exit(1)
})
