/**
 * Exit management C1 / C2 / C3 against the real engine, database and monitor
 * (Task 007C), and the corrected AI position information (Task 007A).
 *
 * Run: npx tsx --test src/services/positionProtection.test.ts
 *
 * Throwaway SQLite file; the ccxt exchange is the stub of the cross-margin
 * tests (chosen mid/mark prices, the real `meta` snapshot, an l2Book that is
 * either zero-spread at the mid or a book set by the test with a real spread
 * and depth); no network except a local fake AI server in test 16.
 * Reference: 1000 USDC, BTC 0.01 at 80000 4x (notional 800, margin 200,
 * opening fee 0.36); ATR 400 -> R = 800, stop 79200 (LONG) / 80800 (SHORT),
 * chandelier 1200, C3 take profit 81600, C2 partial 25% at 81200.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
const realFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const S = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { resetFundingRates } = await import('./fundingSettlement.js')
const { resetQuantData } = await import('./quantData.js')
const { hyperliquidClient } = await import('./hyperliquid.js')
const P = await import('./positionProtection.js')
const { loadExitConfig, atrAt } = await import('./exitRules.js')
const { buildPrompt, getPortfolioData } = await import('./aiDecision.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
installHyperliquidStub()
const user = db.insert(S.users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ATR: Record<string, number> = { BTC: 400, ETH: 20, DOGE: 0.0008, XRP: 0.02 }
const deps = {
  atr: async (symbol: string, asOf: number) => ({ atr: ATR[symbol]!, asOf: Math.floor(asOf / 3_600_000) * 3_600_000, bars: 30 }),
  sizeDecimals: P.defaultExitDeps.sizeDecimals,
}
const setEnv = (protection: string, config?: object, info: 'v1' | 'v2' = 'v1') => {
  process.env.ALPHA_PROTECTION = protection
  process.env.ALPHA_POSITION_INFO = info
  if (config) process.env.ALPHA_PROTECTION_CONFIG = JSON.stringify(config)
  else delete process.env.ALPHA_PROTECTION_CONFIG
}
beforeEach(() => {
  rawDb.exec(
    'DELETE FROM exit_events; DELETE FROM exit_plans; DELETE FROM liquidation_events; DELETE FROM funding_payments; DELETE FROM ai_decision_logs; ' +
      "DELETE FROM funding_oracle_prices; DELETE FROM book_fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts WHERE name != 'GPT'",
  )
  Object.assign(hyperliquidStub, { quotes: {}, failTickers: false, failMeta: false, failBook: false, books: {}, candles: {} })
  resetMarginTables()
  resetFundingRates()
  resetQuantData()
  clearPrices()
  setEnv('C1')
})

let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(S.accounts).values({
    userId: user.id, name: `x-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(S.accounts).where(eq(S.accounts.id, id)).get()!
const position = (id: number, s = 'BTC') => db.select().from(S.positions).where(and(eq(S.positions.accountId, id), eq(S.positions.symbol, s))).get()
const rows = (id: number) => db.select().from(S.positions).where(eq(S.positions.accountId, id)).all()
const events = (id: number) => db.select().from(S.exitEvents).where(eq(S.exitEvents.accountId, id)).all()
const kinds = (id: number) => events(id).map((e) => `${e.kind}:${e.status}`)
const plans = (id: number) => db.select().from(S.exitPlans).where(eq(S.exitPlans.accountId, id)).all()
const closes = (id: number) => db.select().from(S.trades).where(eq(S.trades.accountId, id)).all().filter((t) => t.side === 'SELL' || t.side === 'BUY')
async function open(id: number, side: 'LONG' | 'SHORT', price: number, quantity = 0.01, leverage = 4, symbol = 'BTC') {
  quote(symbol, price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
let clock = Date.now()
/** One pass of the module at a mark price (the book follows the mark unless the test set one). */
async function pass(id: number, price: number, symbol = 'BTC', at = (clock += 5_000)) {
  quote(symbol, price)
  return P.runProtectionPass(account(id), rows(id), { [symbol]: price }, at, loadExitConfig(), deps)
}
const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
function reconciled(id: number, price: number, symbol = 'BTC') {
  const rep = buildReport({ dbFile, accountId: id, prices: { [symbol]: price }, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}
/** A book with a real spread: bids below and asks above the mid, `depth` units per level. */
function book(coin: string, mid: number, spreadBps: number, depth: number, levels = 5) {
  const half = (mid * spreadBps) / 2e4
  const side = (dir: number) => Array.from({ length: levels }, (_, k) => ({ px: String(mid + dir * (half + k * mid * 1e-4)), sz: String(depth), n: 1 }))
  hyperliquidStub.books[coin] = { coin, time: Date.now(), levels: [side(-1), side(1)] }
}

// --- configurations ---------------------------------------------------------------------

test('1. off: nothing runs, no plan, no event; the same loss is left to Gemini', async () => {
  setEnv('off')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  const s = await pass(id, 78000)
  assert.deepEqual(s, { evaluated: 0, exits: 0, partials: 0, failed: 0, emergency: false, skipped: [] })
  assert.equal(position(id)!.quantity, 0.01)
  assert.deepEqual(plans(id), [])
})

test('2. C1 LONG: plan with levels and risk at the stop, chandelier exit; accounting reconciles; cooldown for LONG only', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  const [p] = plans(id)
  assert.deepEqual([p!.mode, p!.entry, p!.atr, p!.stopPrice, p!.riskPrice, p!.trailDistance, p!.takeProfitPrice], ['C1', 80000, 400, 79200, 800, 1200, null])
  near(p!.riskUsdc, 0.01 * (80000 - 79200 * 0.9998) + 0.36 + 0.01 * 79200 * 0.9998 * 0.00045, 'risk at the stop')
  near(p!.riskPct, p!.riskUsdc / 999.64, 'risk % of the account')
  assert.equal(p!.oversized, 0)
  const created = events(id)[0]!
  assert.equal(created.kind, 'plan_created')
  assert.match(created.reason, /C1 plan: entry 80000, ATR\(14, 1h\) 400 .* stop 79200; 0\.89% of the account at the stop, within the 1% reference/)
  assert.deepEqual(JSON.parse(created.detail).risk.fits, { '0.5%': false, '1%': true, '2%': true })
  await pass(id, 82000) // best 82000 -> chandelier 80800
  assert.equal(plans(id)[0]!.lastLevel, 80800)
  await pass(id, 81000)
  assert.equal(position(id)!.quantity, 0.01)
  await pass(id, 80790)
  assert.equal(position(id)!.quantity, 0)
  const exit = events(id).at(-1)!
  assert.deepEqual([exit.kind, exit.status, exit.level, exit.fillPrice, exit.closedPosition], ['exit_trailing', 'executed', 80800, 80790, 1])
  assert.match(exit.orderNo!, /^PRT-/)
  near(account(id).currentCash, 1000 + 7.9 - 0.36 - 0.01 * 80790 * 0.00045, 'cash = capital + P&L - both fees')
  assert.equal(plans(id)[0]!.status, 'closed')
  reconciled(id, 80790)
  // cooldown: LONG BTC blocked for 2 h, SHORT BTC and other coins free
  const until = P.cooldownUntil(id, 'BTC', 'LONG', clock + 1)
  near(until!, exit.at + 2 * 3_600_000, 'until')
  assert.equal(P.cooldownUntil(id, 'BTC', 'SHORT', clock + 1), null)
  assert.equal(P.cooldownUntil(id, 'ETH', 'LONG', clock + 1), null)
  assert.equal(P.cooldownUntil(id, 'BTC', 'LONG', exit.at + 2 * 3_600_000 + 1), null, 'over after 2 h')
})

test('3. C1 SHORT: initial stop; mirror of LONG; reconciles', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await pass(id, 80500)
  await pass(id, 80850)
  assert.equal(position(id)!.quantity, 0)
  const e = events(id).at(-1)!
  assert.deepEqual([e.kind, e.level], ['exit_stop', 80800])
  assert.match(e.reason, /initial stop 80800\.00 \(entry 80000\.00 \+ 2 ATR\)/)
  reconciled(id, 80850)
})

