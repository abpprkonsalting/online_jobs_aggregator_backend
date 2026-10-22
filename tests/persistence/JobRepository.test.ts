import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, execute } = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
}))

vi.mock('../../src/database/db', () => ({ query, execute }))

import { JobRepository } from '../../src/persistence/JobRepository'

describe('JobRepository persistence contracts', () => {
  let repo: JobRepository

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new JobRepository()
    query.mockResolvedValue([])
    execute.mockResolvedValue({})
  })

  it('updates an existing job using its persisted id and parameterized values', async () => {
    query.mockResolvedValueOnce([{ id: 'existing-job' }])
    const job = {
      id: 'new-generated-id',
      source_id: 'source-1',
      external_id: 'external-1',
      title: 'Updated title',
      job_url: 'https://jobs.example.test/1',
      raw_data: { fixture: true },
    }

    await expect(repo.upsertJob(job)).resolves.toEqual({ id: 'existing-job', isNew: false })

    expect(query).toHaveBeenCalledWith(
      'SELECT id FROM jobs WHERE source_id = ? AND external_id = ?',
      ['source-1', 'external-1'],
    )
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toContain('UPDATE jobs')
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'Updated title',
      JSON.stringify({ fixture: true }),
      'existing-job',
    ]))
  })

  it('inserts a new job with serialized raw data and reports the generated id', async () => {
    const job = {
      id: 'new-job',
      source_id: 'source-1',
      external_id: 'external-2',
      title: 'New title',
      job_url: 'https://jobs.example.test/2',
      raw_data: { fixture: true },
    }

    await expect(repo.upsertJob(job)).resolves.toEqual({ id: 'new-job', isNew: true })

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toContain('INSERT INTO jobs')
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'new-job',
      'source-1',
      'external-2',
      JSON.stringify({ fixture: true }),
    ]))
  })

  it('uses one placeholder per category id when resolving related jobs', async () => {
    query.mockResolvedValueOnce([{ job_id: 'job-1' }, { job_id: 'job-2' }])

    await expect(repo.findJobIdsByCategories(['category-1', 'category-2'])).resolves.toEqual([
      'job-1',
      'job-2',
    ])

    expect(query).toHaveBeenCalledWith(
      'SELECT DISTINCT job_id FROM job_categories WHERE category_id IN (?, ?)',
      ['category-1', 'category-2'],
    )
  })

  it('returns no job ids without issuing SQL for an empty category list', async () => {
    await expect(repo.findJobIdsByCategories([])).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('builds fetch-run updates only from supplied fields and serializes JSON values', async () => {
    const finishedAt = new Date('2026-10-21T10:00:00.000Z')

    await repo.updateFetchRun({
      id: 'run-1',
      status: 'success',
      finishedAt,
      jobsFound: 12,
      metadata: { area: 'Boston' },
      warnings: ['one warning'],
    })

    expect(execute).toHaveBeenCalledOnce()
    const [sql, params] = execute.mock.calls[0]
    expect(sql).toContain('status = ?')
    expect(sql).toContain('finished_at = ?')
    expect(sql).toContain('metadata = ?')
    expect(sql).toContain('warnings = ?')
    expect(params).toEqual([
      'success',
      finishedAt,
      12,
      JSON.stringify({ area: 'Boston' }),
      JSON.stringify(['one warning']),
      expect.any(Date),
      'run-1',
    ])
  })

  it('does not update a fetch run when no update values were supplied', async () => {
    await repo.updateFetchRun({ id: 'run-1' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('stores fetch-run metadata and warnings as JSON on creation', async () => {
    const startedAt = new Date('2026-10-21T09:00:00.000Z')

    const id = await repo.createFetchRun({
      sourceId: 'source-1',
      status: 'running',
      startedAt,
      metadata: { area: 'Boston' },
      warnings: ['notice'],
    })

    expect(id).toEqual(expect.any(String))
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toContain('INSERT INTO fetch_runs')
    expect(execute.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'source-1',
      'running',
      startedAt,
      JSON.stringify({ area: 'Boston' }),
      JSON.stringify(['notice']),
    ]))
  })
})
