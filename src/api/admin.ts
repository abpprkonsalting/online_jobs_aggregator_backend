import { Router, Request, Response } from 'express'
import { body, param, query, validationResult } from 'express-validator'
import { requireRole } from '../middleware/auth'
import { createJobRepository } from '../database/db'
import { getOrchestrator } from '../orchestrator/JobOrchestrator'
import { getConfig } from '../config'
import { createNotificationChannels } from '../services/notifications/channel-factory'
import { logger } from '../utils/logger'

const router = Router()
const repo = createJobRepository()

router.post(
  '/notifications/test',
  [body('email').isEmail().normalizeEmail()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return

    let channels
    try {
      channels = createNotificationChannels(getConfig())
    } catch (error) {
      logger.error('Test notification channel configuration is invalid', { error: (error as Error).message })
      res.status(503).json({ error: 'Notification delivery is not configured correctly.' })
      return
    }
    if (channels.length === 0) {
      res.status(503).json({ error: 'No notification channels are enabled.' })
      return
    }

    const delivered: string[] = []
    for (const channel of channels) {
      try {
        await channel.send({
          to: req.body.email,
          subject: 'Map Rezi email delivery test',
          html: '<p>This test message confirms that the configured Map Rezi notification channel can deliver email.</p>',
        })
        delivered.push(channel.name)
      } catch (error) {
        logger.error('Test notification delivery failed', { channel: channel.name, error: (error as Error).message })
      }
    }

    if (delivered.length === 0) {
      res.status(502).json({ error: 'Email delivery failed. Check the backend service logs and SMTP settings.' })
      return
    }
    res.json({ success: true, channels: delivered })
  },
)

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() })
    return false
  }
  return true
}

function polygonBounds(geometry: unknown): { bbox: [number, number, number, number]; zoom: number } | null {
  if (!geometry || typeof geometry !== 'object') return null
  const value = geometry as { type?: unknown; coordinates?: unknown }
  if (value.type !== 'Polygon' || !Array.isArray(value.coordinates) || value.coordinates.length === 0) return null
  const points: number[][] = []
  for (const ring of value.coordinates as unknown[]) {
    if (!Array.isArray(ring) || ring.length < 4) return null
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2 ||
          typeof point[0] !== 'number' || !Number.isFinite(point[0]) || point[0] < -180 || point[0] > 180 ||
          typeof point[1] !== 'number' || !Number.isFinite(point[1]) || point[1] < -90 || point[1] > 90) return null
      points.push(point as number[])
    }
    const first = ring[0] as number[]
    const last = ring[ring.length - 1] as number[]
    if (first[0] !== last[0] || first[1] !== last[1]) return null
  }
  if (points.length < 4) return null
  const lngs = points.map((point) => point[0])
  const lats = points.map((point) => point[1])
  const bbox: [number, number, number, number] = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]
  const span = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1])
  const zoom = span === 0 ? 20 : Math.max(1, Math.min(20, Math.floor(Math.log2(360 / span))))
  return { bbox, zoom }
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
    body('code_id').optional().isString(),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { name, type, config, enabled, working_mode, code_id } = req.body
    const id = crypto.randomUUID()
    await repo.upsertSource({ id, name, type, config, enabled, working_mode, code_id })
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
    body('code_id').optional().isString(),
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
      code_id: req.body.code_id ?? source.code_id,
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
router.post('/geographic-areas/from-geometry', (req: Request, res: Response) => {
  const result = polygonBounds(req.body?.geometry ?? req.body)
  if (!result) {
    res.status(400).json({ error: 'Invalid geometry' })
    return
  }
  res.json(result)
})

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

router.get(
  '/fetch-runs/:id',
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const run = await repo.getFetchRun(req.params.id)
    if (!run) {
      res.status(404).json({ error: 'Fetch run not found' })
      return
    }
    res.json(run)
  }
)

router.post(
  '/fetch-cycles/start',
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    const orchestrator = getOrchestrator()
    await orchestrator.start()
    res.json({ status: 'started' })
  }
)

router.post(
  '/fetch-cycles/stop',
  requireRole('admin'),
  async (_req: Request, res: Response) => {
    const orchestrator = getOrchestrator()
    await orchestrator.stop()
    res.json({ status: 'stopped' })
  }
)

router.post(
  '/sources/:id/trigger',
  requireRole('admin'),
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const orchestrator = getOrchestrator()
    await orchestrator.triggerSourceFetch(req.params.id)
    res.json({ status: 'triggered' })
  }
)

export default router
