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
    query('category').optional().isUUID(),
    query('skill').optional().isUUID(),
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
    const sortDirRaw = (req.query.sortDir as string) || 'desc'
    const sortDir = sortDirRaw === 'asc' ? 'asc' : 'desc'

    // Parse comma-separated IDs for multi-value filters
    const parseIds = (val: string | string[] | undefined): string[] | undefined => {
      if (!val) return undefined
      const arr = Array.isArray(val) ? val : String(val).split(',')
      return arr.filter((v) => v.trim().length > 0)
    }

    const categoryIds = parseIds(req.query.category as string | string[] | undefined)
    const skillIds = parseIds(req.query.skill as string | string[] | undefined)
    const cityIds = parseIds(req.query.city_id as string | string[] | undefined)
    const countryIds = parseIds(req.query.country_id as string | string[] | undefined)
    const sourceId = req.query.source_id as string | undefined
    const allowRemoteRaw = req.query.allow_remote as string | undefined
    const allowRemote = allowRemoteRaw === 'true' ? true : allowRemoteRaw === 'false' ? false : undefined
    const salaryMin = req.query.salary_min ? parseFloat(req.query.salary_min as string) : undefined
    const salaryMax = req.query.salary_max ? parseFloat(req.query.salary_max as string) : undefined
    const organization = req.query.organization as string | undefined

    const result = await repo.findJobsWithFilters({
      limit,
      offset,
      sort,
      sortDir,
      categoryIds,
      skillIds,
      cityIds,
      countryIds,
      sourceId,
      allowRemote,
      salaryMin,
      salaryMax,
      organization,
      userId: req.auth?.sub,
    })

    res.json({
      jobs: result.jobs,
      total: result.total,
      limit,
      offset,
      hasMore: offset + limit < result.total,
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