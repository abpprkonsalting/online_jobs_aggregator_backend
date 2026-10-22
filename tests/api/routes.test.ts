import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { signAccessToken } from '../../src/utils/auth'

const { repo } = vi.hoisted(() => ({
  repo: {
    getUserByEmail: vi.fn(),
    createUser: vi.fn(),
    updateUserLastLogin: vi.fn(),
    createRefreshToken: vi.fn(),
    getRefreshTokenByUser: vi.fn(),
    revokeRefreshToken: vi.fn(),
    listUsers: vi.fn(),
    getUserById: vi.fn(),
    updateUserRole: vi.fn(),
    deactivateUser: vi.fn(),
    listUserCategories: vi.fn(),
    createUserCategory: vi.fn(),
    deleteUserCategory: vi.fn(),
    findJobs: vi.fn(),
    findJobIdsByCategories: vi.fn(),
    getJobWithDetails: vi.fn(),
    listSources: vi.fn(),
    upsertSource: vi.fn(),
    getSource: vi.fn(),
    deleteSource: vi.fn(),
    listGeographicAreas: vi.fn(),
    upsertGeographicArea: vi.fn(),
    getGeographicArea: vi.fn(),
    deleteGeographicArea: vi.fn(),
    listSourceAreas: vi.fn(),
    linkSourceGeographicArea: vi.fn(),
    unlinkSourceGeographicArea: vi.fn(),
    listFetchRuns: vi.fn(),
    getMasterSchema: vi.fn(),
    upsertSkill: vi.fn(),
    upsertCategory: vi.fn(),
    upsertCity: vi.fn(),
    upsertCountry: vi.fn(),
    listKeywords: vi.fn(),
    upsertKeyword: vi.fn(),
    listCategories: vi.fn(),
    upsertCategoryKeyword: vi.fn(),
  },
}))

vi.mock('../../src/persistence/JobRepository', () => ({
  JobRepository: class {
    constructor() {
      Object.assign(this, repo)
    }
  },
  default: class {
    constructor() {
      Object.assign(this, repo)
    }
  },
}))

import authRoutes from '../../src/api/auth'
import jobsRoutes from '../../src/api/jobs'
import usersRoutes from '../../src/api/users'
import adminRoutes from '../../src/api/admin'
import masterRoutes from '../../src/api/master'
import { optionalAuth, requireAuthStrict } from '../../src/middleware/auth'
import { hashPassword, hashToken } from '../../src/utils/auth'

const adminId = 'a3cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const userId = 'b4cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const otherUserId = 'c5cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const categoryId = 'd6cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const sourceId = 'e7cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const areaId = 'f8cfeb1d-3e89-4cc6-9b04-2fd43c25303b'
const keywordId = '09cfeb1d-3e89-4cc6-9b04-2fd43c25303b'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/auth', authRoutes)
  app.use('/jobs', optionalAuth, jobsRoutes)
  app.use('/users', requireAuthStrict, usersRoutes)
  app.use('/admin', requireAuthStrict, adminRoutes)
  app.use('/master', requireAuthStrict, masterRoutes)
  return app
}

function tokenFor(id: string, role: 'admin' | 'user' = 'user'): string {
  return signAccessToken({ id, email: `${role}@example.test`, role })
}

function asAdmin(testRequest: request.Test): request.Test {
  return testRequest.set('Authorization', `Bearer ${tokenFor(adminId, 'admin')}`)
}

function asUser(testRequest: request.Test, id = userId): request.Test {
  return testRequest.set('Authorization', `Bearer ${tokenFor(id)}`)
}

