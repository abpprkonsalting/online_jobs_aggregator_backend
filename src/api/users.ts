import { Router, Request, Response } from 'express'
import { body, param, validationResult } from 'express-validator'
import { JobRepository } from '../persistence/JobRepository'
import { requireRole, requireAuthStrict, AuthRequest } from '../middleware/auth'

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

function canAccessUser(req: AuthRequest, targetUserId: string): boolean {
  if (!req.auth) return false
  return req.auth.role === 'admin' || req.auth.sub === targetUserId
}

router.get('/', requireRole('admin'), async (_req: Request, res: Response) => {
  const users = await repo.listUsers()
  res.json(users)
})

router.post(
  '/',
  requireRole('admin'),
  [
    body('email').isEmail(),
    body('password').isString().isLength({ min: 6 }),
    body('role').optional().isIn(['admin', 'user']),
  ],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { email, password, role } = req.body
    const existing = await repo.getUserByEmail(email)
    if (existing) {
      res.status(409).json({ error: 'User already exists' })
      return
    }
    const { hashPassword } = await import('../utils/auth')
    const hash = await hashPassword(password)
    const id = await repo.createUser(email, hash, role)
    res.status(201).json({ id, email, role: role ?? 'user' })
  }
)

router.patch(
  '/:id',
  requireRole('admin'),
  [param('id').isUUID(), body('role').isIn(['admin', 'user'])],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const user = await repo.getUserById(req.params.id)
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    await repo.updateUserRole(req.params.id, req.body.role)
    res.json({ id: req.params.id, role: req.body.role })
  }
)

router.delete(
  '/:id',
  requireRole('admin'),
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const user = await repo.getUserById(req.params.id)
    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }
    await repo.deactivateUser(req.params.id)
    res.json({ success: true })
  }
)

// ── User category management ──
router.get(
  '/:id/categories',
  requireAuthStrict,
  async (req: AuthRequest, res: Response) => {
    const targetUserId = req.params.id
    if (!canAccessUser(req, targetUserId)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const categories = await repo.listUserCategories(targetUserId)
    res.json(categories)
  }
)

router.post(
  '/:id/categories',
  requireAuthStrict,
  [param('id').isUUID(), body('category_id').isUUID()],
  async (req: AuthRequest, res: Response) => {
    if (!validate(req, res)) return
    const targetUserId = req.params.id
    if (!canAccessUser(req, targetUserId)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const { category_id } = req.body
    await repo.createUserCategory(targetUserId, category_id)
    res.status(201).json({ user_id: targetUserId, category_id })
  }
)

router.delete(
  '/:id/categories/:category_id',
  requireAuthStrict,
  [param('id').isUUID(), param('category_id').isUUID()],
  async (req: AuthRequest, res: Response) => {
    if (!validate(req, res)) return
    const targetUserId = req.params.id
    if (!canAccessUser(req, targetUserId)) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    await repo.deleteUserCategory(targetUserId, req.params.category_id)
    res.json({ success: true })
  }
)

export default router
