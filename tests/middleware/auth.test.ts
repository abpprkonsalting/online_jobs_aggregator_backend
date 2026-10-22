import type { Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  optionalAuth,
  requireAuth,
  requireAuthStrict,
  requireRole,
  type AuthRequest,
} from '../../src/middleware/auth'
import { signAccessToken } from '../../src/utils/auth'

function request(authorization?: string): AuthRequest {
  return { headers: authorization ? { authorization } : {} } as AuthRequest
}

function response(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> }
}

describe('authentication middleware', () => {
  const next = vi.fn()

  beforeEach(() => next.mockReset())

  it('attaches a valid bearer token for optional authentication', () => {
    const req = request(`Bearer ${signAccessToken({ id: 'user-1', email: 'user@example.test', role: 'user' })}`)

    optionalAuth(req, response(), next)

    expect(req.auth).toMatchObject({ sub: 'user-1', email: 'user@example.test', role: 'user' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('allows anonymous optional requests and ignores invalid tokens', () => {
    const anonymous = request()
    optionalAuth(anonymous, response(), next)
    expect(anonymous.auth).toBeUndefined()

    const invalid = request('Bearer invalid')
    optionalAuth(invalid, response(), next)
    expect(invalid.auth).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('allows requireAuth requests through without credentials for downstream optional handling', () => {
    const req = request()

    requireAuth(req, response(), next)

    expect(req.auth).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('rejects missing and invalid strict credentials with 401', () => {
    for (const authorization of [undefined, 'Bearer invalid']) {
      const res = response()
      requireAuthStrict(request(authorization), res, next)
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({
        error: authorization ? 'Invalid or expired token' : 'Authorization header required',
      })
    }
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts valid strict credentials and enforces administrator role', () => {
    const token = signAccessToken({ id: 'user-1', email: 'user@example.test', role: 'user' })
    const req = request(`Bearer ${token}`)
    requireAuthStrict(req, response(), next)
    expect(req.auth?.sub).toBe('user-1')
    expect(next).toHaveBeenCalledOnce()

    const res = response()
    requireRole('admin')(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin role required' })

    const unauthenticated = response()
    requireRole('admin')({ headers: {} } as AuthRequest, unauthenticated, next)
    expect(unauthenticated.status).toHaveBeenCalledWith(401)
    expect(unauthenticated.json).toHaveBeenCalledWith({ error: 'Authentication required' })
  })
})
