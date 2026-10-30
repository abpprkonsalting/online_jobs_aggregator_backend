import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signAccessToken } from '../../src/utils/auth'

const { repo, query, execute } = vi.hoisted(() => ({
  repo: { listSources: vi.fn(), listGeographicAreas: vi.fn() },
  query: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('../../src/database/db', () => ({
  createJobRepository: () => repo,
  query,
  execute,
}))

import geocodeRoutes from '../../src/api/geocode'
import usersRoutes from '../../src/api/users'
import adminRoutes from '../../src/api/admin'
import { requireAuthStrict, requireRole } from '../../src/middleware/auth'

const adminId = 'a3cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const userId = 'b4cfeb1d-3e89-4cc6-9b04-2fd43c25303b'

function app() {
  const server = express()
  server.use(express.json())
  server.use('/api/geocode', geocodeRoutes)
  server.use('/api/users', requireAuthStrict, usersRoutes)
  server.use('/api/admin', requireAuthStrict, requireRole('admin'), adminRoutes)
  return server
}

function token(id: string, role: 'admin' | 'user' = 'user') {
  return signAccessToken({ id, email: `${role}@example.test`, role })
}

describe('Phase 3 API endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue([])
    execute.mockResolvedValue(undefined)
  })

  describe('POST /api/geocode', () => {
    it('returns numeric coordinates from the Google Geocoding response', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 40.4168, lng: -3.7038 } } }] }),
      } as Response)

      const response = await request(app()).post('/api/geocode').send({ address: 'Madrid, Spain' })

      expect(response.status).toBe(200)
      expect(response.body).toEqual({ lat: 40.4168, lng: -3.7038 })
      const url = new URL(fetch.mock.calls[0][0] as string)
      expect(url.searchParams.get('address')).toBe('Madrid, Spain')
      expect(url.searchParams.get('key')).toBe('test-google-maps-api-key')
      fetch.mockRestore()
    })

    it('returns the required address validation error without calling Google', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      const response = await request(app()).post('/api/geocode').send({ address: '' })
      expect(response.status).toBe(400)
      expect(response.body).toEqual({ error: 'Address is required' })
      expect(fetch).not.toHaveBeenCalled()
      fetch.mockRestore()
    })

    it('returns 404 when Google has no result for an address', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ZERO_RESULTS', results: [] }),
      } as Response)
      const response = await request(app()).post('/api/geocode').send({ address: 'somewhere nonexistent' })
      expect(response.status).toBe(404)
      expect(response.body.error).toMatch(/could not be resolved/i)
      fetch.mockRestore()
    })
  })

  describe('POST /api/admin/geographic-areas/from-geometry', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [[[-3.8, 40.3], [-3.6, 40.3], [-3.6, 40.5], [-3.8, 40.3]]],
    }

    it('returns the polygon bounds and a numeric zoom for admins', async () => {
      const response = await request(app())
        .post('/api/admin/geographic-areas/from-geometry')
        .set('Authorization', `Bearer ${token(adminId, 'admin')}`)
        .send({ geometry: polygon })
      expect(response.status).toBe(200)
      expect(response.body.bbox).toEqual([-3.8, 40.3, -3.6, 40.5])
      expect(response.body.zoom).toEqual(expect.any(Number))
    })

    it('rejects non-polygons and malformed rings', async () => {
      const server = app()
      const auth = `Bearer ${token(adminId, 'admin')}`
      const wrongType = await request(server).post('/api/admin/geographic-areas/from-geometry').set('Authorization', auth).send({ type: 'Point', coordinates: [0, 0] })
      const openRing = await request(server).post('/api/admin/geographic-areas/from-geometry').set('Authorization', auth).send({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })
      expect(wrongType.status).toBe(400)
      expect(wrongType.body).toEqual({ error: 'Invalid geometry' })
      expect(openRing.status).toBe(400)
    })

    it('forbids non-admin access', async () => {
      const response = await request(app())
        .post('/api/admin/geographic-areas/from-geometry')
        .set('Authorization', `Bearer ${token(userId)}`)
        .send(polygon)
      expect(response.status).toBe(403)
    })
  })

  describe('user notification endpoints', () => {
    it('updates only the authenticated user notification preference', async () => {
      const response = await request(app())
        .patch('/api/users/me/notification-preferences')
        .set('Authorization', `Bearer ${token(userId)}`)
        .send({ opt_in: true })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ opt_in: true })
      expect(execute).toHaveBeenCalledWith(
        'UPDATE users SET notification_opt_in = ?, updated_at = ? WHERE id = ?',
        [1, expect.any(Date), userId],
      )
    })

    it('returns the authenticated user notification history', async () => {
      query.mockResolvedValueOnce([{ id: 'history-1', job_count: 1, jobs: [{ id: 'job-1' }], sent_at: '2026-10-30' }])
      const response = await request(app())
        .get('/api/users/me/notifications')
        .set('Authorization', `Bearer ${token(userId)}`)
      expect(response.status).toBe(200)
      expect(response.body).toEqual([{ id: 'history-1', job_count: 1, jobs: [{ id: 'job-1' }], sent_at: '2026-10-30' }])
      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id = ?'), [userId])
    })
  })
})
