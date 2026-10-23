/**
 * Deterministic tests for the quantitative snapshot (quantData.ts) and for
 * the unchanged price paths around it.
 *
 * Run: npx tsx --test src/services/quantData.test.ts
 *
 * ccxt.hyperliquid is a fake exchange counting fetchTickers and
 * candleSnapshot calls; candles are generated per coin and interval, with the
 * bar still forming deliberately absurd (close x10) so any use of it shows.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quant-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}

const BASE: Record<string, number> = { BTC: 81000, ETH: 2400, SOL: 103, BNB: 740, XRP: 1.3, DOGE: 0.079 }
const INTERVAL: Record<string, number> = { '15m': 900_000, '4h': 14_400_000 }

type Failure = 'rateLimit' | 'timeout' | 'incomplete'
const provider = {
  tickersCalls: 0,
  tickerCalls: 0,
  candleCalls: [] as { coin: string; interval: string; startTime: number; endTime: number }[],
  /** coin:interval -> failure mode */
  fail: new Map<string, Failure>(),
  /** coin:interval -> number of closed bars to return */
  history: new Map<string, number>(),
  /** coin -> ctx overrides; null removes the symbol from the response */
  ctx: new Map<string, Record<string, unknown> | null>(),
}

function ctxFor(coin: string): Record<string, unknown> {
  const mid = BASE[coin]!
  return {
    name: coin, midPx: String(mid), markPx: String(mid * 1.0001), prevDayPx: String(mid / 1.02),
    dayNtlVlm: '1000000.5', openInterest: '1234.5', funding: '-0.0000125', oraclePx: String(mid),
  }
}

function bar(coin: string, interval: string, k: number) {
  const b = BASE[coin]!
  const close = b * (1 + 0.02 * Math.sin(k / 5) + 0.0001 * (k % 13))
  const open = b * (1 + 0.02 * Math.sin((k - 1) / 5) + 0.0001 * ((k - 1) % 13))
  const ms = INTERVAL[interval]!
  return {
    t: k * ms, T: k * ms + ms - 1, s: coin, i: interval,
    o: String(open), c: String(close),
    h: String(Math.max(open, close) * 1.001), l: String(Math.min(open, close) * 0.999),
    v: String(100 + (k % 17)), n: 10,
  }
}

const delay = () => new Promise((r) => setTimeout(r, 15))
;(ccxt as any).hyperliquid = class {
  async fetchTicker(symbol: string) {
    provider.tickerCalls++
    return { symbol, last: 40 }
  }
  async fetchTickers(symbols: string[]) {
    provider.tickersCalls++
    await delay()
    const out: Record<string, unknown> = {}
    for (const s of symbols) {
      const coin = s.split('/')[0]!
      const override = provider.ctx.get(coin)
      if (override === null) continue
      const info = { ...ctxFor(coin), ...override }
      out[s] = { symbol: s, last: Number(info.midPx), info }
    }
    return out
  }
  async publicPostInfo(body: { type: string; req: any }) {
    assert.equal(body.type, 'candleSnapshot')
    const { coin, interval, startTime, endTime } = body.req
    provider.candleCalls.push({ coin, interval, startTime, endTime })
    await delay()
    const mode = provider.fail.get(`${coin}:${interval}`)
    if (mode === 'rateLimit') throw new ccxt.RateLimitExceeded('hyperliquid 429 Too Many Requests')
    if (mode === 'timeout') throw new ccxt.RequestTimeout('hyperliquid request timed out')
    if (mode === 'incomplete') return { status: 'partial' }
    const ms = INTERVAL[interval]!
    const formingK = Math.floor(endTime / ms)
    let first = Math.ceil(startTime / ms)
    const limit = provider.history.get(`${coin}:${interval}`)
    if (limit !== undefined) first = formingK - limit
    const rows = []
    for (let k = first; k < formingK; k++) rows.push(bar(coin, interval, k))
    const forming = bar(coin, interval, formingK)
    rows.push({ ...forming, c: String(BASE[coin]! * 10), h: String(BASE[coin]! * 10) })
    return rows
  }
}

const { getQuantSnapshots, parseCandles, resetQuantData, tickerSnapshot, BARS, CLOSE_GRACE_MS } =
  await import('./quantData.js')
