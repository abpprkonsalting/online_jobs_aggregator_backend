import { Router, Request, Response } from 'express'
import { query, validationResult } from 'express-validator'
import { JobRepository } from '../persistence/JobRepository'
import { AuthRequest } from '../middleware/auth'

const router = Router()
const repo = new JobRepository()

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() })
    return false
  }
  return true
}

router.get(
  '/',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    query('sort').optional().isIn(['posted_at', 'date_posted', 'title', 'organization', 'salary_min', 'salary_max']),
    query('sortDir').optional().isIn(['asc', 'desc']),
    query('category').optional().isString(),
    query('skill').optional().isString(),
    query('city_id').optional().isUUID(),
    query('country_id').optional().isUUID(),
    query('source_id').optional().isUUID(),
    query('allow_remote').optional().isBoolean(),
    query('salary_min').optional().isNumeric(),
    query('salary_max').optional().isNumeric(),
    query('organization').optional().isString(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (!validate(req, res)) return

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0
    const sort = (req.query.sort as string) || 'posted_at'
    const sortDir = (req.query.sortDir as string) || 'desc'

    const jobs = await repo.findJobs()

    let filtered = jobs
    if (req.auth) {
      const followedCategories = await repo.listUserCategories(req.auth.sub)
      if (followedCategories.length > 0) {
        const matchingJobIds = new Set(
          await repo.findJobIdsByCategories(followedCategories.map((category) => category.id)),
        )
        filtered = filtered.filter((job: any) => matchingJobIds.has(job.id))
      }
    }

    // Apply filters
    if (req.query.category) {
      // Would need job_categories join - simplified: return all for now
    }
    if (req.query.skill) {
      // Would need job_skills join
    }
    if (req.query.city_id) {
      // Would need locations join
    }
    if (req.query.country_id) {
      // Would need locations/cities join
    }
    if (req.query.source_id) {
      filtered = filtered.filter((j: any) => j.source_id === req.query.source_id)
    }
    if (req.query.allow_remote !== undefined) {
      const allowRemote = req.query.allow_remote === 'true'
      filtered = filtered.filter((j: any) => j.allow_remote === allowRemote)
    }
    if (req.query.salary_min) {
      const min = parseFloat(req.query.salary_min as string)
      filtered = filtered.filter((j: any) => j.salary_min != null && j.salary_min >= min)
    }
    if (req.query.salary_max) {
      const max = parseFloat(req.query.salary_max as string)
      filtered = filtered.filter((j: any) => j.salary_max != null && j.salary_max <= max)
    }
    if (req.query.organization) {
      const org = String(req.query.organization).toLowerCase()
      filtered = filtered.filter((j: any) => j.organization?.toLowerCase().includes(org))
    }

    // Sort
    filtered.sort((a: any, b: any) => {
      const av = a[sort]
      const bv = b[sort]
      if (av == null && bv == null) return 0
      if (av == null) return sortDir === 'asc' ? 1 : -1
      if (bv == null) return sortDir === 'asc' ? -1 : 1
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })

    // Paginate
    const total = filtered.length
    const page = filtered.slice(offset, offset + limit)

    res.json({
      jobs: page,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    })
  }
)

router.get('/:id', async (req: Request, res: Response) => {
  const job = await repo.getJobWithDetails(req.params.id)
  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json(job)
})

export default router
