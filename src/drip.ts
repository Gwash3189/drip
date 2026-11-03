import { DripRateLimitError } from './errors'

export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd'
export type DurationString = `${number}${DurationUnit}` | string
export type DurationInput = number | DurationString

export type DripEvent = 'limited' | 'throttled'

export type LimitedHandler = (error: DripRateLimitError, key: string) => void | Promise<void>
export type ThrottledHandler = (waitMs: number, key: string) => void | Promise<void>
export type WorkFn<T = unknown> = () => Promise<T> | T

export interface DripConfig {
  /**
   * Maximum number of allowed requests/tokens within the `per` interval.
   */
  allow: number
  /**
   * Time window in milliseconds or human-readable duration string (e.g. '100ms', '1s', '1m', '1h', '1d').
   */
  per: DurationInput
  /**
   * Maximum time in milliseconds (or duration string) to wait for a token before rejecting with DripRateLimitError.
   * Defaults to 0 (reject immediately when rate-limited).
   */
  wait?: DurationInput
  /**
   * Optional callback invoked when a request is rejected due to rate limiting.
   */
  onLimited?: LimitedHandler
  /**
   * Optional callback invoked when a request has to wait for a token.
   */
  onThrottled?: ThrottledHandler
}

export interface DripStatus {
  key: string
  remaining: number
  retryAfterMs: number
}

const DURATION_MULTIPLIERS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/

export function parseDuration(input: DurationInput, fieldName = 'per'): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) {
      throw new RangeError(`${fieldName} must be a positive number`)
    }
    return input
  }

  const match = DURATION_REGEX.exec(input.trim())
  if (!match) {
    throw new RangeError(`Invalid duration string for ${fieldName}: "${input}"`)
  }

  const value = Number(match[1])
  const unit = match[2] as DurationUnit
  const ms = value * DURATION_MULTIPLIERS[unit]

  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`${fieldName} duration must be greater than 0`)
  }

  return ms
}

function parseWaitDuration(input: DurationInput): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new RangeError('wait must be a non-negative number')
    }
    return input
  }

  return parseDuration(input, 'wait')
}

function validateKey(key: string): void {
  if (!key || key.trim().length === 0) {
    throw new RangeError('rate limit key must be a non-empty string')
  }
}

function validateAllow(allow: number): void {
  if (!Number.isInteger(allow) || allow < 1) {
    throw new RangeError('allow must be an integer of at least 1')
  }
}

interface BucketEntry {
  timestamps: number[]
}

const buckets = new Map<string, BucketEntry>()

function getOrCreateBucket(key: string): BucketEntry {
  let entry = buckets.get(key)
  if (!entry) {
    entry = { timestamps: [] }
    buckets.set(key, entry)
  }
  return entry
}

function pruneExpiredTimestamps(entry: BucketEntry, now: number, perMs: number): void {
  const cutoff = now - perMs
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireTokens(
  key: string,
  allow: number,
  perMs: number,
  waitMs: number,
  count: number,
  limitedHandlers: LimitedHandler[],
  throttledHandlers: ThrottledHandler[]
): Promise<DripStatus> {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('token count must be an integer of at least 1')
  }
  if (count > allow) {
    throw new RangeError(`token count (${count}) cannot exceed allow (${allow})`)
  }

  const entry = getOrCreateBucket(key)
  const now = Date.now()
  pruneExpiredTimestamps(entry, now, perMs)

  const activeCount = entry.timestamps.length
  if (activeCount + count <= allow) {
    for (let i = 0; i < count; i++) {
      entry.timestamps.push(now)
    }
    return {
      key,
      remaining: Math.max(0, allow - entry.timestamps.length),
      retryAfterMs: 0,
    }
  }

  const unblockIndex = activeCount + count - allow - 1
  const blockingTimestamp = entry.timestamps[unblockIndex] ?? now
  const availableAt = blockingTimestamp + perMs
  const retryAfterMs = Math.max(1, availableAt - now)

  if (waitMs <= 0 || retryAfterMs > waitMs) {
    const error = new DripRateLimitError(key, retryAfterMs)
    for (const handler of limitedHandlers) {
      await handler(error, key)
    }
    throw error
  }

  for (let i = 0; i < count; i++) {
    entry.timestamps.push(availableAt)
  }

  for (const handler of throttledHandlers) {
    await handler(retryAfterMs, key)
  }

  await sleep(retryAfterMs)

  const afterWaitNow = Date.now()
  pruneExpiredTimestamps(entry, afterWaitNow, perMs)

  return {
    key,
    remaining: Math.max(0, allow - entry.timestamps.length),
    retryAfterMs,
  }
}

interface BuilderConfig<T = unknown> {
  key: string
  allow: number
  perMs: number
  waitMs: number
  workFn?: WorkFn<T>
  limitedHandlers: LimitedHandler[]
  throttledHandlers: ThrottledHandler[]
}

export class DripBuilder<T = unknown> implements PromiseLike<T> {
  private readonly config: BuilderConfig<T>
  private executionPromise?: Promise<T>

