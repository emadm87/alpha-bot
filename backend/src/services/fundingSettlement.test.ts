/**
 * Hourly Hyperliquid funding for the 'hyperliquid' cost model (Task 006I-2).
 *
 * Run: npx tsx --test src/services/fundingSettlement.test.ts
 *
 * Throwaway SQLite file, real engine fills dated to chosen milliseconds,
 * fundingHistory and oracle prices served by injected stubs (shaped like the
 * public API: fundingRate as a string, time a few ms after the hour), no
 * network. Expected payments are worked out here:
 *   amount = (LONG ? -1 : +1) * size * oracle price * hourly rate.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FundingDeps, OraclePrices } from './fundingSettlement.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funding-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, fundingPayments, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')
const funding = await import('./fundingSettlement.js')
const { HOUR_MS, captureFundingOracle, settleFunding, runFundingTasks, resetFundingRates } = funding
const { utcNow } = await import('../utils/datetime.js')
const { accountFills, accountFunding, replayEquity } = await import('./assetCurveCalculator.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A funding hour well in the past, so every date below is history. */
const H0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 24 * HOUR_MS
const h = (n: number) => H0 + n * HOUR_MS
const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP']
const PX: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, DOGE: 0.08, BNB: 740, XRP: 1.3 }

// --- stubs ------------------------------------------------------------------------
/** coin -> hour -> rate string, as published by fundingHistory. */
let published: Record<string, Record<number, string>> = {}
let historyRequests: string[] = []
let oracleRequests = 0
let cachedOracles: OraclePrices = {}
/** Oracle price served for the hour being captured (by coin). */
let liveOracle: Record<string, number> = PX
let captureAt = 0
const deps: FundingDeps = {
  fetchFundingHistory: async (coin, start, end) => {
    historyRequests.push(coin)
    return Object.entries(published[coin] ?? {})
      .map(([hour, rate]) => ({ coin, fundingRate: rate, premium: '0.0', time: Number(hour) + 49 }))
      .filter((row) => row.time >= start && row.time <= end)
  },
  fetchOraclePrices: async () => {
    oracleRequests++
    return Object.fromEntries(Object.entries(liveOracle).map(([c, px]) => [c, { oraclePx: px, receivedAt: captureAt }]))
  },
  cachedOraclePrices: () => cachedOracles,
}
/** Captures the oracle prices of hour `hour`, `lagMs` after it. */
async function capture(hour: number, prices: Record<string, number> = PX, lagMs = 5_000) {
  liveOracle = prices
  captureAt = hour + lagMs
  return captureFundingOracle(hour + lagMs, deps)
}
function publish(coin: string, hour: number, rate: string) {
  ;(published[coin] ??= {})[hour] = rate
}

