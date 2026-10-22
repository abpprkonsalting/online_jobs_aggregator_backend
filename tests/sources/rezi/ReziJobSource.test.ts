import type { Logger } from '../../../src/utils/logger.types'
import type { RateLimiter } from '../../../src/utils/rate-limiter'
import type { JobSourceContext } from '../../../src/sources/base/JobSource'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { fetchPmtilesJobIds } = vi.hoisted(() => ({
  fetchPmtilesJobIds: vi.fn(),
}))

vi.mock('../../../src/sources/rezi/pmtiles', () => ({
  computeTileRange: vi.fn(),
  fetchPmtilesJobIds,
}))

import { ReziJobSource } from '../../../src/sources/rezi/ReziJobSource'

const sourceConfig = {
  id: 'source-1',
  name: 'Rezi',
  type: 'api' as const,
  working_mode: 'both' as const,
  config: {
    searchApiUrl: 'https://rezi.example.test/search',
    detailsApiUrl: 'https://rezi.example.test/details',
    pmtilesUrl: 'https://rezi.example.test/jobs.pmtiles',
  },
  enabled: true,
}

function createContext(): {
  context: JobSourceContext
  acquire: ReturnType<typeof vi.fn>
  logger: Logger
} {
  const acquire = vi.fn<RateLimiter['acquire']>().mockResolvedValue(undefined)
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  return {
    context: {
      source: sourceConfig,
      logger,
      rateLimiter: { acquire, reset: vi.fn() },
      clock: () => new Date('2026-10-21T12:00:00.000Z'),
    },
    acquire,
    logger,
  }
}

function validJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    obfuscated_id: 123,
    title: 'Backend Engineer',
    job_url: 'https://jobs.example.test/123',
    organization: 'Example Co',
    remote_derived: true,
    salary_min_value: '90000',
    salary_max_value: 120000,
    salary_currency: 'USD',
    salary_unit_text: 'YEAR',
    date_posted: '2026-10-20',
    ai_key_skills: ['TypeScript'],
    _categories: ['Engineering'],
    _locations: ['Remote'],
    ...overrides,
  }
}

describe('ReziJobSource', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchPmtilesJobIds.mockReset()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('returns a warning for an area missing its bbox/zoom definition', async () => {
    const { context, acquire, logger } = createContext()
    const result = await new ReziJobSource(context).fetch({
      id: 'area-1',
      name: 'Missing',
      definition: {},
    })

    expect(result.rawJobs).toEqual([])
    expect(result.warnings?.[0]).toContain('has no bbox/zoom definition')
    expect(acquire).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it('fetches passive details, normalizes job data, and applies rate limits', async () => {
    fetchPmtilesJobIds.mockResolvedValue({
      obfuscatedIds: [123],
      tilesFetched: 1,
      warnings: [],
    })
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      jobs: [validJob(), { title: 'Missing ID', job_url: 'https://jobs.example.test/no-id' }],
    })))
    const { context, acquire } = createContext()

    const result = await new ReziJobSource(context).fetch({
      id: 'area-1',
      name: 'Boston',
      definition: { bbox: [-71, 42, -70, 43], zoom: 9 },
    })

    expect(fetchPmtilesJobIds).toHaveBeenCalledWith(
      sourceConfig.config,
      [-71, 42, -70, 43],
      9,
      expect.any(AbortSignal),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://rezi.example.test/details?page=1&rows_per_page=12',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ obfuscated_ids: [123] }),
      }),
    )
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(result.rawJobs).toEqual([expect.objectContaining({
      obfuscated_id: 123,
      title: 'Backend Engineer',
      salary_min_value: 90000,
      salary_max_value: 120000,
      remote_derived: true,
      ai_key_skills: ['TypeScript'],
    })])
    expect(result.metrics.jobsFound).toBe(1)
    expect(result.metadata).toMatchObject({ area: 'area-1', obfuscatedIdsCount: 1 })
  })

  it('skips the details request if passive tile lookup returns no ids', async () => {
    fetchPmtilesJobIds.mockResolvedValue({ obfuscatedIds: [], tilesFetched: 3, warnings: [] })
    const { context } = createContext()
    const result = await new ReziJobSource(context).fetch({
      id: 'area-1',
      name: 'Empty',
      definition: { bbox: [0, 0, 1, 1], zoom: 1 },
    })

    expect(result.rawJobs).toEqual([])
    expect(result.metadata).toMatchObject({ tilesFetched: 3, obfuscatedIdsCount: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('deduplicates keyword results, batches ids, paginates details, and drops invalid jobs', async () => {
    const ids = Array.from({ length: 51 }, (_value, index) => index + 1)
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://rezi.example.test/search') {
        const query = JSON.parse(String(init?.body)).query
        const foundIds = query === 'engineering' ? ids : [1, 2, 51]
        return new Response(JSON.stringify({
          data: {
            roles: {
              developer: {
                locations: {
                  features: foundIds.map((id: number) => ({ properties: { id } })),
                },
              },
            },
          },
        }))
      }

      const page = new URL(url).searchParams.get('page')
      const body = JSON.parse(String(init?.body))
      if (body.obfuscated_ids.length === 50 && page === '1') {
        return new Response(JSON.stringify({ data: { jobs: Array.from({ length: 12 }, (_v, i) => validJob({ obfuscated_id: i + 1 })) } }))
      }
      if (body.obfuscated_ids.length === 50) {
        return new Response(JSON.stringify({ data: { jobs: [validJob({ obfuscated_id: 13 }), { obfuscated_id: 14, title: 'No URL' }] } }))
      }
      return new Response(JSON.stringify({ jobs: [validJob({ obfuscated_id: 51 })] }))
    })
    const { context, acquire } = createContext()

    const result = await new ReziJobSource(context).fetchByKeywords(['engineering', 'software'])

    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url) === 'https://rezi.example.test/search')
    const detailCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://rezi.example.test/details'))
    expect(searchCalls).toHaveLength(2)
    expect(detailCalls).toHaveLength(3)
    expect(JSON.parse(String(detailCalls[0][1]?.body)).obfuscated_ids).toHaveLength(50)
    expect(JSON.parse(String(detailCalls[1][1]?.body)).obfuscated_ids).toHaveLength(50)
    expect(JSON.parse(String(detailCalls[2][1]?.body)).obfuscated_ids).toEqual([51])
    expect(new URL(String(detailCalls[0][0])).searchParams.get('page')).toBe('1')
    expect(new URL(String(detailCalls[1][0])).searchParams.get('page')).toBe('2')
    expect(new URL(String(detailCalls[2][0])).searchParams.get('page')).toBe('1')
    expect(result.rawJobs).toHaveLength(14)
    expect(result.metrics.jobsFound).toBe(14)
    expect(result.metadata).toMatchObject({ keywords: ['engineering', 'software'], obfuscatedIdsCount: 51 })
    expect(acquire).toHaveBeenCalledTimes(5)
  })

  it('returns warnings for failed search and details responses instead of throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { roles: { role: { locations: { features: [{ properties: { id: 5 } }] } } } },
      })))
      .mockResolvedValueOnce(new Response('', { status: 502 }))
    const { context } = createContext()

    const result = await new ReziJobSource(context).fetchByKeywords(['failing', 'successful'])

    expect(result.rawJobs).toEqual([])
    expect(result.warnings).toEqual([
      'Search API for "failing" failed: HTTP 503',
      'Details API batch 1 page 1 failed: HTTP 502',
    ])
  })
})
