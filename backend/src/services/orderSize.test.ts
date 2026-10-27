/**
 * Order size precision and minimum order value of the 'hyperliquid' cost
 * model (Task 006I-4); the 'original' model unchanged.
 *
 * Run: npx tsx --test src/services/orderSize.test.ts
 *
 * Throwaway SQLite file; the ccxt exchange is replaced by the stub serving the
 * real `meta` snapshot of 2026-10-27 (__fixtures__/hyperliquid-meta.json):
 * szDecimals BTC 5, ETH 4, BNB 3, SOL 2, XRP 0, DOGE 0. No network.
 * Rules (docs for-developers/api/tick-and-lot-size and error-responses):
 *   size rounded DOWN to the lot 10^-szDecimals (never above the request);
 *   an order worth less than 10 USD is refused (MinTradeNtl), except a close
 *   of the whole position and a liquidation.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FundingDeps } from './fundingSettlement.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-size-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')
const { floorToLot, hyperliquidSizeDecimals, resetMarginTables, HL_MIN_ORDER_NOTIONAL } = await import('./hyperliquidMarket.js')
const { parseMetaResponse } = await import('./hyperliquidMarginData.js')
const { captureFundingOracle, settleFunding, resetFundingRates, HOUR_MS } = await import('./fundingSettlement.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices, META } = await import('./__fixtures__/hyperliquidStub.js')
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

const META_BACKUP = structuredClone(META)
beforeEach(() => {
  rawDb.exec(
    'DELETE FROM liquidation_events; DELETE FROM funding_payments; DELETE FROM funding_oracle_prices; ' +
      'DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  Object.assign(META, structuredClone(META_BACKUP))
  hyperliquidStub.quotes = {}
  hyperliquidStub.failTickers = false
  hyperliquidStub.failMeta = false
  resetMarginTables()
  resetFundingRates()
  clearPrices()
})

const HL = 0.00045
const SZ: Record<string, number> = { BTC: 5, ETH: 4, BNB: 3, SOL: 2, XRP: 0, DOGE: 0 }
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `os-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const lastOrder = (id: number) => db.select().from(orders).where(eq(orders.accountId, id)).all().at(-1)!
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
async function fill(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number, orderNo?: string) {
  quote(symbol, price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage, orderNo })
}
/** Everything a refused order must leave untouched. */
const snapshot = (id: number) => JSON.stringify({
  account: account(id),
  positions: db.select().from(positions).where(eq(positions.accountId, id)).all(),
  orders: db.select().from(orders).where(eq(orders.accountId, id)).all(),
  trades: fills(id),
})
async function refused(id: number, run: () => Promise<unknown>, message: RegExp) {
  const before = snapshot(id)
  await assert.rejects(run, message)
  assert.equal(snapshot(id), before, 'a refused order changed cash, margin, positions, orders or trades')
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

// --- precision -----------------------------------------------------------------------------

test('1. szDecimals of the six markets come from meta; sizes rounded down to the lot, floating point safe', async () => {
  for (const [coin, d] of Object.entries(SZ)) assert.deepEqual(await hyperliquidSizeDecimals(coin), { szDecimals: d }, coin)
  const cases: [number, number, number][] = [
    // [size, szDecimals, expected]
    [0.000019999, 5, 0.00001], // just below 2 lots
    [0.00002, 5, 0.00002], // 0.00002 * 1e5 = 2.0000000000000004: exactly 2 lots
    [0.000009999, 5, 0], // below one lot
    [0.123456789, 5, 0.12345],
    [0.20839, 4, 0.2083],
    [0.29, 2, 0.29], // 0.29 * 100 = 28.999999999999996
    [0.1 + 0.2, 2, 0.3], // 0.30000000000000004
    [1.239, 2, 1.23],
    [0.0139, 3, 0.013],
    [150.9, 0, 150],
    [7.99999, 0, 7],
    [8, 0, 8],
  ]
  for (const [size, d, expected] of cases) assert.equal(floorToLot(size, d), expected, `${size} @ ${d}`)
})

test('2. each market: an open executes the size rounded down; order keeps the request; fee and margin on the size executed', async () => {
  const px: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }
  const ask: Record<string, number> = { BTC: 0.0012349, ETH: 0.041679, SOL: 1.2399, BNB: 0.27119, XRP: 77.9, DOGE: 1250.7 }
  const got: Record<string, number> = { BTC: 0.00123, ETH: 0.0416, SOL: 1.23, BNB: 0.271, XRP: 77, DOGE: 1250 }
  const id = newAccount('hyperliquid', 100_000)
  for (const coin of Object.keys(SZ)) {
    const cash = account(id).currentCash
    const order = await fill(id, coin, coin === 'XRP' ? 'SHORT' : 'LONG', ask[coin]!, 2, px[coin]!)
    assert.equal(order.quantity, ask[coin], `${coin}: requested size kept on the order`)
    assert.equal(order.filledQuantity, got[coin], `${coin}: size executed`)
    const p = position(id, coin)!
    assert.equal(p.quantity, got[coin])
    const t = fills(id).at(-1)!
    assert.equal(t.quantity, got[coin])
    near(t.commission, got[coin]! * px[coin]! * HL, `${coin} fee`)
    near(p.margin, (got[coin]! * px[coin]!) / 2, `${coin} margin`)
    near(cash - account(id).currentCash, (got[coin]! * px[coin]!) * (0.5 + HL), `${coin} cash`)
    assert.ok(got[coin]! <= ask[coin]!, 'never above the request')
  }
  // the report lists requested and executed sizes, and the refusals found in the trace
  const traceFile = path.join(tmpDir, 'trace-2.jsonl')
  fs.writeFileSync(traceFile, JSON.stringify({
    ts: '2026-10-27T10:00:00.000Z', cycle_id: 'c1', event: 'outcome', account_id: id, status: 'execution_failed',
    detail: 'LONG SOL quantity=0.05 leverage=1x: Error: Hyperliquid order refused (MinTradeNtl): 0.05 SOL x 100 = 5.0000 USD, below the minimum of 10 USD',
  }) + '\n')
  const rep = buildReport({ dbFile, traceFile, accountId: id, prices: px, at: new Date().toISOString() })
  assert.equal(rep.reconciliation.ok, true)
  assert.equal(rep.order_sizes.filled_orders, 6)
  assert.deepEqual(rep.order_sizes.rounded.map((o: any) => [o.symbol, o.requested, o.executed]), Object.keys(SZ).map((c) => [c, ask[c], got[c]]))
  assert.equal(rep.order_sizes.refused.length, 1)
  assert.match(rep.cost_model.note, /precisione degli ordini/)
})

