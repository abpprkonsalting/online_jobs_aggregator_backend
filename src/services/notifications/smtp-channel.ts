import tls from 'node:tls'
import type { Config } from '../../config'
import type { NotificationChannelDriver, NotificationMessage } from './channel'

interface SmtpResponse { code: number; text: string }

class SmtpSession {
  private buffer = ''
  private pending: ((response: SmtpResponse) => void) | null = null
  private failure: ((error: Error) => void) | null = null

  constructor(private readonly socket: tls.TLSSocket) {
    socket.setTimeout(20000, () => socket.destroy(new Error('SMTP connection timed out')))
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      this.flush()
    })
    socket.on('error', (error) => this.failure?.(error))
    socket.on('close', () => this.failure?.(new Error('SMTP connection closed unexpectedly')))
  }

  async response(): Promise<SmtpResponse> {
    const parsed = this.parseResponse()
    if (parsed) return parsed
    return new Promise((resolve, reject) => {
      this.pending = resolve
      this.failure = reject
      this.flush()
    })
  }

  write(line: string): void {
    this.socket.write(`${line}\r\n`)
  }

  private flush(): void {
    if (!this.pending) return
    const parsed = this.parseResponse()
    if (parsed) {
      const resolve = this.pending
      this.pending = null
      this.failure = null
      resolve(parsed)
    }
  }

  private parseResponse(): SmtpResponse | null {
    const lines = this.buffer.split('\r\n')
    if (lines.length < 2) return null
    const first = lines[0].match(/^(\d{3})[- ]/)
    if (!first) throw new Error(`Invalid SMTP response: ${lines[0]}`)
    const code = Number(first[1])
    let end = -1
    for (let i = 0; i < lines.length; i++) {
      if (new RegExp(`^${code} `).test(lines[i])) { end = i; break }
    }
    if (end < 0) return null
    const text = lines.slice(0, end + 1).join('\n')
    this.buffer = lines.slice(end + 1).join('\r\n')
    return { code, text }
  }
}

export class SmtpNotificationChannel implements NotificationChannelDriver {
  readonly name = 'smtp'
  private readonly from: string

  constructor(private readonly config: Pick<Config, 'smtpHost' | 'smtpPort' | 'smtpUsername' | 'smtpPassword' | 'smtpFromEmail'>) {
    this.from = config.smtpFromEmail || config.smtpUsername
    if (!config.smtpHost || !config.smtpPort || !config.smtpUsername || !config.smtpPassword || !this.from) {
      throw new Error('SMTP notifications require SMTP_HOST, SMTP_PORT, SMTP_USERNAME, and SMTP_PASSWORD; SMTP_FROM_EMAIL defaults to SMTP_USERNAME')
    }
  }

  async send(message: NotificationMessage): Promise<void> {
    if (!/^[^\r\n<>]+$/.test(this.from) || !/^[^\r\n<>]+$/.test(message.to)) {
      throw new Error('SMTP sender and recipient must be valid email addresses')
    }
    const socket = tls.connect({ host: this.config.smtpHost, port: this.config.smtpPort, servername: this.config.smtpHost })
    const smtp = new SmtpSession(socket)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('error', reject)
      })
      await this.expect(smtp, [220])
      smtp.write('EHLO map-rezi-backend')
      await this.expect(smtp, [250])
      smtp.write('AUTH LOGIN')
      await this.expect(smtp, [334])
      smtp.write(Buffer.from(this.config.smtpUsername).toString('base64'))
      await this.expect(smtp, [334])
      smtp.write(Buffer.from(this.config.smtpPassword).toString('base64'))
      await this.expect(smtp, [235])
      smtp.write(`MAIL FROM:<${this.from}>`)
      await this.expect(smtp, [250])
      smtp.write(`RCPT TO:<${message.to}>`)
      await this.expect(smtp, [250, 251])
      smtp.write('DATA')
      await this.expect(smtp, [354])
      const subject = `=?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`
      const body = [
        `From: ${this.from}`, `To: ${message.to}`, `Subject: ${subject}`,
        'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '',
        message.html.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'), '.',
      ].join('\r\n')
      smtp.write(body)
      await this.expect(smtp, [250])
      smtp.write('QUIT')
      await this.expect(smtp, [221])
    } finally {
      socket.destroy()
    }
  }

  private async expect(session: SmtpSession, expected: number[]): Promise<void> {
    const response = await session.response()
    if (!expected.includes(response.code)) throw new Error(`SMTP error ${response.code}: ${response.text}`)
  }
}
