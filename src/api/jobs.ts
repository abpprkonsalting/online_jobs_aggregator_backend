import { Router, Request, Response } from 'express'
import { JobRepository } from '../persistence/JobRepository'

const router = Router()
const repo = new JobRepository()

router.get('/', async (_req: Request, res: Response) => {
  const jobs = await repo.findJobs()
  res.json(jobs)
})

router.get('/:id', async (req: Request, res: Response) => {
  const job = await repo.getJobDetails(req.params.id)
  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json(job)
})

export default router
