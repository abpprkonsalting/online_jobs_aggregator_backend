export interface RateLimiter {
  acquire(): Promise<void>
  reset(): void
}

export class TokenBucketRateLimiter implements RateLimiter {
  private tokens: number
  private lastRefill: number
  private readonly capacity: number
  private readonly refillPerMs: number
  private pendingWait: Promise<void> | null = null

  constructor(capacity: number, refillPerMs: number) {
    this.capacity = capacity
    this.refillPerMs = refillPerMs
    this.tokens = capacity
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
      this.lastRefill = now
    }
  }

  async acquire(): Promise<void> {
    // Chain onto any pending wait to serialize concurrent callers
    const currentWait = this.pendingWait
    this.pendingWait = (async () => {
      try {
        await currentWait
      } catch {
        // previous wait failed/rejected; continue anyway
      }

      this.refill()
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      this.refill()
      this.tokens = Math.max(0, this.tokens - 1)
    })()

    await this.pendingWait
  }

  reset(): void {
    this.tokens = this.capacity
    this.lastRefill = Date.now()
    this.pendingWait = null
  }
}

export class FixedDelayRateLimiter implements RateLimiter {
  private lastAcquire: number = 0
  private readonly delayMs: number
  private pendingWait: Promise<void> | null = null

  constructor(delayMs: number) {
    this.delayMs = delayMs
  }

  async acquire(): Promise<void> {
    const currentWait = this.pendingWait
    this.pendingWait = (async () => {
      try {
        await currentWait
      } catch {
        // continue anyway
      }

      const now = Date.now()
      const waitMs = Math.max(0, this.lastAcquire + this.delayMs - now)
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
      this.lastAcquire = Date.now()
    })()

    await this.pendingWait
  }

  reset(): void {
    this.lastAcquire = 0
    this.pendingWait = null
  }
}

export function createRateLimiter(config: Record<string, unknown>): RateLimiter {
  const apiDelay = (config.api_delay as number) ?? 0
  if (apiDelay > 0) {
    return new FixedDelayRateLimiter(apiDelay * 1000)
  }
  return new TokenBucketRateLimiter(10, 1)
}