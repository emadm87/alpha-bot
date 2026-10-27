/**
 * After-the-fact comparison of the 'original' and 'hyperliquid' cost rules on
 * the same recorded fills (Task 006I-6, pilot/compare.mjs via report.mjs).
 *
 * Run: npx tsx --test src/services/costComparison.test.ts
 *
 * Throwaway SQLite file; Hyperliquid stub with books set per fill (mid known),
 * trade times moved to chosen hours so interest and funding are exact. No
 * network. Hand-worked scenario (hyperliquid account, 10,000 USDC):
 *   BTC  t0      LONG 0.1 2x    asks 80010 / bids 79990 (mid 80000)  -> 80010
 *        t0+2h   LONG 0.05 2x   asks 81010 / bids 80990 (mid 81000)  -> 81010
 *        t0+5h   SELL 0.06      asks 82010 / bids 81990 (mid 82000)  -> 81990
 *        0.09 BTC left open, valued at 83000
 *   ETH  t0      SHORT 1 1x     asks 2401 / bids 2399 (mid 2400)     -> 2399
 *        t0+3h   BUY 1          asks 2301 / bids 2299 (mid 2300)     -> 2301
 * Original rules on the same fills, at the mids:
 *   interest at the BTC add: 4000 borrowed * 0.00125% * 2 h = 0.1
 *   interest at the BTC close: (12050 - 6025) * 0.00125% * 3 h = 0.2259375 (ETH is 1x: none)
 *   realized at mid: BTC (82000 - 80333.33) * 0.06 = 100, ETH (2400 - 2300) * 1 = 100
 * Spread and depth paid by the hyperliquid fills: 1 + 0.5 + 0.6 (BTC) + 1 + 1 (ETH) = 4.1
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FundingDeps } from './fundingSettlement.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-comparison-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, bookFills, orders, trades, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { captureFundingOracle, settleFunding, resetFundingRates, HOUR_MS } = await import('./fundingSettlement.js')
const { hyperliquidStub, installHyperliquidStub, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const { cachePrice } = await import('./priceCache.js')
const { utcNow } = await import('../utils/datetime.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }
const compareModule = new URL('../../pilot/compare.mjs', import.meta.url).href
const { buildComparison } = (await import(compareModule)) as { buildComparison: (o: Record<string, unknown>) => any }

ensureSchema()
installHyperliquidStub()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
beforeEach(() => {
  rawDb.exec(
    'DELETE FROM book_fills; DELETE FROM liquidation_events; DELETE FROM funding_payments; DELETE FROM funding_oracle_prices; ' +
      'DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  hyperliquidStub.quotes = {}
  hyperliquidStub.books = {}
  hyperliquidStub.failBook = false
  hyperliquidStub.failMeta = false
  resetMarginTables()
  resetFundingRates()
  clearPrices()
})

const HL = 0.00045
const OG = 0.0007
const RATE_H = 0.0000125
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid', capital = 10_000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `cmp-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
function setBook(coin: string, bid: number, ask: number, depth = 10) {
  hyperliquidStub.books[coin] = {
    coin, time: Date.now(),
    levels: [[{ px: String(bid), sz: String(depth), n: 1 }], [{ px: String(ask), sz: String(depth), n: 1 }]],
  }
}
/** One fill, then its trade moved to `atMs` (the engine stamps the current time). */
async function fillAt(id: number, symbol: string, side: string, quantity: number, leverage: number, atMs: number | null) {
  const o = await placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
  if (atMs !== null) rawDb.prepare('UPDATE trades SET trade_time = ? WHERE order_id = ?').run(utcNow(new Date(atMs)), o.id)
  return o
}
function near(actual: number | null | undefined, expected: number, what: string, eps = 1e-9) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** Every row of every table the report reads. */
const dump = () => JSON.stringify(['accounts', 'orders', 'trades', 'positions', 'book_fills', 'funding_payments', 'funding_oracle_prices']
  .map((t) => rawDb.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))

