/**
 * Task 009F: technical summary of the six coins in the AI prompt, from
 * Hyperliquid 1 h candles (closed bars only), through the quantData cache.
 *
 * Run: npx tsx --test src/services/technicalSummary.test.ts
 *
 * Offline: ccxt.hyperliquid is a fake exchange serving synthetic 1 h candles
 * (the bar still forming is absurd, x10, so any use of it shows) and counting
 * candleSnapshot requests; a fake AI endpoint answers fixed decisions; a fixed
 * CoinJournal RSS. Reference values are computed here with the textbook
 * formulas, independently of the technical module.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techsummary-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const H = 3_600_000
const BASE: Record<string, number> = { BTC: 76000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 }
const SIX = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']

/** Synthetic 1 h bar k (open time k*H) of a coin: a slow wave plus a drift. */
function row(coin: string, k: number) {
  const b = BASE[coin]!
  const px = (j: number) => b * (1 + 0.03 * Math.sin(j / 9) + 0.00005 * (j % 1000))
  const open = px(k - 1), close = px(k)
  return {
    t: k * H, T: k * H + H - 1, s: coin, i: '1h', o: String(open), c: String(close),
    h: String(Math.max(open, close) * 1.002), l: String(Math.min(open, close) * 0.998), v: String(100 + (k % 17) * 3), n: 10,
  }
}

type Mode = 'rateLimit' | 'timeout' | 'notArray' | 'hang'
const ex = {
  calls: [] as { coin: string; interval: string; startTime: number; endTime: number }[],
  mode: new Map<string, Mode>(),
  /** coin -> only this many closed bars are served */
  history: new Map<string, number>(),
}
;(ccxt as any).hyperliquid = class {
  async fetchTickers() { throw new Error('tickers not used in these tests') }
  async publicPostInfo(body: { type: string; req: any }) {
    assert.equal(body.type, 'candleSnapshot')
    const { coin, interval, startTime, endTime } = body.req
    ex.calls.push({ coin, interval, startTime, endTime })
    const mode = ex.mode.get(coin)
    if (mode === 'hang') return new Promise(() => {})
    if (mode === 'rateLimit') throw new ccxt.RateLimitExceeded('hyperliquid 429')
    if (mode === 'timeout') throw new ccxt.RequestTimeout('hyperliquid timed out')
    if (mode === 'notArray') return { status: 'partial' }
    const forming = Math.floor(endTime / H)
    const first = ex.history.has(coin) ? forming - ex.history.get(coin)! : Math.ceil(startTime / H)
    const rows = []
    for (let k = first; k < forming; k++) rows.push(row(coin, k))
    const f = row(coin, forming)
    rows.push({ ...f, c: String(BASE[coin]! * 10), h: String(BASE[coin]! * 10), v: '999999' })
    return rows
  }
}

