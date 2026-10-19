import express from 'express'
import authRoutes from './auth'
import jobsRoutes from './jobs'
import usersRoutes from './users'
import adminRoutes from './admin'
import masterRoutes from './master'
import { requireAuthStrict, optionalAuth } from '../middleware/auth'
import { ensureDatabase, seedAdminUser } from '../database/migrations'
import { getConfig } from '../config'
import JobRepository from '../persistence/JobRepository'

const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const config = getConfig()

async function start() {
  await ensureDatabase()
  await seedAdminUser(config.adminEmail, config.adminPassword, 'admin')

  const skillsRouter = express.Router()
  skillsRouter.get('/', async (_req, res) => {
    const repo = new JobRepository()
    res.json(await repo.listSkills())
  })
  const citiesRouter = express.Router()
  citiesRouter.get('/', async (_req, res) => {
    const repo = new JobRepository()
    res.json(await repo.listCities())
  })
  const countriesRouter = express.Router()
  countriesRouter.get('/', async (_req, res) => {
    const repo = new JobRepository()
    res.json(await repo.listCountries())
  })
  const categoriesRouter = express.Router()
  categoriesRouter.get('/', async (_req, res) => {
    const repo = new JobRepository()
    res.json(await repo.listCategories())
  })

  app.use('/api/auth', authRoutes)
  app.use('/api/jobs', optionalAuth, jobsRoutes)
  app.use('/api/users', requireAuthStrict, usersRoutes)
  app.use('/api/admin', requireAuthStrict, adminRoutes)
  app.use('/api/master', requireAuthStrict, masterRoutes)
  app.use('/api/categories', optionalAuth, categoriesRouter)
  app.use('/api/skills', optionalAuth, skillsRouter)
  app.use('/api/cities', optionalAuth, citiesRouter)
  app.use('/api/countries', optionalAuth, countriesRouter)

  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`)
  })
}

start().catch((e) => {
  console.error('Failed to start server:', e)
  process.exit(1)
})
