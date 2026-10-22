/**
 * Deterministic tests for the liquidation path: the real margin monitor
 * (TaskScheduler.checkMarginLevels) and TaskScheduler.liquidatePositions,
 * with no spy on the execution.
 *
 * Run: npx tsx --test src/services/liquidation.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, network
 * blocked, scheduler never started. Expected values follow the perpetual
 * engine's own model (placeAndExecuteCrypto), written here as formulas:
 *   open : cash -= quantity * entry / leverage + fee
 *   close: cash += quantity * entry / leverage + pnl - fee - interest
 *   fee  = 0.0007 * notional at the fill price
 *   pnl  = LONG q * (exit - entry), SHORT q * (entry - exit)
 *   full close: margin_used back to 0, side null, leverage 1
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liquidation-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
// Expected failure paths log errors; keep the test output readable
console.error = () => {}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice, priceCache } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { TaskScheduler } = await import('./scheduler.js')
const { utcNow } = await import('../utils/datetime.js')

ensureSchema()
const user = db
  .insert(users)
  .values({ username: 'default', isActive: 'true' })
  .returning()
  .get()

after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const CAPITAL = 1000
const FEE = 0.0007
const EPS = 1e-6

let seq = 0
function newAccount() {
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `liq-${++seq}`,
      accountType: 'AI',
      apiKey: 'test-placeholder',
      initialCapital: CAPITAL,
      currentCash: CAPITAL,
      maintenanceMarginRatio: 0.5,
    })
    .returning()
    .get().id
}

const account = (id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, id), eq(positions.symbol, symbol)))
    .get()!
const liqOrders = (id: number) =>
  db
    .select()
    .from(orders)
    .where(eq(orders.accountId, id))
    .all()
    .filter((o) => o.orderNo.startsWith('LIQ-'))
const liqTrades = (id: number) => {
  const ids = new Set(liqOrders(id).map((o) => o.id))
  return db
    .select()
    .from(trades)
    .where(eq(trades.accountId, id))
    .all()
    .filter((t) => ids.has(t.orderId))
}

function close(actual: number, expected: number, what: string, eps = EPS) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${what}: actual=${actual} expected=${expected}`,
  )
}

async function open(
  id: number,
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  leverage: number,
  price: number,
) {
  cachePrice(symbol, 'CRYPTO', price)
  await placeAndExecuteCrypto({
    account: account(id),
    symbol,
    name: symbol,
    side,
    orderType: 'MARKET',
    price: null,
    quantity,
    leverage,
  })
}

/** Leaves only this account's positions open for the monitor pass. */
function isolate(id: number) {
  rawDb
    .prepare('UPDATE positions SET quantity = 0, available_quantity = 0 WHERE account_id <> ?')
    .run(id)
}

async function monitorPass() {
  const scheduler = new TaskScheduler() as any
  assert.equal(scheduler.isRunning(), false)
  await scheduler.checkMarginLevels()
}

/** Calls the real liquidatePositions directly for the given open positions. */
async function liquidate(id: number) {
  const open = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, id))
    .all()
    .filter((p) => p.quantity > 0 && p.leverage > 1)
  await (new TaskScheduler() as any).liquidatePositions(account(id), open, 'test')
}

function assertClosed(id: number, symbol: string) {
  const p = position(id, symbol)
  assert.equal(p.quantity, 0, `${symbol} quantity`)
  assert.equal(p.availableQuantity, 0, `${symbol} available quantity`)
  assert.equal(p.side, null, `${symbol} side`)
  assert.equal(p.leverage, 1, `${symbol} leverage`)
}

function assertNoPendingLiq(id: number) {
  assert.deepEqual(
    liqOrders(id).filter((o) => o.status !== 'FILLED').map((o) => o.status),
    [],
    'no PENDING liquidation order',
  )
}

// --- full liquidations -------------------------------------------------------

