import { PMTiles, FetchSource } from 'pmtiles'

export interface PMTilesSourceConfig {
  pmtilesUrl?: string
  detailsApiUrl?: string
  max_tiles?: number
  api_delay?: number
}

export interface PMTilesIdsResult {
  obfuscatedIds: number[]
  tilesFetched: number
  warnings: string[]
}

/**
 * Decode unsigned LEB128 varints from a binary buffer.
 * PMTiles job tiles contain a sequence of varint-encoded obfuscated_id integers.
 */
function readVarintsFromBuffer(buf: Buffer): number[] {
  const ids: number[] = []
  let pos = 0
  while (pos < buf.length) {
    let result = 0
    let shift = 0
    let byte: number
    do {
      if (pos >= buf.length) break
      byte = buf[pos++]
      result |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)
    ids.push(result >>> 0)
  }
  return ids
}

/**
 * Convert longitude to tile x coordinate at a given zoom level.
 */
function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z))
}

/**
 * Convert latitude to tile y coordinate at a given zoom level.
 * Web mercator: y increases southward.
 */
function latToY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z))
}

/**
 * Compute the inclusive tile x/y range covering a bbox at a given zoom.
 */
export function computeTileRange(
  bbox: [number, number, number, number],
  zoom: number
): { minX: number; maxX: number; minY: number; maxY: number } {
  const [minLon, minLat, maxLon, maxLat] = bbox
  const minX = lonToX(minLon, zoom)
  const maxX = lonToX(maxLon, zoom)
  const minY = latToY(maxLat, zoom)
  const maxY = latToY(minLat, zoom)
  return { minX, maxX, minY, maxY }
}

/**
 * Clamp tile coordinates to valid range for the zoom level.
 */
function clampTile(coord: number, z: number): number {
  const maxTile = Math.pow(2, z) - 1
  return Math.max(0, Math.min(maxTile, coord))
}

/**
 * Fetch all tiles covering a geographic area from a PMTiles archive
 * and extract obfuscated_id integers from each tile.
 */
export async function fetchPmtilesJobIds(
  config: PMTilesSourceConfig,
  bbox: [number, number, number, number],
  zoom: number,
  signal?: AbortSignal
): Promise<PMTilesIdsResult> {
  const obfuscatedIds: number[] = []
  const warnings: string[] = []
  let tilesFetched = 0

  const pmtilesUrl = config.pmtilesUrl
  if (!pmtilesUrl) {
    warnings.push('No PMTiles URL configured for Rezi source')
    return { obfuscatedIds: [], tilesFetched: 0, warnings }
  }

  const { minX, maxX, minY, maxY } = computeTileRange(bbox, zoom)
  const maxTiles = config.max_tiles ?? 100

  const source = new FetchSource(pmtilesUrl)
  const pmtiles = new PMTiles(source)

  let tileCount = 0

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (tileCount >= maxTiles) {
        warnings.push(`Max tiles limit (${maxTiles}) reached, stopping tile fetch`)
        return { obfuscatedIds, tilesFetched, warnings }
      }

      const cx = clampTile(x, zoom)
      const cy = clampTile(y, zoom)

      try {
        const response = await pmtiles.getZxy(zoom, cx, cy, signal)
        if (!response) {
          continue
        }

        tilesFetched++
        tileCount++

        const buffer = Buffer.from(response.data as ArrayBuffer)
        const ids = readVarintsFromBuffer(buffer)
        obfuscatedIds.push(...ids)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Tile z=${zoom} x=${cx} y=${cy} failed: ${message}`)
      }
    }
  }

  // Deduplicate IDs across tiles (a job can appear in adjacent tiles)
  const uniqueIds = [...new Set(obfuscatedIds)]
  if (uniqueIds.length < obfuscatedIds.length) {
    warnings.push(`Deduplicated ${obfuscatedIds.length - uniqueIds.length} duplicate obfuscated_ids across tiles`)
  }

  return { obfuscatedIds: uniqueIds, tilesFetched, warnings }
}

export type { PMTiles, FetchSource }
