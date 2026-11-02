/**
 * Task 008: the v4 prompt (ALPHA_PROMPT=v4), offline.
 *
 * Run: npx tsx --test src/services/aiV4.test.ts
 *
 * Throwaway SQLite file, the exchange stub, synthetic 1 h candles; the only
 * network is a local fake AI server (127.0.0.1) answering fixed JSON. No
 * Gemini, no decision of the model is simulated: the tests check what is sent,
 * how an answer is validated and recorded, and that v1/v3 are unchanged.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}
for (const k of ['ALPHA_PROMPT', 'ALPHA_POSITION_INFO', 'ALPHA_PROTECTION', 'ALPHA_PROTECTION_CONFIG']) delete process.env[k]
const realFetch = globalThis.fetch
const noNetwork = (() => { throw new Error('network disabled in tests') }) as typeof fetch
globalThis.fetch = noNetwork

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const S = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { resetFundingRates } = await import('./fundingSettlement.js')
const { resetQuantData } = await import('./quantData.js')
const P = await import('./positionProtection.js')
const { loadExitConfig } = await import('./exitRules.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const M = await import('./marketContext.js')
const M4 = await import('./marketContextV4.js')
const H = await import('./marketHistory.js')
const N = await import('./newsFeed.js')
const V = await import('./v3Context.js')
const V4 = await import('./v4Context.js')
const PR = await import('./promptV3.js')
const PR4 = await import('./promptV4.js')
const D4 = await import('./aiDecisionV4.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')

ensureSchema()
installHyperliquidStub()
const user = db.insert(S.users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const HOUR = 3_600_000
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const BASE: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 }
const C3 = loadExitConfig({ ALPHA_PROTECTION: 'C3' })

/** Deterministic closed 1 h bars ending before `now` (same generator as the v3 regression fixture). */
function hourBars(base: number, seed: number, now: number, n = 1080) {
  let x = seed, p = base
  const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647)
  const last = Math.floor((now - 5000) / HOUR) * HOUR - HOUR
  const out = []
  for (let k = 0; k < n; k++) {
    const t = last - (n - 1 - k) * HOUR, o = p
    p = o * (1 + 0.004 * Math.sin(t / HOUR / 9) + (rnd() - 0.5) * 0.006)
    out.push({ openTime: t, endTime: t + HOUR, open: o, high: Math.max(o, p) * (1 + rnd() * 0.002), low: Math.min(o, p) * (1 - rnd() * 0.002), close: p, volume: 100 + rnd() * 50 })
  }
  return out
}
const live = (p: number, now: number, funding = 0.0000125) => ({ markPx: p, midPx: p, funding, premium: 0, openInterest: 1, dayNtlVlm: 5e8, impactPxs: [p * 0.9999, p * 1.0001] as [number, number], receivedAt: now })
const OPTS = { feeRate: 0.00045, equityBase: 1000 }
type Full = Extract<import('./marketContext.js').CoinBrief, { trend: unknown }>

/** The fixed v3 context of the regression fixture (same values as before Task 008). */
function fixedContext(now = Date.UTC(2026, 9, 30, 12, 0, 30)): import('./v3Context.js').V3Context {
  const markets: Record<string, any> = {}, snapshots: Record<string, any> = {}, prices: Record<string, number | null> = {}
  COINS.forEach((c, i) => {
    const b = hourBars(BASE[c]!, 17 + i, now)
    const p = b.at(-1)!.close
    const brief = M.coinBrief(b, live(p, now), now, OPTS)
    markets[c] = { ...brief, mid_price: p }; snapshots[c] = M.briefSnapshot(brief); prices[c] = brief.price
  })
  return {
    now, account: { cash_usdc: 1000, frozen_cash_usdc: 0, total_assets_usdc: 1000, cost_model: 'hyperliquid', taker_fee_pct_each_side: 0.045, open_positions: 0 },
    positions: [], cooldowns: [], exitModule: C3,
    memory: [{ minutes_ago: 5, operation: 'hold', symbol: 'BTC', direction: null, outcome: 'hold', valid: true, reason: 'ZEBRA earlier reasoning', thesis: null, invalidation_price: null, target_price: null, price_then: 80000, price_now: 80100, change_since_pct: 0.13 }],
    markets, news: N.selectNews([{ title: 'Bitcoin climbs', summary: 'ETF inflows', publishedAt: now - HOUR, source: N.NEWS_SOURCE }], now, new Map()), snapshots, prices, history: {},
  }
}
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const noMemory: import('./v4Context.js').V4Memory = { recent: [], last_decision_minutes_ago: null, since_last_decision: null }