const { getLastPrice } = await import('./marketData.js')
const { priceCache } = await import('./priceCache.js')
const tech = await import('../indicators/technical.js')

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

const SIX = ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP']
// 2026-10-23 20:07:30 UTC: inside the 15m bar opened at 20:00 and the 4h bar opened at 20:00
const NOW = Date.UTC(2026, 9, 23, 20, 7, 30)
const M15 = 900_000
const H4 = 14_400_000

beforeEach(() => {
  resetQuantData()
  ;(priceCache as any).cache.clear()
  provider.tickersCalls = 0
  provider.tickerCalls = 0
  provider.candleCalls = []
  provider.fail.clear()
  provider.history.clear()
  provider.ctx.clear()
})

const candleCount = (interval?: string) =>
  provider.candleCalls.filter((c) => !interval || c.interval === interval).length

/** The closed bars the module should use, as 006D candles. */
function closedBars(coin: string, interval: string, now: number) {
  const ms = INTERVAL[interval]!
  const formingK = Math.floor(now / ms)
  const out = []
  for (let k = formingK - BARS; k < formingK; k++) {
    const r = bar(coin, interval, k)
    out.push({ openTime: r.t, closeTime: r.T, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v })
  }
  return out
}

test('six symbols: one ticker call, 12 candle calls, each snapshot valid and its own', async () => {
  const snaps = await getQuantSnapshots({ now: NOW })
  assert.deepEqual(Object.keys(snaps).sort(), [...SIX].sort())
  assert.equal(provider.tickersCalls, 1)
  assert.equal(candleCount('15m'), 6)
  assert.equal(candleCount('4h'), 6)
  for (const c of provider.candleCalls) {
    const ms = INTERVAL[c.interval]!
    assert.equal(c.endTime, NOW)
    assert.equal(c.startTime, Math.floor(NOW / ms) * ms - BARS * ms)
  }
  for (const coin of SIX) {
    const s = snaps[coin]!
    assert.equal(s.symbol, coin)
    assert.equal(s.valid, true, `${coin}: ${JSON.stringify([s.ticker.issues, s.tf15m.issues, s.tf4h.issues])}`)
    assert.equal(s.ticker.mid, BASE[coin])
    assert.equal(s.ticker.mark, BASE[coin]! * 1.0001)
    assert.ok(Math.abs(s.ticker.change24hPct! - 2) < 1e-9)
    assert.equal(s.ticker.dayNotionalVolume, 1000000.5)
    assert.equal(s.ticker.openInterest, 1234.5)
    assert.equal(s.ticker.fundingHourly, -0.0000125)
    assert.equal(s.ticker.status, 'ok')
    assert.ok(s.ticker.receivedAt)
    assert.ok(Math.abs(s.tf15m.indicators!.close! - BASE[coin]!) / BASE[coin]! < 0.03, 'price scale of its own coin')
  }
})

test('indicators equal the 006D functions on the closed bars only', async () => {
  const snaps = await getQuantSnapshots({ now: NOW })
  for (const [tf, ms] of [['15m', M15], ['4h', H4]] as const) {
    const closed = closedBars('ETH', tf, NOW)
    const expected = tech.indicatorSnapshot(closed, ms, NOW)
    const got = (tf === '15m' ? snaps.ETH!.tf15m : snaps.ETH!.tf4h)
    assert.equal(got.status, 'ok')
    assert.equal(got.bars, BARS)
    assert.equal(got.lagBars, 0)
    assert.equal(got.asOf, new Date(Math.floor(NOW / ms) * ms - 1).toISOString())
    assert.deepEqual({ ...got.indicators!, issues: [] }, { ...expected, issues: [] })
    assert.equal(got.indicators!.ema50, tech.ema(closed.map((c) => c.close), 50).at(-1))
  }
  const last8 = closedBars('ETH', '15m', NOW).slice(-8)
  assert.deepEqual(snaps.ETH!.tf15m.lastCloses, last8.map((c) => ({ closeTime: new Date(c.closeTime).toISOString(), close: c.close })))
  assert.equal(snaps.ETH!.tf4h.lastCloses, undefined)
})