beforeEach(() => {
  // one account per test: the settlement looks at every hyperliquid account
  rawDb.exec(
    'DELETE FROM funding_payments; DELETE FROM funding_oracle_prices; DELETE FROM trades; ' +
      'DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  resetFundingRates()
  published = {}
  historyRequests = []
  oracleRequests = 0
  cachedOracles = {}
})

// --- helpers ------------------------------------------------------------------------
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', cash = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `fund-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: cash, currentCash: cash, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const rows = (id: number) =>
  db.select().from(fundingPayments).where(eq(fundingPayments.accountId, id)).all()
    .sort((a, b) => a.fundingTime - b.fundingTime || a.symbol.localeCompare(b.symbol))
/** Engine fill at `price`, dated `atMs`. */
async function fill(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number, atMs: number) {
  cachePrice(symbol, 'CRYPTO', price)
  const order = await placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
  rawDb.prepare('UPDATE trades SET trade_time = ? WHERE order_id = ?').run(utcNow(new Date(atMs)), order.id)
}
const pay = (side: 'LONG' | 'SHORT', qty: number, px: number, rate: number) => (side === 'LONG' ? -1 : 1) * qty * px * rate
function near(actual: number, expected: number, what: string, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
function report(id: number, atMs: number, prices: Record<string, number> = PX) {
  const rep = buildReport({ dbFile, accountId: id, prices, at: new Date(atMs).toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}
const cashAfterFills = (id: number) =>
  db.select().from(trades).where(eq(trades.accountId, id)).all()

// --- tests ------------------------------------------------------------------------

test('1. LONG 2x and SHORT 1x over three hours, positive and negative rates', async () => {
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.005, 2, 80000, h(0) - 30 * 60_000) // 400 USDC, fee 0.18
  await fill(id, 'ETH', 'SHORT', 0.1, 1, 2400, h(0) - 20 * 60_000) // 240 USDC 1x, fee 0.108
  const btc = [80000, 80100, 79900]
  const eth = [2400, 2410, 2390]
  const btcRate = ['0.0000125', '-0.00002', '0.0001']
  const ethRate = ['0.0000125', '-0.00003', '0.00005']
  for (let n = 0; n < 3; n++) {
    await capture(h(n), { ...PX, BTC: btc[n]!, ETH: eth[n]! })
    publish('BTC', h(n), btcRate[n]!)
    publish('ETH', h(n), ethRate[n]!)
  }
  const cashBefore = account(id).currentCash
  const now = h(2) + 10_000
  const summary = await settleFunding(now, deps)
  assert.deepEqual(summary, { settled: 6, missingOracle: 0, missingRate: 0, pending: 0 })
  const expected: number[] = []
  for (let n = 0; n < 3; n++) {
    expected.push(pay('LONG', 0.005, btc[n]!, Number(btcRate[n])), pay('SHORT', 0.1, eth[n]!, Number(ethRate[n])))
  }
  const got = rows(id)
  assert.equal(got.length, 6)
  got.forEach((r, i) => {
    assert.equal(r.status, 'settled')
    near(r.amount, expected[i]!, `row ${i} ${r.symbol} ${r.side}`)
    assert.equal(r.oracleReceivedAt! - r.fundingTime, 5_000, 'oracle captured 5 s after the hour')
    assert.equal(r.rateTime! - r.fundingTime, 49)
  })
  // hour 0: LONG pays 0.005, SHORT receives 0.003; hour 1 (negative): LONG receives, SHORT pays
  near(got[0]!.amount, -0.005, 'BTC h0 LONG pays')
  near(got[1]!.amount, 0.003, 'ETH h0 SHORT receives')
  assert.ok(got[2]!.amount > 0 && got[3]!.amount < 0, 'negative rate reverses the sides')
  const net = expected.reduce((a, b) => a + b, 0)
  near(account(id).currentCash, cashBefore + net, 'cash')
  assert.equal(account(id).marginUsed, 200, 'margin untouched')

  // idempotent: a second run, or a run after a restart, pays nothing more
  assert.deepEqual(await settleFunding(now, deps), { settled: 0, missingOracle: 0, missingRate: 0, pending: 0 })
  resetFundingRates()
  await settleFunding(now + 60_000, deps)
  near(account(id).currentCash, cashBefore + net, 'cash after rerun and restart')
  assert.equal(rows(id).length, 6)

  const rep = report(id, now, { ...PX, BTC: 79900, ETH: 2390 })
  near(rep.funding.net_usdc, net, 'report funding net', 1e-6)
  near(rep.funding.paid_usdc, -expected.filter((x) => x < 0).reduce((a, b) => a + b, 0), 'paid', 1e-6)
  near(rep.funding.received_usdc, expected.filter((x) => x > 0).reduce((a, b) => a + b, 0), 'received', 1e-6)
  assert.deepEqual(rep.funding.intervals, { settled: 6, not_settled_missing_oracle: 0, not_settled_missing_rate: 0, not_recorded: 0 })
  near(rep.pnl.net_usdc, rep.pnl.gross_usdc - rep.pnl.fees + net, 'net includes funding', 1e-4)
  assert.equal(rep.pnl.interest_charged, 0)
  assert.equal(rep.if_closed.accrued_interest_not_charged, 0, 'no original interest in if_closed')
  near(rep.if_closed.net_usdc, rep.pnl.net_usdc - rep.if_closed.closing_fees_estimated, 'if_closed: funding not counted twice', 1e-4)

  // the dashboard equity (live and rebuilt for the curve) includes the funding
  const finalPx: Record<string, number> = { ...PX, BTC: 79900, ETH: 2390 }
  for (const [c, p] of Object.entries(finalPx)) cachePrice(c, 'CRYPTO', p)
  near((await calcAccountEquity(account(id))).equity, rep.capital.final_equity, 'live equity', 1e-4)
  const rebuilt = replayEquity(1000, accountFills(id), now, (sym) => finalPx[sym], accountFunding(id))
  near(rebuilt.equity, rep.capital.final_equity, 'curve equity', 1e-4)
  near(replayEquity(1000, accountFills(id), h(1) - 1, (sym) => finalPx[sym], accountFunding(id)).equity -
    replayEquity(1000, accountFills(id), h(1) - 1, (sym) => finalPx[sym]).equity, expected[0]! + expected[1]!, 'curve before h1: only h0 funding')
})

test('2. fills around the hour: opened 1 ms before pays, opened exactly at the hour does not', async () => {
  const id = newAccount()
  await fill(id, 'SOL', 'LONG', 1, 1, 100, h(0) - 1) // held at h0
  await fill(id, 'XRP', 'LONG', 10, 3, 1.3, h(0)) // not held at h0 (strictly before)
  await fill(id, 'SOL', 'SELL', 1, 1, 100, h(1) - 1) // closed 1 ms before h1: not held at h1
  for (const n of [0, 1]) {
    await capture(h(n))
    publish('SOL', h(n), '0.0000125')
    publish('XRP', h(n), '0.0000125')
  }
  await settleFunding(h(1) + 10_000, deps)
  assert.deepEqual(rows(id).map((r) => [r.symbol, (r.fundingTime - H0) / HOUR_MS]), [['SOL', 0], ['XRP', 1]])
  near(rows(id)[0]!.amount, -1 * 100 * 0.0000125, 'SOL h0')
  report(id, h(1) + 10_000)
})

test('3. increased then partly closed: the size held at each hour', async () => {
  const id = newAccount()
  await fill(id, 'DOGE', 'LONG', 1000, 2, 0.08, h(0) - 600_000)
  await fill(id, 'DOGE', 'LONG', 500, 2, 0.08, h(0) + 600_000) // increased after h0
  await fill(id, 'DOGE', 'SELL', 700, 2, 0.08, h(1) + 600_000) // partial close after h1
  for (const n of [0, 1, 2]) {
    await capture(h(n))
    publish('DOGE', h(n), '0.0000125')
  }
  await settleFunding(h(2) + 10_000, deps)
  assert.deepEqual(rows(id).map((r) => r.quantity), [1000, 1500, 800])
  report(id, h(2) + 10_000)
})

test('4. missing oracle: recorded, never paid, never priced later', async () => {
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.005, 2, 80000, h(0) - 600_000)
  publish('BTC', h(0), '0.0000125')
  publish('BTC', h(1), '0.0000125')
  // h0: the app was stopped; a capture 2 minutes late is refused
  assert.equal(await capture(h(0), PX, 120_000), 0, 'late capture refused')
  await capture(h(1)) // h1 captured normally
  const cash = account(id).currentCash
  await settleFunding(h(1) + 10_000, deps)
  const [r0, r1] = rows(id)
  assert.equal(r0!.status, 'missing_oracle')
  assert.equal(r0!.amount, 0)
  assert.equal(r0!.oraclePrice, null, 'the h1 price is not used for h0')
  assert.equal(r1!.status, 'settled')
  near(account(id).currentCash, cash + r1!.amount, 'only h1 paid')
  const rep = report(id, h(1) + 10_000)
  assert.equal(rep.funding.intervals.not_settled_missing_oracle, 1)
  assert.equal(rep.if_closed.funding_not_settled_intervals, 1)
})

test('5. late rate settles when published; a rate never published is given up after 6 h', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'SHORT', 0.1, 2, 2400, h(0) - 600_000)
  await capture(h(0))
  await capture(h(1))
  const cash = account(id).currentCash
  // nothing published yet: pending, no row, no cash change
  assert.equal((await settleFunding(h(0) + 10_000, deps)).pending, 1)
  assert.equal(rows(id).length, 0)
  assert.equal(account(id).currentCash, cash)
  // a second run within 60 s makes no new request
  const before = historyRequests.length
  await settleFunding(h(0) + 30_000, deps)
  assert.equal(historyRequests.length, before, 'rate requests are spaced')
  // h0 published late: settled; h1 never published
  publish('ETH', h(0), '0.00002')
  await settleFunding(h(0) + 120_000, deps)
  assert.equal(rows(id)[0]!.status, 'settled')
  await settleFunding(h(1) + 3 * HOUR_MS, deps)
  assert.equal(rows(id).find((r) => r.fundingTime === h(1)), undefined, 'h1 still pending at +3 h')
  // later hours were not captured (no capture call in this test): missing_oracle, no payment
  assert.ok(rows(id).filter((r) => r.fundingTime > h(1)).every((r) => r.status === 'missing_oracle' && r.amount === 0))
  const summary = await settleFunding(h(1) + 6 * HOUR_MS + 60_000, deps)
  assert.equal(summary.missingRate, 1)
  const r1 = rows(id).find((r) => r.fundingTime === h(1))!
  assert.deepEqual([r1.status, r1.amount], ['missing_rate', 0])
  near(account(id).currentCash, cash + pay('SHORT', 0.1, PX.ETH!, 0.00002), 'only h0 paid')
})