// --- minimum order value ---------------------------------------------------------------------

test('3. order value 9.99 / 10 / 10.01 USD: refused below 10, accepted from 10; rounding comes first', async () => {
  assert.equal(HL_MIN_ORDER_NOTIONAL, 10)
  const id = newAccount()
  await refused(id, () => fill(id, 'XRP', 'LONG', 10, 1, 0.999), /MinTradeNtl.*9\.9900 USD, below the minimum of 10 USD/)
  await fill(id, 'XRP', 'LONG', 10, 1, 1) // 10.00
  assert.equal(position(id, 'XRP')!.quantity, 10)
  await fill(id, 'XRP', 'LONG', 10, 1, 1.001) // 10.01
  assert.equal(position(id, 'XRP')!.quantity, 20)
  // 0.0999 SOL asked at 100 is 9.99 USD; the lot (0.01) gives 0.09 = 9 USD: refused
  await refused(id, () => fill(id, 'SOL', 'LONG', 0.0999, 1, 100), /MinTradeNtl.*0\.09 SOL/)
  // 0.10009 SOL is rounded to 0.1 = 10 USD: accepted
  await fill(id, 'SOL', 'SHORT', 0.10009, 1, 100)
  assert.equal(position(id, 'SOL')!.quantity, 0.1)
  // below one lot
  await refused(id, () => fill(id, 'DOGE', 'LONG', 0.9, 1, 20), /below the lot 1 \(szDecimals 0\)/)
  reconciled(id, { XRP: 1.001, SOL: 100 })
})

