import { Router, Request, Response } from 'express'
import { JobRepository } from '../persistence/JobRepository'

const router = Router()
const repo = new JobRepository()

router.get('/', async (_req: Request, res: Response) => {
  const users = await repo.listUsers()
  res.json(users)
})

export default router
