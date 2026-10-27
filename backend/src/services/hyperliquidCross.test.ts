/**
 * Mark price, cross margin, liquidations and leverage limits of the
 * 'hyperliquid' cost model (Task 006I-3); the 'original' monitor unchanged.
 *
 * Run: npx tsx --test src/services/hyperliquidCross.test.ts
 *
 * Throwaway SQLite file; the ccxt exchange is replaced by a stub that serves
 * chosen mid/mark prices and the real `meta` snapshot of 2026-10-27
 * (__fixtures__/hyperliquid-meta.json: BTC 40x, ETH 25x, SOL 20x, XRP 20x,
 * BNB 10x, DOGE 10x); no network. Expected values follow the official rule:
 *   account value = cash + posted margin + sum side * q * (mark - entry)
 *   maintenance   = sum q * mark / (2 * max leverage of the tier)
 *   liquidated when account value < maintenance
 * so the liquidation mark of one position with collateral C is
 *   LONG  (q*E - C) / (q * (1 - mmr)),   SHORT (q*E + C) / (q * (1 + mmr)).
 */
import { test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FundingDeps } from './fundingSettlement.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-cross-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, liquidationEvents, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { TaskScheduler } = await import('./scheduler.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { captureFundingOracle, settleFunding, resetFundingRates, HOUR_MS } = await import('./fundingSettlement.js')
const { accountRoutes } = await import('../api/account.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const { utcNow } = await import('../utils/datetime.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
installHyperliquidStub()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  // one scenario at a time: the monitor scans every account
  rawDb.exec(
    'DELETE FROM liquidation_events; DELETE FROM funding_payments; DELETE FROM funding_oracle_prices; ' +
      'DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  hyperliquidStub.quotes = {}
  hyperliquidStub.failTickers = false
  hyperliquidStub.failMeta = false
  resetMarginTables()
  resetFundingRates()
  clearPrices()
})

