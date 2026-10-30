import express from 'express'
import cookieParser from 'cookie-parser'
import authRoutes from './auth'
import jobsRoutes from './jobs'
import usersRoutes from './users'
import adminRoutes from './admin'
import masterRoutes from './master'
import versionRoutes from './version'
import healthRoutes from './health'
import geocodeRoutes from './geocode'
import { requireAuthStrict, requireRole } from '../middleware/auth'
import { ensureDatabase, seedAdminUser } from '../database/migrations'
import { getConfig } from '../config'
import { createJobRepository } from '../database/db'
import { logger } from '../utils/logger'
import { versionLogFields } from '../utils/version'

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())

const config = getConfig()

async function start() {
  logger.info('API service starting', versionLogFields('map-rezi-api'))
  await ensureDatabase()
  await seedAdminUser(config.adminEmail, config.adminPassword, 'admin')

  const repo = createJobRepository()

  const skillsRouter = express.Router()
  skillsRouter.get('/', async (_req, res) => {
    res.json(await repo.listSkills())
  })
  const citiesRouter = express.Router()
  citiesRouter.get('/', async (_req, res) => {
    res.json(await repo.listCities())
  })
  const countriesRouter = express.Router()
  countriesRouter.get('/', async (_req, res) => {
    res.json(await repo.listCountries())
  })
  const categoriesRouter = express.Router()
  categoriesRouter.get('/', async (_req, res) => {
    res.json(await repo.listCategories())
  })

  app.use('/api/auth', authRoutes)
  app.use('/version', versionRoutes)
  app.use('/api/version', versionRoutes)
  app.use('/api/jobs', requireAuthStrict, jobsRoutes)
  app.use('/api/users', requireAuthStrict, usersRoutes)
  app.use('/api/admin', requireAuthStrict, requireRole('admin'), adminRoutes)
  app.use('/api/master', requireAuthStrict, requireRole('admin'), masterRoutes)
  app.use('/api/categories', requireAuthStrict, categoriesRouter)
  app.use('/api/skills', requireAuthStrict, skillsRouter)
  app.use('/api/cities', requireAuthStrict, citiesRouter)
  app.use('/api/countries', requireAuthStrict, countriesRouter)
  app.use('/api/health', healthRoutes)
  app.use('/api/geocode', geocodeRoutes)

  app.listen(config.port, () => {
    logger.info('API server listening', { port: config.port })
  })
}

start().catch((e) => {
  logger.error('Failed to start server', { error: (e as Error).message })
  process.exit(1)
})
