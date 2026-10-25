import { Router, Request, Response } from 'express'
import { body, validationResult } from 'express-validator'
import { AuthRequest, requireAuthStrict } from '../middleware/auth'
import { signAccessToken, signRefreshToken, verifyToken, verifyTokenHash, hashToken, hashPassword, verifyPassword } from '../utils/auth'
import { createJobRepository } from '../database/db'
import { getConfig } from '../config'

const router = Router()
const repo = createJobRepository()
const config = getConfig()

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req)
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() })
    return false
  }
  return true
}

router.post(
  '/login',
  [body('email').isEmail(), body('password').isString().notEmpty()],
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return
    const { email, password } = req.body

    const user = await repo.getUserByEmail(email)
    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const ok = await verifyPassword(password, user.password_hash)
    if (!ok) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const accessToken = signAccessToken({ id: user.id, email: user.email, role: user.role })
    const refreshToken = signRefreshToken({ id: user.id, email: user.email, role: user.role })
    const refreshHash = await hashToken(refreshToken)

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await repo.createRefreshToken(user.id, refreshHash, expiresAt)
    await repo.updateUserLastLogin(user.id)

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      domain: config.cookieDomain || undefined,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    })

    res.json({
      access_token: accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    })
  }
)

router.post('/refresh', async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refresh_token
  if (!refreshToken) {
    res.status(401).json({ error: 'Refresh token required' })
    return
  }

  const payload = verifyToken(refreshToken)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired refresh token' })
    return
  }

  const tokenRecord = await repo.getRefreshTokenByUser(payload.sub)
  if (!tokenRecord || tokenRecord.revoked_at) {
    res.status(401).json({ error: 'Refresh token revoked' })
    return
  }

  const ok = await verifyTokenHash(refreshToken, tokenRecord.token_hash)
  if (!ok) {
    res.status(401).json({ error: 'Invalid refresh token' })
    return
  }

  await repo.revokeRefreshToken(tokenRecord.id)

  const newAccessToken = signAccessToken({ id: payload.sub, email: payload.email, role: payload.role })
  const newRefreshToken = signRefreshToken({ id: payload.sub, email: payload.email, role: payload.role })
  const newRefreshHash = await hashToken(newRefreshToken)
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  await repo.createRefreshToken(payload.sub, newRefreshHash, expiresAt)

  res.cookie('refresh_token', newRefreshToken, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    domain: config.cookieDomain || undefined,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })

  res.json({ access_token: newAccessToken })
})

router.post('/logout', async (req: AuthRequest, res: Response) => {
  const refreshToken = req.cookies?.refresh_token
  if (refreshToken) {
    const payload = verifyToken(refreshToken)
    if (payload) {
      const tokenRecord = await repo.getRefreshTokenByUser(payload.sub)
      if (tokenRecord && !tokenRecord.revoked_at) {
        await repo.revokeRefreshToken(tokenRecord.id)
      }
    }
  }
  res.clearCookie('refresh_token', {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'lax',
    domain: config.cookieDomain || undefined,
  })
  res.json({ success: true })
})

router.get('/me', requireAuthStrict, (req: AuthRequest, res: Response) => {
  if (!req.auth) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  res.json({ id: req.auth.sub, email: req.auth.email, role: req.auth.role })
})

export default router