const HL = 0.00045
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `x-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const events = (id: number) => db.select().from(liquidationEvents).where(eq(liquidationEvents.accountId, id)).all()
async function fill(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  quote(symbol, price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
const monitor = () => (new TaskScheduler() as any).checkMarginLevels() as Promise<void>
const collateral = (id: number) =>
  account(id).currentCash + db.select().from(positions).where(eq(positions.accountId, id)).all()
    .filter((p) => p.quantity > 0).reduce((s, p) => s + (p.margin ?? 0), 0)
function near(actual: number, expected: number, what: string, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
function reconciled(id: number, prices: Record<string, number>) {
  const rep = buildReport({ dbFile, accountId: id, prices, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}
const liquidationMark = (side: 'LONG' | 'SHORT', q: number, entry: number, c: number, mmr: number) =>
  side === 'LONG' ? (q * entry - c) / (q * (1 - mmr)) : (q * entry + c) / (q * (1 + mmr))

// --- leverage limits -------------------------------------------------------------------

test('1. leverage limits per market from meta; original unchanged; no meta, no open', async () => {
  const limits: Record<string, number> = { BTC: 40, ETH: 25, SOL: 20, XRP: 20, BNB: 10, DOGE: 10 }
  const px: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, XRP: 1.3, BNB: 740, DOGE: 0.08 }
  const id = newAccount('hyperliquid', 1_000_000)
  for (const [coin, max] of Object.entries(limits)) {
    const q = Number((1000 / px[coin]!).toFixed(6))
    const before = { cash: account(id).currentCash, fills: fills(id).length }
    await assert.rejects(fill(id, coin, 'LONG', q, max + 1, px[coin]!), new RegExp(`above the Hyperliquid maximum of ${max}x for ${coin}`))
    assert.deepEqual({ cash: account(id).currentCash, fills: fills(id).length }, before, `${coin}: nothing booked`)
    await fill(id, coin, coin === 'XRP' ? 'SHORT' : 'LONG', q, max, px[coin]!)
    assert.equal(position(id, coin)!.leverage, max)
  }
  const og = newAccount('original')
  await fill(og, 'BNB', 'LONG', 0.1, 50, 740) // the engine's own limit, as before
  assert.equal(position(og, 'BNB')!.leverage, 50)
  // without margin tables a hyperliquid open cannot be checked: refused
  resetMarginTables()
  hyperliquidStub.failMeta = true
  const id2 = newAccount()
  // (the size rule of Task 006I-4 is checked first and needs the same meta)
  await assert.rejects(fill(id2, 'ETH', 'LONG', 0.1, 2, 2400), /Hyperliquid size rules for ETH unavailable: meta not received/)
  await fill(og, 'ETH', 'LONG', 0.1, 2, 2400) // original needs no meta
})

// --- mark price -----------------------------------------------------------------------

test('2. equity at mark in hyperliquid, at mid in original; missing mark reported', async () => {
  const hl = newAccount()
  const og = newAccount('original')
  await fill(hl, 'SOL', 'LONG', 1, 1, 100)
  await fill(og, 'SOL', 'LONG', 1, 1, 100)
  quote('SOL', 110, 108)
  const hlEq = await calcAccountEquity(account(hl))
  near(hlEq.unrealizedPnl, 8, 'hyperliquid P&L at mark')
  assert.equal(hlEq.priceBasis, 'mark')
  const ogEq = await calcAccountEquity(account(og))
  near(ogEq.unrealizedPnl, 10, 'original P&L at mid')
  assert.equal(ogEq.priceBasis, 'mid')
  // the dashboard shows the same value
  rawDb.prepare("UPDATE accounts SET is_active = 'true' WHERE id = ?").run(hl)
  const overview = (await (await accountRoutes.request(`/${hl}/overview`)).json()) as any
  near(overview.total_assets, hlEq.equity, 'dashboard = equity at mark')
  rawDb.prepare("UPDATE accounts SET is_active = 'false' WHERE id = ?").run(hl)
  quote('SOL', 110, undefined) // no markPx in the context
  const missing = await calcAccountEquity(account(hl))
  near(missing.unrealizedPnl, 10, 'mid used without a mark')
  assert.equal(missing.priceBasis, 'mid')
  assert.match(missing.priceIssues.join(), /SOL: markPx missing or invalid, mid used/)
})

// --- cross liquidations ------------------------------------------------------------------

for (const [side, leverage] of [['LONG', 2], ['LONG', 5], ['LONG', 10], ['SHORT', 1], ['SHORT', 2], ['SHORT', 5], ['SHORT', 10]] as const) {
  test(`3. ETH ${side} ${leverage}x: kept just inside the threshold, liquidated just beyond it`, async () => {
    const id = newAccount()
    const q = 0.375 * leverage // 900 USDC of notional per leverage unit: margin 900
    await fill(id, 'ETH', side, q, leverage, 2400)
    const c = collateral(id)
    near(c, 1000 - 900 * leverage * HL, 'collateral = capital - opening fee')
    const mStar = liquidationMark(side, q, 2400, c, 1 / 50) // ETH 25x: mmr 2%
    const inside = side === 'LONG' ? mStar * 1.0001 : mStar * 0.9999
    const beyond = side === 'LONG' ? mStar * 0.9999 : mStar * 1.0001
    quote('ETH', inside)
    await monitor()
    assert.equal(position(id, 'ETH')!.quantity, q, 'not liquidated inside the threshold')
    assert.equal(events(id).length, 0)
    quote('ETH', beyond)
    await monitor()
    assert.equal(position(id, 'ETH')!.quantity, 0, 'liquidated beyond it')
    const [ev] = events(id)
    assert.ok(ev && ev.accountValue < ev.maintenanceMargin)
    near(ev!.maintenanceMargin, q * beyond / 50, 'maintenance margin = notional at mark x 2%', 1e-6)
    near(ev!.accountValue, c + (side === 'LONG' ? 1 : -1) * q * (beyond - 2400), 'account value at mark', 1e-6)
    const liq = fills(id).at(-1)!
    assert.match(JSON.parse(ev!.orders)[0], /^LIQ-/)
    near(liq.commission, q * beyond * HL, 'only the taker fee, no extra liquidation fee')
    assert.equal(liq.interestCharged, 0)
    near(account(id).currentCash, ev!.accountValue - liq.commission, 'cash = account value - closing fee', 1e-6)
    assert.equal(account(id).marginUsed, 0)
    const rep = reconciled(id, { ETH: beyond })
    assert.equal(rep.operations.liquidations, 1)
    assert.equal(rep.margin.liquidation_events.length, 1)
  })
}

test('3b. LONG 1x alone is never liquidated (it would need a price at or below zero)', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 0.375, 1, 2400)
  quote('ETH', 1)
  await monitor()
  assert.equal(position(id, 'ETH')!.quantity, 0.375)
  assert.equal(events(id).length, 0)
})

test('4. exactly at the threshold: kept; one cent below: liquidated; one cent above: kept', async () => {
  // BTC 0.125 @ 80000 at 10x: margin 1000; at mark 64000 P&L -2000, maintenance 8000 / 80 = 100
  const run = async (cash: number) => {
    const id = newAccount('hyperliquid', 2000)
    await fill(id, 'BTC', 'LONG', 0.125, 10, 80000)
    rawDb.prepare('UPDATE accounts SET current_cash = ? WHERE id = ?').run(cash, id) // account value = cash - 1000
    quote('BTC', 64000)
    await monitor()
    return { liquidated: position(id, 'BTC')!.quantity === 0, events: events(id) }
  }
  assert.equal((await run(1100)).liquidated, false, 'account value 100 = maintenance 100')
  const below = await run(1099.99)
  assert.equal(below.liquidated, true, 'account value 99.99 < 100')
  near(below.events[0]!.maintenanceMargin, 100, 'maintenance')
  assert.equal((await run(1100.01)).liquidated, false, 'account value 100.01')
})

test('5. mark decides, mid executes; the original rule keeps using the mid', async () => {
  const mStar = liquidationMark('LONG', 3.75, 2400, 1000 - 9000 * HL, 1 / 50) // ~2177.98
  const a = newAccount()
  await fill(a, 'ETH', 'LONG', 3.75, 10, 2400)
  quote('ETH', 2300, 2170) // mark beyond, mid inside
  await monitor()
  assert.equal(position(a, 'ETH')!.quantity, 0, 'liquidated on the mark')
  assert.ok(2170 < mStar)
  // the stub's default book is a zero-spread book at the mid: the fill is at 2300 (book execution: bookExecution.test.ts)
  assert.equal(fills(a).at(-1)!.price, 2300, 'closed on the book at 2300, not at the mark 2170')
  assert.deepEqual(JSON.parse(events(a)[0]!.marks), { ETH: 2170 })
  assert.match(events(a)[0]!.execution, /l2Book snapshot/)

  const b = newAccount()
  await fill(b, 'ETH', 'LONG', 3.75, 10, 2400)
  quote('ETH', 2170, 2300) // mid beyond, mark inside
  await monitor()
  assert.equal(position(b, 'ETH')!.quantity, 3.75, 'not liquidated: the mark is inside')

  const og = newAccount('original')
  await fill(og, 'ETH', 'LONG', 3.75, 10, 2400)
  quote('ETH', 2170, 2300)
  await monitor() // equity at mid 993.7 - 862.5 = 131.2 < 0.5 * 900
  assert.equal(position(og, 'ETH')!.quantity, 0, 'original rule at mid')
  assert.equal(events(og).length, 0, 'no cross event for the original monitor')
})

test('6. two positions: a profit keeps the account alive, a loss on both liquidates both', async () => {
  const setup = async () => {
    const id = newAccount()
    await fill(id, 'BTC', 'LONG', 0.05, 5, 80000) // 4000, margin 800, fee 1.8
    await fill(id, 'SOL', 'SHORT', 1, 1, 100) // 100, fee 0.045
    return id
  }
  const kept = await setup()
  quote('BTC', 61000) // -950
  quote('SOL', 50) // +50: account value 98.155 > maintenance 38.125 + 1.25
  await monitor()
  assert.equal(position(kept, 'BTC')!.quantity, 0.05)
  assert.equal(position(kept, 'SOL')!.quantity, 1)

  rawDb.exec('DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts')
  const gone = await setup()
  quote('BTC', 61000)
  quote('SOL', 150) // -50: account value -1.845
  await monitor()
  assert.equal(position(gone, 'BTC')!.quantity, 0)
  assert.equal(position(gone, 'SOL')!.quantity, 0)
  const ev = events(gone)[0]!
  near(ev.maintenanceMargin, 0.05 * 61000 / 80 + 150 / 40, 'sum of both maintenance margins')
  assert.equal(ev.belowBackstop, 1, 'below 2/3 of maintenance: reported')
  assert.equal(JSON.parse(ev.orders).length, 2)
  reconciled(gone, { BTC: 61000, SOL: 150 })
})

test('7. hourly funding brings the account under the threshold', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 3.75, 10, 2400)
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS
  rawDb.prepare('UPDATE trades SET trade_time = ? WHERE account_id = ?').run(utcNow(new Date(hour - 60_000)), id)
  quote('ETH', 2180) // account value - maintenance = 995.95 - 825 - 163.5 = 7.45
  await monitor()
  assert.equal(position(id, 'ETH')!.quantity, 3.75, 'above before the funding')
  const deps: FundingDeps = {
    fetchFundingHistory: async (coin) => [{ coin, fundingRate: '0.001', premium: '0', time: hour + 30 }],
    fetchOraclePrices: async () => ({ ETH: { oraclePx: 2180, receivedAt: hour + 5_000 } }),
    cachedOraclePrices: () => ({}),
  }
  await captureFundingOracle(hour + 5_000, deps)
  await settleFunding(hour + 10_000, deps) // LONG pays 3.75 * 2180 * 0.1% = 8.175
  near(account(id).currentCash, 1000 - 900 - 9000 * HL - 8.175, 'funding paid')
  quote('ETH', 2180)
  await monitor()
  assert.equal(position(id, 'ETH')!.quantity, 0, 'liquidated after the funding')
  near(events(id)[0]!.accountValue, 995.95 - 825 - 8.175, 'account value includes the funding', 1e-6)
  reconciled(id, { ETH: 2180 })
})

test('8. no liquidation without valid, fresh mark prices or margin tables', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 3.75, 10, 2400)
  for (const mark of [undefined, null, '0', 'abc', -5]) {
    quote('ETH', 1000, mark) // a catastrophic mid, an unusable mark
    await monitor()
    assert.equal(position(id, 'ETH')!.quantity, 3.75, `mark ${String(mark)}: nothing decided`)
  }
  // margin tables unavailable
  quote('ETH', 1000, 1000)
  resetMarginTables()
  hyperliquidStub.failMeta = true
  await monitor()
  assert.equal(position(id, 'ETH')!.quantity, 3.75, 'no tables: nothing decided')
  hyperliquidStub.failMeta = false
  // stale mark: the last context is 61 s old and the price requests fail
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    quote('ETH', 2300, 2300)
    await calcAccountEquity(account(id)) // receives the context
    hyperliquidStub.quotes.ETH = { mid: 1000, mark: 1000 }
    hyperliquidStub.failTickers = true
    mock.timers.tick(61_000)
    clearPrices()
    await monitor()
    assert.equal(position(id, 'ETH')!.quantity, 3.75, 'stale mark: nothing decided')
  } finally {
    mock.timers.reset()
  }
  assert.equal(events(id).length, 0)
})

test('9. concurrent checks liquidate once', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 3.75, 10, 2400)
  quote('ETH', 2000)
  const scheduler = new TaskScheduler() as any
  await Promise.all([scheduler.checkMarginLevels(), scheduler.checkMarginLevels(), monitor()])
  assert.equal(events(id).length, 1, 'one liquidation event')
  assert.equal(fills(id).filter((t) => t.side === 'SELL').length, 1, 'one closing fill')
  reconciled(id, { ETH: 2000 })
})

test('10. original model: same rule as before, 1x not monitored, no cross event', async () => {
  const short1x = newAccount('original')
  await fill(short1x, 'ETH', 'SHORT', 0.375, 1, 2400)
  quote('ETH', 5000, 5000) // far beyond the cross threshold of 4966
  await monitor()
  assert.equal(position(short1x, 'ETH')!.quantity, 0.375, 'original never liquidates 1x')
  const lev = newAccount('original')
  await fill(lev, 'SOL', 'LONG', 90, 10, 100) // margin 900, fee 6.3
  quote('SOL', 95) // equity 993.7 - 450 = 543.7 > 450: kept
  await monitor()
  assert.equal(position(lev, 'SOL')!.quantity, 90)
  quote('SOL', 94) // 993.7 - 540 = 453.7 > 450: kept
  await monitor()
  assert.equal(position(lev, 'SOL')!.quantity, 90)
  quote('SOL', 93.9) // 993.7 - 549 = 444.7 < 450: liquidated
  await monitor()
  assert.equal(position(lev, 'SOL')!.quantity, 0)
  near(fills(lev).at(-1)!.commission, 90 * 93.9 * 0.0007, 'original fee', 1e-9)
  assert.equal(db.select().from(liquidationEvents).all().length, 0)
})
