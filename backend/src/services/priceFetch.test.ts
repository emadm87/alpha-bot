/**
 * Deterministic tests for how prices are requested from Hyperliquid:
 * the six mainstream perps share one fetchTickers call, concurrent requests
 * share the call in flight, and the 30 s cache and price validation are kept.
 *
 * Run: npx tsx --test src/services/priceFetch.test.ts
 *
 * ccxt.hyperliquid is replaced by a fake exchange before the services load,
 * so no network is used. A fake fetchTicker call stands for 12 HTTP requests
 * (ccxt reloads every market kind); the mainstream fetchTickers call asks for
 * perpetuals only since Task 006J-2 and stands for 1 (measured with ccxt).
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}

const provider = {
  prices: {} as Record<string, unknown>,
  fail: false,
  /** The error thrown when `fail` is set: HTTP 429 unless changed. */
  error: () => new ccxt.RateLimitExceeded('429 (simulated)') as Error,
  tickerCalls: 0,
  tickersCalls: 0,
}
const quote = (symbol: string) => {
  const base = symbol.split('/')[0]!
  return { symbol, last: provider.prices[base] }
}
const delay = () => new Promise((r) => setTimeout(r, 20))
;(ccxt as any).hyperliquid = class {
  async fetchTicker(symbol: string) {
    provider.tickerCalls++
    await delay()
    if (provider.fail) throw provider.error()
    return quote(symbol)
  }
  async fetchTickers(symbols: string[]) {
    provider.tickersCalls++
    await delay()
    if (provider.fail) throw provider.error()
    return Object.fromEntries(symbols.map((s) => [s, quote(s)]))
  }
}
const calls = () => provider.tickerCalls + provider.tickersCalls
const http = () => provider.tickerCalls * 12 + provider.tickersCalls

const { getLastPrice, resetPriceRefreshState, RATE_LIMIT_BACKOFF_MS } = await import('./marketData.js')
const { priceCache } = await import('./priceCache.js')
const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')

after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const SIX = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const MARKET = { BTC: 84000, ETH: 2500, SOL: 108, BNB: 750, XRP: 1.4, DOGE: 0.08 }

beforeEach(() => {
  ;(priceCache as any).cache.clear()
  provider.prices = { ...MARKET, HYPE: 40 }
  provider.fail = false
  provider.error = () => new ccxt.RateLimitExceeded('429 (simulated)')
  provider.tickerCalls = 0
  provider.tickersCalls = 0
  resetPriceRefreshState()
})

test('AI cycle: the six prices cost one call (1 HTTP) instead of six (72 HTTP)', async (t) => {
  for (const s of SIX) assert.equal(await getLastPrice(s, 'CRYPTO'), MARKET[s as keyof typeof MARKET])
  t.diagnostic(`calls=${calls()} http=${http()}`)
  assert.equal(calls(), 1)
  assert.equal(http(), 1)
})

test('within the 30 s cache no new call is made', async () => {
  await getLastPrice('BTC', 'CRYPTO')
  for (const s of SIX) await getLastPrice(s, 'CRYPTO')
  assert.equal(calls(), 1)
})

test('expired cache entries are fetched again, never served as fresh', async () => {
  await getLastPrice('BTC', 'CRYPTO')
  for (const entry of (priceCache as any).cache.values()) entry.timestamp -= 31
  provider.prices.BTC = 85000
  assert.equal(await getLastPrice('BTC', 'CRYPTO'), 85000)
  assert.equal(calls(), 2)
})

test('3 concurrent requests for the same symbol share one call', async () => {
  const prices = await Promise.all([1, 2, 3].map(() => getLastPrice('BTC', 'CRYPTO')))
  assert.deepEqual(prices, [84000, 84000, 84000])
  assert.equal(calls(), 1)
})

test('concurrent requests for different symbols get their own prices from one call', async () => {
  const prices = await Promise.all(['BTC', 'ETH', 'DOGE'].map((s) => getLastPrice(s, 'CRYPTO')))
  assert.deepEqual(prices, [84000, 2500, 0.08])
  assert.equal(calls(), 1)
})

test('a 429 rejects every waiting caller, caches nothing, and the next request waits for the pause', async (t) => {
  provider.fail = true
  const results = await Promise.allSettled([1, 2, 3].map(() => getLastPrice('BTC', 'CRYPTO')))
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected'])
  assert.equal(calls(), 1)
  assert.equal((priceCache as any).cache.size, 0)

  provider.fail = false
  await assert.rejects(getLastPrice('BTC', 'CRYPTO'), /paused/)
  assert.equal(calls(), 1, 'no request during the pause')
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + RATE_LIMIT_BACKOFF_MS[0]! + 1)
  assert.equal(await getLastPrice('BTC', 'CRYPTO'), 84000)
  assert.equal(calls(), 2)
})

test('any other error rejects every waiting caller and the next request retries at once', async () => {
  provider.fail = true
  provider.error = () => new Error('network error (simulated)')
  const results = await Promise.allSettled([1, 2, 3].map(() => getLastPrice('BTC', 'CRYPTO')))
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected'])
  assert.equal(calls(), 1)

  provider.fail = false
  assert.equal(await getLastPrice('BTC', 'CRYPTO'), 84000)
  assert.equal(calls(), 2)
})

test('invalid prices are rejected per symbol and never cached', async () => {
  provider.prices = { ...MARKET, ETH: null, SOL: 0, BNB: -5, XRP: Number.NaN }
  assert.equal(await getLastPrice('BTC', 'CRYPTO'), 84000)
  for (const s of ['ETH', 'SOL', 'BNB', 'XRP']) {
    await assert.rejects(getLastPrice(s, 'CRYPTO'), /invalid price/)
  }
  assert.equal(await getLastPrice('DOGE', 'CRYPTO'), 0.08)
  const cached = [...(priceCache as any).cache.keys()].map((k: string) => k.split('\0')[0])
  assert.deepEqual(cached.sort(), ['BTC', 'DOGE'])
})

test('other symbols keep the single-ticker request, deduplicated', async () => {
  const prices = await Promise.all([1, 2].map(() => getLastPrice('HYPE', 'CRYPTO')))
  assert.deepEqual(prices, [40, 40])
  assert.equal(provider.tickerCalls, 1)
  assert.equal(provider.tickersCalls, 0)
})

test('margin monitor with 3 open positions makes one call', async () => {
  ensureSchema()
  const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
  const id = db
    .insert(accounts)
    .values({ userId: user.id, name: 'p', accountType: 'AI', apiKey: 'x', initialCapital: 1000, currentCash: 1000 })
    .returning()
    .get().id
  for (const [s, q] of [['BTC', 0.001], ['ETH', 0.1], ['SOL', 1]] as const) {
    await placeAndExecuteCrypto({
      account: db.select().from(accounts).where(eq(accounts.id, id)).get()!,
      symbol: s, name: s, side: 'LONG', orderType: 'MARKET', price: null, quantity: q, leverage: 2,
    })
  }
  ;(priceCache as any).cache.clear()
  provider.tickerCalls = 0
  provider.tickersCalls = 0
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(calls(), 1)
})
