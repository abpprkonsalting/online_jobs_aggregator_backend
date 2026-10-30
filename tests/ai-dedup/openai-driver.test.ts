import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiDedupDriver } from '../../src/ai-dedup/openai-driver'
import type { DedupJob } from '../../src/ai-dedup/contract'

const job = (id: string, title: string): DedupJob => ({
  id,
  source_id: `source-${id}`,
  external_id: id,
  title,
  organization: 'Example Co',
  job_url: `https://jobs.example.test/${id}`,
})

describe('OpenAiDedupDriver', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the provider decision for identical and different postings', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"duplicate":true}' } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: '{"duplicate":false}' } }] }) })
    vi.stubGlobal('fetch', fetch)
    const driver = new OpenAiDedupDriver('test-key', 'test-model')

    await expect(driver.isDuplicate(job('1', 'Platform Engineer'), job('2', 'Platform Engineer'))).resolves.toBe(true)
    await expect(driver.isDuplicate(job('3', 'Platform Engineer'), job('4', 'Designer'))).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions')
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer test-key' },
      body: expect.stringContaining('test-model'),
    })
  })

  it('groups duplicates and leaves unrelated titles separate', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const requestBody = JSON.parse(String(init.body))
      const prompt = requestBody.messages[1].content as string
      const { jobA, jobB } = JSON.parse(prompt)
      const duplicate = jobA.title === 'Platform Engineer' && jobB.title === 'Platform Engineer'
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ duplicate }) } }] }) } as Response
    })
    vi.stubGlobal('fetch', fetch)
    const driver = new OpenAiDedupDriver('test-key')

    const groups = await driver.findDuplicates([
      job('1', 'Platform Engineer'),
      job('2', 'Platform Engineer'),
      job('3', 'Designer'),
    ])

    expect(groups).toEqual([{ canonical: job('1', 'Platform Engineer'), duplicates: [job('2', 'Platform Engineer')] }])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('rejects malformed provider decisions instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"duplicate":"yes"}' } }] }),
    }))
    const driver = new OpenAiDedupDriver('test-key')
    await expect(driver.isDuplicate(job('1', 'A'), job('2', 'A'))).rejects.toThrow(/boolean duplicate field/)
  })
})
