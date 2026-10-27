/**
 * Execution against the Hyperliquid order book in the 'hyperliquid' cost
 * model (Task 006I-5); the 'original' model unchanged.
 *
 * Run: npx tsx --test src/services/bookExecution.test.ts
 *
 * Throwaway SQLite file; the ccxt exchange is replaced by the stub: `meta` is
 * the real snapshot of 2026-10-27, `l2Book` answers are the books written in
 * each test ({ coin, time, levels: [bids, asks] }, levels { px, sz, n } as
 * strings, best first). No network. Expected values are worked out by hand:
 *   buy  (LONG open, SHORT close) takes the asks, sell the bids, best first;
 *   average price = sum(px * sz taken) / size filled;
 *   AI orders stop at mid * (1 +/- 5%), liquidations do not;
 *   what the visible book cannot fill is not filled (IOC).
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FundingDeps } from './fundingSettlement.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-exec-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, bookFills, liquidationEvents, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')
const { floorToLot, resetMarginTables } = await import('./hyperliquidMarket.js')
const { parseL2Book, walkBook, BOOK_MAX_AGE_MS, HL_MARKET_SLIPPAGE } = await import('./hyperliquidBook.js')
const { captureFundingOracle, settleFunding, resetFundingRates, HOUR_MS } = await import('./fundingSettlement.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const { cachePrice } = await import('./priceCache.js')
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
  rawDb.exec(
    'DELETE FROM book_fills; DELETE FROM liquidation_events; DELETE FROM funding_payments; DELETE FROM funding_oracle_prices; ' +
      'DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  hyperliquidStub.quotes = {}
  hyperliquidStub.books = {}
  hyperliquidStub.failTickers = false
  hyperliquidStub.failMeta = false
  hyperliquidStub.failBook = false
  resetMarginTables()
  resetFundingRates()
  clearPrices()
})

const HL = 0.00045
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `bk-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const bookRows = (id: number) => db.select().from(bookFills).where(eq(bookFills.accountId, id)).all()
/** A raw l2Book answer: levels as [px, sz] pairs, best first. */
function book(coin: string, bids: [number, number][], asks: [number, number][], time = Date.now()) {
  const side = (ls: [number, number][]) => ls.map(([px, sz]) => ({ px: String(px), sz: String(sz), n: 1 }))
  return { coin, time, levels: [side(bids), side(asks)] }
}
function setBook(coin: string, bids: [number, number][], asks: [number, number][], time?: number) {
  hyperliquidStub.books[coin] = book(coin, bids, asks, time)
}
async function order(id: number, symbol: string, side: string, quantity: number, leverage: number, orderNo?: string) {
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage, orderNo })
}
const snapshot = (id: number) => JSON.stringify({
  account: account(id),
  positions: db.select().from(positions).where(eq(positions.accountId, id)).all(),
  orders: db.select().from(orders).where(eq(orders.accountId, id)).all(),
  trades: fills(id),
  book: bookRows(id),
})
async function refused(id: number, run: () => Promise<unknown>, message: RegExp) {
  const before = snapshot(id)
  await assert.rejects(run, message)
  assert.equal(snapshot(id), before, 'a refused order changed cash, margin, positions, orders, trades or book fills')
}
function near(actual: number | null | undefined, expected: number, what: string, eps = 1e-9) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
function reconciled(id: number, prices: Record<string, number>) {
  const rep = buildReport({ dbFile, accountId: id, prices, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}

// --- 0. floorToLot (006I-4) ------------------------------------------------------------------

test('0. floorToLot with lot 0.1: 0.29 -> 0.2, 0.1 + 0.2 -> 0.3, never above the request', () => {
  assert.equal(floorToLot(0.29, 1), 0.2)
  assert.equal(floorToLot(0.1 + 0.2, 1), 0.3) // 0.30000000000000004: 3 lots within the numeric tolerance
  assert.equal(floorToLot(0.2999, 1), 0.2)
  assert.equal(floorToLot(0.35, 1), 0.3)
  for (let i = 1; i <= 2000; i++) {
    const size = i * 0.0137
    for (const d of [0, 1, 2, 3, 4, 5]) {
      const lot = floorToLot(size, d)
      assert.ok(lot <= size + 1e-12, `${size} @ ${d}: ${lot} above the request`)
      assert.ok(size - lot < 10 ** -d + 1e-12, `${size} @ ${d}: ${lot} more than one lot below`)
    }
  }
})

// --- 1. the snapshot -------------------------------------------------------------------------

test('1. book validation: valid, empty, invalid, crossed, stale, future, another coin', () => {
  const now = Date.now()
  const ok = parseL2Book(book('BTC', [[79990, 0.5], [79980, 1]], [[80010, 0.3], [80020, 1]], now), 'BTC', now)
  assert.ok(!('error' in ok))
  if ('error' in ok) return
  assert.deepEqual([ok.bestBid, ok.bestAsk, ok.mid, ok.spread], [79990, 80010, 80000, 20])
  // bid = ask (no spread) is accepted, bid > ask is not
  assert.ok(!('error' in parseL2Book(book('BTC', [[80000, 1]], [[80000, 1]], now), 'BTC', now)))
  const bad: [unknown, RegExp][] = [
    [null, /not an object/],
    [book('ETH', [[1, 1]], [[2, 1]], now), /belongs to ETH/],
    [{ ...book('BTC', [[1, 1]], [[2, 1]], now), time: undefined }, /snapshot time missing/],
    [book('BTC', [[1, 1]], [[2, 1]], now - BOOK_MAX_AGE_MS - 1), /s old/],
    [book('BTC', [[1, 1]], [[2, 1]], now + 6_000), /in the future/],
    [{ coin: 'BTC', time: now }, /levels missing/],
    [book('BTC', [], [[2, 1]], now), /no bids/],
    [book('BTC', [[1, 1]], [], now), /no asks/],
    [book('BTC', [[80010, 1]], [[79990, 1]], now), /crossed/],
    [book('BTC', [[79990, 1], [79995, 1]], [[80010, 1]], now), /bids not ordered/],
    [book('BTC', [[79990, 1]], [[80010, 1], [80005, 1]], now), /asks not ordered/],
  ]
  for (const [raw, message] of bad) {
    const r = parseL2Book(raw, 'BTC', now)
    assert.ok('error' in r && message.test(r.error), `${JSON.stringify(raw)?.slice(0, 80)}: ${JSON.stringify(r)}`)
  }
  for (const [px, sz] of [['0', '1'], ['-1', '1'], ['abc', '1'], ['1', '0'], ['1', null], ['', '1']]) {
    const raw = { coin: 'BTC', time: now, levels: [[{ px, sz, n: 1 }], [{ px: '2', sz: '1', n: 1 }]] }
    const r = parseL2Book(raw, 'BTC', now)
    assert.ok('error' in r && /invalid bids level/.test(r.error), `${px}/${sz}`)
  }
})

test('2. walking the book: one level, several levels, weighted average, partial, slippage bound', () => {
  const now = Date.now()
  const b = parseL2Book(book('BTC', [[79990, 0.002], [79900, 0.004]], [[80010, 0.003], [80020, 0.002], [90000, 1]], now), 'BTC', now)
  assert.ok(!('error' in b))
  if ('error' in b) return
  // one level
  let f = walkBook(b, 'buy', 0.002, null)
  assert.deepEqual([f.filled, f.avgPrice, f.partial, f.levels.length], [0.002, 80010, false, 1])
  // two levels: (0.003 * 80010 + 0.002 * 80020) / 0.005 = 80014
  f = walkBook(b, 'buy', 0.005, null)
  near(f.avgPrice, 80014, 'weighted ask average', 1e-9)
  assert.deepEqual([f.filled, f.partial], [0.005, false])
  // sells take the bids: (0.002 * 79990 + 0.003 * 79900) / 0.005 = 79936
  f = walkBook(b, 'sell', 0.005, null)
  near(f.avgPrice, 79936, 'weighted bid average', 1e-9)
  // more than the visible bids: partial
  f = walkBook(b, 'sell', 0.01, null)
  assert.deepEqual([f.filled, f.partial], [0.006, true])
  // the 5% bound stops the buy before 90000 (mid 80000 -> 84000)
  f = walkBook(b, 'buy', 0.1, b.mid * (1 + HL_MARKET_SLIPPAGE))
  assert.deepEqual([f.filled, f.partial, f.worstPrice], [0.005, true, 80020])
})

// --- 2. engine fills ---------------------------------------------------------------------------

test('3. LONG opens on the asks and closes on the bids; P&L, fee and margin at the prices filled', async () => {
  const id = newAccount()
  setBook('BTC', [[79990, 0.002], [79900, 0.004]], [[80010, 0.003], [80020, 0.002]])
  const requests = hyperliquidStub.bookRequests
  const open = await order(id, 'BTC', 'LONG', 0.005, 2)
  assert.equal(hyperliquidStub.bookRequests - requests, 1, 'one l2Book request per order')
  near(open.price, 80014, 'average fill price on the order')
  assert.deepEqual([open.filledQuantity, open.status], [0.005, 'FILLED'])
  const p = position(id, 'BTC')!
  near(p.avgCost, 80014, 'entry at the asks')
  near(p.margin, 0.005 * 80014 / 2, 'margin on the notional filled')
  near(fills(id)[0]!.commission, 0.005 * 80014 * HL, 'open fee')
  const row = bookRows(id)[0]!
  assert.deepEqual([row.bookSide, row.bestBid, row.bestAsk, row.mid, row.status, JSON.parse(row.levels).length], ['buy', 79990, 80010, 80000, 'filled', 2])
  near(row.limitPrice, 80000 * 1.05, 'IOC limit at mid + 5%')
  const close = await order(id, 'BTC', 'SELL', 0.005, 2)
  near(close.price, 79936, 'exit at the bids')
  const pnl = 0.005 * (79936 - 80014) // -0.39
  near(account(id).currentCash, 1000 - 0.005 * 80014 * HL - 0.005 * 79936 * HL + pnl, 'cash = capital - fees + P&L')
  assert.equal(position(id, 'BTC')!.quantity, 0)
  const rep = reconciled(id, { BTC: 80000 })
  // cost against the mid 80000: buy 0.005 * 14 = 0.07, sell 0.005 * 64 = 0.32; half spread 0.005 * 10 each
  near(rep.execution.cost_vs_mid_usdc, 0.39, 'spread and depth cost', 1e-6)
  near(rep.execution.half_spread_cost_usdc, 0.1, 'half spread', 1e-6)
  near(rep.execution.depth_impact_usdc, 0.29, 'depth impact', 1e-6)
})

test('4. SHORT opens on the bids and closes on the asks', async () => {
  const id = newAccount()
  setBook('ETH', [[2399, 0.1], [2398, 0.2]], [[2401, 0.1], [2402, 0.3]])
  await order(id, 'ETH', 'SHORT', 0.25, 3) // 0.1 @ 2399 + 0.15 @ 2398 = 2398.4
  near(position(id, 'ETH')!.avgCost, 2398.4, 'entry at the bids')
  const close = await order(id, 'ETH', 'BUY', 0.25, 3) // 0.1 @ 2401 + 0.15 @ 2402 = 2401.6
  near(close.price, 2401.6, 'exit at the asks')
  const pnl = 0.25 * (2398.4 - 2401.6) // SHORT: -0.8
  near(account(id).currentCash, 1000 + pnl - 0.25 * 2398.4 * HL - 0.25 * 2401.6 * HL, 'cash')
  reconciled(id, { ETH: 2400 })
})

test('5. partial fills: the book fills less than asked, nothing is invented, the rest is cancelled', async () => {
  const id = newAccount()
  setBook('SOL', [[99.9, 1]], [[100.1, 0.6]]) // only 0.6 SOL offered
  const open = await order(id, 'SOL', 'LONG', 1, 2)
  assert.deepEqual([open.quantity, open.filledQuantity, open.status], [1, 0.6, 'PARTIALLY_FILLED'])
  assert.equal(position(id, 'SOL')!.quantity, 0.6)
  near(position(id, 'SOL')!.margin, 0.6 * 100.1 / 2, 'margin of the size filled only')
  near(account(id).currentCash, 1000 - 0.6 * 100.1 / 2 - 0.6 * 100.1 * HL, 'cash for the size filled only')
  assert.equal(bookRows(id)[0]!.status, 'partial')
  // partial close: 0.6 held, the bids show 0.25
  setBook('SOL', [[99.9, 0.25]], [[100.1, 5]])
  const close = await order(id, 'SOL', 'SELL', 0.6, 2)
  assert.deepEqual([close.filledQuantity, close.status], [0.25, 'PARTIALLY_FILLED'])
  assert.equal(position(id, 'SOL')!.quantity, 0.35)
  near(position(id, 'SOL')!.margin, 0.6 * 100.1 / 2 * (0.35 / 0.6), 'margin released pro rata', 1e-9)
  const rep = reconciled(id, { SOL: 100 })
  assert.equal(rep.execution.partial_fills, 2)
})

test('6. refused: unusable book, nothing within the 5% bound, request failure; nothing booked', async () => {
  const id = newAccount()
  const cases: [() => void, RegExp][] = [
    [() => setBook('BTC', [], [[80010, 1]]), /no bids/],
    [() => setBook('BTC', [[80010, 1]], [[79990, 1]]), /crossed/],
    [() => setBook('BTC', [[79990, 1]], [[80010, 1]], Date.now() - 60_000), /60 s old/],
    [() => { hyperliquidStub.books.BTC = { coin: 'BTC', time: Date.now(), levels: [[{ px: 'x', sz: '1', n: 1 }], []] } }, /invalid bids level/],
    [() => { hyperliquidStub.books.BTC = { coin: 'BTC', time: Date.now(), levels: [[], []] } }, /no bids/],
    // asks only far above the mid (79990 / 95000 -> mid 87495, bound 91869.75)
    [() => setBook('BTC', [[79990, 1]], [[95000, 1]]), /no ask level of the BTC book within 91869\.75/],
    [() => { delete hyperliquidStub.books.BTC; hyperliquidStub.failBook = true; quote('BTC', 80000) }, /BTC book request failed/],
  ]
  for (const [arrange, message] of cases) {
    hyperliquidStub.failBook = false
    arrange()
    await refused(id, () => order(id, 'BTC', 'LONG', 0.002, 2), message)
  }
})

test('7. liquidation decided at mark, executed on the bids; an insufficient book leaves the rest open', async () => {
  const id = newAccount()
  setBook('BTC', [[79999, 1]], [[80000, 1]])
  await order(id, 'BTC', 'LONG', 0.1, 10) // 8000 USD, margin 800, fee 3.6
  // mark 70800: account value 996.4 + 0.1 * (70800 - 80000) = 76.4 < maintenance 0.1 * 70800 / 80 = 88.5
  quote('BTC', 70820, 70800)
  setBook('BTC', [[70700, 0.04], [70650, 0.03]], [[70900, 1]]) // only 0.07 BTC bid
  await (new TaskScheduler() as any).checkMarginLevels()
  const liq = db.select().from(orders).where(eq(orders.accountId, id)).all().at(-1)!
  assert.ok(liq.orderNo.startsWith('LIQ-'))
  assert.deepEqual([liq.quantity, liq.filledQuantity, liq.status], [0.1, 0.07, 'PARTIALLY_FILLED'])
  const avg = (0.04 * 70700 + 0.03 * 70650) / 0.07
  near(liq.price, avg, 'filled at the bids, not at the mark 70800')
  assert.equal(bookRows(id).at(-1)!.limitPrice, null, 'liquidations: no slippage bound')
  assert.equal(position(id, 'BTC')!.quantity, 0.03, 'no fictitious full close: 0.03 BTC still open')
  const ev = db.select().from(liquidationEvents).where(eq(liquidationEvents.accountId, id)).all()
  assert.equal(ev.length, 1)
  near(JSON.parse(ev[0]!.marks).BTC, 70800, 'decision at mark')
  // after the partial close the account is healthy again: 0.03 BTC stays open
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'BTC')!.quantity, 0.03)
  reconciled(id, { BTC: 70820 })
})