const AI_URL = 'http://fake-ai.test/v1'
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Bitcoin holds above $80,000 as ETF inflows continue</title>
<description>BTC trades above $80,000.</description><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`
let decision: Record<string, unknown> = {}
const prompts: string[] = []
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response(RSS, { status: 200 })
  if (url.startsWith(AI_URL)) {
    prompts.push(JSON.parse(String(init?.body)).messages[0].content)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { coinTechnical, technicalSummary, technicalSection, TECH_LEGEND } = await import('./technicalSummary.js')
const { resetQuantData, BARS } = await import('./quantData.js')
const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, positions, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')

ensureSchema()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
beforeEach(() => {
  resetQuantData()
  ex.calls = []
  ex.mode.clear()
  ex.history.clear()
})

// 2026-11-07 10:07:30 UTC: the bar opened at 10:00 is forming, the last closed one ended at 10:00
const NOW = Date.UTC(2026, 10, 7, 10, 7, 30)
const PRICES = { BTC: 76008.5, ETH: 2401, SOL: 181, BNB: 601, XRP: 2.51, DOGE: 0.201 }

/** Closed bars [from, to) of a coin as candles, plus the forming bar if asked. */
function candles(coin: string, n: number, now = NOW, withForming = true) {
  const forming = Math.floor(now / H)
  const out = []
  for (let k = forming - n; k < (withForming ? forming + 1 : forming); k++) {
    const r = row(coin, k)
    const absurd = k === forming
    out.push({ openTime: r.t, closeTime: r.T, open: +r.o, high: absurd ? +r.h * 10 : +r.h, low: +r.l, close: absurd ? +r.c * 10 : +r.c, volume: absurd ? 1e9 : +r.v })
  }
  return out
}

// textbook references
const sig = (x: number, d = 5) => Number(x.toPrecision(d))
function refEma(x: number[], n: number) {
  const a = 2 / (n + 1)
  let v = x.slice(0, n).reduce((s, y) => s + y, 0) / n
  for (let i = n; i < x.length; i++) v = a * x[i]! + (1 - a) * v
  return v
}
function refAtr(c: { high: number; low: number; close: number }[], n = 14) {
  const tr = (i: number) => Math.max(c[i]!.high - c[i]!.low, Math.abs(c[i]!.high - c[i - 1]!.close), Math.abs(c[i]!.low - c[i - 1]!.close))
  let v = 0
  for (let i = 1; i <= n; i++) v += tr(i)
  v /= n
  for (let i = n + 1; i < c.length; i++) v = (v * (n - 1) + tr(i)) / n
  return v
}

test('1. EMA20, EMA50, ATR14, 1h / 24h change, relative volume and trend follow the stated formulas', () => {
  for (const coin of SIX) {
    const all = candles(coin, 250)
    const closed = all.slice(0, -1)
    const got = coinTechnical(all, NOW, NOW, PRICES[coin as keyof typeof PRICES])
    const closes = closed.map((c) => c.close)
    const last = closed.at(-1)!
    assert.equal(got.issue, undefined, `${coin}: ${got.issue}`)
    assert.equal(got.price, PRICES[coin as keyof typeof PRICES])
    assert.equal(got.close_1h, sig(last.close))
    assert.equal(got.ema20_1h, sig(refEma(closes, 20)), `${coin} ema20`)
    assert.equal(got.ema50_1h, sig(refEma(closes, 50)), `${coin} ema50`)
    assert.equal(got.atr14_1h, sig(refAtr(closed), 3), `${coin} atr14`)
    assert.equal(got.change_1h_pct, Math.round((last.close / closed.at(-2)!.close - 1) * 1e4) / 100)
    assert.equal(got.change_24h_pct, Math.round((last.close / closed.at(-25)!.close - 1) * 1e4) / 100)
    const prev20 = closed.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
    assert.equal(got.rel_volume_1h, Math.round((last.volume / prev20) * 100) / 100)
    const e20 = refEma(closes, 20), e50 = refEma(closes, 50)
    const trend = last.close > e20 && e20 > e50 ? 'up' : last.close < e20 && e20 < e50 ? 'down' : 'mixed'
    assert.equal(got.trend_1h, trend)
  }
  // trend label on monotonic series: up, down; mixed when the order does not hold
  const mk = (f: (k: number) => number) => Array.from({ length: 200 }, (_, i) => {
    const k = Math.floor(NOW / H) - 200 + i, o = f(k - 1), c = f(k)
    return { openTime: k * H, closeTime: k * H + H - 1, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 10 }
  })
  assert.equal(coinTechnical(mk((k) => 1000 + k % 100000), NOW, NOW, 1).trend_1h, 'up')
  assert.equal(coinTechnical(mk((k) => 200000 - k % 100000), NOW, NOW, 1).trend_1h, 'down')
  const vee = mk((k) => 1000 + Math.abs((k % 100000) - (Math.floor(NOW / H) % 100000) + 10) * 5) // falling, then 10 rising bars
  assert.equal(coinTechnical(vee, NOW, NOW, 1).trend_1h, 'mixed')
  assert.equal(coinTechnical(mk(() => 1000), NOW, NOW, 1).rel_volume_1h, 1)
})

test('2. closed bars only: the forming bar and a bar closed after the fetch are never used', () => {
  const withForming = coinTechnical(candles('BTC', 250), NOW, NOW, 1)
  const without = coinTechnical(candles('BTC', 250, NOW, false), NOW, NOW, 1)
  assert.deepEqual(withForming, without, 'the absurd forming bar changes nothing')
  assert.ok(withForming.close_1h! < BASE.BTC! * 2)
  // fetched 3 s after the 10:00 close (inside the 5 s grace): the 09:00 bar is not used yet
  const at = Date.UTC(2026, 10, 7, 10, 0, 3)
  const early = coinTechnical(candles('BTC', 250, at), at, NOW, 1)
  assert.equal(early.last_closed_1h, '2026-11-07T09:00Z')
  assert.match(early.issue!, /stale/, 'the newer bar is missing: values not given')
  // a cached series cannot show a bar that closed after it was fetched
  const fetched = Date.UTC(2026, 10, 7, 9, 30)
  const later = coinTechnical(candles('BTC', 250, NOW), fetched, NOW, 1)
  assert.equal(later.last_closed_1h, '2026-11-07T09:00Z')
})

test('3. time reference and stale data', () => {
  const ok = coinTechnical(candles('ETH', 250), NOW, NOW, 2401)
  assert.equal(ok.last_closed_1h, '2026-11-07T10:00Z', 'close time of the last closed bar')
  // the same cached series one hour later: stale, values not given, the reason says so
  const stale = coinTechnical(candles('ETH', 250), NOW, NOW + H, 2401)
  assert.equal(stale.last_closed_1h, '2026-11-07T10:00Z')
  for (const k of ['close_1h', 'change_1h_pct', 'change_24h_pct', 'ema20_1h', 'ema50_1h', 'atr14_1h', 'rel_volume_1h', 'trend_1h'] as const) assert.equal(stale[k], null, k)
  assert.match(stale.issue!, /^stale: last closed 1h bar received ended 68 min ago, 1 newer bar\(s\) not received/)
  assert.equal(stale.price, 2401, 'the current price is still given')
})

test('4. missing data, gaps, invalid bars and missing prices: null with the reason', () => {
  // 100 bars: EMA50 not warmed up (166 needed), the rest computed
  const short = coinTechnical(candles('SOL', 100), NOW, NOW, 181)
  assert.equal(short.ema50_1h, null)
  assert.ok(short.ema20_1h !== null && short.atr14_1h !== null && short.change_24h_pct !== null)
  assert.equal(short.trend_1h, null, 'no trend without EMA50')
  assert.match(short.issue!, /ema50_1h: 100 contiguous closed bars, 166 needed/)
  // a gap 30 bars back: indicators restart after it; the 1 h change still exists, the 24 h one still found by time
  const gapped = candles('BNB', 250).filter((_, i, a) => i !== a.length - 32)
  const g = coinTechnical(gapped, NOW, NOW, 601)
  assert.equal(g.ema20_1h, null)
  assert.equal(g.atr14_1h, null)
  assert.ok(g.rel_volume_1h !== null && g.change_1h_pct !== null && g.change_24h_pct !== null)
  assert.match(g.issue!, /ema20_1h: 30 contiguous closed bars, 67 needed/)
  assert.match(g.issue!, /gap before/)
  // the bar 24 h back missing: that change is null with the reason
  const no24 = candles('BNB', 250).filter((_, i, a) => i !== a.length - 26)
  assert.equal(coinTechnical(no24, NOW, NOW, 601).change_24h_pct, null)
  assert.match(coinTechnical(no24, NOW, NOW, 601).issue!, /change_24h_pct: no valid bar closed 24 h before/)
  // the last closed bar invalid (high below low): nothing from this series
  const bad = candles('XRP', 250)
  bad[bad.length - 2] = { ...bad[bad.length - 2]!, high: 1, low: 2 }
  const b = coinTechnical(bad, NOW, NOW, 2.51)
  assert.equal(b.close_1h, null)
  assert.match(b.issue!, /^no valid closed 1h bar \(invalid bar at /)
  // no bars at all; no price
  assert.match(coinTechnical([], NOW, NOW, null).issue!, /^no current price; no valid closed 1h bar/)
})

test('4b. invalid API answers and errors: unavailable with a stable reason, other coins unaffected', async () => {
  ex.mode.set('BTC', 'notArray')
  ex.mode.set('ETH', 'rateLimit')
  ex.mode.set('SOL', 'timeout')
  const s = await technicalSummary(PRICES, NOW)
  for (const c of ['BTC', 'ETH', 'SOL']) {
    assert.equal(s[c]!.issue, '1h candles unavailable from Hyperliquid (request failed, none cached; retried after a pause)', c)
    assert.equal(s[c]!.ema20_1h, null)
    assert.equal(s[c]!.price, PRICES[c as keyof typeof PRICES])
  }
  for (const c of ['BNB', 'XRP', 'DOGE']) assert.equal(s[c]!.issue, undefined, c)
})

test('5. cache: one request per coin per closed hour, shared concurrent loads, backoff, bounded wait', async () => {
  // first cycle: six requests of BARS closed hours
  const [a, b] = await Promise.all([technicalSummary(PRICES, NOW), technicalSummary(PRICES, NOW)])
  assert.deepEqual(a, b)
  assert.equal(ex.calls.length, 6, 'concurrent loads share one request per coin')
  for (const c of ex.calls) {
    assert.equal(c.interval, '1h')
    assert.equal(c.startTime, Math.floor(NOW / H) * H - BARS * H)
    assert.equal(c.endTime, NOW)
  }
  // the next 5-minute cycles of the same hour: no request
  for (let m = 5; m < 50; m += 5) await technicalSummary(PRICES, NOW + m * 60_000)
  assert.equal(ex.calls.length, 6)
  // after the next 1 h close (+ 5 s grace): one new request per coin
  const next = Date.UTC(2026, 10, 7, 11, 0, 6)
  const n = await technicalSummary(PRICES, next)
  assert.equal(ex.calls.length, 12)
  assert.equal(n.BTC!.last_closed_1h, '2026-11-07T11:00Z')
  // a rate limit at the following close: the cached series is used (stale), no new request for 120 s
  ex.mode.set('BTC', 'rateLimit')
  const t2 = Date.UTC(2026, 10, 7, 12, 0, 6)
  const r = await technicalSummary(PRICES, t2)
  assert.equal(ex.calls.length, 18)
  assert.match(r.BTC!.issue!, /^stale: /)
  assert.equal(r.ETH!.issue, undefined)
  await technicalSummary(PRICES, t2 + 60_000)
  assert.equal(ex.calls.filter((c) => c.coin === 'BTC').length, 3, 'no BTC request during the backoff')
  ex.mode.delete('BTC')
  await technicalSummary(PRICES, t2 + 121_000)
  assert.equal(ex.calls.filter((c) => c.coin === 'BTC').length, 4, 'one request after it')
  // at most six requests per cycle, and in steady state six per hour (the summary is never refetched every 5 minutes)
})

test('5b. a hanging exchange does not hold the cycle: bounded wait, no duplicate request', async () => {
  ex.mode.set('DOGE', 'hang')
  const t0 = Date.now()
  const s = await technicalSummary(PRICES, NOW, 50)
  assert.ok(Date.now() - t0 < 2000)
  assert.equal(s.DOGE!.issue, '1h candles: no answer from Hyperliquid within 0.05 s')
  assert.equal(s.BTC!.issue, undefined)
  await technicalSummary(PRICES, NOW + 60_000, 50)
  assert.equal(ex.calls.filter((c) => c.coin === 'DOGE').length, 1, 'the pending request is shared, not repeated')
  const sec = await technicalSection(PRICES, NOW + 120_000)
  assert.ok(sec.includes('"DOGE": {"price":0.201,"last_closed_1h":null'), 'the prompt says DOGE data are missing')
})

// ---------- in the real prompt ----------

const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
const id = db.insert(accounts).values({
  userId: user.id, name: 'tech-summary', accountType: 'AI', isActive: 'true', apiKey: 'fake-key-for-test', model: 'fake', baseUrl: AI_URL,
  initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
}).returning().get().id
const setPrices = (btc: number) => { for (const [c, p] of Object.entries({ ...PRICES, BTC: btc })) cachePrice(c, 'CRYPTO', p) }
const pos = (s: string) => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()

const NEW_RULE = '- Technical data vs news: the Technical Summary and Current Market Prices are computed from current exchange data and take precedence over any interpretation of the news. ' +
  'Base your reason on the data given here and name the values you rely on; a null value is unknown, do not assume it. Judge each open position on the current conditions, not only on its opening thesis. ' +
  'Hold is a valid decision when the data support it; a loss alone does not require a close; making no trade is not an error in itself. Open (long or short), close and hold all remain available.'
const NEWS_RULE = '- News vs current data: news items report past events and may be old; prices, momentum or technical levels they mention are not necessarily valid now. '

test('6. the real prompt carries the summary of the six coins, the legend and the new rule, once', async () => {
  setPrices(76008.5)
  decision = { operation: 'hold', reason: 'test' }
  await placeAIDrivenCryptoOrder()
  const p = prompts.at(-1)!
  const expected = await technicalSummary({ ...PRICES }, Date.now()) // same cache, no new request
  assert.equal(ex.calls.length, 6, 'one request per coin for the cycle')
  const head = 'Technical Summary (Hyperliquid 1h candles, closed bars only):\n' + TECH_LEGEND + '\n{\n'
  assert.equal(p.split(head).length - 1, 1)
  for (const c of SIX) {
    const line = `  "${c}": ${JSON.stringify(expected[c])}`
    assert.ok(p.includes(line), `${c} line`)
    assert.ok(expected[c]!.ema20_1h !== null && expected[c]!.ema50_1h !== null && expected[c]!.atr14_1h !== null && expected[c]!.trend_1h !== null, c)
  }
  // placed after the current prices, before the news; the rules after it
  assert.ok(p.indexOf('Current Market Prices:') < p.indexOf(head) && p.indexOf(head) < p.indexOf('Latest Crypto News (CoinJournal):'))
  assert.equal(p.split(NEW_RULE).length - 1, 1, 'the new rule, once')
  assert.ok(p.indexOf(NEW_RULE) > p.indexOf('Rules:'))
  assert.ok(!/generated_at|price_age/.test(p), 'no wall clock in the section: the same data give the same text')
})

test('6b. Hyperliquid unavailable: the prompt says so and the cycle still decides', async () => {
  for (const c of SIX) ex.mode.set(c, 'timeout')
  setPrices(76008.5)
  decision = { operation: 'hold', reason: 'test' }
  const n = prompts.length
  await placeAIDrivenCryptoOrder()
  assert.equal(prompts.length, n + 1, 'the AI was asked')
  const p = prompts.at(-1)!
  assert.equal(p.split('1h candles unavailable from Hyperliquid').length - 1, 6)
})

test('7. open long, hold, close and open short all execute as before; the answer format is unchanged', async () => {
  setPrices(76008.5)
  decision = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'open' }
  await placeAIDrivenCryptoOrder()
  assert.equal(pos('BTC')!.quantity, Math.floor((1000 * 0.25) / 76008.5 * 1e6) / 1e6, 'sizing capped at 25% of the equity (009G)')
  setPrices(76100)
  decision = { operation: 'hold', reason: 'hold' }
  await placeAIDrivenCryptoOrder()
  assert.ok(pos('BTC')!.quantity > 0)
  setPrices(76200)
  decision = { operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, reason: 'close' }
  await placeAIDrivenCryptoOrder()
  assert.equal(pos('BTC')!.quantity, 0)
  decision = { operation: 'open', symbol: 'ETH', direction: 'short', target_portion_of_balance: 0.2, leverage: 1, reason: 'short' }
  await placeAIDrivenCryptoOrder()
  assert.equal(pos('ETH')!.side, 'SHORT')
  decision = { operation: 'hold', reason: 'hold short' }
  await placeAIDrivenCryptoOrder()
  assert.equal(pos('ETH')!.side, 'SHORT', 'hold keeps the short')
  const p = prompts.at(-1)!
  assert.ok(p.includes('{\n  "operation": "open" or "close" or "hold",\n  "symbol": "BTC" or "ETH" or "SOL" or "BNB" or "XRP" or "DOGE",\n  "direction": "long" or "short",\n  "target_portion_of_balance": 0.2,\n  "leverage": 3,\n  "reason": "Brief explanation of your decision"\n}'))
})

test('8. memory, costs and News Guard still in the prompt', () => {
  const p = prompts.at(-1)!
  assert.ok(p.includes('- Position memory (per open position'))
  assert.ok(p.includes('"entry_reason": "short"'))
  assert.ok(p.includes('- Trading costs in this paper engine: taker fee 0.07% of the notional'))
  assert.ok(p.includes('"estimated_net_pnl_if_closed_now"'))
  assert.equal(p.split(NEWS_RULE).length - 1, 1)
  assert.ok(p.includes('Bitcoin holds above $80,000 as ETF inflows continue'))
  assert.ok(p.includes('- Each cycle, review every open position with its current data and memory'))
})
