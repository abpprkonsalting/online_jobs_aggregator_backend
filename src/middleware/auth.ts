import { Request, Response, NextFunction } from 'express'
import { verifyToken, TokenPayload } from '../utils/auth'

export interface AuthRequest extends Request {
  auth?: TokenPayload
}

export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return next()
  }
  const token = header.substring(7)
  const payload = verifyToken(token)
  if (payload) {
    req.auth = payload
  }
  next()
}

export function requireAuthStrict(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization header required' })
    return
  }
  const token = header.substring(7)
  const payload = verifyToken(token)
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }
  req.auth = payload
  next()
}

export function requireRole(role: 'admin' | 'user') {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    if (role === 'admin' && req.auth.role !== 'admin') {
      res.status(403).json({ error: 'Admin role required' })
      return
    }
    next()
  }
}

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (header && header.startsWith('Bearer ')) {
    const token = header.substring(7)
    const payload = verifyToken(token)
    if (payload) {
      req.auth = payload
    }
  }
  next()
}