test('the bar still forming is never used', async () => {
  const s = (await getQuantSnapshots({ now: NOW })).BTC!
  for (const tf of [s.tf15m, s.tf4h]) {
    assert.ok(tf.indicators!.close! < BASE.BTC! * 1.1, 'close of the forming bar (x10) not used')
    assert.ok(tf.issues.some((m) => m.includes('not closed yet excluded')))
  }
  assert.ok(s.tf15m.lastCloses!.every((c) => c.close < BASE.BTC! * 1.1))
})

test('a bar closed less than 5 s before the fetch waits for the grace period', async () => {
  const justAfter = Date.UTC(2026, 9, 23, 20, 15, 2) // 2 s after the 20:00-20:15 bar closed
  const first = (await getQuantSnapshots({ now: justAfter, symbols: ['BTC'] })).BTC!
  assert.equal(first.tf15m.asOf, new Date(Date.UTC(2026, 9, 23, 20, 0) - 1).toISOString())
  assert.equal(first.tf15m.status, 'ok') // still the expected bar inside the grace period
  const later = justAfter + CLOSE_GRACE_MS
  const second = (await getQuantSnapshots({ now: later, symbols: ['BTC'] })).BTC!
  assert.equal(candleCount('15m'), 2, 'fetched again after the grace period')
  assert.equal(second.tf15m.asOf, new Date(Date.UTC(2026, 9, 23, 20, 15) - 1).toISOString())
  assert.equal(second.tf15m.lagBars, 0)
})

test('insufficient history: null indicators with an explanation, never zeros', async () => {
  provider.history.set('SOL:4h', 100)
  const snaps = await getQuantSnapshots({ now: NOW })
  const tf = snaps.SOL!.tf4h
  assert.equal(tf.status, 'insufficient')
  assert.equal(tf.bars, 100)
  assert.equal(tf.indicators!.ema50, null)
  assert.equal(tf.indicators!.macdSignal, null)
  assert.notEqual(tf.indicators!.ema20, null)
  assert.ok(tf.issues.some((m) => m.startsWith('not available: ') && m.includes('ema50')))
  assert.equal(snaps.SOL!.valid, false)
  assert.equal(snaps.SOL!.tf15m.status, 'ok')
  assert.equal(snaps.ETH!.valid, true, 'other symbols unaffected')
})

test('15m and 4h caches refresh only when their next bar has closed', async () => {
  await getQuantSnapshots({ now: NOW })
  assert.deepEqual([candleCount('15m'), candleCount('4h')], [6, 6])
  await getQuantSnapshots({ now: NOW + 5 * 60_000 }) // 20:12:30, same bars
  assert.deepEqual([candleCount('15m'), candleCount('4h')], [6, 6])
  const after15 = Date.UTC(2026, 9, 23, 20, 15) + CLOSE_GRACE_MS
  const s = await getQuantSnapshots({ now: after15 })
  assert.deepEqual([candleCount('15m'), candleCount('4h')], [12, 6])
  assert.equal(s.BTC!.tf15m.lagBars, 0)
  assert.equal(s.BTC!.tf4h.lagBars, 0)
  const after4h = Date.UTC(2026, 9, 24, 0, 0) + CLOSE_GRACE_MS
  await getQuantSnapshots({ now: after4h })
  assert.deepEqual([candleCount('15m'), candleCount('4h')], [18, 12])
})

test('three concurrent snapshot requests share every fetch', async () => {
  const results = await Promise.all([1, 2, 3].map(() => getQuantSnapshots({ now: NOW })))
  assert.equal(provider.tickersCalls, 1)
  assert.equal(candleCount(), 12)
  assert.deepEqual(results[1], results[0])
  assert.deepEqual(results[2], results[0])
})