test('8. funding is charged on the size the book filled', async () => {
  const id = newAccount()
  setBook('ETH', [[2399, 5]], [[2401, 2.5]])
  await order(id, 'ETH', 'LONG', 3.75, 10) // only 2.5 ETH offered
  assert.equal(position(id, 'ETH')!.quantity, 2.5)
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS
  rawDb.prepare('UPDATE trades SET trade_time = ? WHERE account_id = ?').run(utcNow(new Date(hour - 60_000)), id)
  const deps: FundingDeps = {
    fetchFundingHistory: async (coin) => [{ coin, fundingRate: '0.001', premium: '0', time: hour + 30 }],
    fetchOraclePrices: async () => ({ ETH: { oraclePx: 2390, receivedAt: hour + 5_000 } }),
    cachedOraclePrices: () => ({}),
  }
  await captureFundingOracle(hour + 5_000, deps)
  const cash = account(id).currentCash
  await settleFunding(hour + 10_000, deps)
  near(cash - account(id).currentCash, 2.5 * 2390 * 0.001, 'funding on 2.5 ETH at the oracle, not on the fill price')
  reconciled(id, { ETH: 2400 })
})

test('9. original model unchanged: last price, no book request, no book rows, report without execution block', async () => {
  const id = newAccount('original')
  const requests = hyperliquidStub.bookRequests
  cachePrice('BTC', 'CRYPTO', 80000)
  setBook('BTC', [[70000, 1]], [[90000, 1]]) // ignored by the original model
  const o = await order(id, 'BTC', 'LONG', 0.005, 2)
  assert.deepEqual([o.price, o.filledQuantity, o.status], [80000, 0.005, 'FILLED'])
  cachePrice('BTC', 'CRYPTO', 81000)
  await order(id, 'BTC', 'SELL', 0.005, 2)
  near(account(id).currentCash, 1000 + 0.005 * 1000 - 0.005 * 80000 * 0.0007 - 0.005 * 81000 * 0.0007, 'original cash (plus interest of a few ms)', 1e-6)
  assert.equal(hyperliquidStub.bookRequests, requests)
  assert.equal(bookRows(id).length, 0)
  const rep = buildReport({ dbFile, accountId: id, prices: { BTC: 81000 }, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [])
  assert.equal('execution' in rep, false)
  assert.match(rep.if_closed.basis, /nessuno spread, slippage o impatto di prezzo$/)
})

test('10. if_closed in hyperliquid is declared an estimate at the final prices, not a book execution', async () => {
  const id = newAccount()
  setBook('SOL', [[99.9, 10]], [[100.1, 10]])
  await order(id, 'SOL', 'LONG', 1, 2)
  const rep = reconciled(id, { SOL: 100 })
  assert.match(rep.if_closed.basis, /STIMA ai prezzi finali \(mid\), non un'esecuzione verificata sul book/)
  assert.match(rep.cost_model.note, /IOC sul book l2Book/)
})