test('4. C2 LONG: 25% at +1.5R, then the rest at break-even; quantities, fees and margin reconcile', async () => {
  setEnv('C2')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  await pass(id, 81250) // partial at 81200 reached
  const part = events(id).find((e) => e.kind === 'partial_take_profit')!
  assert.deepEqual([part.status, part.quantityRequested, part.quantityFilled, part.closedPosition], ['executed', 0.0025, 0.0025, 0])
  near(position(id)!.quantity, 0.0075, 'three quarters left')
  near(position(id)!.margin!, 150, 'margin released pro rata')
  assert.equal(plans(id)[0]!.partialState, 'done')
  assert.equal(plans(id)[0]!.plannedQty, 0.0075)
  await pass(id, 81000) // best 81250 -> chandelier 80050 above break-even 80000
  await pass(id, 80040)
  assert.equal(position(id)!.quantity, 0)
  assert.equal(events(id).at(-1)!.kind, 'exit_trailing')
  reconciled(id, 80040)
  // a pure break-even exit
  const id2 = newAccount()
  await open(id2, 'LONG', 80000)
  await pass(id2, 80000)
  await pass(id2, 81200)
  await pass(id2, 79999)
  assert.equal(events(id2).at(-1)!.kind, 'exit_breakeven')
  reconciled(id2, 79999)
})