test('429, timeout and incomplete responses: isolated errors and backoff, no retry storm', async () => {
  provider.fail.set('BTC:15m', 'rateLimit')
  provider.fail.set('ETH:4h', 'timeout')
  provider.fail.set('SOL:15m', 'incomplete')
  const first = await getQuantSnapshots({ now: NOW })
  assert.equal(candleCount(), 12, 'one attempt each')
  assert.equal(first.BTC!.tf15m.status, 'error')
  assert.match(first.BTC!.tf15m.issues[0]!, /429/)
  assert.equal(first.ETH!.tf4h.status, 'error')
  assert.match(first.ETH!.tf4h.issues[0]!, /timed out/)
  assert.equal(first.SOL!.tf15m.status, 'error')
  assert.match(first.SOL!.tf15m.issues[0]!, /incomplete/)
  for (const s of [first.BTC!, first.ETH!, first.SOL!]) assert.equal(s.valid, false)
  assert.equal(first.BTC!.tf4h.status, 'ok', 'the other timeframe still works')
  for (const coin of ['DOGE', 'BNB', 'XRP']) assert.equal(first[coin]!.valid, true)

  provider.fail.clear()
  // Within the backoff no new request for the failed keys (60 s, 120 s after a 429)
  await getQuantSnapshots({ now: NOW + 30_000 })
  assert.equal(candleCount(), 12)
  const at70 = await getQuantSnapshots({ now: NOW + 70_000 })
  assert.equal(candleCount(), 14, 'timeout and incomplete retried after 60 s')
  assert.equal(at70.BTC!.tf15m.status, 'error', 'rate limit still backing off')
  const at121 = await getQuantSnapshots({ now: NOW + 121_000 })
  assert.equal(candleCount(), 15)
  assert.equal(at121.BTC!.valid, true)
})

test('a failed refresh keeps the cached bars but reports them stale', async () => {
  await getQuantSnapshots({ now: NOW, symbols: ['XRP'] })
  provider.fail.set('XRP:15m', 'rateLimit')
  const later = Date.UTC(2026, 9, 23, 20, 30) + CLOSE_GRACE_MS // two bars later
  const s = (await getQuantSnapshots({ now: later, symbols: ['XRP'] })).XRP!
  assert.equal(s.tf15m.status, 'stale')
  assert.equal(s.tf15m.lagBars, 2)
  assert.equal(s.tf15m.asOf, new Date(Date.UTC(2026, 9, 23, 20) - 1).toISOString())
  assert.ok(s.tf15m.issues.some((m) => m.includes('2 bar(s) old')))
  assert.equal(s.valid, false)
})

test('symbol missing from the ticker response or with invalid prices', async () => {
  await getQuantSnapshots({ now: NOW }) // DOGE present in this first answer
  ;(priceCache as any).cache.clear()
  provider.ctx.set('DOGE', null) // ...and missing from the next one
  provider.ctx.set('BNB', { markPx: '0', funding: 'abc', prevDayPx: null })
  const snaps = await getQuantSnapshots({ now: NOW })
  assert.equal(snaps.DOGE!.ticker.status, 'missing')
  assert.equal(snaps.DOGE!.ticker.mid, null)
  assert.equal(snaps.DOGE!.valid, false)
  assert.equal(snaps.DOGE!.tf15m.status, 'ok', 'candles still computed')
  const bnb = snaps.BNB!.ticker
  assert.equal(bnb.mid, BASE.BNB)
  assert.equal(bnb.mark, null)
  assert.equal(bnb.fundingHourly, null)
  assert.equal(bnb.change24hPct, null)
  assert.deepEqual(bnb.issues.sort(), ['funding missing or invalid', 'markPx missing or invalid', 'prevDayPx missing or invalid'])
  assert.equal(snaps.BNB!.valid, false)
  for (const coin of ['BTC', 'ETH', 'SOL', 'XRP']) assert.equal(snaps[coin]!.valid, true)
})

test('ticker context older than 60 s is stale', async () => {
  await getLastPrice('BTC', 'CRYPTO')
  const t = tickerSnapshot('ETH', Date.now() + 61_000)
  assert.equal(t.status, 'stale')
  assert.ok(t.issues.some((m) => m.includes('s old')))
  assert.equal(t.mid, BASE.ETH, 'values kept, flagged stale')
})

