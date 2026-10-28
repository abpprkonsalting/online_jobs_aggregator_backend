import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createPool, pool, connection } = vi.hoisted(() => ({
  createPool: vi.fn(),
  pool: {
    query: vi.fn(),
    getConnection: vi.fn(),
    end: vi.fn(),
  },
  connection: {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  },
}))

vi.mock('mysql2/promise', () => ({ createPool }))

describe('database pool and transaction lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    createPool.mockReturnValue(pool)
    pool.query.mockResolvedValue([[], []])
    pool.getConnection.mockResolvedValue(connection)
    pool.end.mockResolvedValue(undefined)
    connection.beginTransaction.mockResolvedValue(undefined)
    connection.commit.mockResolvedValue(undefined)
    connection.rollback.mockResolvedValue(undefined)
  })

  it('creates a single pool shared by getPool() and getDriver()', async () => {
    const db = await import('../../src/database/db')
    const rows = [{ id: 'row-1' }]
    const result = { affectedRows: 1 }
    pool.query
      .mockResolvedValueOnce([rows, []])
      .mockResolvedValueOnce([result, []])

    expect(db.getPool()).toBe(pool)
    expect(db.getPool()).toBe(pool)
    await expect(db.query('SELECT ?', ['value'])).resolves.toBe(rows)
    await expect(db.execute('UPDATE jobs SET title = ?', ['title'])).resolves.toBe(result)

    expect(createPool).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT ?', ['value'])
    expect(pool.query).toHaveBeenNthCalledWith(2, 'UPDATE jobs SET title = ?', ['title'])
  })

  it('getDriver() reuses the getPool() pool (singleton driver)', async () => {
    const db = await import('../../src/database/db')

    expect(db.getDriver()).toBe(db.getDriver())
    expect(createPool).toHaveBeenCalledTimes(1)
  })

  it('commits successful transactions and always releases the connection', async () => {
    const db = await import('../../src/database/db')

    await expect(db.transaction(async () => 'result')).resolves.toBe('result')

    expect(connection.beginTransaction).toHaveBeenCalledOnce()
    expect(connection.commit).toHaveBeenCalledOnce()
    expect(connection.rollback).not.toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('rolls back failed transactions, rethrows the failure, and releases the connection', async () => {
    const db = await import('../../src/database/db')
    const failure = new Error('write failed')

    await expect(db.transaction(async () => {
      throw failure
    })).rejects.toBe(failure)

    expect(connection.rollback).toHaveBeenCalledOnce()
    expect(connection.commit).not.toHaveBeenCalled()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('closes and clears the shared pool idempotently', async () => {
    const db = await import('../../src/database/db')
    db.getPool()
    db.getDriver()

    await db.closePool()
    await db.closePool()

    expect(pool.end).toHaveBeenCalledOnce()
    expect(createPool).toHaveBeenCalledTimes(1)

    // re-initialization creates a fresh pool
    expect(db.getPool()).toBe(pool)
    expect(createPool).toHaveBeenCalledTimes(2)
  })
})