test('4. LONG and SHORT, increases and partial closes use the size executed; a partial close under 10 USD is refused', async () => {
  const id = newAccount('hyperliquid', 10_000)
  await fill(id, 'BTC', 'SHORT', 0.0125, 5, 80000) // 1000 USD
  await fill(id, 'BTC', 'SHORT', 0.0062499, 5, 80000) // increase: 0.00624
  assert.equal(position(id, 'BTC')!.quantity, 0.01874)
  near(position(id, 'BTC')!.margin, 0.01874 * 80000 / 5, 'margin after increase')
  await fill(id, 'BTC', 'BUY', 0.0041237, 5, 78000) // partial close: 0.00412
  const p = position(id, 'BTC')!
  assert.equal(p.quantity, 0.01462)
  assert.equal(lastOrder(id).filledQuantity, 0.00412)
  near(p.margin, 0.01874 * 80000 / 5 * (0.01462 / 0.01874), 'margin released pro rata', 1e-9)
  // a partial close worth 8 USD: MinTradeNtl, nothing booked
  await refused(id, () => fill(id, 'BTC', 'BUY', 0.0001, 5, 80000), /MinTradeNtl/)
  // LONG with increase and partial close
  await fill(id, 'ETH', 'LONG', 0.5, 3, 2400)
  await fill(id, 'ETH', 'LONG', 0.12345, 3, 2500) // 0.1234
  await fill(id, 'ETH', 'SELL', 0.30001, 3, 2600) // 0.3
  assert.equal(position(id, 'ETH')!.quantity, 0.3234)
  reconciled(id, { BTC: 78000, ETH: 2600 })
})

test('5. a full close is allowed below 10 USD and leaves no residue; a non-lot remainder closes in full', async () => {
  const id = newAccount()
  await fill(id, 'SOL', 'LONG', 1, 2, 100)
  await fill(id, 'SOL', 'SELL', 0.95, 2, 100) // leaves 0.05 SOL = 5 USD
  assert.equal(position(id, 'SOL')!.quantity, 0.05)
  await refused(id, () => fill(id, 'SOL', 'SELL', 0.04, 2, 100), /MinTradeNtl/) // partial, 4 USD
  await fill(id, 'SOL', 'SELL', 0.05, 2, 100) // whole position, 5 USD: allowed
  const p = position(id, 'SOL')!
  assert.deepEqual([p.quantity, p.margin, p.side], [0, null, null])
  // a position whose size is not a lot multiple (row written before 006I-4) closes in full, as it is
  await fill(id, 'ETH', 'LONG', 0.01, 1, 2400)
  rawDb.prepare('UPDATE positions SET quantity = 0.0100007, available_quantity = 0.0100007, margin = 24.00168 WHERE account_id = ? AND symbol = ?').run(id, 'ETH')
  rawDb.prepare('UPDATE trades SET quantity = 0.0100007 WHERE account_id = ? AND symbol = ?').run(id, 'ETH')
  rawDb.prepare('UPDATE accounts SET margin_used = 0 WHERE id = ?').run(id)
  const order = await fill(id, 'ETH', 'SELL', 0.0100007, 1, 2400)
  assert.equal(order.filledQuantity, 0.0100007)
  assert.equal(position(id, 'ETH')!.quantity, 0)
})

test('6. liquidations close the whole position, without lot or minimum, and leave no residue', async () => {
  // the monitor (006I-3) liquidates at mark: DOGE 1250 @ 0.08, 10x, 20 USDC
  const id = newAccount('hyperliquid', 20)
  await fill(id, 'DOGE', 'LONG', 1250, 10, 0.08)
  quote('DOGE', 0.066)
  await (new TaskScheduler() as any).checkMarginLevels()
  const p = position(id, 'DOGE')!
  assert.deepEqual([p.quantity, p.margin, p.side], [0, null, null])
  assert.ok(lastOrder(id).orderNo.startsWith('LIQ-'))
  assert.equal(lastOrder(id).filledQuantity, 1250)
  // a liquidation order on a position worth 5 USD with a non-lot size, even without meta
  const small = newAccount()
  await fill(small, 'SOL', 'LONG', 1, 2, 100)
  rawDb.prepare('UPDATE positions SET quantity = 0.0500003 WHERE account_id = ? AND symbol = ?').run(small, 'SOL')
  resetMarginTables()
  hyperliquidStub.failMeta = true
  await fill(small, 'SOL', 'SELL', 0.0500003, 2, 100, 'LIQ-TEST000000000001')
  assert.equal(position(small, 'SOL')!.quantity, 0)
})

// --- missing metadata ---------------------------------------------------------------------