/** The hand-worked scenario of the header, funding settled hour by hour. */
async function scenario(rates: { BTC: number[]; ETH: number[] }) {
  const id = newAccount('hyperliquid')
  const h0 = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 6 * HOUR_MS
  const t0 = h0 + 10 * 60_000
  setBook('BTC', 79990, 80010)
  await fillAt(id, 'BTC', 'LONG', 0.1, 2, t0)
  setBook('ETH', 2399, 2401)
  await fillAt(id, 'ETH', 'SHORT', 1, 1, t0)
  setBook('BTC', 80990, 81010)
  await fillAt(id, 'BTC', 'LONG', 0.05, 2, t0 + 2 * HOUR_MS)
  setBook('ETH', 2299, 2301)
  await fillAt(id, 'ETH', 'BUY', 1, 1, t0 + 3 * HOUR_MS)
  setBook('BTC', 81990, 82010)
  await fillAt(id, 'BTC', 'SELL', 0.06, 2, t0 + 5 * HOUR_MS)
  // funding hours h0+1h .. h0+6h, oracle BTC 80000 / ETH 2400 captured at each hour
  const deps: FundingDeps = {
    fetchFundingHistory: async (coin, start, end) => {
      const out = []
      for (let h = h0 + HOUR_MS, i = 0; h <= h0 + 6 * HOUR_MS; h += HOUR_MS, i++) {
        if (h >= start && h <= end) out.push({ coin, fundingRate: String(rates[coin as 'BTC' | 'ETH'][i]), premium: '0', time: h + 30 })
      }
      return out
    },
    fetchOraclePrices: async () => ({ BTC: { oraclePx: 80000, receivedAt: Date.now() }, ETH: { oraclePx: 2400, receivedAt: Date.now() } }),
    cachedOraclePrices: () => ({}),
  }
  for (let h = h0 + HOUR_MS; h <= h0 + 6 * HOUR_MS; h += HOUR_MS) {
    const at = h + 5_000
    await captureFundingOracle(at, { ...deps, fetchOraclePrices: async () => ({ BTC: { oraclePx: 80000, receivedAt: at }, ETH: { oraclePx: 2400, receivedAt: at } }) })
  }
  await settleFunding(Date.now(), deps)
  return { id, h0, t0 }
}
const reportOf = (id: number, extra: Record<string, unknown> = {}) =>
  buildReport({ dbFile, accountId: id, prices: { BTC: 83000, ETH: 2300 }, at: new Date().toISOString(), ...extra })

test('1. hyperliquid account: same fills under both rule sets, hand-worked values, own net found again', async () => {
  // BTC: LONG pays at positive rates, receives at the negative one; ETH SHORT receives at positive rates
  const { id, t0 } = await scenario({ BTC: [0.0001, 0.0001, -0.0001, 0.0001, 0.0001, 0.0001], ETH: [0.0002, 0.0002, 0.0002, 0, 0, 0] })
  const before = dump()
  const rep = reportOf(id)
  assert.equal(dump(), before, 'the comparison wrote to the database')
  assert.deepEqual(rep.issues, [])
  const c = rep.comparison
  assert.match(c.kind, /a posteriori.*NON il risultato di due AI indipendenti/)
  assert.deepEqual(c.issues, [])
  assert.deepEqual([c.fills_compared, c.fills_with_book, c.fills_without_book, c.funding_intervals_missing], [5, 5, 0, 0])
  const o = c.same_fills.original
  const h = c.same_fills.hyperliquid
  // gross at mid, shared: realized 100 + 100, open 0.09 BTC from 80333.33 to 83000
  const avgMid = (0.1 * 80000 + 0.05 * 81000) / 0.15
  near(c.same_fills.realized_at_mid, 200, 'realized at mid', 1e-6)
  near(o.gross, 200 + 0.09 * (83000 - avgMid), 'gross at mid', 1e-6)
  near(h.gross, o.gross, 'same gross for both rule sets', 1e-12)
  // fees: original 0.07% on mid notionals, hyperliquid 0.045% on executed notionals (= recorded)
  near(o.fees, OG * (0.1 * 80000 + 1 * 2400 + 0.05 * 81000 + 1 * 2300 + 0.06 * 82000), 'original fees', 1e-9)
  const hlFees = db.select().from(trades).where(eq(trades.accountId, id)).all().reduce((s, t) => s + t.commission, 0)
  near(h.fees, hlFees, 'hyperliquid fees = recorded', 1e-12)
  near(h.fees, HL * (0.1 * 80010 + 1 * 2399 + 0.05 * 81010 + 1 * 2301 + 0.06 * 81990), 'hyperliquid fees by hand', 1e-9)
  // original interest rebuilt: 0.1 + 0.2259375 (1x ETH pays none); hyperliquid none
  near(o.interest, 0.1 + 0.2259375, 'original interest', 1e-6)
  assert.equal(h.interest, 0)
  // spread and depth
  near(h.spread_cost, 4.1, 'spread and depth', 1e-6)
  near(h.spread_cost, rep.execution.cost_vs_mid_usdc, 'same as the execution block', 1e-6)
  // funding recorded: BTC paid and received, ETH received
  const btcQ = [0.1, 0.1, 0.15, 0.15, 0.15, 0.09]
  const btcRates = [0.0001, 0.0001, -0.0001, 0.0001, 0.0001, 0.0001]
  const btcFunding = btcQ.reduce((s, q, i) => s - q * 80000 * btcRates[i]!, 0)
  const ethFunding = [1, 1, 1].reduce((s, q) => s + q * 2400 * 0.0002, 0)
  near(h.funding, btcFunding + ethFunding, 'funding net', 1e-6)
  assert.ok(h.funding_paid > 0 && h.funding_received > 0, 'paid and received')
  // the account's own rule set finds the recorded net again: nothing attributed
  near(c.self_check.difference, 0, 'hyperliquid net = recorded net', 1e-6)
  near(h.net, rep.pnl.net_usdc, 'hyperliquid net = report net', 1e-4)
  near(h.equity, account(id).initialCapital + h.net, 'equity')
  // no double count: the gap is exactly the cost components
  near(h.net - o.net, (o.fees - h.fees) + o.interest + h.funding - h.spread_cost, 'net gap = cost gap', 1e-9)
  near(c.same_fills.difference_hyperliquid_minus_original.net, h.net - o.net, 'difference row', 1e-12)
  // per operation
  const ops = c.operations
  assert.deepEqual(ops.map((r: any) => [r.symbol, r.action, r.position_side]), [
    ['BTC', 'open', 'LONG'], ['ETH', 'open', 'SHORT'], ['BTC', 'increase', 'LONG'], ['ETH', 'close', 'SHORT'], ['BTC', 'partial_close', 'LONG'],
  ])
  assert.deepEqual(ops.map((r: any) => [r.mid_price, r.hyperliquid_price]), [[80000, 80010], [2400, 2399], [81000, 81010], [2300, 2301], [82000, 81990]])
  near(ops[2].interest_original, 0.1, 'interest at the add', 1e-9)
  near(ops[4].interest_original, 0.2259375, 'interest at the partial close', 1e-6)
  near(ops[4].realized_at_mid, 100, 'BTC realized at mid', 1e-6)
  near(ops[3].realized_hyperliquid, 98, 'ETH realized at the book', 1e-9)
  // if_closed: estimate at the final prices, accrued original interest from the last BTC fill
  const accrued = (0.09 * avgMid - 6025 * 0.09 / 0.15) * RATE_H * (Date.parse(rep.window.to) - (t0 + 5 * HOUR_MS)) / HOUR_MS
  near(c.if_closed.original.accrued_interest, accrued, 'accrued original interest', 1e-6)
  near(c.if_closed.original.closing_fees, 0.09 * 83000 * OG, 'original closing fee')
  near(c.if_closed.hyperliquid.closing_fees, 0.09 * 83000 * HL, 'hyperliquid closing fee')
  assert.match(c.if_closed.basis, /^STIMA/)
})