test('5. C2 partial below the 10 USD minimum: recorded once as skipped, break-even then applies to the whole position', async () => {
  setEnv('C2')
  const id = newAccount()
  await open(id, 'LONG', 0.08, 150, 2, 'DOGE') // 12 USD; R = 2 x 0.0008, partial 25% at 0.0824 = 37 DOGE ~ 3 USD
  await pass(id, 0.08, 'DOGE')
  await pass(id, 0.0825, 'DOGE')
  await pass(id, 0.0826, 'DOGE')
  const skipped = events(id).filter((e) => e.kind === 'partial_take_profit')
  assert.equal(skipped.length, 1, 'once, not at every pass')
  assert.equal(skipped[0]!.status, 'skipped')
  assert.match(skipped[0]!.reason, /below the Hyperliquid minimum of 10 USD; break-even and trailing now apply to the whole position/)
  assert.equal(plans(id)[0]!.partialState, 'skipped')
  assert.equal(position(id, 'DOGE')!.quantity, 150)
  await pass(id, 0.0799, 'DOGE')
  assert.equal(position(id, 'DOGE')!.quantity, 0, 'the whole position closes (a full close is allowed under 10 USD)')
  // best 0.0826 -> chandelier 0.0802, above the break-even 0.08: the trailing level closes it
  assert.deepEqual([events(id).at(-1)!.kind, events(id).at(-1)!.quantityFilled], ['exit_trailing', 150])
  near(events(id).at(-1)!.level!, 0.0802, 'chandelier level', 1e-12)
  reconciled(id, 0.0799, 'DOGE')
})

test('6. C2 lot rounding (XRP szDecimals 0): 25% of 101 = 25.25 -> 25 asked and filled, labelled executed', async () => {
  setEnv('C2')
  const id = newAccount()
  await open(id, 'SHORT', 2.5, 101, 3, 'XRP')
  await pass(id, 2.5, 'XRP')
  await pass(id, 2.43, 'XRP') // partial at 2.5 - 1.5 x 0.04 = 2.44
  const e = events(id).find((x) => x.kind === 'partial_take_profit')!
  assert.deepEqual([e.status, e.quantityRequested, e.quantityFilled], ['executed', 25, 25])
  assert.equal(position(id, 'XRP')!.quantity, 76)
  reconciled(id, 2.43, 'XRP')
})

