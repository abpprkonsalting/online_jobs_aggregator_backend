import { Router } from 'express'

const router = Router()

router.get('/', async (_req, res) => {
  res.json({ status: 'ok', service: 'map-rezi-api', timestamp: new Date().toISOString() })
})

export default router
