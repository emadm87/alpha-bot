/**
 * Deterministic tests for closing positions smaller than the 0.0001 minimum
 * order quantity: only an exact 100% close (AI or liquidation) is allowed,
 * every other order below the minimum is still rejected.
 *
 * Run: npx tsx --test src/services/dustClose.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, network
 * blocked, no AI. Close quantities follow tradingCommands:
 * min(round6(position quantity * portion), position quantity).
 * Expected values are closed-form:
 *   fee   = 0.0007 * quantity * price, on every fill
 *   close : cash += quantity * entry / leverage + pnl - fee (interest ~0)
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dust-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { TaskScheduler } = await import('./scheduler.js')

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

const FEE = 0.0007
const BTC = 84621.5
const MIN_ERROR = /Quantity must be >= 0.0001/
const round6 = (v: number) => Number(v.toFixed(6))
const aiClose = (quantity: number, portion: number) =>
  Math.min(round6(quantity * portion), quantity)

let seq = 0
function newAccount(capital = 1000) {
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `dust-${++seq}`,
      accountType: 'AI',
      apiKey: 'test-placeholder',
      initialCapital: capital,
      currentCash: capital,
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
const orderCount = (id: number) =>
  db.select().from(orders).where(eq(orders.accountId, id)).all().length
const accountTrades = (id: number) =>
  db.select().from(trades).where(eq(trades.accountId, id)).all()

function close(actual: number, expected: number, what: string, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    `${what}: actual=${actual} expected=${expected}`,
  )
}

async function trade(
  id: number,
  symbol: string,
  side: string,
  quantity: number,
  leverage: number,
  price: number,
) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
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

/** Opens size at BTC, closes portion of it, returns the residue left. */
async function residue(
  id: number,
  symbol: string,
  side: 'LONG' | 'SHORT',
  size: number,
  portion: number,
) {
  await trade(id, symbol, side, size, 3, BTC)
  await trade(id, symbol, side === 'LONG' ? 'SELL' : 'BUY', aiClose(size, portion), 3, BTC)
  return position(id, symbol).quantity
}

function assertFlat(id: number, symbol: string) {
  const p = position(id, symbol)
  assert.equal(p.quantity, 0, 'quantity')
  assert.equal(p.availableQuantity, 0, 'available quantity')
  assert.equal(p.side, null, 'side')
  assert.equal(p.leverage, 1, 'leverage')
  close(account(id).marginUsed, 0, 'margin_used', 1e-9)
}

// --- exact 100% closes of residues below the minimum -----------------------

test('BTC 0.005909 LONG 3x: 99% close leaves 0.000059, the 100% close succeeds', async () => {
  const id = newAccount()
  const rest = await residue(id, 'D1', 'LONG', 0.005909, 0.99)
  assert.equal(rest, 0.000059, 'real residue kept exactly')
  close(account(id).marginUsed, (0.000059 * BTC) / 3, 'margin of the residue')

  await trade(id, 'D1', 'SELL', aiClose(rest, 1), 3, BTC)
  assertFlat(id, 'D1')
  const fees = FEE * BTC * (0.005909 + 0.00585 + 0.000059)
  close(account(id).currentCash, 1000 - fees, 'cash = capital - fees (price unchanged)')
  close((await calcAccountEquity(account(id))).equity, 1000 - fees, 'equity')
  close(accountTrades(id).reduce((s, t) => s + t.takerFee, 0), fees, 'fees once')
})

for (const [side, size, portion, expected] of [
  ['LONG', 0.001182, 0.99, 0.000012],
  ['SHORT', 0.001182, 0.95, 0.000059],
  ['SHORT', 0.002954, 0.99, 0.00003],
] as const) {
  test(`${side} residue ${expected}: 100% close at a new price with P&L`, async () => {
    const id = newAccount()
    const rest = await residue(id, `E${seq}`, side, size, portion)
    assert.equal(rest, expected)
    const symbol = `E${seq}`
    const cashBefore = account(id).currentCash
    const exit = 90000
    await trade(id, symbol, side === 'LONG' ? 'SELL' : 'BUY', aiClose(rest, 1), 3, exit)

    const pnl = side === 'LONG' ? rest * (exit - BTC) : rest * (BTC - exit)
    const expectedCash = cashBefore + (rest * BTC) / 3 + pnl - FEE * rest * exit
    close(account(id).currentCash, expectedCash, 'cash')
    assertFlat(id, symbol)
  })
}

