import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getZxy } = vi.hoisted(() => ({ getZxy: vi.fn() }))

vi.mock('pmtiles', () => ({
  FetchSource: class {
    constructor(readonly url: string) {}
  },
  PMTiles: class {
    constructor(_source: unknown) {}
    getZxy = getZxy
  },
}))

import { computeTileRange, fetchPmtilesJobIds } from '../../../src/sources/rezi/pmtiles'

function tile(...bytes: number[]): { data: ArrayBuffer } {
  return { data: Uint8Array.from(bytes).buffer }
}

describe('Rezi PMTiles utilities', () => {
  beforeEach(() => getZxy.mockReset())

  it('computes the inclusive Web Mercator tile range', () => {
    expect(computeTileRange([0, 0, 0, 0], 1)).toEqual({
      minX: 1,
      maxX: 1,
      minY: 1,
      maxY: 1,
    })

    expect(computeTileRange([-180, -85, 180, 85], 1)).toEqual({
      minX: 0,
      maxX: 2,
      minY: 0,
      maxY: 1,
    })
  })

  it('reports missing archive configuration without requesting tiles', async () => {
    await expect(fetchPmtilesJobIds({}, [0, 0, 0, 0], 1)).resolves.toEqual({
      obfuscatedIds: [],
      tilesFetched: 0,
      warnings: ['No PMTiles URL configured for Rezi source'],
    })
    expect(getZxy).not.toHaveBeenCalled()
  })

  it('decodes unsigned varints and deduplicates ids shared between tiles', async () => {
    getZxy
      .mockResolvedValueOnce(tile(0xac, 0x02, 0x01))
      .mockResolvedValueOnce(tile(0x01, 0x02))
    const result = await fetchPmtilesJobIds(
      { pmtilesUrl: 'https://archive.example.test/jobs.pmtiles' },
      [0, 0, 100, 40],
      1,
    )

    expect(result.obfuscatedIds).toEqual([300, 1, 2])
    expect(result.tilesFetched).toBe(2)
    expect(result.warnings).toEqual([
      'Deduplicated 1 duplicate obfuscated_ids across tiles',
    ])
    expect(getZxy).toHaveBeenCalledTimes(2)
  })

  it('honors the configured tile limit', async () => {
    getZxy.mockResolvedValueOnce(tile(7))
    const result = await fetchPmtilesJobIds(
      { pmtilesUrl: 'https://archive.example.test/jobs.pmtiles', max_tiles: 1 },
      [0, 0, 100, 40],
      1,
    )

    expect(result.obfuscatedIds).toEqual([7])
    expect(result.tilesFetched).toBe(1)
    expect(result.warnings).toEqual([
      'Max tiles limit (1) reached, stopping tile fetch',
    ])
    expect(getZxy).toHaveBeenCalledOnce()
  })

  it('continues after a corrupt tile and preserves the failure as a warning', async () => {
    getZxy
      .mockRejectedValueOnce(new Error('corrupt tile'))
      .mockResolvedValueOnce(tile(9))
    const result = await fetchPmtilesJobIds(
      { pmtilesUrl: 'https://archive.example.test/jobs.pmtiles' },
      [0, 0, 100, 40],
      1,
    )

    expect(result.obfuscatedIds).toEqual([9])
    expect(result.tilesFetched).toBe(1)
    expect(result.warnings).toEqual(['Tile z=1 x=1 y=0 failed: corrupt tile'])
  })
})