test('LONG 2x 10 @100 liquidated at 24: closed, margin released', async () => {
  const id = newAccount()
  await open(id, 'LA', 'LONG', 10, 2, 100)
  isolate(id)
  cachePrice('LA', 'CRYPTO', 24)
  await monitorPass()

  const cash = CAPITAL - 500 - FEE * 1000 + 500 + 10 * (24 - 100) - FEE * 240
  close(account(id).currentCash, cash, 'cash') // 239.132
  close(account(id).marginUsed, 0, 'margin_used')
  assertClosed(id, 'LA')
  const [o] = liqOrders(id)
  assert.ok(o && o.side === 'SELL' && o.status === 'FILLED', 'LIQ- SELL FILLED')
  const [t] = liqTrades(id)
  close(t!.takerFee, FEE * 240, 'taker fee')
  close(t!.commission, FEE * 240, 'commission')
  close((await calcAccountEquity(account(id))).equity, cash, 'equity = cash')
})

test('SHORT 5x 10 @100 liquidated at 195: closed by BUY, no PENDING order', async () => {
  const id = newAccount()
  await open(id, 'SA', 'SHORT', 10, 5, 100)
  isolate(id)
  cachePrice('SA', 'CRYPTO', 195)
  await monitorPass()
  await monitorPass()

  const cash = CAPITAL - 200 - FEE * 1000 + 200 + 10 * (100 - 195) - FEE * 1950
  close(account(id).currentCash, cash, 'cash') // 47.935
  close(account(id).marginUsed, 0, 'margin_used')
  assertClosed(id, 'SA')
  assert.deepEqual(
    liqOrders(id).map((o) => [o.side, o.status, o.quantity]),
    [['BUY', 'FILLED', 10]],
  )
  assertNoPendingLiq(id)
})

test('LONG 2x + SHORT 5x liquidated together: both closed, cash consistent', async () => {
  const id = newAccount()
  await open(id, 'MA', 'LONG', 10, 2, 100)
  await open(id, 'MB', 'SHORT', 1, 5, 100)
  isolate(id)
  cachePrice('MA', 'CRYPTO', 25)
  await monitorPass()

  const cash =
    CAPITAL - 500 - FEE * 1000 - 20 - FEE * 100 + // opens
    500 + 10 * (25 - 100) - FEE * 250 + // LONG close
    20 + 0 - FEE * 100 // SHORT close
  close(account(id).currentCash, cash, 'cash') // 248.985
  close(account(id).marginUsed, 0, 'margin_used')
  assertClosed(id, 'MA')
  assertClosed(id, 'MB')
  assertNoPendingLiq(id)
})

// --- after a liquidation ----------------------------------------------------

test('after LONG liquidation: SHORT and LONG can be opened on the same coin', async () => {
  const id = newAccount()
  await open(id, 'RA', 'LONG', 10, 2, 100)
  isolate(id)
  cachePrice('RA', 'CRYPTO', 24)
  await monitorPass()
  assertClosed(id, 'RA')

  await open(id, 'RA', 'SHORT', 1, 2, 24)
  assert.equal(position(id, 'RA').side, 'SHORT')
  close(account(id).marginUsed, 12, 'margin_used = new SHORT margin only')
})

test('after SHORT liquidation: LONG can be opened on the same coin', async () => {
  const id = newAccount()
  await open(id, 'RB', 'SHORT', 10, 5, 100)
  isolate(id)
  cachePrice('RB', 'CRYPTO', 195)
  await monitorPass()
  assertClosed(id, 'RB')

  await open(id, 'RB', 'LONG', 0.1, 2, 195)
  assert.equal(position(id, 'RB').side, 'LONG')
  close(account(id).marginUsed, 9.75, 'margin_used = new LONG margin only')
})

test('no phantom margin: a healthy position opened after a liquidation stays open', async () => {
  const id = newAccount()
  await open(id, 'PA', 'LONG', 10, 2, 100)
  isolate(id)
  cachePrice('PA', 'CRYPTO', 24)
  await monitorPass()

  const quantity = Number((account(id).currentCash / 50).toFixed(6))
  await open(id, 'PB', 'LONG', quantity, 2, 50)
  close(account(id).marginUsed, (quantity * 50) / 2, 'margin_used = new margin only')
  await monitorPass()
  assert.equal(position(id, 'PB').quantity, quantity, 'PB still open')
  assert.equal(liqOrders(id).length, 1, 'only the first liquidation')
})

