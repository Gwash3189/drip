import { describe, expect, it } from 'vitest'
import Drip, {
  consume,
  drip,
  DripError,
  DripRateLimitError,
  parseDuration,
  RateLimit,
  resetDrip,
} from '../src'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('Drip', () => {
  describe('.key', () => {
    describe('when tokens are available in the window', () => {
      it('executes the work function and returns the result immediately', async () => {
        const result = await Drip.key('allow-immediate')
          .allow(5)
          .per('1s')
          .work(async () => 'ok')

        expect(result).toBe('ok')
      })

      it('decrements the remaining tokens count', async () => {
        const limiter = Drip.key('decrement-remaining').allow(3).per(5000)

        await limiter.work(async () => 'first')

        expect(limiter.remaining).toBe(2)
      })

      it('isolates rate limits across distinct keys', async () => {
        await Drip.key('isolated-key-a')
          .allow(1)
          .per(5000)
          .work(async () => 'a')

        const resultB = await Drip.key('isolated-key-b')
          .allow(1)
          .per(5000)
          .work(async () => 'b')

        expect(resultB).toBe('b')
      })

      it('replenishes tokens once the sliding window elapses', async () => {
        const key = 'replenish-after-window'

        await Drip.key(key)
          .allow(1)
          .per('25ms')
          .work(async () => 'first')

        await delay(35)

        const second = await Drip.key(key)
          .allow(1)
          .per('25ms')
          .work(async () => 'second')

        expect(second).toBe('second')
      })
    })

    describe('when rate limit is exceeded and wait is not configured', () => {
      it('rejects immediately with DripRateLimitError', async () => {
        const key = 'exceed-no-wait'

        await Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => 'first')

        const secondCall = Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => 'second')

        await expect(secondCall).rejects.toBeInstanceOf(DripRateLimitError)
      })

      it('exposes the key and positive retryAfterMs on DripRateLimitError', async () => {
        const key = 'error-metadata'
        let capturedError: DripRateLimitError | undefined

        await Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => 'first')

        try {
          await Drip.key(key)
            .allow(1)
            .per(5000)
            .work(async () => 'second')
        } catch (error) {
          if (error instanceof DripRateLimitError) {
            capturedError = error
          }
        }

        expect(
          capturedError instanceof DripError &&
            capturedError.key === key &&
            capturedError.retryAfterMs > 0
        ).toBe(true)
      })

      it('does not execute the work function when rejected', async () => {
        const key = 'no-work-on-reject'
        let workCount = 0

        await Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => {
            workCount++
          })

        try {
          await Drip.key(key)
            .allow(1)
            .per(5000)
            .work(async () => {
              workCount++
            })
        } catch {
          // Expected rate limit error
        }

        expect(workCount).toBe(1)
      })

      it('invokes the limited event handler with the error and key', async () => {
        const key = 'limited-event-handler'
        let limitedKey = ''

        await Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => 'first')

        try {
          await Drip.key(key)
            .allow(1)
            .per(5000)
            .on('limited', (_err, k) => {
              limitedKey = k
            })
            .work(async () => 'second')
        } catch {
          // Expected rate limit error
        }

        expect(limitedKey).toBe(key)
      })
    })

    describe('when rate limit is exceeded and wait is configured', () => {
      it('waits for the next available token and executes work when within wait budget', async () => {
        const key = 'wait-within-budget'

        await Drip.key(key)
          .allow(1)
          .per(30)
          .work(async () => 'first')

        const secondResult = await Drip.key(key)
          .allow(1)
          .per(30)
          .wait(200)
          .work(async () => 'after-wait')

        expect(secondResult).toBe('after-wait')
      })

      it('invokes the throttled event handler with waitMs and key', async () => {
        const key = 'throttled-event-handler'
        let recordedWaitMs = 0

        await Drip.key(key)
          .allow(1)
          .per(30)
          .work(async () => 'first')

        await Drip.key(key)
          .allow(1)
          .per(30)
          .wait('200ms')
          .on('throttled', (waitMs) => {
            recordedWaitMs = waitMs
          })
          .work(async () => 'second')

        expect(recordedWaitMs).toBeGreaterThan(0)
      })

      it('rejects immediately if required wait time exceeds configured wait budget', async () => {
        const key = 'wait-exceeds-budget'

        await Drip.key(key)
          .allow(1)
          .per(5000)
          .work(async () => 'first')

        const secondCall = Drip.key(key)
          .allow(1)
          .per(5000)
          .wait(20)
          .work(async () => 'second')

        await expect(secondCall).rejects.toBeInstanceOf(DripRateLimitError)
      })
    })

    describe('when invalid configuration is provided', () => {
      it('throws a RangeError when key is empty or whitespace', () => {
        expect(() => Drip.key('   ')).toThrow(RangeError)
      })

      it('throws a RangeError when allow is less than 1', () => {
        expect(() => Drip.key('bad-allow').allow(0)).toThrow(RangeError)
      })

      it('throws a RangeError when per is zero or negative', () => {
        expect(() => Drip.key('bad-per-num').per(0)).toThrow(RangeError)
      })

      it('throws a RangeError when per is an invalid duration string', () => {
        expect(() => Drip.key('bad-per-str').per('10weeks')).toThrow(RangeError)
      })

      it('throws a RangeError when per duration string evaluates to 0', () => {
        expect(() => Drip.key('bad-per-zero-str').per('0s')).toThrow(RangeError)
      })

      it('throws a RangeError when wait is negative', () => {
        expect(() => Drip.key('bad-wait').wait(-5)).toThrow(RangeError)
      })
    })
  })

  describe('.for and RateLimit alias', () => {
    describe('when using .for on RateLimit', () => {
      it('configures the key and executes the work function', async () => {
        const value = await RateLimit.for('for-alias-key')
          .allow(2)
          .per('1m')
          .work(() => 42)

        expect(value).toBe(42)
      })
    })
  })

  describe('.consume', () => {
    describe('when consuming tokens directly via builder', () => {
      it('consumes the specified token count and returns remaining status', async () => {
        const status = await Drip.key('builder-consume').allow(5).per('1h').consume(3)

        expect(status.remaining).toBe(2)
      })

      it('throws a RangeError when token count is less than 1', async () => {
        const call = Drip.key('consume-zero').allow(5).per('1s').consume(0)

        await expect(call).rejects.toThrow(RangeError)
      })

      it('throws a RangeError when token count exceeds allow', async () => {
        const call = Drip.key('consume-too-many').allow(3).per('1s').consume(4)

        await expect(call).rejects.toThrow(RangeError)
      })
    })
  })

  describe('.reset and .resetAll', () => {
    describe('when resetting rate limit state', () => {
      it('restores full capacity for a single key with .reset()', async () => {
        const limiter = Drip.key('reset-single-key').allow(1).per('1d')

        await limiter.consume()
        limiter.reset()

        expect(limiter.remaining).toBe(1)
      })

      it('clears all keys when .resetAll() is called', async () => {
        const limiter = Drip.key('reset-all-keys').allow(1).per(60_000)

        await limiter.consume()
        limiter.resetAll()

        expect(limiter.remaining).toBe(1)
      })
    })
  })

  describe('drip', () => {
    describe('when called with a callback function', () => {
      it('acquires a token and returns the callback result', async () => {
        const output = await drip('fn-with-cb', { allow: 2, per: 1000, wait: 0 }, async () => {
          return 'direct-result'
        })

        expect(output).toBe('direct-result')
      })

      it('invokes onLimited and onThrottled callbacks from config', async () => {
        const key = 'fn-config-callbacks'
        const events: string[] = []

        await drip(key, { allow: 1, per: 25 })

        await drip(key, {
          allow: 1,
          per: 25,
          wait: 100,
          onThrottled: () => {
            events.push('throttled')
          },
        })

        try {
          await drip(key, {
            allow: 1,
            per: 5000,
            onLimited: () => {
              events.push('limited')
            },
          })
        } catch {
          // Expected limited error
        }

        expect(events).toEqual(['throttled', 'limited'])
      })
    })

    describe('when called without a callback function', () => {
      it('consumes one token and returns the DripStatus', async () => {
        const status = await drip('fn-without-cb', { allow: 4, per: '10s' })

        expect(status.remaining).toBe(3)
      })
    })
  })

  describe('consume and resetDrip', () => {
    describe('when using standalone consume and resetDrip helpers', () => {
      it('consumes multiple tokens and resets specific key state', async () => {
        const key = 'standalone-consume-reset'

        await consume(key, { allow: 2, per: 10_000, wait: 0 }, 2)
        resetDrip(key)
        const statusAfterReset = await consume(key, { allow: 2, per: 10_000 })

        expect(statusAfterReset.remaining).toBe(1)
      })

      it('clears all buckets when resetDrip is called without arguments', async () => {
        const key = 'standalone-reset-all'

        await consume(key, { allow: 1, per: 10_000 })
        resetDrip()
        const status = await consume(key, { allow: 1, per: 10_000 })

        expect(status.remaining).toBe(0)
      })
    })
  })

  describe('parseDuration', () => {
    describe('when parsing duration strings across all supported units', () => {
      it('converts ms, s, m, h, and d strings to milliseconds', () => {
        const values = [
          parseDuration('250ms'),
          parseDuration('2s'),
          parseDuration('1m'),
          parseDuration('1h'),
          parseDuration('1d'),
        ]

        expect(values).toEqual([250, 2_000, 60_000, 3_600_000, 86_400_000])
      })
    })
  })

  describe('#catch and #finally', () => {
    describe('when chaining promise methods on the Drip builder', () => {
      it('catches errors via .catch()', async () => {
        const fallback = await Drip.key('catch-chain')
          .allow(1)
          .per(1000)
          .work(async () => {
            throw new Error('work failed')
          })
          .catch(() => 'recovered')

        expect(fallback).toBe('recovered')
      })

      it('runs .finally() handler on resolution and rejection', async () => {
        let count = 0

        await Drip.key('finally-resolve')
          .allow(2)
          .per(1000)
          .work(async () => 'ok')
          .finally(() => {
            count++
          })

        try {
          await Drip.key('finally-reject')
            .allow(2)
            .per(1000)
            .work(async () => {
              throw new Error('fail')
            })
            .finally(() => {
              count++
            })
        } catch {
          // Expected rejection
        }

        expect(count).toBe(2)
      })

      it('rejects when awaited without configuring a work function', async () => {
        const builder = Drip.key('missing-work').allow(1).per(1000)

        await expect(builder).rejects.toThrow('No work function provided')
      })
    })
  })
})