test('liquidation of a LONG residue below the minimum closes it', async () => {
  const id = newAccount()
  const rest = await residue(id, 'L1', 'LONG', 0.005909, 0.99)
  const cashBefore = account(id).currentCash
  cachePrice('L1', 'CRYPTO', 80000)
  const open = db.select().from(positions).where(eq(positions.accountId, id)).all()
  await (new TaskScheduler() as any).liquidatePositions(account(id), open, 'test')

  const pnl = rest * (80000 - BTC)
  close(account(id).currentCash, cashBefore + (rest * BTC) / 3 + pnl - FEE * rest * 80000, 'cash')
  assertFlat(id, 'L1')
  const liq = db
    .select()
    .from(orders)
    .where(eq(orders.accountId, id))
    .all()
    .filter((o) => o.orderNo.startsWith('LIQ-'))
  assert.deepEqual(liq.map((o) => [o.side, o.quantity, o.status]), [['SELL', rest, 'FILLED']])
})

test('liquidation of a SHORT residue below the minimum closes it', async () => {
  const id = newAccount()
  const rest = await residue(id, 'L2', 'SHORT', 0.001182, 0.99)
  cachePrice('L2', 'CRYPTO', 95000)
  const open = db.select().from(positions).where(eq(positions.accountId, id)).all()
  await (new TaskScheduler() as any).liquidatePositions(account(id), open, 'test')
  assert.equal(rest, 0.000012)
  assertFlat(id, 'L2')
})

test('after the 100% close of a residue, LONG and SHORT can be opened again', async () => {
  const id = newAccount()
  const rest = await residue(id, 'O1', 'LONG', 0.005909, 0.99)
  await trade(id, 'O1', 'SELL', rest, 3, BTC)
  await trade(id, 'O1', 'SHORT', 0.001, 3, BTC)
  assert.equal(position(id, 'O1').side, 'SHORT')
  await trade(id, 'O1', 'BUY', 0.001, 3, BTC)
  await trade(id, 'O1', 'LONG', 0.001, 3, BTC)
  assert.equal(position(id, 'O1').side, 'LONG')
  close(account(id).marginUsed, (0.001 * BTC) / 3, 'margin_used = new position only')
})

// --- the minimum still applies everywhere else ------------------------------

test('opens below the minimum are rejected (LONG and SHORT)', async () => {
  const id = newAccount()
  await assert.rejects(trade(id, 'M1', 'LONG', 0.00005, 3, BTC), MIN_ERROR)
  await assert.rejects(trade(id, 'M1', 'SHORT', 0.00005, 3, BTC), MIN_ERROR)
  assert.equal(orderCount(id), 0)
})

test('partial closes below the minimum are rejected', async () => {
  const id = newAccount()
  await trade(id, 'P1', 'LONG', 0.001, 3, BTC)
  await assert.rejects(trade(id, 'P1', 'SELL', 0.00005, 3, BTC), MIN_ERROR)
  assert.equal(position(id, 'P1').quantity, 0.001)

  // Residue below the minimum: closing only part of it is still rejected
  const rest = await residue(id, 'P2', 'SHORT', 0.005909, 0.99) // 0.000059
  await assert.rejects(trade(id, 'P2', 'BUY', 0.00003, 3, BTC), MIN_ERROR)
  assert.equal(position(id, 'P2').quantity, rest)
  assert.equal(position(id, 'P2').side, 'SHORT')
})

test('closing more than the position is rejected', async () => {
  const id = newAccount()
  const rest = await residue(id, 'X1', 'LONG', 0.005909, 0.99) // 0.000059
  await assert.rejects(trade(id, 'X1', 'SELL', 0.00006, 3, BTC), /Cannot close more than position size/)
  await assert.rejects(trade(id, 'X1', 'SELL', 0.0002, 3, BTC), /Cannot close more than position size/)
  assert.equal(position(id, 'X1').quantity, rest)
})

test('1x residue below the minimum: the 100% close succeeds, a partial one does not', async () => {
  const id = newAccount()
  await trade(id, 'S1', 'LONG', 0.005909, 1, BTC)
  await trade(id, 'S1', 'SELL', aiClose(0.005909, 0.99), 1, BTC)
  assert.equal(position(id, 'S1').quantity, 0.000059)
  await assert.rejects(trade(id, 'S1', 'SELL', 0.00003, 1, BTC), MIN_ERROR)
  await trade(id, 'S1', 'SELL', 0.000059, 1, BTC)
  assert.equal(position(id, 'S1').quantity, 0)
  assert.equal(position(id, 'S1').availableQuantity, 0)
})