let seq = 0
const newAccount = () => db.insert(S.accounts).values({ userId: user.id, name: `v4-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
  initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5, costModel: 'hyperliquid' }).returning().get().id
const v3rows = (id: number) => db.select().from(S.aiDecisionsV3).where(eq(S.aiDecisionsV3.accountId, id)).all()
const position = (id: number, s = 'BTC') => db.select().from(S.positions).where(eq(S.positions.accountId, id)).all().find((p) => p.symbol === s)

beforeEach(() => {
  rawDb.exec('DELETE FROM exit_events; DELETE FROM exit_plans; DELETE FROM ai_decision_logs; DELETE FROM ai_decisions_v3; DELETE FROM market_bars; DELETE FROM position_watch; ' +
    "DELETE FROM book_fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; UPDATE accounts SET is_active='false'")
  Object.assign(hyperliquidStub, { quotes: {}, failTickers: false, failMeta: false, failBook: false, books: {}, candles: {}, candleRequests: 0 })
  resetMarginTables(); resetFundingRates(); resetQuantData(); clearPrices(); H.resetHistoryState(); V.resetV3State()
  delete process.env.ALPHA_PROMPT
  process.env.ALPHA_PROTECTION = 'off'
})

// ------------------------------------------------------------------ regressions: v1 / v3 unchanged

test('1. v3 unchanged: messages of a fixed context byte-identical to the code before Task 008 (hashes taken from 2d5cfa4)', () => {
  const msgs = PR.buildMessagesV3(fixedContext())
  assert.equal(sha(msgs[0]!.content), '131eaf17ab61804560ee115fdacd906e7582cb3eb35a338ccb83679661dfa423')
  assert.equal(sha(msgs[1]!.content), 'b75e30a28adfa671146f3e55edc48416f59c962bee860ad71c45d6cd29266c65')
  assert.deepEqual(PR.V3_GENERATION, { temperature: 0.7, max_tokens: 1000 })
  // the committed v3 examples (Task 007F-BACKUP) are still what the v3 system prompt produces
  const dir = new URL('../../research/ai-decisions/examples/sizes/', import.meta.url)
  for (const [name, mode] of [['minimum', 'off'], ['medium', 'C3'], ['maximum', 'C2']] as const) {
    assert.equal(PR.buildSystemV3(loadExitConfig({ ALPHA_PROTECTION: mode })), fs.readFileSync(new URL(`${name}.system.txt`, dir), 'utf8'), name)
  }
})

test('2. selection: v1 default, v3 and v4 only when chosen, anything else refused; the startup line says which', () => {
  assert.equal(PR.promptVersion({}), 'v1')
  assert.equal(PR.promptVersion({ ALPHA_PROMPT: 'v3' }), 'v3')
  assert.equal(PR.promptVersion({ ALPHA_PROMPT: ' V4 ' }), 'v4')
  assert.throws(() => PR.promptVersion({ ALPHA_PROMPT: 'v5' }), /ALPHA_PROMPT must be v1, v3 or v4/)
  assert.equal(P.describeExperiment({ ALPHA_PROMPT: 'v4' }), 'Experiment config: position_info=v1 protection=off prompt=v4')
  assert.equal(P.describeExperiment({}), 'Experiment config: position_info=v1 protection=off prompt=v1')
})

// ------------------------------------------------------------------ sign convention

test('3. one sign convention: every price_minus_<x>_atr is (price - x) / ATR; v3 fields re-signed, never re-computed differently', () => {
  const ctx = fixedContext()
  for (const c of COINS) {
    const b3 = ctx.markets[c] as unknown as Full
    const b = M4.coinBriefV4(b3, b3.price, C3) as any
    const price = b.price, atr = b.volatility.atr14_1h
    const near = (got: number | null, x: number | null, what: string) => {
      if (x === null) return assert.equal(got, null, what)
      assert.ok(got !== null && Math.abs(got - (price - x) / atr) <= 0.011, `${c} ${what}: ${got} vs ${(price - x) / atr}`)
    }
    near(b.trend['1h'].price_minus_ema20_atr, b.trend['1h'].ema20, '1h EMA20')
    near(b.trend['1h'].price_minus_ema50_atr, b.trend['1h'].ema50, '1h EMA50')
    near(b.trend['4h'].price_minus_ema20_atr, b.trend['4h'].ema20, '4h EMA20')
    near(b.trend['4h'].price_minus_ema50_atr, b.trend['4h'].ema50, '4h EMA50')
    for (const s of [...b.levels.swing_highs_1h, ...b.levels.swing_lows_1h]) near(s.price_minus_level_atr, s.price, 'swing')
    for (const r of [b.levels.range_24h, b.levels.range_7d]) { near(r.price_minus_high_atr, r.high, 'range high'); near(r.price_minus_low_atr, r.low, 'range low') }
    assert.ok(b.levels.range_24h.price_minus_high_atr <= 0 && b.levels.range_24h.price_minus_low_atr >= 0, 'price inside its 24 h range')
    if (b.levels.nearest_above) { near(b.levels.nearest_above.price_minus_level_atr, b.levels.nearest_above.price, 'nearest above'); assert.ok(b.levels.nearest_above.price_minus_level_atr < 0) }
    if (b.levels.nearest_below) { near(b.levels.nearest_below.price_minus_level_atr, b.levels.nearest_below.price, 'nearest below'); assert.ok(b.levels.nearest_below.price_minus_level_atr > 0) }
    // no field of the other convention survives in v4
    const text = JSON.stringify(b)
    assert.ok(!/distance_atr|price_vs_|high_distance|low_distance/.test(text), `${c}: v3 field names in v4`)
  }
  // v3 had two opposite conventions under one header (the proven ambiguity v4 removes)
  const v3user = PR.buildUserV3(ctx)
  assert.match(v3user, /distances in ATR\(14, 1h\) are signed: level minus price/)
  const b3 = ctx.markets.BTC as unknown as Full
  assert.equal(Math.sign(b3.trend['1h'].price_vs_ema20_atr!), Math.sign(b3.price! - b3.trend['1h'].ema20!), 'v3 EMA field is price minus EMA')
  assert.equal(Math.sign(b3.structure.range_24h!.high_distance_atr!), 1, 'v3 range field is level minus price')
})

// ------------------------------------------------------------------ symmetry of LONG and SHORT

test('4. LONG and SHORT described with the same rules: mirrored prices swap the two sides exactly', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 30)
  const bars = hourBars(80000, 23, now)
  const K = 200000 // mirror: p -> K - p keeps ranges, ATR and distances, swaps up and down
  const mirror = bars.map((b) => ({ ...b, open: K - b.open, close: K - b.close, high: K - b.low, low: K - b.high }))
  const zeroFunding = (p: number) => live(p, now, 0)
  const b = M.coinBrief(bars, zeroFunding(bars.at(-1)!.close), now, OPTS) as Full
  const m = M.coinBrief(mirror, zeroFunding(mirror.at(-1)!.close), now, OPTS) as Full
  for (const cfg of [C3, loadExitConfig({ ALPHA_PROTECTION: 'C2' }), loadExitConfig({})]) {
    const L = M4.sideReference(m, 'long', cfg), Sh = M4.sideReference(b, 'short', cfg)
    const dist = (x: number | null | undefined, p: number) => (x === null || x === undefined ? null : Math.round(Math.abs(x - p)))
    assert.equal(dist(L.stop, m.price!), dist(Sh.stop, b.price!), `${cfg.mode} stop`)
    assert.equal(dist(L.take_profit, m.price!), dist(Sh.take_profit, b.price!), `${cfg.mode} take profit`)
    assert.equal(dist(L.partial_exit, m.price!), dist(Sh.partial_exit, b.price!), `${cfg.mode} partial`)
    // costs in R: one value per coin, the same for both sides by construction
    assert.ok(M4.costsInR(b, cfg)! > 0)
    assert.deepEqual(Object.keys(L).sort(), Object.keys(Sh).sort(), `${cfg.mode}: same fields both sides`)
    assert.deepEqual(L.levels_in_the_way.map((l) => -l.price_minus_level_atr), Sh.levels_in_the_way.map((l) => l.price_minus_level_atr), `${cfg.mode} levels`)
    assert.deepEqual(L.levels_in_the_way.map((l) => l.kind.replace('high', 'X').replace('low', 'X')), Sh.levels_in_the_way.map((l) => l.kind.replace('high', 'X').replace('low', 'X')))
  }
  // funding: the side that pays is the one the sign says (positive: LONG pays)
  const f = M.coinBrief(bars, live(bars.at(-1)!.close, now, 0.0001), now, OPTS) as Full
  assert.equal(M4.sideReference(f, 'long', C3).funding_8h_pct, -0.08)
  assert.equal(M4.sideReference(f, 'short', C3).funding_8h_pct, 0.08)
  // stop and take profit of the reference = the exit module's rule (2 ATR, +2R) on both sides
  const atr = f.volatility.atr14_1h!
  assert.ok(Math.abs(M4.sideReference(f, 'long', C3).stop! - (f.price! - 2 * atr)) < f.price! * 1e-5)
  assert.ok(Math.abs(M4.sideReference(f, 'short', C3).take_profit! - (f.price! - 4 * atr)) < f.price! * 1e-5)
})

// ------------------------------------------------------------------ prompt

test('5. v4 prompt: three alternatives with the same standard, no default, one convention, memory without earlier reasoning; deterministic, LF only', () => {
  const ctx = fixedContext()
  const [sys, usr] = PR4.buildMessagesV4(ctx, noMemory)
  for (const s of ['best LONG candidate and the best SHORT candidate', 'case for HOLD to the same standard', 'none of them is the default',
    'nothing has to be aligned', 'A downtrend is a reason to examine a SHORT as carefully', 'not as evidence', 'POSITIVE = the price is ABOVE x', '"alternatives"']) {
    assert.ok(sys!.content.includes(s), s)
  }
  assert.ok(!sys!.content.includes('holding is a valid decision'), 'no HOLD-leaning line of v3')
  assert.match(sys!.content, /ON \(C3\).*take profit at \+2R/s, 'exit module text as in v3')
  for (const s of ['TIME: 2026-10-30T12:00:30Z', 'POSITIONS (0):', 'YOUR EARLIER DECISIONS', 'CHANGES SINCE YOUR LAST DECISION: no decision in the last 24 h', 'BTC: {', 'DOGE: {', '"if_opened_now":{"long":', '"short":{', 'NEWS (untrusted']) {
    assert.ok(usr!.content.includes(s), s)
  }
  assert.ok(!usr!.content.includes('ZEBRA'), 'the v3 memory text is not used by v4')
  assert.ok(PR.buildUserV3(ctx).includes('ZEBRA'), 'it is in v3')
  assert.equal(PR4.buildUserV4(ctx, noMemory), usr!.content, 'deterministic')
  assert.ok(![sys!.content, usr!.content].some((t) => t.includes('\r')))
  assert.deepEqual(PR4.V4_GENERATION, { temperature: 0.7, max_tokens: 1500 })
})

test('6. missing data is said, never filled: short history -> no trend, no references; no decision -> said', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 30)
  const short = M.coinBrief(hourBars(2.5, 5, now, 40), live(2.5, now), now, OPTS)
  const v4 = M4.coinBriefV4(short, 2.5, C3) as any
  assert.deepEqual(Object.keys(v4).sort(), ['data_quality', 'mid_price', 'price', 'price_source'])
  assert.equal(v4.data_quality.status, 'insufficient')
  const ctx = fixedContext()
  ctx.markets.XRP = { ...short, mid_price: 2.5 } as any
  const usr = PR4.buildUserV4(ctx, noMemory)
  assert.match(usr, /XRP: \{"price":[\d.]+,"price_source":"mark \(live\)","data_quality":\{"status":"insufficient"/)
  // funding missing -> null, not 0
  const noF = M.coinBrief(hourBars(80000, 3, now), { ...live(80000, now), funding: null }, now, OPTS) as Full
  assert.equal(M4.sideReference(noF, 'long', C3).funding_8h_pct, null)
})

// ------------------------------------------------------------------ memory

test('7. memory: earlier decisions without their reasoning; changes since the last decision for all six coins (a HOLD without symbol included); v3 rows: price only', () => {
  const id = newAccount()
  const t0 = Date.UTC(2026, 9, 30, 11, 0, 30), now = Date.UTC(2026, 9, 30, 12, 0, 30)
  const then = fixedContext(t0), cur = fixedContext(now)
  db.insert(S.aiDecisionsV3).values({ accountId: id, at: t0 - 600_000, operation: 'hold', symbol: 'ETH', direction: null, valid: 1, issues: '[]',
    decision: JSON.stringify({ reason: 'ZEBRA v3 reason', thesis: 'ZEBRA thesis' }), context: JSON.stringify({ snapshot: null, prices: then.prices }), executed: 0, outcome: 'hold: No order placed' }).run()
  // a v3 row (no snapshots) is the last one: price-only changes
  let mem = V4.memoryV4(id, now, cur.snapshots, cur.prices)
  assert.equal(mem.since_last_decision!.BTC!.changes.length, 0)
  assert.equal(mem.since_last_decision!.BTC!.price_then, then.prices.BTC)
  // a v4 HOLD with no symbol, with the snapshots of every coin: full changes for all six
  db.insert(S.aiDecisionsV3).values({ accountId: id, at: t0, operation: 'hold', symbol: null, direction: null, valid: 1, issues: '[]',
    decision: JSON.stringify({ reason: 'ZEBRA v4 reason', alternatives: {} }), context: JSON.stringify({ snapshot: null, prices: then.prices, prompt: 'v4', snapshots: then.snapshots }), executed: 0, outcome: 'hold: No order placed' }).run()
  mem = V4.memoryV4(id, now, cur.snapshots, cur.prices)
  assert.equal(mem.last_decision_minutes_ago, 60)
  assert.deepEqual(Object.keys(mem.since_last_decision!), COINS)
  for (const c of COINS) {
    const x = mem.since_last_decision![c]!
    assert.ok(x.changes.some((s) => s.startsWith('price ')), `${c}: ${x.changes.join('; ')}`)
    assert.equal(x.change_pct, Math.round((cur.prices[c]! / then.prices[c]! - 1) * 1e4) / 100)
  }
  assert.deepEqual(mem.recent.map((r) => [r.operation, r.symbol, r.outcome]), [['hold', null, 'hold'], ['hold', 'ETH', 'hold']])
  const usr = PR4.buildUserV4(cur, mem)
  assert.ok(!usr.includes('ZEBRA'), 'earlier reasoning not shown')
  assert.match(usr, /CHANGES SINCE YOUR LAST DECISION \(60 min ago/)
  for (const c of COINS) assert.ok(usr.includes(`\n${c}: {"price_then":`), c)
})

// ------------------------------------------------------------------ validation

test('8. validation: v3 rules unchanged (blocking); the alternatives are checked and flagged, never blocking', () => {
  const ctx = { prices: { BTC: 80000, ETH: 2400 } as Record<string, number | null> }
  const data = 'BTC: {"price":80000,"ema20":79850.5,"rsi14_1h":61.37,"range_24h":{"high":81200,"low":79100}} ETH: {"price":2400,"low":2350.3}'
  const alternatives = {
    long: { symbol: 'BTC', case_for: 'RSI 61.37 and price above EMA20 79850.5', case_against: '24 h high 81200 close', invalidation_price: 79100, target_price: 81200 },
    short: { symbol: 'ETH', case_for: 'below the 4h EMA50', case_against: 'support at 2350.3', invalidation_price: 2450, target_price: 2350.3 },
    hold: { case_for: 'costs', case_against: 'momentum is up' },
  }
  const open = { alternatives, operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.2, leverage: 2, thesis: 't', invalidation_price: 79100,
    target_price: 81200, time_horizon_hours: 8, confidence: 'medium', key_factors: ['RSI 61.37'], changed_since_last: 'price above EMA20', reason: 'long beats short and hold' }
  const ok = D4.validateDecisionV4(open, ctx, data)
  assert.deepEqual([ok.rejected, ok.issues], [false, []])
  // an open with its level on the wrong side: blocked by the v3 rule, as before
  assert.equal(D4.validateDecisionV4({ ...open, invalidation_price: 80500 }, ctx, data).rejected, true)
  // alternatives missing or inconsistent: flagged only
  const hold = { operation: 'hold', symbol: null, direction: null, confidence: 'low', key_factors: [], changed_since_last: 'nothing', reason: 'r' }
  const noAlt = D4.validateDecisionV4(hold, ctx, data)
  assert.deepEqual([noAlt.rejected, noAlt.alternativeIssues], [false, ['no alternatives (long, short, hold)']])
  const bad = D4.validateDecisionV4({ ...open, symbol: 'ETH', invalidation_price: 2300, target_price: 2500, alternatives: { ...alternatives,
    short: { ...alternatives.short, invalidation_price: 2300, case_for: 'support at 1999.5' }, hold: {} } }, ctx, data)
  assert.equal(bad.rejected, false)
  assert.deepEqual(bad.alternativeIssues, [
    'alternatives.short.invalidation_price 2300 is on the wrong side of the price 2400',
    'alternatives.hold.case_for missing', 'alternatives.hold.case_against missing',
    'open ETH long does not match alternatives.long.symbol BTC',
    'numbers in the alternatives not found in the data given: 1999.5',
  ])
  const none = D4.validateDecisionV4({ ...hold, alternatives: { ...alternatives, long: { symbol: null, case_for: 'none', case_against: 'no setup' }, short: { ...alternatives.short, symbol: 'XYZ' } } }, ctx, data)
  assert.deepEqual(none.alternativeIssues, ['alternatives.short.symbol "XYZ" is not one of the six coins or null'])
})

// ------------------------------------------------------------------ end to end with a fake AI

async function fakeAI(id: number, answer: () => unknown) {
  const requests: any[] = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  rawDb.prepare("UPDATE accounts SET is_active='true', api_key='test-key-v4', base_url=?, model='fake' WHERE id=?").run(`http://127.0.0.1:${(srv.address() as any).port}/v1`, id)
  globalThis.fetch = ((input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('network disabled in test'))
    return realFetch(input, init)
  }) as typeof fetch
  return { requests, close: () => { srv.close(); globalThis.fetch = noNetwork; rawDb.prepare("UPDATE accounts SET is_active='false' WHERE id=?").run(id) } }
}

test('E2E v4: same call settings except the output limit; a valid open executes with the size asked; snapshots of all coins recorded; next prompt shows the changes; rejection and C3 unchanged', async () => {
  process.env.ALPHA_PROMPT = 'v4'
  process.env.ALPHA_PROTECTION = 'C3'
  const id = newAccount()
  const now = Date.now()
  for (const [i, c] of COINS.entries()) {
    hyperliquidStub.candles[c] = hourBars(BASE[c]!, 40 + i, now).map((b) => ({ t: b.openTime, T: b.openTime + HOUR - 1, s: c, i: '1h', o: String(b.open), h: String(b.high), l: String(b.low), c: String(b.close), v: String(b.volume), n: 1 }))
  }
  Object.assign(V.v3Deps, { fetchNews: async () => ({ items: [] }) })
  const alts = { long: { symbol: 'BTC', case_for: 'a', case_against: 'b', invalidation_price: 79000, target_price: 81500 }, short: { symbol: null, case_for: 'none', case_against: 'none' }, hold: { case_for: 'c', case_against: 'd' } }
  let answer: Record<string, unknown> = { alternatives: alts, operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.2, leverage: 2, thesis: 't',
    invalidation_price: 79000, target_price: 81500, time_horizon_hours: 8, confidence: 'low', key_factors: [], changed_since_last: 'first', reason: 'r' }
  const ai = await fakeAI(id, () => answer)
  const quoteAll = (btc: number) => { for (const c of COINS) quote(c, c === 'BTC' ? btc : BASE[c]!) }
  try {
    quoteAll(80000)
    await placeAIDrivenCryptoOrder()
    const req = ai.requests[0]
    assert.deepEqual(Object.keys(req), ['model', 'messages', 'temperature', 'max_tokens'])
    assert.deepEqual([req.temperature, req.max_tokens, req.messages.map((m: any) => m.role)], [0.7, 1500, ['system', 'user']])
    assert.ok(req.messages[0].content.includes('best LONG candidate'))
    assert.equal(position(id)!.quantity, Math.round((1000 * 0.2) / 80000 * 1e6) / 1e6, 'size as asked, unchanged')
    const [row] = v3rows(id)
    assert.deepEqual([row!.operation, row!.valid, row!.executed], ['open', 1, 1])
    const c0 = JSON.parse(row!.context)
    assert.equal(c0.prompt, 'v4')
    assert.deepEqual(Object.keys(c0.snapshots), COINS)
    // next cycle: a HOLD without symbol; the prompt shows what changed since the open for every coin
    answer = { alternatives: alts, operation: 'hold', symbol: null, direction: null, confidence: 'low', key_factors: [], changed_since_last: 'n', reason: 'r' }
    quoteAll(80400)
    await placeAIDrivenCryptoOrder()
    const usr = ai.requests[1].messages[1].content as string
    assert.match(usr, /CHANGES SINCE YOUR LAST DECISION \(0 min ago/)
    assert.match(usr, /\nBTC: \{"price_then":80000,"price_now":80400,"change_pct":0.5,"changes":\["price 80000 -> 80400/)
    assert.match(usr, /"operation":"open","symbol":"BTC","direction":"long","outcome":"executed","invalidation_price":79000,"target_price":81500/)
    const memorySection = usr.slice(usr.indexOf('YOUR EARLIER DECISIONS'), usr.indexOf('CHANGES SINCE'))
    assert.ok(!memorySection.includes('"reason"') && !memorySection.includes('"thesis"'), 'no earlier reasoning text in the memory')
    assert.match(usr, /"entry":\{"source":"v4 decision","reason":"r","thesis":"t"/, 'the open position keeps its entry thesis (position management)')
    // an open whose invalidation is above the price of a long: rejected exactly as in v3
    answer = { ...answer, operation: 'open', symbol: 'ETH', direction: 'long', target_portion_of_balance: 0.2, leverage: 2, thesis: 't', invalidation_price: 2500, target_price: 2600, time_horizon_hours: 4 }
    await placeAIDrivenCryptoOrder()
    assert.equal(position(id, 'ETH')?.quantity ?? 0, 0)
    assert.match(v3rows(id).at(-1)!.outcome!, /^rejected: v3 validation: invalidation_price 2500 is on the wrong side/)
    // the exit module acts on its own, whatever the prompt
    const atrDeps = { atr: async (_s: string, asOf: number) => ({ atr: 400, asOf: Math.floor(asOf / HOUR) * HOUR, bars: 30 }), sizeDecimals: P.defaultExitDeps.sizeDecimals }
    quote('BTC', 80000)
    await P.runProtectionPass(db.select().from(S.accounts).where(eq(S.accounts.id, id)).get()!, [position(id)!], { BTC: 80000 }, Date.now(), loadExitConfig(), atrDeps)
    quote('BTC', 81700)
    await P.runProtectionPass(db.select().from(S.accounts).where(eq(S.accounts.id, id)).get()!, [position(id)!], { BTC: 81700 }, Date.now(), loadExitConfig(), atrDeps)
    assert.equal(position(id)!.quantity, 0, 'C3 take profit')
  } finally {
    ai.close()
    Object.assign(V.v3Deps, { fetchNews: N.fetchNewsItems })
  }
})

// ------------------------------------------------------------------ size

test('9. size: v4 vs v3 on the same context (estimate; exact counts in research/ai-decisions/examples/v4)', () => {
  const ctx = fixedContext()
  const t3 = PR.buildMessagesV3(ctx).reduce((s, m) => s + PR.estimateTokens(m.content), 0)
  const t4 = PR4.buildMessagesV4(ctx, noMemory).reduce((s, m) => s + PR.estimateTokens(m.content), 0)
  assert.ok(t4 > t3 && t4 < t3 * 1.6, `v3 ${t3}, v4 ${t4}`)
})
