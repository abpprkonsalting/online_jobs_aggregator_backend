import { Router, Request, Response } from 'express'
import { body, param, query, validationResult } from 'express-validator'
import { requireRole } from '../middleware/auth'
import { createJobRepository } from '../database/db'

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

// ── Sources CRUD ──
router.get('/sources', async (_req: Request, res: Response) => {
  const sources = await repo.listSources()
  res.json(sources)
})

router.post(
  '/sources',
  requireRole('admin'),
  [
    body('name').isString().notEmpty(),
    body('type').isIn(['api', 'scrape', 'hybrid']),
    body('working_mode').optional().isIn(['passive', 'proactive', 'both']),
    body('config').isObject(),
    body('enabled').optional().isBoolean(),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { name, type, config, enabled, working_mode } = req.body
    const id = crypto.randomUUID()
    await repo.upsertSource({ id, name, type, config, enabled, working_mode })
    const source = await repo.getSource(id)
    res.status(201).json(source)
  }
)

router.patch(
  '/sources/:id',
  requireRole('admin'),
  [
    param('id').isUUID(),
    body('name').optional().isString(),
    body('working_mode').optional().isIn(['passive', 'proactive', 'both']),
    body('enabled').optional().isBoolean(),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { id } = req.params
    const source = await repo.getSource(id)
    if (!source) {
      res.status(404).json({ error: 'Source not found' })
      return
    }
    await repo.upsertSource({
      id,
      name: req.body.name ?? source.name,
      type: source.type,
      working_mode: req.body.working_mode ?? source.working_mode,
      config: req.body.config ?? source.config,
      enabled: req.body.enabled ?? source.enabled,
    })
    res.json(await repo.getSource(id))
  }
)

router.delete(
  '/sources/:id',
  requireRole('admin'),
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    await repo.deleteSource(req.params.id)
    res.json({ success: true })
  }
)

// ── Geographic Areas CRUD ──
router.get('/geographic-areas', async (_req: Request, res: Response) => {
  const areas = await repo.listGeographicAreas()
  res.json(areas)
})

router.post(
  '/geographic-areas',
  requireRole('admin'),
  [
    body('name').isString().notEmpty(),
    body('definition').isObject(),
    body('enabled').optional().isBoolean(),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { name, definition, enabled } = req.body
    const id = crypto.randomUUID()
    await repo.upsertGeographicArea({ id, name, definition, enabled })
    const area = await repo.getGeographicArea(id)
    res.status(201).json(area)
  }
)

router.put(
  '/geographic-areas/:id',
  requireRole('admin'),
  [param('id').isUUID(), body('name').optional().isString(), body('definition').optional().isObject()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { id } = req.params
    const area = await repo.getGeographicArea(id)
    if (!area) {
      res.status(404).json({ error: 'Geographic area not found' })
      return
    }
    await repo.upsertGeographicArea({
      id,
      name: req.body.name ?? area.name,
      definition: req.body.definition ?? area.definition,
      enabled: req.body.enabled ?? area.enabled,
    })
    res.json(await repo.getGeographicArea(id))
  }
)

router.delete(
  '/geographic-areas/:id',
  requireRole('admin'),
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    await repo.deleteGeographicArea(req.params.id)
    res.json({ success: true })
  }
)

// ── Source ↔ Area links ──
router.get('/areas', async (_req: Request, res: Response) => {
  const areas = await repo.listSourceAreas()
  res.json(areas)
})

router.post(
  '/areas',
  requireRole('admin'),
  [
    body('source_id').isUUID(),
    body('geographic_area_id').isUUID(),
    body('enabled').optional().isBoolean(),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { source_id, geographic_area_id, enabled } = req.body
    await repo.linkSourceGeographicArea({ source_id, geographic_area_id, enabled })
    res.status(201).json({ source_id, geographic_area_id, enabled: enabled ?? true })
  }
)

router.delete(
  '/areas/:source_id/:area_id',
  requireRole('admin'),
  [param('source_id').isUUID(), param('area_id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    await repo.unlinkSourceGeographicArea(req.params.source_id, req.params.area_id)
    res.json({ success: true })
  }
)

// ── Fetch runs ──
router.get(
  '/fetch-runs',
  [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100)
    const offset = parseInt(req.query.offset as string) || 0
    const runs = await repo.listFetchRuns(undefined, limit, offset)
    res.json(runs)
  }
)

export default router
