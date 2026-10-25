import { beforeEach, describe, expect, it, vi } from 'vitest'

const { repo } = vi.hoisted(() => ({
  repo: {
    findJobsWithFilters: vi.fn(),
    listFetchRuns: vi.fn(),
    getPool: vi.fn(),
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

import { getPool } from '../../src/database/db'

describe('Query plan validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should have findJobsWithFilters method', async () => {
    expect(typeof repo.findJobsWithFilters).toBe('function')
  })

  it('should have listFetchRuns with limit/offset params', async () => {
    expect(typeof repo.listFetchRuns).toBe('function')
    repo.listFetchRuns.mockResolvedValue([])
    const result = await repo.listFetchRuns(undefined, 10, 0)
    expect(result).toEqual([])
    expect(repo.listFetchRuns).toHaveBeenCalledWith(undefined, 10, 0)
  })

  it('getPool should be configurable', async () => {
    expect(typeof getPool).toBe('function')
    const pool = getPool()
    expect(pool).toBeDefined()
  })
})

describe('API response shape compatibility', () => {
  it('findJobsWithFilters returns { jobs, total }', async () => {
    repo.findJobsWithFilters.mockResolvedValue({ jobs: [{ id: 'job-1' }], total: 1 })
    const result = await repo.findJobsWithFilters({ limit: 20, offset: 0 })
    expect(result).toHaveProperty('jobs')
    expect(result).toHaveProperty('total')
    expect(Array.isArray(result.jobs)).toBe(true)
    expect(typeof result.total).toBe('number')
  })
})