export interface NotificationMessage {
  to: string
  subject: string
  html: string
}

export interface NotificationChannelDriver {
  readonly name: string
  send(message: NotificationMessage): Promise<void>
}
