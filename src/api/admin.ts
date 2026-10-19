import { Router, Request, Response } from 'express'
import { JobRepository } from '../persistence/JobRepository'

const router = Router()
const repo = new JobRepository()

router.get('/sources', async (_req: Request, res: Response) => {
  const sources = await repo.listSources()
  res.json(sources)
})

router.get('/fetch-runs', async (_req: Request, res: Response) => {
  const runs = await repo.listFetchRuns()
  res.json(runs)
})

export default router