test('2. equal rules give equal results: nothing comes from the comparison itself', async () => {
  const id = newAccount('hyperliquid')
  for (const [coin, px, side, q, lev] of [['SOL', 100, 'LONG', 2, 1], ['XRP', 1.25, 'SHORT', 40, 1]] as const) {
    setBook(coin, px, px) // zero spread
    await fillAt(id, coin, side, q, lev, null)
  }
  setBook('SOL', 110, 110)
  await fillAt(id, 'SOL', 'SELL', 1, 1, null)
  const rep = reportOf(id, { prices: { SOL: 105, XRP: 1.2 } })
  const raw = buildReport({ dbFile, accountId: id, prices: { SOL: 105, XRP: 1.2 }, at: new Date().toISOString() })
  const tradesRows = rawDb.prepare('SELECT t.*, o.order_no, o.leverage AS order_leverage FROM trades t JOIN orders o ON o.id = t.order_id WHERE t.account_id = ? ORDER BY t.trade_time, t.id').all(id)
  const same = buildComparison({
    costModel: 'hyperliquid', initialCapital: 10_000, trades: tradesRows,
    orders: rawDb.prepare('SELECT * FROM orders WHERE account_id = ?').all(id),
    bookFills: rawDb.prepare('SELECT * FROM book_fills WHERE account_id = ?').all(id), fundingRows: [], fundingNotRecorded: 0,
    finalPrices: { SOL: 105, XRP: 1.2 }, asOf: new Date().toISOString(), feeRates: { original: HL, hyperliquid: HL },
    interestRateHourly: RATE_H, recordedNet: raw.pnl.net_usdc,
  })
  // 1x positions (no interest), no funding hour, zero spread, same fee rate: identical nets
  near(same.same_fills.original.net, same.same_fills.hyperliquid.net, 'equal nets', 1e-9)
  near(same.same_fills.hyperliquid.spread_cost, 0, 'no spread', 1e-12)
  assert.equal(same.same_fills.original.interest, 0)
  near(rep.comparison.self_check.difference, 0, 'own net found', 1e-6)
})

