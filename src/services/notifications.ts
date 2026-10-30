import { execute, query } from '../database/db'
import { getConfig } from '../config'
import { logger } from '../utils/logger'
import { createNotificationChannels } from './notifications/channel-factory'

interface NotificationJob { id: string; title: string; organization: string | null; job_url: string; category_id: string }

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export async function sendNewJobNotifications(jobIds: string[]): Promise<void> {
  if (!jobIds.length) return
  const config = getConfig()
  let channels
  try {
    channels = createNotificationChannels(config)
  } catch (error) {
    logger.warn('Job notifications skipped because a configured channel is incomplete', { error: (error as Error).message })
    return
  }
  if (channels.length === 0) {
    logger.info('Job notifications skipped: configure NOTIFICATION_CHANNELS to enable delivery')
    return
  }
  const marks = jobIds.map(() => '?').join(',')
  const matching = await query<any>(
    `SELECT DISTINCT u.id AS user_id, u.email
     FROM users u JOIN user_categories uc ON uc.user_id = u.id AND uc.enabled = 1
     JOIN job_categories jc ON jc.category_id = uc.category_id
     WHERE u.is_active = 1 AND u.notification_opt_in = 1 AND jc.job_id IN (${marks})`, jobIds,
  )
  for (const recipient of matching) {
    const jobs = await query<any>(
      `SELECT DISTINCT j.id, j.title, j.organization, j.job_url, jc.category_id
       FROM jobs j JOIN job_categories jc ON jc.job_id = j.id
       JOIN user_categories uc ON uc.category_id = jc.category_id AND uc.user_id = ? AND uc.enabled = 1
       WHERE j.id IN (${marks}) ORDER BY j.posted_at DESC`, [recipient.user_id, ...jobIds],
    ) as NotificationJob[]
    if (!jobs.length) continue
    try {
      const links = jobs.map((job) => `<li><a href="${escapeHtml(job.job_url)}">${escapeHtml(job.title)}</a>${job.organization ? ` — ${escapeHtml(job.organization)}` : ''}</li>`).join('')
      const message = {
        to: recipient.email,
        subject: `${jobs.length} new job${jobs.length === 1 ? '' : 's'} matching your interests`,
        html: `<p>New jobs match your followed categories:</p><ul>${links}</ul>`,
      }
      let delivered = false
      for (const channel of channels) {
        try {
          await channel.send(message)
          delivered = true
        } catch (error) {
          logger.error('Notification channel failed', { channel: channel.name, userId: recipient.user_id, error: (error as Error).message })
        }
      }
      if (!delivered) continue
      const now = new Date()
      await execute(
        `INSERT INTO notification_history (id, user_id, job_count, jobs, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), recipient.user_id, jobs.length, JSON.stringify(jobs.map(({ id, title, organization, job_url }) => ({ id, title, organization, job_url }))), now, now],
      )
    } catch (error) {
      logger.error('Job notification failed for recipient', { userId: recipient.user_id, error: (error as Error).message })
    }
  }
}
