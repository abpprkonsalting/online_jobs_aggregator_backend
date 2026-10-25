export class UpstreamRateLimitError extends Error {
  public readonly retryAfterMs: number

  constructor(retryAfterMs: number, message = 'Rate limited by upstream') {
    super(message)
    this.name = 'UpstreamRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

export class UpstreamTransientError extends Error {
  public readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'UpstreamTransientError'
    this.statusCode = statusCode
  }
}

export function isRetryableError(err: unknown): err is UpstreamRateLimitError | UpstreamTransientError {
  return err instanceof UpstreamRateLimitError || err instanceof UpstreamTransientError
}