import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { getConfig } from '../config'

const BCRYPT_ROUNDS = 10

export interface TokenPayload {
  sub: string
  email: string
  role: 'admin' | 'user'
  iat?: number
  exp?: number
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function hashToken(token: string): Promise<string> {
  return bcrypt.hash(token, BCRYPT_ROUNDS)
}

export async function verifyTokenHash(token: string, hash: string): Promise<boolean> {
  return bcrypt.compare(token, hash)
}

export function signAccessToken(user: { id: string; email: string; role: string }): string {
  const config = getConfig()
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtAccessExpiresIn as any,
  })
}

export function signRefreshToken(user: { id: string; email: string; role: string }): string {
  const config = getConfig()
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtRefreshExpiresIn as any,
  })
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, getConfig().jwtSecret) as TokenPayload
  } catch {
    return null
  }
}

export function decodeToken(token: string): TokenPayload | null {
  try {
    return jwt.decode(token) as TokenPayload
  } catch {
    return null
  }
}