test('6. duplicated rows in the answer and concurrent runs: one payment', async () => {
  const id = newAccount()
  await fill(id, 'SOL', 'SHORT', 2, 1, 100, h(0) - 600_000)
  await capture(h(0))
  const duplicating: FundingDeps = {
    ...deps,
    fetchFundingHistory: async (coin) => [
      { coin, fundingRate: '0.0000125', premium: '0', time: h(0) + 49 },
      { coin, fundingRate: '0.0000125', premium: '0', time: h(0) + 49 },
      { coin: 'BTC', fundingRate: '0.5', premium: '0', time: h(0) + 49 }, // another coin: ignored
      { coin, fundingRate: 0.9, premium: '0', time: h(0) + 49 }, // not a string: ignored
    ],
  }
  const cash = account(id).currentCash
  await Promise.all([settleFunding(h(0) + 10_000, duplicating), settleFunding(h(0) + 10_000, duplicating), runFundingTasks(h(0) + 10_000, duplicating)])
  assert.equal(rows(id).length, 1)
  near(account(id).currentCash, cash + pay('SHORT', 2, 100, 0.0000125), 'paid once')
  report(id, h(0) + 10_000)
})

test('7. paying more than the free cash: cash goes below zero, equity and report stay exact', async () => {
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.0124, 1, 80000, h(0) - 600_000) // 992 USDC at 1x, fee 0.4464 -> cash 7.5536
  await capture(h(0))
  publish('BTC', h(0), '0.001') // 0.1%/h: 0.992 * 80000 * ... = 0.992
  await settleFunding(h(0) + 10_000, deps)
  near(account(id).currentCash, 1000 - 992 - 0.4464 - 0.992, 'cash')
  await capture(h(1))
  publish('BTC', h(1), '0.01') // extreme rate: 9.92 USDC > cash
  await settleFunding(h(1) + 10_000, deps)
  assert.ok(account(id).currentCash < 0, 'taken from the posted margin, as on Hyperliquid')
  const rep = report(id, h(1) + 10_000)
  near(rep.capital.final_equity, 1000 - 0.4464 - 0.992 - 9.92, 'equity = capital - fee - funding', 1e-4)
})

