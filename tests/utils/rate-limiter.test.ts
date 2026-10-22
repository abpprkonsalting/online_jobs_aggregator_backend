import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, FixedDelayRateLimiter, TokenBucketRateLimiter } from '../../src/utils/rate-limiter'

describe('rate limiters', () => {
  afterEach(() => vi.useRealTimers())

  it('allows requests up to token-bucket capacity immediately', async () => {
    const limiter = new TokenBucketRateLimiter(2, 1000)

    await expect(limiter.acquire()).resolves.toBeUndefined()
    await expect(limiter.acquire()).resolves.toBeUndefined()
  })

  it('refills consumed tokens and reset restores the configured capacity', async () => {
    vi.useFakeTimers()
    const limiter = new TokenBucketRateLimiter(1, 10)
    await limiter.acquire()

    const waiting = limiter.acquire()
    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toBeUndefined()

    limiter.reset()
    await expect(limiter.acquire()).resolves.toBeUndefined()
  })

  it('serializes fixed-delay acquisitions and reset removes the prior delay', async () => {
    vi.useFakeTimers()
    const limiter = new FixedDelayRateLimiter(100)
    await limiter.acquire()

    const waiting = limiter.acquire()
    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toBeUndefined()

    limiter.reset()
    await expect(limiter.acquire()).resolves.toBeUndefined()
  })

  it('selects fixed delay when api_delay is configured and token bucket otherwise', async () => {
    expect(createRateLimiter({ api_delay: 2 })).toBeInstanceOf(FixedDelayRateLimiter)
    expect(createRateLimiter({ api_delay: 0 })).toBeInstanceOf(TokenBucketRateLimiter)
    expect(createRateLimiter({})).toBeInstanceOf(TokenBucketRateLimiter)
  })
})