test('7. C3: take profit at +2R closes everything (LONG and SHORT)', async () => {
  setEnv('C3')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  await pass(id, 81500)
  assert.equal(position(id)!.quantity, 0.01)
  await pass(id, 81650)
  assert.deepEqual([events(id).at(-1)!.kind, events(id).at(-1)!.level, position(id)!.quantity], ['exit_take_profit', 81600, 0])
  reconciled(id, 81650)
  const id2 = newAccount()
  await open(id2, 'SHORT', 80000)
  await pass(id2, 80000)
  await pass(id2, 78390)
  assert.equal(events(id2).at(-1)!.kind, 'exit_take_profit')
  reconciled(id2, 78390)
})

// --- execution: spread, depth, retries, concurrency ------------------------------------------

test('8. real spread: the exit fills at the bid, below the mark; the slippage is recorded and the accounting reconciles', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  book('BTC', 79150, 2, 1) // 2 bps spread around 79150: best bid 79142.085
  await P.runProtectionPass(account(id), rows(id), { BTC: 79150 }, (clock += 5_000), loadExitConfig(), deps)
  const e = events(id).at(-1)!
  assert.equal(e.kind, 'exit_stop')
  near(e.fillPrice!, 79150 - 79150 * 1e-4, 'filled at the best bid')
  assert.ok(e.slippageVsMarkBps! > 0.9 && e.slippageVsMarkBps! < 1.1, `slippage ${e.slippageVsMarkBps}`)
  reconciled(id, 79150)
})

test('9. thin book: the exit fills in part (book_partial), the rest is closed at the next attempt; then flat', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  book('BTC', 79100, 2, 0.001, 4) // 0.004 BTC visible
  const t0 = (clock += 5_000)
  await P.runProtectionPass(account(id), rows(id), { BTC: 79100 }, t0, loadExitConfig(), deps)
  const first = events(id).at(-1)!
  assert.equal(first.status, 'book_partial')
  near(first.quantityFilled!, 0.004, 'visible depth')
  near(position(id)!.quantity, 0.006, 'rest open')
  await P.runProtectionPass(account(id), rows(id), { BTC: 79100 }, t0 + 5_000, loadExitConfig(), deps)
  assert.equal(events(id).filter((e) => e.kind === 'exit_stop').length, 1, 'no attempt before the retry delay')
  book('BTC', 79100, 2, 1)
  await P.runProtectionPass(account(id), rows(id), { BTC: 79100 }, t0 + 16_000, loadExitConfig(), deps)
  assert.equal(position(id)!.quantity, 0)
  assert.deepEqual(events(id).filter((e) => e.kind === 'exit_stop').map((e) => e.status), ['book_partial', 'executed'])
  reconciled(id, 79100)
})

test('10. failures back off 15 s, 30 s, 60 s...: a few attempts, not one every 5 s; then the exit goes through', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await pass(id, 80000)
  hyperliquidStub.failBook = true
  const t0 = (clock += 5_000)
  for (let s = 0; s <= 120; s += 5) await P.runProtectionPass(account(id), rows(id), { BTC: 81000 }, t0 + s * 1000, loadExitConfig(), deps)
  const failed = events(id).filter((e) => e.status === 'failed')
  assert.deepEqual(failed.map((e) => (e.at - t0) / 1000), [0, 15, 45, 105], 'attempts at 0, +15, +30, +60 s')
  assert.match(failed[0]!.reason, /next attempt after/)
  hyperliquidStub.failBook = false
  await P.runProtectionPass(account(id), rows(id), { BTC: 81000 }, t0 + 230_000, loadExitConfig(), deps)
  assert.equal(position(id)!.quantity, 0)
  assert.equal(plans(id)[0]!.status, 'closed')
  reconciled(id, 81000)
})

