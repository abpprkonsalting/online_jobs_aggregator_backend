import { beforeEach, describe, expect, it, vi } from 'vitest'

const { query, execute, channel } = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  channel: { name: 'fake', send: vi.fn() },
}))

vi.mock('../../src/database/db', () => ({ query, execute }))
vi.mock('../../src/config', () => ({
  getConfig: () => ({ notificationChannels: ['fake'] }),
}))
vi.mock('../../src/services/notifications/channel-factory', () => ({
  createNotificationChannels: () => [channel],
}))

import { sendNewJobNotifications } from '../../src/services/notifications'

describe('sendNewJobNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue([])
    execute.mockResolvedValue(undefined)
    channel.send.mockResolvedValue(undefined)
  })

  it('sends one consolidated email per subscribed opted-in user and records its history', async () => {
    query
      .mockResolvedValueOnce([{ user_id: 'user-1', email: 'user@example.test' }])
      .mockResolvedValueOnce([
        { id: 'job-1', title: 'Platform Engineer', organization: 'Example Co', job_url: 'https://jobs.example.test/1' },
        { id: 'job-2', title: 'Data Engineer', organization: 'Example Co', job_url: 'https://jobs.example.test/2' },
      ])

    await sendNewJobNotifications(['job-1', 'job-2'])

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][0]).toContain('u.notification_opt_in = 1')
    expect(query.mock.calls[0][0]).toContain('uc.enabled = 1')
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.test',
      subject: '2 new jobs matching your interests',
      html: expect.stringContaining('Platform Engineer'),
    }))
    expect(channel.send.mock.calls[0][0].html).toContain('Data Engineer')
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO notification_history'),
      [expect.any(String), 'user-1', 2, expect.stringContaining('job-1'), expect.any(Date), expect.any(Date)],
    )
  })

  it('does not contact a channel when no opted-in subscribed users match', async () => {
    await sendNewJobNotifications(['job-1'])
    expect(query).toHaveBeenCalledTimes(1)
    expect(channel.send).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('does nothing for an empty new-job batch', async () => {
    await sendNewJobNotifications([])
    expect(query).not.toHaveBeenCalled()
    expect(channel.send).not.toHaveBeenCalled()
  })

  it('continues with other recipients when a channel delivery fails', async () => {
    query
      .mockResolvedValueOnce([
        { user_id: 'user-1', email: 'one@example.test' },
        { user_id: 'user-2', email: 'two@example.test' },
      ])
      .mockResolvedValueOnce([{ id: 'job-1', title: 'Engineer', organization: null, job_url: 'https://jobs.example.test/1' }])
      .mockResolvedValueOnce([{ id: 'job-1', title: 'Engineer', organization: null, job_url: 'https://jobs.example.test/1' }])
    channel.send.mockRejectedValueOnce(new Error('smtp unavailable')).mockResolvedValueOnce(undefined)

    await sendNewJobNotifications(['job-1'])

    expect(channel.send).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1][1]).toBe('user-2')
  })
})