test('7. missing or invalid szDecimals: nothing assumed; opens and partial closes refused, full closes allowed', async () => {
  for (const bad of [undefined, null, 'x', -1, 2.5, 7]) {
    const raw = structuredClone(META_BACKUP)
    const eth = raw.universe.find((u: { name: string }) => u.name === 'ETH')
    if (bad === undefined) delete eth.szDecimals
    else eth.szDecimals = bad
    const parsed = parseMetaResponse(raw, Date.now())
    assert.ok(!('error' in parsed))
    if ('error' in parsed) return
    assert.equal(parsed.assets.get('ETH')!.szDecimals, null, String(bad))
    assert.ok(parsed.issues.some((i) => i.startsWith('ETH: szDecimals')), String(bad))
    assert.equal(parsed.assets.get('BTC')!.szDecimals, 5, 'other markets unaffected')
  }
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 0.5, 2, 2400) // opened while meta was valid
  // meta now without ETH szDecimals
  const eth = META.universe.find((u: { name: string }) => u.name === 'ETH')
  delete eth.szDecimals
  resetMarginTables()
  await refused(id, () => fill(id, 'ETH', 'LONG', 0.1, 2, 2400), /szDecimals for ETH missing or invalid/)
  await refused(id, () => fill(id, 'ETH', 'SELL', 0.1, 2, 2400), /szDecimals for ETH missing or invalid/)
  await fill(id, 'BTC', 'LONG', 0.001, 2, 80000) // other markets keep trading
  await fill(id, 'ETH', 'SELL', 0.5, 2, 2400) // full close: allowed
  assert.equal(position(id, 'ETH')!.quantity, 0)
  // meta unavailable: opens refused, full closes still possible
  resetMarginTables()
  hyperliquidStub.failMeta = true
  await refused(id, () => fill(id, 'SOL', 'LONG', 1, 2, 100), /Hyperliquid size rules for SOL unavailable: meta not received/)
  await fill(id, 'BTC', 'SELL', 0.001, 2, 80000)
  assert.equal(position(id, 'BTC')!.quantity, 0)
})

// --- funding and the original model -------------------------------------------------------------

test('8. hourly funding is charged on the size executed', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'LONG', 3.75009, 10, 2400) // executed 3.75
  assert.equal(position(id, 'ETH')!.quantity, 3.75)
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS
  rawDb.prepare('UPDATE trades SET trade_time = ? WHERE account_id = ?').run(utcNow(new Date(hour - 60_000)), id)
  const deps: FundingDeps = {
    fetchFundingHistory: async (coin) => [{ coin, fundingRate: '0.001', premium: '0', time: hour + 30 }],
    fetchOraclePrices: async () => ({ ETH: { oraclePx: 2400, receivedAt: hour + 5_000 } }),
    cachedOraclePrices: () => ({}),
  }
  await captureFundingOracle(hour + 5_000, deps)
  const cash = account(id).currentCash
  await settleFunding(hour + 10_000, deps)
  near(cash - account(id).currentCash, 3.75 * 2400 * 0.001, 'funding on 3.75 ETH, not 3.75009')
  reconciled(id, { ETH: 2400 })
})

test('9. original model unchanged: sizes executed as asked, no 10 USD minimum, no meta needed', async () => {
  hyperliquidStub.failMeta = true
  const metaBefore = hyperliquidStub.metaRequests
  const id = newAccount('original')
  // 6 decimals, as the AI sizes orders (round6); the hyperliquid model would execute 0.00123
  const order = await fill(id, 'BTC', 'LONG', 0.001234, 2, 80000)
  assert.equal(order.quantity, 0.001234)
  assert.equal(order.filledQuantity, 0.001234)
  assert.equal(position(id, 'BTC')!.quantity, 0.001234)
  await fill(id, 'SOL', 'LONG', 0.05, 1, 100) // 5 USD: accepted as before
  await fill(id, 'SOL', 'SELL', 0.0123, 1, 100) // 1.23 USD partial close: accepted as before
  assert.equal(position(id, 'SOL')!.quantity, 0.0377)
  near(fills(id).at(-1)!.commission, 0.0123 * 100 * 0.0007, 'original fee')
  assert.equal(hyperliquidStub.metaRequests, metaBefore, 'no meta request')
  const rep = buildReport({ dbFile, accountId: id, prices: { BTC: 80000, SOL: 100 }, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [])
  assert.equal('order_sizes' in rep, false, 'original report unchanged')
})
