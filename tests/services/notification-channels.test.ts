import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config'

const tlsMocks = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('node:tls', () => ({ ...tlsMocks, default: tlsMocks }))

import { createNotificationChannels } from '../../src/services/notifications/channel-factory'
import { SmtpNotificationChannel } from '../../src/services/notifications/smtp-channel'

class FakeTlsSocket extends EventEmitter {
  writes: string[] = []
  setTimeout() { return this }
  destroy() { this.emit('close'); return this }
  write(chunk: string) {
    this.writes.push(chunk)
    let response = ''
    if (chunk === 'EHLO map-rezi-backend\r\n') response = '250-gmail.example\r\n250 AUTH LOGIN\r\n'
    else if (chunk === 'AUTH LOGIN\r\n') response = '334 VXNlcm5hbWU6\r\n'
    else if (chunk === `${Buffer.from('jobs@gmail.com').toString('base64')}\r\n`) response = '334 UGFzc3dvcmQ6\r\n'
    else if (chunk === `${Buffer.from('app-password').toString('base64')}\r\n`) response = '235 2.7.0 Accepted\r\n'
    else if (chunk.startsWith('MAIL FROM:')) response = '250 2.1.0 OK\r\n'
    else if (chunk.startsWith('RCPT TO:')) response = '250 2.1.5 OK\r\n'
    else if (chunk === 'DATA\r\n') response = '354 End data with <CR><LF>.<CR><LF>\r\n'
    else if (chunk.endsWith('\r\n.\r\n')) response = '250 2.0.0 queued\r\n'
    else if (chunk === 'QUIT\r\n') response = '221 2.0.0 closing\r\n'
    if (response) queueMicrotask(() => this.emit('data', Buffer.from(response)))
    return true
  }
}

const smtpConfig = {
  notificationChannels: ['smtp'],
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
  smtpUsername: 'jobs@gmail.com',
  smtpPassword: 'app-password',
  smtpFromEmail: '',
} as Config

describe('notification channel drivers', () => {
  let socket: FakeTlsSocket

  beforeEach(() => {
    vi.clearAllMocks()
    socket = new FakeTlsSocket()
    tlsMocks.connect.mockImplementation(() => {
      queueMicrotask(() => {
        socket.emit('secureConnect')
        socket.emit('data', Buffer.from('220 smtp.gmail.com ESMTP ready\r\n'))
      })
      return socket
    })
  })

  it('selects SMTP through the channel factory and delivers a TLS authenticated summary', async () => {
    const channels = createNotificationChannels(smtpConfig)
    expect(channels).toHaveLength(1)
    expect(channels[0].name).toBe('smtp')
    await channels[0].send({ to: 'user@example.test', subject: 'Two new jobs', html: '<ul><li>Engineer</li></ul>' })

    expect(tlsMocks.connect).toHaveBeenCalledWith({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' })
    expect(socket.writes).toContain('AUTH LOGIN\r\n')
    expect(socket.writes).toContain(`${Buffer.from('jobs@gmail.com').toString('base64')}\r\n`)
    expect(socket.writes).toContain(`${Buffer.from('app-password').toString('base64')}\r\n`)
    expect(socket.writes.some((line) => line.includes('To: user@example.test'))).toBe(true)
    expect(socket.writes.some((line) => line.includes('Subject: =?UTF-8?B?'))).toBe(true)
    expect(socket.writes.some((line) => line.includes('<ul><li>Engineer</li></ul>'))).toBe(true)
  })

  it('rejects an enabled SMTP channel with missing Gmail credentials', () => {
    expect(() => createNotificationChannels({ ...smtpConfig, smtpPassword: '' })).toThrow(/SMTP_PASSWORD/)
  })

  it('rejects a channel identifier without a registered driver', () => {
    expect(() => createNotificationChannels({ ...smtpConfig, notificationChannels: ['unknown'] })).toThrow(/Unsupported NOTIFICATION_CHANNELS/)
  })

  it('exports the concrete SMTP driver for direct use', () => {
    expect(new SmtpNotificationChannel(smtpConfig).name).toBe('smtp')
  })
})
