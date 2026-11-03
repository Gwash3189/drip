# drip

A lightweight, fluent TypeScript library for keyed rate limiting and throttling using a sliding window / token bucket algorithm. Zero runtime dependencies.

## Features

- **Fluent Builder & Functional APIs**: Chain `.key()`, `.allow()`, `.per()`, `.wait()`, `.work()`, and `.on()` or call `drip(key, config, fn)` directly.
- **Human-Readable Durations**: Pass milliseconds (`1000`) or duration strings (`'500ms'`, `'1s'`, `'1m'`, `'1h'`, `'1d'`).
- **Fail-Fast or Queue with Wait Budget**: Reject immediately with `DripRateLimitError` when capacity is exhausted, or configure `.wait(ms)` to queue callers until the next token arrives.
- **Lifecycle Hooks**: Subscribe to `'limited'` and `'throttled'` events for metrics, logging, or observability.
- **Dual ESM / CJS Package**: Built with `tsdown` with full TypeScript type declarations.

## Installation

```bash
npm install drip
```

## Usage

### Fluent Builder API

```ts
import Drip from 'drip'

const result = await Drip.key(`api:${orgId}`)
  .allow(100)
  .per('1m')
  .wait(5_000)
  .on('throttled', (waitMs, key) => {
    console.log(`Throttling ${key} for ${waitMs}ms`)
  })
  .on('limited', (err, key) => {
    console.warn(`Rate limited ${key}, retry after ${err.retryAfterMs}ms`)
  })
  .work(async () => {
    return await callExternalApi()
  })
```

### Direct Function API

```ts
import { drip } from 'drip'

const result = await drip(
  `api:${orgId}`,
  { allow: 10, per: '1s', wait: 500 },
  async () => {
    return await callExternalApi()
  }
)
```

### Consuming Tokens Without a Callback

```ts
import Drip, { consume } from 'drip'

// Via builder
const status = await Drip.key('user:123').allow(10).per('1m').consume(1)
console.log(status.remaining) // 9

// Or standalone function
const nextStatus = await consume('user:123', { allow: 10, per: '1m' }, 2)
console.log(nextStatus.remaining) // 7
```

### Error Handling

When a rate limit is exceeded and cannot be satisfied within the `wait` window, `DripRateLimitError` is thrown:

```ts
import Drip, { DripRateLimitError } from 'drip'

try {
  await Drip.key('export:job').allow(1).per('10s').work(() => runExport())
} catch (error) {
  if (error instanceof DripRateLimitError) {
    console.error(`Rate limit hit for ${error.key}. Retry after ${error.retryAfterMs}ms.`)
  }
}
```

### Resetting State

```ts
import Drip, { resetDrip } from 'drip'

// Reset a specific key
resetDrip('api:org-1')
Drip.key('api:org-1').reset()

// Reset all rate limiters
resetDrip()
Drip.resetAll()
```

## License

MIT