test('8. original model untouched: no request, no row, interest as before', async () => {
  const id = newAccount('original')
  await fill(id, 'BTC', 'LONG', 0.005, 2, 80000, h(0) - 600_000)
  rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ?').run(utcNow(new Date(Date.now() - 10 * HOUR_MS)), id)
  publish('BTC', h(0), '0.0000125')
  for (let n = 0; n < 3; n++) await runFundingTasks(h(n) + 5_000, deps)
  assert.equal(oracleRequests, 0, 'no oracle request without a hyperliquid account')
  assert.deepEqual(historyRequests, [], 'no fundingHistory request')
  assert.equal(rows(id).length, 0)
  await fill(id, 'BTC', 'SELL', 0.005, 2, 80000, Date.now())
  const close = cashAfterFills(id).at(-1)!
  near(close.interestCharged, 200 * 0.0000125 * 10, 'original interest on the borrowed part', 1e-6)
  near(account(id).currentCash, 1000 - 0.28 - 0.28 - close.interestCharged, 'cash as before', 1e-9)
})

test('9. hyperliquid: no original interest on add, partial close, close or liquidation', async () => {
  const id = newAccount()
  const back = () =>
    rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ?').run(utcNow(new Date(Date.now() - 10 * HOUR_MS)), id)
  await fill(id, 'ETH', 'LONG', 0.1, 3, 2400, Date.now())
  back()
  await fill(id, 'ETH', 'LONG', 0.1, 3, 2400, Date.now()) // add
  back()
  await fill(id, 'ETH', 'SELL', 0.05, 3, 2400, Date.now()) // partial close
  back()
  await fill(id, 'ETH', 'SELL', 0.15, 3, 2400, Date.now()) // close
  // liquidation through the real monitor
  await fill(id, 'SOL', 'LONG', 90, 10, 100, Date.now())
  back()
  cachePrice('SOL', 'CRYPTO', 93)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, 'SOL'))).get()!.quantity, 0)
  assert.ok(cashAfterFills(id).every((t) => t.interestCharged === 0), 'interest 0 on every fill')
})

