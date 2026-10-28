import { Router, Request, Response } from 'express'
import { body, query, validationResult } from 'express-validator'
import { AuthRequest, requireAuthStrict } from '../middleware/auth'
import { createJobRepository } from '../database/db'
import { getOrchestrator } from '../orchestrator/JobOrchestrator'
import { logger } from '../utils/logger'

const router = Router()
const repo = createJobRepository()

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
    query('category').optional().isUUID(),
    query('skill').optional().isUUID(),
    query('city_id').optional().isUUID(),
    query('country_id').optional().isUUID(),
    query('source_id').optional().isUUID(),
    query('allow_remote').optional().isBoolean(),
    query('salary_min').optional().isNumeric(),
    query('salary_max').optional().isNumeric(),
    query('organization').optional().isString(),
    query('location').optional().isString(),
  ],
  async (req: AuthRequest, res: Response) => {
    if (!validate(req, res)) return

    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const offset = parseInt(req.query.offset as string) || 0

    const sorts = parseMultiSort(
      req.query.sort as string | string[] | undefined,
      req.query.sortDir as string | string[] | undefined,
    )

    const allowedSortColumns = ['posted_at', 'date_posted', 'title', 'organization', 'salary_min', 'salary_max']
    for (const s of sorts) {
      if (!allowedSortColumns.includes(s.field)) {
        res.status(400).json({ errors: [{ msg: `Invalid sort field: ${s.field}` }] })
        return
      }
    }

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
    const location = req.query.location as string | undefined

    const result = await repo.findJobsWithFilters({
      limit,
      offset,
      sorts,
      categoryIds,
      skillIds,
      cityIds,
      countryIds,
      sourceId,
      allowRemote,
      salaryMin,
      salaryMax,
      organization,
      location,
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

router.post(
  '/search',
  requireAuthStrict,
  [
    body('query').optional().isString(),
    body('category_id').optional().isUUID(),
    body('city_id').optional().isUUID(),
    body('country_id').optional().isUUID(),
    body('limit').optional().isInt({ min: 1, max: 100 }),
    body('offset').optional().isInt({ min: 0 }),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() })
      return
    }

    const { query: searchQuery, category_id, city_id, country_id, limit, offset } = req.body
    const safeLimit = Math.min(limit ?? 20, 100)
    const safeOffset = offset ?? 0

    // Trigger proactive fetch for the search keyword(s)
    if (searchQuery && searchQuery.trim().length > 0) {
      const keywords = searchQuery.split(/[\s,]+).filter((k: string) => k.trim().length > 0)
      try {
        await getOrchestrator().runProactiveSearch(keywords)
      } catch (err) {
        // Non-fatal: proceed to return existing results even if fetch fails
        logger.warn('Proactive search fetch failed, returning existing results', {
          error: (err as Error).message,
        })
      }
    }

    // Parse multi-value IDs
    const parseIds = (val: string | string[] | undefined): string[] | undefined => {
      if (!val) return undefined
      const arr = Array.isArray(val) ? val : String(val).split(',')
      return arr.filter((v: string) => v.trim().length > 0)
    }

    const categoryIds = category_id ? [category_id] : undefined
    const cityIds = city_id ? [city_id] : undefined
    const countryIds = country_id ? [country_id] : undefined

    const result = await repo.findJobsWithFilters({
      limit: safeLimit,
      offset: safeOffset,
      categoryIds,
      cityIds,
      countryIds,
      search: searchQuery,
      userId: req.auth?.sub,
    })

    res.json({
      jobs: result.jobs,
      total: result.total,
      limit: safeLimit,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < result.total,
    })
  }
)

function parseMultiSort(sort: string | string[] | undefined, sortDir: string | string[] | undefined): Array<{ field: string; dir: 'asc' | 'desc' }> {
  const fields = sort === undefined || sort === '' ? [] : (Array.isArray(sort) ? sort : [String(sort)])
  const dirs = sortDir === undefined || sortDir === '' ? [] : (Array.isArray(sortDir) ? sortDir : [String(sortDir)])
  const result: Array<{ field: string; dir: 'asc' | 'desc' }> = []
  for (let i = 0; i < fields.length; i++) {
    const field = String(fields[i]).trim()
    if (!field) continue
    const dir = dirs[i] !== undefined ? String(dirs[i]).trim() : 'desc'
    result.push({ field, dir: dir === 'asc' ? 'asc' : 'desc' })
  }
  return result
}

router.get('/:id', async (req: Request, res: Response) => {
  const job = await repo.getJobWithDetails(req.params.id)
  if (!job) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json(job)
})

export default router