test('candle parsing: duplicates, disorder, other coins, misaligned and partial rows', () => {
  const k = 1000
  const rows = [
    bar('BTC', '15m', k + 2), bar('BTC', '15m', k), bar('BTC', '15m', k + 1),
    bar('BTC', '15m', k + 1), // identical duplicate
    { ...bar('BTC', '15m', k + 3), c: '1' }, bar('BTC', '15m', k + 3), // conflicting duplicate
    bar('ETH', '15m', k + 4), // other coin
    { ...bar('BTC', '15m', k + 5), t: (k + 5) * M15 + 1 }, // misaligned open time
    { ...bar('BTC', '15m', k + 6), v: undefined }, // missing volume
    { o: '1' }, // no timestamps
  ]
  const { candles, issues } = parseCandles(rows, 'BTC', '15m')
  assert.deepEqual(candles.map((c) => c.openTime), [k, k + 1, k + 2, k + 3, k + 5, k + 6].map((x) => x * M15 + (x === k + 5 ? 1 : 0)))
  assert.equal(candles[3]!.close, null, 'conflicting duplicate invalid')
  assert.equal(candles[4]!.close, null, 'misaligned invalid')
  assert.equal(candles[5]!.volume, null, 'missing volume stays null')
  for (const m of ['bars received out of order, sorted', 'row of ETH dropped', 'row without timestamps dropped']) {
    assert.ok(issues.includes(m), m)
  }
  assert.ok(issues.some((m) => m.startsWith('duplicate bar')))
  assert.ok(issues.some((m) => m.startsWith('conflicting duplicate')))
  assert.ok(issues.some((m) => m.startsWith('misaligned bar')))
  assert.throws(() => parseCandles({}, 'BTC', '15m'), /incomplete/)
})

test('a gap in the bars restarts the indicators on the latest run', async () => {
  const realPost = (ccxt as any).hyperliquid.prototype.publicPostInfo
  ;(ccxt as any).hyperliquid.prototype.publicPostInfo = async function (body: any) {
    const rows = await realPost.call(this, body)
    return Array.isArray(rows) ? rows.filter((_: unknown, i: number) => i !== rows.length - 31) : rows
  }
  try {
    const s = (await getQuantSnapshots({ now: NOW, symbols: ['ETH'] })).ETH!
    assert.equal(s.tf15m.bars, 29)
    assert.equal(s.tf15m.status, 'insufficient')
    assert.ok(s.tf15m.issues.some((m) => m.startsWith('gap before')))
  } finally {
    ;(ccxt as any).hyperliquid.prototype.publicPostInfo = realPost
  }
})

// --- Original bot paths ---------------------------------------------------------

test('original price paths: no candle request, same single ticker call', async () => {
  for (const s of SIX) await getLastPrice(s, 'CRYPTO')
  assert.equal(provider.tickersCalls, 1)
  assert.equal(candleCount(), 0)
  assert.equal(await getLastPrice('HYPE', 'CRYPTO'), 40)
  assert.equal(provider.tickerCalls, 1)
  assert.equal(candleCount(), 0)
})

test('margin monitor and order execution: same requests, prices are mid not mark', async () => {
  const { db, ensureSchema, rawDb } = await import('../db/client.js')
  const { accounts, trades, users } = await import('../db/schema.js')
  const { eq } = await import('drizzle-orm')
  const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
  const { TaskScheduler } = await import('./scheduler.js')
  try {
    ensureSchema()
    const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
    const id = db.insert(accounts).values({
      userId: user.id, name: 'q', accountType: 'AI', apiKey: 'x', initialCapital: 1000, currentCash: 1000,
    }).returning().get().id
    for (const s of ['BTC', 'ETH']) {
      await placeAndExecuteCrypto({
        account: db.select().from(accounts).where(eq(accounts.id, id)).get()!,
        symbol: s, name: s, side: 'LONG', orderType: 'MARKET', price: null, quantity: s === 'BTC' ? 0.001 : 0.1, leverage: 2,
      })
    }
    const prices = db.select().from(trades).where(eq(trades.accountId, id)).all().map((t) => [t.symbol, t.price])
    assert.deepEqual(prices, [['BTC', BASE.BTC], ['ETH', BASE.ETH]], 'executed at mid, mark ignored')
    assert.equal(provider.tickersCalls, 1)

    ;(priceCache as any).cache.clear()
    provider.tickersCalls = 0
    await (new TaskScheduler() as any).checkMarginLevels()
    assert.equal(provider.tickersCalls, 1)
    assert.equal(candleCount(), 0)
  } finally {
    rawDb.close()
  }
})
