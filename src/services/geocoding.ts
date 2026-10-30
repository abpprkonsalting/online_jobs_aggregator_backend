import { getConfig } from '../config'

export class GeocodingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GeocodingError'
  }
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lng: number }> {
  const apiKey = getConfig().googleMapsApiKey
  if (!apiKey) throw new GeocodingError('Geocoding is not configured: GOOGLE_MAPS_API_KEY is missing', 503)
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('key', apiKey)
  const response = await fetch(url)
  if (!response.ok) throw new GeocodingError('Geocoding provider request failed', 502)
  const result = await response.json() as {
    status?: string
    results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>
  }
  const location = result.results?.[0]?.geometry?.location
  if (result.status === 'ZERO_RESULTS' || !location) {
    throw new GeocodingError('Address could not be resolved', 404)
  }
  if (result.status !== 'OK' || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
    throw new GeocodingError(`Geocoding provider error: ${result.status ?? 'unknown status'}`, 502)
  }
  return { lat: location.lat, lng: location.lng }
}
