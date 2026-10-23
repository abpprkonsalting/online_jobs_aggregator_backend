import { Router } from 'express'
import { publicVersionMetadata } from '../utils/version'

const router = Router()

router.get('/', (_req, res) => {
  res.json(publicVersionMetadata())
})

export default router