test('10. oracle capture: reuses fresh contexts, refuses stale ones, one request per hour', async () => {
  newAccount()
  cachedOracles = Object.fromEntries(COINS.map((c) => [c, { oraclePx: PX[c]!, receivedAt: h(3) + 2_000 }]))
  assert.equal(await captureFundingOracle(h(3) + 3_000, deps), 6)
  assert.equal(oracleRequests, 0, 'contexts received in the window are reused')
  cachedOracles = Object.fromEntries(COINS.map((c) => [c, { oraclePx: PX[c]!, receivedAt: h(4) - 1_000 }])) // before the hour
  liveOracle = PX
  captureAt = h(4) + 4_000
  assert.equal(await captureFundingOracle(h(4) + 4_000, deps), 6)
  assert.equal(oracleRequests, 1, 'stale contexts: one request')
  assert.equal(await captureFundingOracle(h(4) + 9_000, deps), 0)
  assert.equal(oracleRequests, 1, 'hour already captured: no request')
})

test('11. interrupted settlement leaves nothing half-done; unsettled hours are reported', async () => {
  const id = newAccount()
  await fill(id, 'XRP', 'SHORT', 100, 2, 1.3, h(0) - 600_000)
  await capture(h(0))
  publish('XRP', h(0), '0.0000125')
  const cash = account(id).currentCash
  // the process "dies" inside the transaction: the cash update fails
  rawDb.exec("CREATE TRIGGER crash BEFORE UPDATE OF current_cash ON accounts BEGIN SELECT RAISE(ABORT, 'crash'); END;")
  await assert.rejects(settleFunding(h(0) + 10_000, deps), /crash/)
  rawDb.exec('DROP TRIGGER crash')
  assert.equal(rows(id).length, 0, 'no payment row without its cash change')
  assert.equal(account(id).currentCash, cash)
  // before the restart the report shows the hour as not recorded
  const pending = buildReport({ dbFile, accountId: id, prices: PX, at: new Date(h(0) + 10_000).toISOString() })
  assert.equal(pending.funding.intervals.not_recorded, 1)
  assert.equal(pending.reconciliation.ok, true)
  // after the restart it is settled once
  resetFundingRates()
  await settleFunding(h(0) + 20_000, deps)
  assert.equal(rows(id).length, 1)
  near(account(id).currentCash, cash + pay('SHORT', 100, 1.3, 0.0000125), 'paid once')
  assert.equal(report(id, h(0) + 20_000).funding.intervals.not_recorded, 0)
})
