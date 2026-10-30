import { afterEach, describe, expect, it, vi } from 'vitest'

describe('required Phase 3 configuration', () => {
  afterEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = 'test-google-maps-api-key'
    vi.resetModules()
  })

  it('fails clearly when GOOGLE_MAPS_API_KEY is missing', async () => {
    vi.resetModules()
    vi.doMock('dotenv', () => ({ default: { config: vi.fn() } }))
    delete process.env.GOOGLE_MAPS_API_KEY
    const { getConfig } = await import('../src/config')
    expect(() => getConfig()).toThrow('Missing required env var: GOOGLE_MAPS_API_KEY')
    vi.doUnmock('dotenv')
  })

  it('parses comma-separated channel selections and Gmail SMTP settings', async () => {
    vi.resetModules()
    vi.doMock('dotenv', () => ({ default: { config: vi.fn() } }))
    process.env.GOOGLE_MAPS_API_KEY = 'google-key'
    process.env.NOTIFICATION_CHANNELS = 'smtp, custom '
    process.env.SMTP_HOST = 'smtp.gmail.com'
    process.env.SMTP_PORT = '465'
    process.env.SMTP_USERNAME = 'jobs@gmail.com'
    process.env.SMTP_PASSWORD = 'app-password'
    const { getConfig } = await import('../src/config')
    expect(getConfig()).toMatchObject({
      notificationChannels: ['smtp', 'custom'],
      smtpHost: 'smtp.gmail.com',
      smtpPort: 465,
      smtpUsername: 'jobs@gmail.com',
      smtpPassword: 'app-password',
    })
    vi.doUnmock('dotenv')
  })
})