// --- costs --------------------------------------------------------------------

test('accrued interest is charged on the liquidation close', async () => {
  const id = newAccount()
  await open(id, 'IA', 'LONG', 10, 2, 100)
  isolate(id)
  const tenHoursAgo = utcNow(new Date(Date.now() - 10 * 3_600_000))
  rawDb
    .prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ? AND symbol = ?')
    .run(tenHoursAgo, id, 'IA')
  cachePrice('IA', 'CRYPTO', 24)
  await monitorPass()

  // borrowed notional = 10 * 100 * (2 - 1) / 2 = 500; rate 0.00125%/h; 10 h
  const interest = 500 * 0.0000125 * 10
  const [t] = liqTrades(id)
  close(t!.interestCharged, interest, 'interest charged', 1e-5)
  const cash = CAPITAL - 500 - FEE * 1000 + 500 + 10 * (24 - 100) - FEE * 240 - interest
  close(account(id).currentCash, cash, 'cash after interest', 1e-5)
  assertClosed(id, 'IA')
})

// --- failures and edge cases ------------------------------------------------

test('missing price at execution: no order recorded, position unchanged', async () => {
  const id = newAccount()
  await open(id, 'NA', 'LONG', 10, 2, 100)
  for (const key of [...(priceCache as any).cache.keys()]) {
    if (String(key).startsWith('NA')) (priceCache as any).cache.delete(key)
  }
  await liquidate(id)
  assert.equal(liqOrders(id).length, 0, 'no LIQ- order')
  assert.equal(position(id, 'NA').quantity, 10)
  close(account(id).marginUsed, 500, 'margin_used unchanged')
})

test('quantity below the engine minimum: not liquidated, no order (documented limit)', async () => {
  const id = newAccount()
  await open(id, 'DA', 'LONG', 1, 2, 100)
  rawDb
    .prepare('UPDATE positions SET quantity = 0.00005, available_quantity = 0.00005 WHERE account_id = ? AND symbol = ?')
    .run(id, 'DA')
  cachePrice('DA', 'CRYPTO', 24)
  await liquidate(id)
  assert.equal(liqOrders(id).length, 0, 'no LIQ- order')
  assert.equal(position(id, 'DA').quantity, 0.00005, 'dust position stays open')
})

test('loss beyond the margin: closed, cash goes negative (no insolvency rule)', async () => {
  const id = newAccount()
  await open(id, 'XA', 'LONG', 19.9, 2, 100)
  isolate(id)
  cachePrice('XA', 'CRYPTO', 40)
  await monitorPass()

  const cash = CAPITAL - 995 - FEE * 1990 + 995 + 19.9 * (40 - 100) - FEE * 796
  close(account(id).currentCash, cash, 'cash') // -195.9502
  assert.ok(account(id).currentCash < 0, 'cash is negative')
  close(account(id).marginUsed, 0, 'margin_used')
  assertClosed(id, 'XA')
})

test('cash below accrued interest: closed, interest paid from the released margin', async () => {
  const id = newAccount()
  await open(id, 'YA', 'LONG', 19.9, 2, 100) // cash left 3.607
  const longAgo = utcNow(new Date(Date.now() - 400 * 3_600_000))
  rawDb
    .prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ? AND symbol = ?')
    .run(longAgo, id, 'YA')
  cachePrice('YA', 'CRYPTO', 70)
  await liquidate(id) // interest = 995 * 0.0000125 * 400 = 4.975 > 3.607

  const interest = 995 * 0.0000125 * 400
  const cash = 3.607 + 995 + 19.9 * (70 - 100) - FEE * 19.9 * 70 - interest
  close(account(id).currentCash, cash, 'cash', 1e-5) // 395.6569
  close(account(id).marginUsed, 0, 'margin_used')
  assertClosed(id, 'YA')
  const [t] = liqTrades(id)
  close(t!.interestCharged, interest, 'interest charged once', 1e-5)
})