test('3. original account: own net found again; Hyperliquid side n.d. (no book, no funding recorded)', async () => {
  const id = newAccount('original')
  cachePrice('BTC', 'CRYPTO', 80000)
  await fillAt(id, 'BTC', 'LONG', 0.1, 3, null)
  cachePrice('ETH', 'CRYPTO', 2400)
  await fillAt(id, 'ETH', 'SHORT', 1, 2, null)
  cachePrice('BTC', 'CRYPTO', 81000)
  await fillAt(id, 'BTC', 'SELL', 0.04, 3, null)
  const before = dump()
  const rep = reportOf(id, { prices: { BTC: 82000, ETH: 2350 } })
  assert.equal(dump(), before)
  const c = rep.comparison
  near(c.self_check.difference, 0, 'original net = recorded net', 1e-6)
  near(c.same_fills.original.net, rep.pnl.net_usdc, 'original net = report net', 1e-4)
  near(c.self_check.interest_gap, 0, 'interest rebuilt from fill times = interest charged', 1e-6)
  const h = c.same_fills.hyperliquid
  assert.equal(h.net, null, 'n.d.: no book and no funding recorded')
  assert.equal(h.spread_cost, null)
  assert.equal(h.funding, null)
  assert.equal(h.complete, false)
  near(h.fees, HL * (0.1 * 80000 + 1 * 2400 + 0.04 * 81000), 'only the fee can be recomputed', 1e-9)
  assert.equal(c.same_intentions.available, false)
  assert.deepEqual([c.fills_with_book, c.fills_without_book], [0, 3])
  assert.equal('execution' in rep, false, 'original report sections unchanged')
})

test('4. a hyperliquid fill without a book snapshot: spread n.d., net n.d., known components shown', async () => {
  const id = newAccount('hyperliquid')
  setBook('SOL', 99.9, 100.1)
  const o = await fillAt(id, 'SOL', 'LONG', 2, 2, null)
  await fillAt(id, 'SOL', 'LONG', 1, 2, null)
  // a fill recorded before 006I-5 has no snapshot (made here by removing it)
  rawDb.prepare('DELETE FROM book_fills WHERE order_id = ?').run(o.id)
  const c = reportOf(id, { prices: { SOL: 101 } }).comparison
  assert.deepEqual([c.fills_with_book, c.fills_without_book], [1, 1])
  assert.equal(c.same_fills.hyperliquid.spread_cost, null)
  assert.equal(c.same_fills.hyperliquid.net, null)
  assert.ok(Number.isFinite(c.same_fills.hyperliquid.net_known_components_only))
  assert.match(c.same_fills.hyperliquid.sources.prices, /1 fill senza snapshot del book: spread n\.d\./)
  assert.equal(c.self_check.rebuilt_net, null)
})

test('5. funding not settled or not recorded: Hyperliquid net n.d.', async () => {
  const id = newAccount('hyperliquid')
  setBook('ETH', 2399, 2401)
  await fillAt(id, 'ETH', 'LONG', 1, 2, Date.now() - 3 * HOUR_MS) // held across hours, nothing settled
  const c = reportOf(id, { prices: { ETH: 2400 } }).comparison
  assert.ok(c.funding_intervals_missing >= 2)
  assert.equal(c.same_fills.hyperliquid.complete, false)
  assert.equal(c.same_fills.hyperliquid.net, null)
  assert.match(c.same_fills.hyperliquid.sources.funding, /intervalli non regolati o non registrati/)
  // the original side does not depend on funding
  assert.ok(Number.isFinite(c.same_fills.original.net))
})

test('6. same intentions: rounded and partial orders listed, refusals counted from the trace, no chained P&L', async () => {
  const id = newAccount('hyperliquid')
  hyperliquidStub.books.BTC = {
    coin: 'BTC', time: Date.now(),
    levels: [[{ px: '79990', sz: '1', n: 1 }], [{ px: '80010', sz: '0.003', n: 1 }]],
  }
  await fillAt(id, 'BTC', 'LONG', 0.0054321, 2, null) // lot 0.00001 -> 0.00543, book 0.003 only
  const traceFile = path.join(tmpDir, 'trace-6.jsonl')
  fs.writeFileSync(traceFile, JSON.stringify({ ts: new Date().toISOString(), cycle_id: 'c', event: 'outcome', account_id: id, status: 'execution_failed', detail: 'Error: Hyperliquid order refused (MinTradeNtl): x' }) + '\n')
  const c = reportOf(id, { traceFile, prices: { BTC: 80000 } }).comparison
  const b = c.same_intentions
  assert.equal(b.available, true)
  assert.deepEqual(b.orders.map((o: any) => [o.requested, o.executed, o.status]), [[0.0054321, 0.003, 'PARTIALLY_FILLED']])
  near(b.orders[0].not_executed, 0.0024321, 'not executed', 1e-12)
  near(b.orders[0].requested_at_mid_original, 0.0054321 * 80000, 'original would execute the whole request at the mid', 1e-9)
  assert.deepEqual([b.rounded_or_partial, b.refused], [1, 1])
  assert.match(b.note, /Nessun P&L concatenato/)
})
