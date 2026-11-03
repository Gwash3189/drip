export class DripError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DripError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class DripRateLimitError extends DripError {
  readonly key: string
  readonly retryAfterMs: number

  constructor(key: string, retryAfterMs: number) {
    super(`Rate limit exceeded for key "${key}". Retry after ${Math.ceil(retryAfterMs)}ms.`)
    this.name = 'DripRateLimitError'
    this.key = key
    this.retryAfterMs = retryAfterMs
  }
}