/** Holds the next l2Book request until released (the moment an exit waits for the book). */
function gateBook() {
  const ex: any = (hyperliquidClient as any).exchange
  const orig = ex.publicPostInfo
  let release: () => void = () => {}
  let gated = false
  ex.publicPostInfo = async (b: any) => {
    if (b.type === 'l2Book' && !gated) { gated = true; await new Promise<void>((r) => (release = r)) }
    return orig(b)
  }
  return { release: () => release(), restore: () => (ex.publicPostInfo = orig) }
}

test('11. concurrency: half closed elsewhere while the exit waits for the book -> re-read and closed in the same pass, no oversell', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await pass(id, 80000)
  quote('BTC', 81000)
  const g = gateBook()
  const run = P.runProtectionPass(account(id), rows(id), { BTC: 81000 }, (clock += 5_000), loadExitConfig(), deps)
  await new Promise((r) => setTimeout(r, 20))
  await placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'BUY', orderType: 'MARKET', price: null, quantity: 0.005, leverage: 1 })
  g.release()
  const s = await run
  g.restore()
  assert.equal(s.exits, 1)
  assert.equal(position(id)!.quantity, 0)
  assert.deepEqual(closes(id).map((t) => t.quantity), [0.005, 0.005])
  assert.deepEqual(events(id).filter((e) => e.kind === 'exit_stop').map((e) => [e.status, e.quantityRequested]), [['executed', 0.005]])
  reconciled(id, 81000)
})

test('12. the position grows (engine API; the AI path refuses opens on an open coin): a new plan from the new average entry', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  await open(id, 'LONG', 81000) // added directly through the engine
  await pass(id, 81000)
  const ps = plans(id).sort((a, b) => a.planSeq - b.planSeq)
  assert.deepEqual(ps.map((p) => [p.planSeq, p.status]), [[1, 'superseded'], [2, 'active']])
  near(ps[1]!.entry, 80500, 'new average entry')
  near(ps[1]!.stopPrice, 79700, 'new stop')
  assert.equal(ps[1]!.plannedQty, 0.02)
  assert.ok(events(id).some((e) => e.kind === 'plan_reset'))
  // while an exit waits for the book the position grows: the close takes the old quantity, the addition gets a new plan
  const id2 = newAccount()
  await open(id2, 'LONG', 80000)
  await pass(id2, 80000)
  quote('BTC', 79100)
  const g = gateBook()
  const run = P.runProtectionPass(account(id2), rows(id2), { BTC: 79100 }, (clock += 5_000), loadExitConfig(), deps)
  await new Promise((r) => setTimeout(r, 20))
  await placeAndExecuteCrypto({ account: account(id2), symbol: 'BTC', name: 'BTC', side: 'LONG', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 4 })
  g.release()
  await run
  g.restore()
  near(position(id2)!.quantity, 0.01, 'the addition is still open')
  await pass(id2, 79100)
  assert.ok(events(id2).some((e) => e.kind === 'plan_reset'), 'the addition has its own plan')
  reconciled(id2, 79100)
})

test('13. restart: the plan, the best price and the partial state are in the database; a new scheduler goes on from them', async () => {
  setEnv('C1')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  hyperliquidStub.candles.BTC = candles(80000, 400)
  quote('BTC', 80000)
  await (new TaskScheduler() as any).checkMarginLevels()
  quote('BTC', 82000)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(plans(id)[0]!.best, 82000)
  quote('BTC', 80700) // a fresh instance, as after a restart: chandelier from the stored best
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id)!.quantity, 0)
  assert.equal(events(id).at(-1)!.kind, 'exit_trailing')
})

