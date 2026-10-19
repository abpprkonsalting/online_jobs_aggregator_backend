import { Router, Request, Response } from 'express'
import { body, param, validationResult } from 'express-validator'
import { JobRepository } from '../persistence/JobRepository'
import { requireRole } from '../middleware/auth'

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

export default router
