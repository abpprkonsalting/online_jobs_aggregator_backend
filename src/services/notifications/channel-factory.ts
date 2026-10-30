import type { Config } from '../../config'
import type { NotificationChannelDriver } from './channel'
import { SmtpNotificationChannel } from './smtp-channel'

export function createNotificationChannels(config: Config): NotificationChannelDriver[] {
  const drivers: NotificationChannelDriver[] = []
  for (const name of config.notificationChannels) {
    switch (name) {
      case 'smtp':
        drivers.push(new SmtpNotificationChannel(config))
        break
      default:
        throw new Error(`Unsupported NOTIFICATION_CHANNELS entry: ${name}`)
    }
  }
  return drivers
}

export type { NotificationChannelDriver, NotificationMessage } from './channel'