/** 15 m candleSnapshot rows ending at the current quarter, with a true range giving about `atr` per hour. */
function candles(price: number, atr: number, n = 120) {
  const q = 900_000
  const end = Math.floor(Date.now() / q) * q
  return Array.from({ length: n }, (_, k) => {
    const t = end - (n - k) * q
    const quarter = (t / q) % 4
    return { t, T: t + q - 1, s: 'BTC', i: '15m', o: String(price), c: String(price),
      h: String(quarter === 1 ? price + atr / 2 : price), l: String(quarter === 2 ? price - atr / 2 : price), v: '1', n: 1 }
  })
}

test('14. live ATR from the shared 15 m candles, only bars ended before the first fill; missing candles: no plan, reported once', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  hyperliquidStub.candles.BTC = candles(80000, 400)
  quote('BTC', 80000)
  await (new TaskScheduler() as any).checkMarginLevels()
  const [p] = plans(id)
  const opened = P.positionLifecycle(id, 'BTC').openedAt!
  const expected = atrAt(hyperliquidStub.candles.BTC.map((r: any) => ({ openTime: r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c })), opened, 14) as any
  near(p!.atr, expected.atr, 'ATR = the pure function on the same bars')
  near(p!.atr, 400, 'about 400')
  assert.ok(p!.atrAsOf <= opened, 'no bar after the first fill')
  // no candles for ETH: no plan, one event, the emergency control still applies
  resetQuantData()
  const id2 = newAccount()
  await open(id2, 'LONG', 2400, 0.1, 2, 'ETH')
  quote('ETH', 2400)
  for (let k = 0; k < 3; k++) await (new TaskScheduler() as any).checkMarginLevels()
  assert.deepEqual(kinds(id2), ['plan_unavailable:info'])
  assert.match(events(id2)[0]!.reason, /only the account emergency control applies/)
})

test('15. account emergency: positions together losing 3% of the account close, each with a cooldown; separate from the stops', async () => {
  setEnv('C1', { stopAtr: 10, trailAtr: 15 }) // stops far away: only the emergency can act
  const id = newAccount()
  await open(id, 'LONG', 80000, 0.02, 4)
  await open(id, 'LONG', 2400, 0.3, 4, 'ETH')
  quote('BTC', 80000); quote('ETH', 2400)
  await P.runProtectionPass(account(id), rows(id), { BTC: 80000, ETH: 2400 }, (clock += 5_000), loadExitConfig(), deps)
  // BTC -1.1% (-17.6), ETH -2% (-14.4): -32 + fees, about -3.3% of 998.95
  quote('BTC', 79120); quote('ETH', 2352)
  const s = await P.runProtectionPass(account(id), rows(id), { BTC: 79120, ETH: 2352 }, (clock += 5_000), loadExitConfig(), deps)
  assert.equal(s.emergency, true)
  assert.equal(position(id)!.quantity, 0)
  assert.equal(position(id, 'ETH')!.quantity, 0)
  const em = events(id).filter((e) => e.kind === 'exit_emergency')
  assert.deepEqual(em.map((e) => [e.symbol, e.status, e.closedPosition]), [['BTC', 'executed', 1], ['ETH', 'executed', 1]])
  assert.match(em[0]!.reason, /account emergency: open positions net -3\d\.\d+ USDC <= -3% of the account value/)
  assert.notEqual(P.cooldownUntil(id, 'ETH', 'LONG', clock + 1), null)
  const rep = buildReport({ dbFile, accountId: id, prices: { BTC: 79120, ETH: 2352 }, at: new Date().toISOString() })
  assert.equal(rep.reconciliation.ok, true)
})