  constructor(config?: Partial<BuilderConfig<T>>) {
    this.config = {
      key: config?.key ?? 'default',
      allow: config?.allow ?? 10,
      perMs: config?.perMs ?? 1_000,
      waitMs: config?.waitMs ?? 0,
      workFn: config?.workFn,
      limitedHandlers: [...(config?.limitedHandlers ?? [])],
      throttledHandlers: [...(config?.throttledHandlers ?? [])],
    }
  }

  key(key: string): DripBuilder<T> {
    validateKey(key)
    return new DripBuilder<T>({ ...this.config, key })
  }

  for(key: string): DripBuilder<T> {
    return this.key(key)
  }

  allow(count: number): DripBuilder<T> {
    validateAllow(count)
    return new DripBuilder<T>({ ...this.config, allow: count })
  }

  per(duration: DurationInput): DripBuilder<T> {
    const perMs = parseDuration(duration, 'per')
    return new DripBuilder<T>({ ...this.config, perMs })
  }

  wait(duration: DurationInput): DripBuilder<T> {
    const waitMs = parseWaitDuration(duration)
    return new DripBuilder<T>({ ...this.config, waitMs })
  }

  work<R>(fn: WorkFn<R>): DripBuilder<R> {
    return new DripBuilder<R>({
      ...(this.config as unknown as BuilderConfig<R>),
      workFn: fn,
    })
  }

  on(event: 'limited', handler: LimitedHandler): DripBuilder<T>
  on(event: 'throttled', handler: ThrottledHandler): DripBuilder<T>
  on(event: DripEvent, handler: LimitedHandler | ThrottledHandler): DripBuilder<T> {
    switch (event) {
      case 'limited':
        return new DripBuilder<T>({
          ...this.config,
          limitedHandlers: [...this.config.limitedHandlers, handler as LimitedHandler],
        })
      case 'throttled':
        return new DripBuilder<T>({
          ...this.config,
          throttledHandlers: [...this.config.throttledHandlers, handler as ThrottledHandler],
        })
    }
  }

  get remaining(): number {
    const entry = getOrCreateBucket(this.config.key)
    pruneExpiredTimestamps(entry, Date.now(), this.config.perMs)
    return Math.max(0, this.config.allow - entry.timestamps.length)
  }

  async consume(count = 1): Promise<DripStatus> {
    return acquireTokens(
      this.config.key,
      this.config.allow,
      this.config.perMs,
      this.config.waitMs,
      count,
      this.config.limitedHandlers,
      this.config.throttledHandlers
    )
  }

  reset(key?: string): void {
    buckets.delete(key ?? this.config.key)
  }

  resetAll(): void {
    buckets.clear()
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null | undefined,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined
  ): Promise<TResult1 | TResult2> {
    if (!this.executionPromise) {
      this.executionPromise = this.execute()
    }
    return this.executionPromise.then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null | undefined
  ): Promise<T | TResult> {
    return this.then(undefined, onrejected)
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.then(
      (value) => {
        onfinally?.()
        return value
      },
      (reason) => {
        onfinally?.()
        throw reason
      }
    )
  }

  private async execute(): Promise<T> {
    const { key, allow, perMs, waitMs, workFn, limitedHandlers, throttledHandlers } = this.config

    if (!workFn) {
      throw new Error('No work function provided. Call .work(fn) before awaiting.')
    }

    await acquireTokens(key, allow, perMs, waitMs, 1, limitedHandlers, throttledHandlers)
    return await workFn()
  }
}

export function drip(key: string, config: DripConfig): Promise<DripStatus>
export function drip<T>(key: string, config: DripConfig, callback: WorkFn<T>): Promise<T>
export async function drip<T>(
  key: string,
  config: DripConfig,
  callback?: WorkFn<T>
): Promise<T | DripStatus> {
  validateKey(key)
  validateAllow(config.allow)
  const perMs = parseDuration(config.per, 'per')
  const waitMs = config.wait !== undefined ? parseWaitDuration(config.wait) : 0
  const limitedHandlers = config.onLimited ? [config.onLimited] : []
  const throttledHandlers = config.onThrottled ? [config.onThrottled] : []

  const status = await acquireTokens(
    key,
    config.allow,
    perMs,
    waitMs,
    1,
    limitedHandlers,
    throttledHandlers
  )

  if (callback) {
    return await callback()
  }

  return status
}

export async function consume(key: string, config: DripConfig, count = 1): Promise<DripStatus> {
  validateKey(key)
  validateAllow(config.allow)
  const perMs = parseDuration(config.per, 'per')
  const waitMs = config.wait !== undefined ? parseWaitDuration(config.wait) : 0
  const limitedHandlers = config.onLimited ? [config.onLimited] : []
  const throttledHandlers = config.onThrottled ? [config.onThrottled] : []

  return acquireTokens(key, config.allow, perMs, waitMs, count, limitedHandlers, throttledHandlers)
}

export function resetDrip(key?: string): void {
  if (key !== undefined) {
    buckets.delete(key)
  } else {
    buckets.clear()
  }
}

export const Drip: DripBuilder = new DripBuilder()
export const RateLimit: DripBuilder = Drip

export default Drip
