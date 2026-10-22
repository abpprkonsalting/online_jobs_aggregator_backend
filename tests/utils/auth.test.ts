import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodeToken,
  hashPassword,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyPassword,
  verifyToken,
  verifyTokenHash,
} from '../../src/utils/auth'

const user = { id: 'user-1', email: 'user@example.test', role: 'user' }

describe('authentication utilities', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hashes passwords and verifies only the matching password', async () => {
    const hash = await hashPassword('correct horse battery staple')

    expect(hash).not.toBe('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('incorrect password', hash)).toBe(false)
  })

  it('hashes refresh tokens without storing their plaintext', async () => {
    const token = 'refresh-token-value'
    const hash = await hashToken(token)

    expect(hash).not.toBe(token)
    expect(await verifyTokenHash(token, hash)).toBe(true)
    expect(await verifyTokenHash('different-token', hash)).toBe(false)
  })

  it('signs access and refresh tokens with the configured user claims', () => {
    const access = signAccessToken(user)
    const refresh = signRefreshToken(user)

    expect(verifyToken(access)).toMatchObject({ sub: user.id, email: user.email, role: user.role })
    expect(verifyToken(refresh)).toMatchObject({ sub: user.id, email: user.email, role: user.role })
    expect(decodeToken(access)).toMatchObject({ sub: user.id, email: user.email })
  })

  it('rejects expired and malformed tokens', () => {
    const expired = signAccessToken(user)
    vi.useFakeTimers()
    vi.advanceTimersByTime(16 * 60 * 1000)

    expect(verifyToken(expired)).toBeNull()
    expect(verifyToken('not-a-jwt')).toBeNull()
    expect(decodeToken('not-a-jwt')).toBeNull()
  })
})