test('16. cooldown through the real AI path: a reopen in the same direction is refused and recorded; the other direction goes', async () => {
  const id = newAccount()
  rawDb.prepare("UPDATE accounts SET is_active='true', api_key='test-key-cooldown', base_url=?, model='fake' WHERE id=?").run('http://127.0.0.1:1/v1', id)
  await open(id, 'SHORT', 80000)
  await pass(id, 80000)
  await pass(id, 80850) // stop -> SHORT BTC in cooldown
  assert.equal(position(id)!.quantity, 0)
  let answer = { operation: 'open', symbol: 'BTC', direction: 'short', target_portion_of_balance: 0.2, leverage: 2, reason: 'test' }
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  const port = (srv.address() as { port: number }).port
  rawDb.prepare('UPDATE accounts SET base_url=? WHERE id=?').run(`http://127.0.0.1:${port}/v1`, id)
  globalThis.fetch = ((input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('network disabled in test'))
    return realFetch(input, init)
  }) as typeof fetch
  try {
    for (const c of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']) quote(c, c === 'BTC' ? 80850 : 100)
    await placeAIDrivenCryptoOrder()
    assert.equal(position(id)?.quantity ?? 0, 0, 'SHORT BTC refused during the cooldown')
    assert.deepEqual(kinds(id).filter((k) => k.startsWith('cooldown')), ['cooldown_block:blocked'])
    const log = db.select().from(S.aiDecisionLogs).where(eq(S.aiDecisionLogs.accountId, id)).all().at(-1)!
    assert.equal(log.executed, 'false')
    answer = { ...answer, direction: 'long' }
    clearPrices()
    for (const c of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']) quote(c, c === 'BTC' ? 80850 : 100)
    await placeAIDrivenCryptoOrder()
    assert.equal(position(id)!.side, 'LONG', 'the other direction is allowed')
  } finally {
    srv.close()
    globalThis.fetch = (() => { throw new Error('network disabled in tests') }) as typeof fetch
    rawDb.prepare("UPDATE accounts SET is_active='false' WHERE id=?").run(id)
  }
})

test('17. liquidation first: a gap to the liquidation level liquidates, the exit module does nothing', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000, 0.1, 10) // cross liquidation below ~70922
  hyperliquidStub.candles.BTC = candles(80000, 400)
  quote('BTC', 70000)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(db.select().from(S.liquidationEvents).where(eq(S.liquidationEvents.accountId, id)).all().length, 1)
  assert.deepEqual(events(id).filter((e) => e.kind.startsWith('exit_')), [])
})

test('18. original cost model: untouched even with C1 on', async () => {
  const id = newAccount('original')
  await open(id, 'LONG', 80000)
  const s = await pass(id, 70000)
  assert.equal(s.evaluated, 0)
  assert.equal(position(id)!.quantity, 0.01)
  assert.deepEqual(events(id), [])
})

