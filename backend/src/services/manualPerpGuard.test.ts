/**
 * Manual orders (orderMatching) against perpetual positions of the engine
 * (Task 006F-3C): S1-S6 of the 006F-3B audit, pending LIMIT orders blocked
 * while a perpetual is open, and the side reset on a reopened row.
 *
 * Run: npx tsx --test src/services/manualPerpGuard.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, no network.
 * Fees: engine 0.07% of notional, orderMatching 0.1% (min 0.1).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-perp-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'warning'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}
console.log = () => {}
/** Warnings emitted while an order is kept pending by a perpetual. */
const warnings: string[] = []
console.warn = (...args: unknown[]) => {
  warnings.push(args.join(' '))
}
const keptPending = (orderNo: string) => warnings.filter((w) => w.includes(`Order ${orderNo} kept pending`)).length

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { createOrder, checkAndExecuteOrder } = await import('./orderMatching.js')
const { calcAccountEquity } = await import('./assetCalculator.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

let seq = 0
const newAccount = () =>
  db.insert(accounts).values({
    userId: user.id, name: `mp-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
const accountOrders = (id: number) => db.select().from(orders).where(eq(orders.accountId, id)).all()
const accountTrades = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const feesPaid = (id: number) => accountTrades(id).reduce((s, t) => s + t.commission, 0)

async function engine(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
    account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage,
  })
}
function order(id: number, symbol: string, side: string, quantity: number, price: number, limit?: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return createOrder({
    account: account(id), symbol, name: symbol, side,
    orderType: limit === undefined ? 'MARKET' : 'LIMIT', price: limit ?? null, quantity,
  })
}
async function manual(id: number, symbol: string, side: string, quantity: number, price: number) {
  const o = await order(id, symbol, side, quantity, price)
  assert.equal(await checkAndExecuteOrder(o), true, `manual ${side} filled`)
}
function near(actual: number, expected: number, what: string, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** Final capital, P&L and margin of a scenario, all positions closed. */
function closedBalance(id: number, cash: number, fees: number, what: string) {
  const a = account(id)
  near(a.currentCash, cash, `${what} final capital`)
  near(a.currentCash - 1000, cash - 1000, `${what} P&L USDC`)
  near(((a.currentCash - 1000) / 1000) * 100, (cash - 1000) / 10, `${what} P&L %`)
  near(feesPaid(id), fees, `${what} fees (each fill once)`)
  near(a.marginUsed, 0, `${what} marginUsed`)
  assert.equal(a.frozenCash, 0, `${what} frozenCash`)
}

/** A manual order on a symbol with an open perpetual is refused and leaves no trace. */
async function refused(id: number, symbol: string, side: string, quantity: number, price: number, open: string) {
  const before = { account: account(id), position: position(id, symbol), orders: accountOrders(id).length, trades: accountTrades(id).length }
  await assert.rejects(order(id, symbol, side, quantity, price), new RegExp(`open ${open} perpetual position`))
  assert.deepEqual(
    { account: account(id), position: position(id, symbol), orders: accountOrders(id).length, trades: accountTrades(id).length },
    before,
  )
}

test('S1 SHORT 1x + manual BUY: refused; the short closes at +20', async () => {
  const id = newAccount()
  await engine(id, 'A', 'SHORT', 2, 1, 100)
  await refused(id, 'A', 'BUY', 1, 100, 'SHORT')
  await engine(id, 'A', 'BUY', 2, 1, 90)
  closedBalance(id, 1019.734, 0.14 + 0.126, 'S1') // +19.734 USDC, +1.9734%
})

test('S2 SHORT 1x + manual SELL: refused; the short closes at -40', async () => {
  const id = newAccount()
  await engine(id, 'B', 'SHORT', 2, 1, 100)
  await refused(id, 'B', 'SELL', 1, 120, 'SHORT')
  await engine(id, 'B', 'BUY', 2, 1, 120)
  closedBalance(id, 959.692, 0.14 + 0.168, 'S2') // -40.308 USDC, -4.0308%
})

test('S3 SHORT 3x + manual BUY and SELL: refused, no leverage mixing, no marginUsed drift', async () => {
  const id = newAccount()
  await engine(id, 'C', 'SHORT', 2, 3, 100)
  await refused(id, 'C', 'BUY', 1, 100, 'SHORT')
  await refused(id, 'C', 'SELL', 1, 120, 'SHORT')
  assert.equal(position(id, 'C')!.leverage, 3)
  near(account(id).marginUsed, 200 / 3, 'marginUsed while open')
  await engine(id, 'C', 'BUY', 2, 3, 120)
  closedBalance(id, 959.692, 0.14 + 0.168, 'S3')
})

test('S4 LONG 3x + manual BUY and SELL: refused; the long closes at +40', async () => {
  const id = newAccount()
  await engine(id, 'D', 'LONG', 2, 3, 100)
  await refused(id, 'D', 'BUY', 1, 100, 'LONG')
  await refused(id, 'D', 'SELL', 1, 120, 'LONG')
  await engine(id, 'D', 'SELL', 2, 3, 120)
  closedBalance(id, 1039.692, 0.14 + 0.168, 'S4') // +39.692 USDC, +3.9692%
})

test('S5 historical row {q 0, side SHORT}: a spot BUY clears the side and sells as spot', async () => {
  const id = newAccount()
  rawDb.prepare(
    "INSERT INTO positions (version, account_id, symbol, name, market, quantity, available_quantity, avg_cost, leverage, side, accumulated_interest) VALUES ('v1', ?, 'E', 'E', 'CRYPTO', 0, 0, 100, 1, 'SHORT', 0)",
  ).run(id)
  await manual(id, 'E', 'BUY', 1, 100)
  const p = position(id, 'E')!
  assert.deepEqual([p.quantity, p.side, p.leverage, p.avgCost], [1, null, 1, 100])
  cachePrice('E', 'CRYPTO', 110)
  near((await calcAccountEquity(account(id))).equity, 899.9 + 110, 'equity at 110 (long holding)')
  await engine(id, 'E', 'SELL', 1, 1, 110) // the AI closes a long holding
  closedBalance(id, 1009.823, 0.1 + 0.077, 'S5') // +9.823 USDC, +0.9823%
})

test('reset does not touch an open row: a spot BUY adding to a spot holding keeps it spot', async () => {
  const id = newAccount()
  await manual(id, 'H', 'BUY', 1, 100)
  await manual(id, 'H', 'BUY', 1, 110)
  const p = position(id, 'H')!
  assert.deepEqual([p.quantity, p.side], [2, null])
  near(p.avgCost, 105, 'average cost')
  await manual(id, 'H', 'SELL', 2, 120)
  closedBalance(id, 1000 - 100.1 - 110.11 + 240 - 0.24, 0.1 + 0.11 + 0.24, 'spot adds') // 1029.55
})

test('S6 LIMIT BUY created before the perpetual stays PENDING, then fills only at its limit', async () => {
  const id = newAccount()
  const limit = await order(id, 'G', 'BUY', 1, 100, 95) // no perpetual yet: accepted
  await engine(id, 'G', 'SHORT', 2, 1, 100)
  const blocked = { account: account(id), position: position(id, 'G'), trades: accountTrades(id).length }

  // Price at / below the limit while the perpetual is open: never filled, nothing changes
  for (const price of [95, 90, 90]) {
    cachePrice('G', 'CRYPTO', price)
    assert.equal(await checkAndExecuteOrder(db.select().from(orders).where(eq(orders.id, limit.id)).get()!), false)
  }
  assert.equal(db.select().from(orders).where(eq(orders.id, limit.id)).get()!.status, 'PENDING')
  assert.deepEqual({ account: account(id), position: position(id, 'G'), trades: accountTrades(id).length }, blocked)
  assert.equal(keptPending(limit.orderNo), 1, 'blocked reason logged once for three attempts')

  await engine(id, 'G', 'BUY', 2, 1, 90) // the AI closes the short: 1019.734
  near(account(id).currentCash, 1019.734, 'after the short')

  // Free again, but above the limit: still pending
  cachePrice('G', 'CRYPTO', 96)
  assert.equal(await checkAndExecuteOrder(db.select().from(orders).where(eq(orders.id, limit.id)).get()!), false)
  assert.equal(db.select().from(orders).where(eq(orders.id, limit.id)).get()!.status, 'PENDING')

  // At the limit: fills as spot at the market price
  cachePrice('G', 'CRYPTO', 94)
  assert.equal(await checkAndExecuteOrder(db.select().from(orders).where(eq(orders.id, limit.id)).get()!), true)
  assert.equal(db.select().from(orders).where(eq(orders.id, limit.id)).get()!.status, 'FILLED')
  const p = position(id, 'G')!
  assert.deepEqual([p.quantity, p.side, p.avgCost], [1, null, 94])
  await manual(id, 'G', 'SELL', 1, 100)
  // short +20, spot 94 -> 100 +6; fees 0.14 + 0.126 + 0.1 + 0.1
  closedBalance(id, 1025.534, 0.466, 'S6')
})

test('M1: MARKET created before the perpetual stays PENDING, fills only on a later explicit execution', async () => {
  const id = newAccount()
  const market = await order(id, 'M', 'BUY', 1, 100) // created, not executed yet
  await engine(id, 'M', 'SHORT', 2, 1, 100)
  const before = { account: account(id), position: position(id, 'M'), trades: accountTrades(id).length }
  const current = () => db.select().from(orders).where(eq(orders.id, market.id)).get()!
  for (const price of [100, 90]) {
    cachePrice('M', 'CRYPTO', price)
    assert.equal(await checkAndExecuteOrder(current()), false)
  }
  assert.equal(current().status, 'PENDING')
  assert.deepEqual({ account: account(id), position: position(id, 'M'), trades: accountTrades(id).length }, before)
  near((await calcAccountEquity(account(id))).equity, 799.86 + 200 + 20, 'equity of the short alone at 90')
  assert.equal(keptPending(market.orderNo), 1)

  await engine(id, 'M', 'BUY', 2, 1, 90) // the AI closes the short: 1019.734
  // Nothing runs it by itself: only an explicit execution, at that moment's price
  cachePrice('M', 'CRYPTO', 92)
  assert.equal(await checkAndExecuteOrder(current()), true)
  assert.equal(current().status, 'FILLED')
  const p = position(id, 'M')!
  assert.deepEqual([p.quantity, p.side, p.avgCost], [1, null, 92])
  // Never executed twice
  assert.equal(await checkAndExecuteOrder(current()), false)
  assert.equal(accountTrades(id).filter((t) => t.orderId === market.id).length, 1)
  await manual(id, 'M', 'SELL', 1, 100)
  // short +20, spot 92 -> 100 +8; fees 0.14 + 0.126 + 0.1 + 0.1
  closedBalance(id, 1027.534, 0.466, 'M1') // +27.534 USDC, +2.7534%
})
