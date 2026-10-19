import { Router, Request, Response } from 'express'
import { JobRepository } from '../persistence/JobRepository'

const router = Router()
const repo = new JobRepository()

router.get('/schema', async (_req: Request, res: Response) => {
  const schema = await repo.getMasterSchema()
  res.json(schema)
})

export default router