test('19. invalid settings stop the app at startup; the 007A "on" is refused', () => {
  assert.throws(() => P.describeExperiment({ ALPHA_POSITION_INFO: 'v3' }), /v1 or v2/)
  assert.throws(() => P.describeExperiment({ ALPHA_PROTECTION: 'on' }), /replaced by C1\/C2\/C3/)
  assert.match(P.describeExperiment({ ALPHA_PROTECTION: 'c2', ALPHA_POSITION_INFO: 'v2' }), /^Experiment config: position_info=v2 protection=C2 config=\{/)
  assert.equal(P.describeExperiment({}), 'Experiment config: position_info=v1 protection=off')
})

// --- what the AI is shown ------------------------------------------------------------------

const promptOf = (p: Awaited<ReturnType<typeof getPortfolioData>>) => buildPrompt(p, { BTC: 80000 }, 'news')

test('20. v1 (default): exactly the original fields and header, no cooldown line even with an active cooldown', async () => {
  setEnv('C1', undefined, 'v1')
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await pass(id, 80000)
  await open(id, 'LONG', 2400, 0.1, 2, 'ETH')
  await pass(id, 80850)
  const p = await getPortfolioData(account(id))
  assert.deepEqual(p.positions.ETH, { quantity: 0.1, avg_cost: 2400, current_value: 240, side: 'LONG', leverage: 2 })
  assert.equal(p.cooldowns, undefined)
  const text = promptOf(p)
  assert.ok(text.includes('- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):'))
  assert.ok(!text.includes('cooldown'))
})

test('21. v2: entry vs current value, P&L, costs, funding, holding time, the exit plan in force and the cooldown line', async () => {
  setEnv('C3', undefined, 'v2')
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  const opened = P.positionLifecycle(id, 'BTC').openedAt!
  db.insert(S.fundingPayments).values({ accountId: id, symbol: 'BTC', fundingTime: Math.floor(opened / 3_600_000) * 3_600_000 + 3_600_000,
    status: 'settled', side: 'SHORT', quantity: 0.01, oraclePrice: 80000, fundingRate: -0.0001, amount: 0.08 }).run()
  await pass(id, 80000)
  quote('BTC', 78000, 78100) // mid 78000, mark 78100 (not passed to the module: the take profit 78400 would close it)
  const v = (await getPortfolioData(account(id))).positions.BTC as any
  assert.equal(v.entry_value, 800)
  assert.equal(v.current_price, 78100)
  assert.equal(v.price_basis, 'mark')
  near(v.current_value, 781, 'current value = quantity x mark')
  near(v.unrealized_pnl, 19, 'SHORT gains when the price falls')
  near(v.fees_paid, 0.36, 'entry fee')
  near(v.financing_net, 0.08, 'funding received')
  near(v.estimated_net_pnl_if_closed_now, 19 - 0.36 - 781 * 0.00045 + 0.08, 'net if closed now', 1e-4)
  assert.deepEqual([v.exit_plan.config, v.exit_plan.stop_price, v.exit_plan.take_profit_price], ['C3', 80800, 78400])
  assert.equal(v.exit_plan.oversized_vs_1pct, false)
  // a cooldown on another coin shows in the prompt
  await open(id, 'LONG', 2400, 0.1, 2, 'ETH')
  await pass(id, 2400, 'ETH')
  await pass(id, 2350, 'ETH') // stop 2360
  const p = await getPortfolioData(account(id))
  assert.equal(p.cooldowns!.length, 1)
  assert.match(promptOf(p), /- Reopening blocked after a protective exit \(cooldown\): ETH LONG until 20\d\d-/)
})

test('22. v2 without a price: the price fields are null with the reason; original model: fee 0.07%, interest', async () => {
  setEnv('off', undefined, 'v2')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  clearPrices()
  hyperliquidStub.failTickers = true
  const v = (await getPortfolioData(account(id))).positions.BTC as any
  assert.deepEqual([v.current_price, v.current_value, v.estimated_net_pnl_if_closed_now], [null, null, null])
  assert.match(v.price_issue, /price unavailable/)
  hyperliquidStub.failTickers = false
  const og = newAccount('original')
  await open(og, 'LONG', 80000)
  quote('BTC', 81000)
  const w = (await getPortfolioData(account(og))).positions.BTC as any
  assert.equal(w.price_basis, 'mid')
  near(w.fees_paid, 0.56, 'original fee 0.07% of 800')
  assert.ok(w.financing_net <= 0)
})

test('23. the report: plans with risk, every intervention, one timeline with the AI decisions', async () => {
  setEnv('C2')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await pass(id, 80000)
  await pass(id, 81250)
  await pass(id, 80040) // best 81250 -> chandelier 80050
  const rep = reconciled(id, 80040)
  assert.equal(rep.exit_management.plans.length, 1)
  assert.equal(rep.exit_management.plans[0].mode, 'C2')
  assert.equal(rep.exit_management.risk.positions, 1)
  assert.equal(rep.exit_management.risk.oversized, 0)
  assert.deepEqual(rep.exit_management.counts, { 'plan_created:info': 1, 'partial_take_profit:executed': 1, 'exit_trailing:executed': 1 })
  assert.deepEqual(rep.decision_trace.map((d: any) => `${d.source}:${d.action}`), ['exits:partial_take_profit', 'exits:exit_trailing'])
})