describe('HTTP API routers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repo.getUserByEmail.mockResolvedValue(null)
    repo.createUser.mockResolvedValue(userId)
    repo.getRefreshTokenByUser.mockResolvedValue(null)
    repo.listUserCategories.mockResolvedValue([])
    repo.findJobs.mockResolvedValue([])
    repo.findJobIdsByCategories.mockResolvedValue([])
    repo.getJobWithDetails.mockResolvedValue(null)
    repo.listSources.mockResolvedValue([])
    repo.getSource.mockResolvedValue(null)
    repo.listGeographicAreas.mockResolvedValue([])
    repo.getGeographicArea.mockResolvedValue(null)
    repo.listSourceAreas.mockResolvedValue([])
    repo.listFetchRuns.mockResolvedValue([])
    repo.getMasterSchema.mockResolvedValue({
      countries: [],
      cities: [],
      skills: [],
      categories: [],
      geographic_areas: [],
    })
    repo.listKeywords.mockResolvedValue([])
    repo.listCategories.mockResolvedValue([])
  })

  describe('authentication', () => {
    it('logs in active users, persists a hashed refresh token, and sets an HTTP-only cookie', async () => {
      const passwordHash = await hashPassword('correct horse battery staple')
      repo.getUserByEmail.mockResolvedValue({
        id: userId,
        email: 'user@example.test',
        role: 'user',
        is_active: 1,
        password_hash: passwordHash,
      })

      const response = await request(createApp())
        .post('/auth/login')
        .send({ email: 'user@example.test', password: 'correct horse battery staple' })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        user: { id: userId, email: 'user@example.test', role: 'user' },
      })
      expect(response.body.access_token).toEqual(expect.any(String))
      expect(response.headers['set-cookie'][0]).toContain('refresh_token=')
      expect(response.headers['set-cookie'][0]).toContain('HttpOnly')
      expect(repo.createRefreshToken).toHaveBeenCalledWith(
        userId,
        expect.any(String),
        expect.any(Date),
      )
      expect(repo.updateUserLastLogin).toHaveBeenCalledWith(userId)
    })

    it.each([
      ['unknown', null],
      ['inactive', { id: userId, email: 'user@example.test', role: 'user', is_active: 0 }],
    ])('rejects %s accounts without issuing tokens', async (_label, user) => {
      repo.getUserByEmail.mockResolvedValue(user)
      const response = await request(createApp())
        .post('/auth/login')
        .send({ email: 'user@example.test', password: 'incorrect' })

      expect(response.status).toBe(401)
      expect(response.body).toEqual({ error: 'Invalid credentials' })
      expect(repo.createRefreshToken).not.toHaveBeenCalled()
    })

    it('validates login input and rejects refresh requests without a cookie', async () => {
      const app = createApp()
      const invalidLogin = await request(app).post('/auth/login').send({ email: 'invalid' })
      const missingRefresh = await request(app).post('/auth/refresh')

      expect(invalidLogin.status).toBe(400)
      expect(missingRefresh.status).toBe(401)
      expect(missingRefresh.body).toEqual({ error: 'Refresh token required' })
    })

    it('rotates a valid refresh token and revokes its previous record', async () => {
      const passwordHash = await hashPassword('correct horse battery staple')
      repo.getUserByEmail.mockResolvedValue({
        id: userId,
        email: 'user@example.test',
        role: 'user',
        is_active: 1,
        password_hash: passwordHash,
      })
      const app = createApp()
      const login = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.test', password: 'correct horse battery staple' })
      const refreshCookie = login.headers['set-cookie'][0].split(';')[0]
      const rawRefreshToken = refreshCookie.slice('refresh_token='.length)
      repo.getRefreshTokenByUser.mockResolvedValue({
        id: 'refresh-record-1',
        revoked_at: null,
        token_hash: await hashToken(decodeURIComponent(rawRefreshToken)),
      })

      const response = await request(app).post('/auth/refresh').set('Cookie', refreshCookie)

      expect(response.status).toBe(200)
      expect(response.body.access_token).toEqual(expect.any(String))
      expect(repo.revokeRefreshToken).toHaveBeenCalledWith('refresh-record-1')
      expect(repo.createRefreshToken).toHaveBeenCalledTimes(2)
      expect(response.headers['set-cookie'][0]).toContain('HttpOnly')
    })

    it('revokes refresh tokens on logout and identifies authenticated users at /me', async () => {
      const passwordHash = await hashPassword('correct horse battery staple')
      repo.getUserByEmail.mockResolvedValue({
        id: userId,
        email: 'user@example.test',
        role: 'user',
        is_active: 1,
        password_hash: passwordHash,
      })
      const app = createApp()
      const login = await request(app)
        .post('/auth/login')
        .send({ email: 'user@example.test', password: 'correct horse battery staple' })
      const refreshCookie = login.headers['set-cookie'][0].split(';')[0]
      repo.getRefreshTokenByUser.mockResolvedValue({ id: 'refresh-record-1', revoked_at: null })
      const accessToken = login.body.access_token as string

      const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${accessToken}`)
      const loggedOut = await request(app).post('/auth/logout').set('Cookie', refreshCookie)
      const anonymous = await request(app).get('/auth/me')

      expect(me.status).toBe(200)
      expect(me.body).toEqual({ id: userId, email: 'user@example.test', role: 'user' })
      expect(repo.revokeRefreshToken).toHaveBeenCalledWith('refresh-record-1')
      expect(loggedOut.body).toEqual({ success: true })
      expect(loggedOut.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970')
      expect(anonymous.status).toBe(401)
    })
  })

  describe('jobs', () => {
    const jobs = [
      { id: 'job-1', source_id: sourceId, title: 'A', organization: 'Example Labs', salary_min: 90000, salary_max: 120000, allow_remote: true },
      { id: 'job-2', source_id: sourceId, title: 'B', organization: 'Example Inc', salary_min: 80000, salary_max: 100000, allow_remote: true },
      { id: 'job-3', source_id: otherUserId, title: 'C', organization: 'Other Co', salary_min: 70000, salary_max: 90000, allow_remote: false },
    ]

    it('allows public listing and applies supported filters, sorting, and pagination', async () => {
      repo.findJobs.mockResolvedValue(jobs)

      const response = await request(createApp()).get(
        `/jobs?source_id=${sourceId}&allow_remote=true&salary_min=80000&organization=example&sort=salary_min&sortDir=asc&offset=1&limit=1`,
      )

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        total: 2,
        limit: 1,
        offset: 1,
        hasMore: false,
        jobs: [{ id: 'job-1' }],
      })
    })

    it('validates list query parameters and returns not found for missing job details', async () => {
      const app = createApp()
      const invalid = await request(app).get('/jobs?limit=1000&sort=unknown')
      const missing = await request(app).get('/jobs/missing')

      expect(invalid.status).toBe(400)
      expect(invalid.body.errors.length).toBeGreaterThan(0)
      expect(missing.status).toBe(404)
      expect(missing.body).toEqual({ error: 'Job not found' })
    })

    it('limits authenticated users to jobs in their followed categories', async () => {
      repo.findJobs.mockResolvedValue(jobs)
      repo.listUserCategories.mockResolvedValue([{ id: categoryId }])
      repo.findJobIdsByCategories.mockResolvedValue(['job-2'])

      const response = await asUser(request(createApp()).get('/jobs'))

      expect(response.status).toBe(200)
      expect(response.body.jobs.map((job: { id: string }) => job.id)).toEqual(['job-2'])
      expect(repo.findJobIdsByCategories).toHaveBeenCalledWith([categoryId])
    })
  })

  describe('users and authorization', () => {
    it('requires admin access for user administration and validates user creation', async () => {
      const app = createApp()
      const anonymous = await request(app).get('/users')
      const forbidden = await asUser(request(app).get('/users'))
      const invalid = await asAdmin(request(app).post('/users').send({
        email: 'not-an-email',
        password: 'short',
        role: 'root',
      }))

      expect(anonymous.status).toBe(401)
      expect(forbidden.status).toBe(403)
      expect(invalid.status).toBe(400)
      expect(repo.createUser).not.toHaveBeenCalled()
    })

    it('creates users for admins and reports duplicate email conflicts', async () => {
      const app = createApp()
      const created = await asAdmin(request(app).post('/users').send({
        email: 'new@example.test',
        password: 'password123',
      }))
      repo.getUserByEmail.mockResolvedValue({ id: userId })
      const conflict = await asAdmin(request(app).post('/users').send({
        email: 'existing@example.test',
        password: 'password123',
      }))

      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ id: userId, email: 'new@example.test', role: 'user' })
      expect(conflict.status).toBe(409)
      expect(conflict.body).toEqual({ error: 'User already exists' })
    })

    it('updates and deactivates existing users for admins', async () => {
      repo.getUserById.mockResolvedValue({ id: userId, role: 'user' })
      const app = createApp()
      const updated = await asAdmin(request(app).patch(`/users/${userId}`).send({ role: 'admin' }))
      const deactivated = await asAdmin(request(app).delete(`/users/${userId}`))

      expect(updated.status).toBe(200)
      expect(updated.body).toEqual({ id: userId, role: 'admin' })
      expect(deactivated.status).toBe(200)
      expect(deactivated.body).toEqual({ success: true })
      expect(repo.updateUserRole).toHaveBeenCalledWith(userId, 'admin')
      expect(repo.deactivateUser).toHaveBeenCalledWith(userId)
    })

    it('allows users to manage only their own category interests', async () => {
      const app = createApp()
      const own = await asUser(request(app).get(`/users/${userId}/categories`))
      const other = await asUser(request(app).get(`/users/${otherUserId}/categories`))
      const invalid = await asUser(request(app).post(`/users/${userId}/categories`).send({
        category_id: 'invalid',
      }))
      const added = await asUser(request(app).post(`/users/${userId}/categories`).send({
        category_id: categoryId,
      }))

      expect(own.status).toBe(200)
      expect(other.status).toBe(403)
      expect(invalid.status).toBe(400)
      expect(added.status).toBe(201)
      expect(repo.createUserCategory).toHaveBeenCalledWith(userId, categoryId)
    })
  })

  describe('admin and master-data routes', () => {
    it('protects source administration, validates payloads, and creates sources', async () => {
      const app = createApp()
      const unauthorized = await request(app).get('/admin/sources')
      const invalid = await asAdmin(request(app).post('/admin/sources').send({
        name: 'Bad source',
        type: 'unknown',
        config: {},
      }))
      repo.getSource.mockResolvedValue({ id: sourceId, name: 'Rezi', type: 'api' })
      const created = await asAdmin(request(app).post('/admin/sources').send({
        name: 'Rezi',
        type: 'api',
        working_mode: 'passive',
        config: { endpoint: 'https://example.test' },
      }))

      expect(unauthorized.status).toBe(401)
      expect(invalid.status).toBe(400)
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ id: sourceId, name: 'Rezi' })
      expect(repo.upsertSource).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Rezi',
        type: 'api',
        working_mode: 'passive',
      }))
    })

    it('creates source-area links and returns not found for missing geographic areas', async () => {
      const app = createApp()
      const invalid = await asAdmin(request(app).post('/admin/areas').send({
        source_id: 'bad-id',
        geographic_area_id: areaId,
      }))
      const linked = await asAdmin(request(app).post('/admin/areas').send({
        source_id: sourceId,
        geographic_area_id: areaId,
      }))
      const missing = await asAdmin(request(app).put(`/admin/geographic-areas/${areaId}`).send({
        name: 'Nowhere',
      }))

      expect(invalid.status).toBe(400)
      expect(linked.status).toBe(201)
      expect(repo.linkSourceGeographicArea).toHaveBeenCalledWith({
        source_id: sourceId,
        geographic_area_id: areaId,
        enabled: undefined,
      })
      expect(missing.status).toBe(404)
    })

    it('updates and deletes sources and geographic areas', async () => {
      repo.getSource
        .mockResolvedValueOnce({
          id: sourceId,
          name: 'Old Rezi',
          type: 'api',
          working_mode: 'both',
          config: {},
          enabled: true,
        })
        .mockResolvedValueOnce({
          id: sourceId,
          name: 'New Rezi',
          type: 'api',
          working_mode: 'proactive',
        })
      repo.getGeographicArea.mockResolvedValue({
        id: areaId,
        name: 'Boston',
        definition: { bbox: [-71, 42, -70, 43], zoom: 8 },
        enabled: true,
      })
      const app = createApp()
      const updatedSource = await asAdmin(request(app).patch(`/admin/sources/${sourceId}`).send({
        name: 'New Rezi',
        working_mode: 'proactive',
      }))
      const deletedSource = await asAdmin(request(app).delete(`/admin/sources/${sourceId}`))
      const deletedArea = await asAdmin(request(app).delete(`/admin/geographic-areas/${areaId}`))

      expect(updatedSource.status).toBe(200)
      expect(updatedSource.body.name).toBe('New Rezi')
      expect(repo.upsertSource).toHaveBeenCalledWith(expect.objectContaining({
        id: sourceId,
        name: 'New Rezi',
        working_mode: 'proactive',
      }))
      expect(deletedSource.body).toEqual({ success: true })
      expect(deletedArea.body).toEqual({ success: true })
      expect(repo.deleteSource).toHaveBeenCalledWith(sourceId)
      expect(repo.deleteGeographicArea).toHaveBeenCalledWith(areaId)
    })

    it('serves master schema and validates/seeds skills and category-keyword links', async () => {
      const app = createApp()
      const schema = await asAdmin(request(app).get('/master/schema'))
      const invalidSeed = await asAdmin(request(app).post('/master/seed-skills').send({ skills: [] }))
      const seed = await asAdmin(request(app).post('/master/seed-skills').send({
        skills: [{ name: 'TypeScript', slug: 'typescript' }],
      }))
      const link = await asAdmin(request(app).post('/master/category-keywords').send({
        category_id: categoryId,
        keyword_id: keywordId,
        weight: 0.75,
        enabled: false,
      }))

      expect(schema.status).toBe(200)
      expect(schema.body).toHaveProperty('geographic_areas')
      expect(invalidSeed.status).toBe(400)
      expect(seed.status).toBe(200)
      expect(seed.body).toEqual({ seeded: 1 })
      expect(repo.upsertSkill).toHaveBeenCalledWith(expect.objectContaining({
        name: 'TypeScript',
        slug: 'typescript',
      }))
      expect(link.status).toBe(201)
      expect(repo.upsertCategoryKeyword).toHaveBeenCalledWith({
        category_id: categoryId,
        keyword_id: keywordId,
        weight: 0.75,
        enabled: false,
      })
    })
  })
})
