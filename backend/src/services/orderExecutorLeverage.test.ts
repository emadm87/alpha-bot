/**
 * Perpetual execution tests for 1x positions (Task 003E, bug E3).
 *
 * Drives the real `placeAndExecuteCrypto` through full open -> close cycles
 * and checks final quantity, cash, margin, fees and the recorded trades.
 * Same offline setup as services/accounting.test.ts:
 *  - DATABASE_PATH points at a throwaway SQLite file in a fresh temp dir,
 *    set before any module opens the DB; only `ensureSchema()` runs (no seed).
 *  - MARKET orders price off the real price cache (`cachePrice`).
 *  - `globalThis.fetch` throws, so any accidental network call fails loudly.
 *
 * Expected values check internal consistency with the engine's own perpetual
 * model (not the real Hyperliquid fee schedule):
 *   fee           = notional * CRYPTO_TAKER_FEE_RATE        (open and close)
 *   open:  cash  -= notional / leverage + fee
 *   close: cash  += margin released + gross P&L - fee
 *   gross P&L     = qty * (exit - entry) LONG, qty * (entry - exit) SHORT
 * so over a full cycle: cash change = gross P&L - open fee - close fee.
 * marginUsed must return to its starting value once the position is closed.
 *
 * Run with: npx tsx --test src/services/orderExecutorLeverage.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-exec-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')

const networkCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  networkCalls.push(String(input))
  throw new Error(`Network access is not allowed in tests: ${String(input)}`)
}) as typeof fetch

// Imported after DATABASE_PATH is set so db/client.ts opens the temp file.
const { db, rawDb, ensureSchema, DATABASE_PATH } = await import('../db/client.js')
const { eq, asc } = await import('drizzle-orm')
const { accounts, orders, positions, trades, users, CRYPTO_TAKER_FEE_RATE } =
  await import('../db/schema.js')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')

/** Tolerance also absorbs the sub-microsecond interest accrued by >1x positions. */
const EPS = 1e-6
const INITIAL_CASH = 1000

function approxEqual(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${label}: actual=${actual} expected=${expected}`,
  )
}

function createAccount() {
  const user = db
    .insert(users)
    .values({ username: `test-${Date.now()}-${Math.random()}`, isActive: 'true' })
    .returning()
    .get()
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      version: 'v1',
      name: 'TEST',
      accountType: 'AI',
      isActive: 'true',
      apiKey: null,
      initialCapital: INITIAL_CASH,
      currentCash: INITIAL_CASH,
      frozenCash: 0,
      marginUsed: 0,
      maintenanceMarginRatio: 0.5,
    })
    .returning()
    .get()
}

/** Fresh account row, as the trading loop reads it before each order. */
const reloadAccount = (id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get()!

const getPosition = (accountId: number) =>
  db.select().from(positions).where(eq(positions.accountId, accountId)).get()

const getTrades = (accountId: number) =>
  db.select().from(trades).where(eq(trades.accountId, accountId)).orderBy(asc(trades.id)).all()

const getOrders = (accountId: number) =>
  db.select().from(orders).where(eq(orders.accountId, accountId)).orderBy(asc(orders.id)).all()

interface Cycle {
  symbol: string
  openSide: 'LONG' | 'SHORT'
  closeSide: 'BUY' | 'SELL'
  leverage: number
  quantity: number
  entry: number
  exit: number
}

/** Opens at `entry`, closes the full quantity at `exit`, checks every ledger. */
async function runCycle(c: Cycle): Promise<void> {
  const acc = createAccount()

  // --- open ---
  cachePrice(c.symbol, 'CRYPTO', c.entry)
  await placeAndExecuteCrypto({
    account: reloadAccount(acc.id),
    symbol: c.symbol,
    name: c.symbol,
    side: c.openSide,
    orderType: 'MARKET',
    price: null,
    quantity: c.quantity,
    leverage: c.leverage,
  })

  const entryNotional = c.entry * c.quantity
  const openFee = entryNotional * CRYPTO_TAKER_FEE_RATE
  const margin = entryNotional / c.leverage

  const afterOpen = reloadAccount(acc.id)
  approxEqual(afterOpen.currentCash, INITIAL_CASH - margin - openFee, 'cash after open')
  const opened = getPosition(acc.id)!
  assert.equal(opened.side, c.openSide, 'position side after open')
  approxEqual(opened.quantity, c.quantity, 'position quantity after open')
  approxEqual(opened.avgCost, c.entry, 'position avg_cost after open')

  // --- close (full) ---
  cachePrice(c.symbol, 'CRYPTO', c.exit)
  await placeAndExecuteCrypto({
    account: reloadAccount(acc.id),
    symbol: c.symbol,
    name: c.symbol,
    side: c.closeSide,
    orderType: 'MARKET',
    price: null,
    quantity: c.quantity,
    leverage: c.leverage,
  })

  const exitNotional = c.exit * c.quantity
  const closeFee = exitNotional * CRYPTO_TAKER_FEE_RATE
  const grossPnl =
    c.openSide === 'LONG' ? exitNotional - entryNotional : entryNotional - exitNotional

  // Position closed
  const closed = getPosition(acc.id)!
  approxEqual(closed.quantity, 0, 'position quantity after close')
  approxEqual(closed.availableQuantity, 0, 'position available_quantity after close')

  // Cash and margin
  const afterClose = reloadAccount(acc.id)
  approxEqual(
    afterClose.currentCash,
    INITIAL_CASH + grossPnl - openFee - closeFee,
    'cash after close',
  )
  approxEqual(afterClose.marginUsed, 0, 'margin_used after close')

  // Trades: open + close, with the engine's fees
  const recorded = getTrades(acc.id)
  assert.equal(recorded.length, 2, 'two trades recorded')
  const [openTrade, closeTrade] = recorded as [typeof recorded[0], typeof recorded[0]]
  assert.equal(openTrade.side, c.openSide)
  assert.equal(closeTrade.side, c.closeSide)
  approxEqual(openTrade.price, c.entry, 'open trade price')
  approxEqual(closeTrade.price, c.exit, 'close trade price')
  approxEqual(openTrade.quantity, c.quantity, 'open trade quantity')
  approxEqual(closeTrade.quantity, c.quantity, 'close trade quantity')
  approxEqual(openTrade.takerFee, openFee, 'open trade taker fee')
  approxEqual(closeTrade.takerFee, closeFee, 'close trade taker fee')

  // Recorded cash flow is internally consistent: gross P&L minus recorded costs
  const recordedCosts = recorded.reduce((s, t) => s + t.takerFee + t.interestCharged, 0)
  approxEqual(
    afterClose.currentCash - INITIAL_CASH,
    grossPnl - recordedCosts,
    'net cash change vs recorded trades',
  )

  // Orders: both FILLED
  const placed = getOrders(acc.id)
  assert.deepEqual(
    placed.map((o) => [o.side, o.status]),
    [
      [c.openSide, 'FILLED'],
      [c.closeSide, 'FILLED'],
    ],
    'orders recorded as FILLED',
  )
}

before(() => {
  assert.ok(
    DATABASE_PATH.startsWith(tmpDir),
    `Refusing to run: DATABASE_PATH is not the temp DB (${DATABASE_PATH})`,
  )
  ensureSchema()
})

after(() => {
  assert.deepEqual(networkCalls, [], 'No network calls should have been made')
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('E3 — SHORT 1x perpetual open/close (placeAndExecuteCrypto)', () => {
  test('SHORT 1x @100, full BUY close @100 -> closed, cash 1000 - 0.07 - 0.07 = 999.86', () =>
    runCycle({ symbol: 'BTC', openSide: 'SHORT', closeSide: 'BUY', leverage: 1, quantity: 1, entry: 100, exit: 100 }))

  test('SHORT 1x @100, BUY close @90 -> gross P&L +10, cash 1000 + 10 - 0.07 - 0.063 = 1009.867', () =>
    runCycle({ symbol: 'ETH', openSide: 'SHORT', closeSide: 'BUY', leverage: 1, quantity: 1, entry: 100, exit: 90 }))

  test('SHORT 1x @100, BUY close @110 -> gross P&L -10, cash 1000 - 10 - 0.07 - 0.077 = 989.853', () =>
    runCycle({ symbol: 'SOL', openSide: 'SHORT', closeSide: 'BUY', leverage: 1, quantity: 1, entry: 100, exit: 110 }))
})

describe('Controls — paths already handled by the engine', () => {
  test('LONG 1x @100, SELL close @110 -> gross P&L +10, cash 1000 + 10 - 0.07 - 0.077 = 1009.853', () =>
    runCycle({ symbol: 'DOGE', openSide: 'LONG', closeSide: 'SELL', leverage: 1, quantity: 1, entry: 100, exit: 110 }))

  test('SHORT 2x @100, BUY close @90 -> gross P&L +10, cash 1000 + 10 - 0.07 - 0.063 = 1009.867', () =>
    runCycle({ symbol: 'XRP', openSide: 'SHORT', closeSide: 'BUY', leverage: 2, quantity: 1, entry: 100, exit: 90 }))
})

describe('E3 — wrong-side close of a SHORT 1x is rejected', () => {
  test('SHORT 1x @100, SELL @90 -> rejected, position and cash unchanged, nothing recorded', async () => {
    const acc = createAccount()
    cachePrice('BNB', 'CRYPTO', 100)
    await placeAndExecuteCrypto({
      account: reloadAccount(acc.id),
      symbol: 'BNB',
      name: 'BNB',
      side: 'SHORT',
      orderType: 'MARKET',
      price: null,
      quantity: 1,
      leverage: 1,
    })
    const cashAfterOpen = INITIAL_CASH - 100 - 100 * CRYPTO_TAKER_FEE_RATE

    cachePrice('BNB', 'CRYPTO', 90)
    await assert.rejects(
      placeAndExecuteCrypto({
        account: reloadAccount(acc.id),
        symbol: 'BNB',
        name: 'BNB',
        side: 'SELL',
        orderType: 'MARKET',
        price: null,
        quantity: 1,
        leverage: 1,
      }),
      /Cannot SELL to close a SHORT position/,
    )

    const pos = getPosition(acc.id)!
    assert.equal(pos.side, 'SHORT', 'position side unchanged')
    approxEqual(pos.quantity, 1, 'position quantity unchanged')
    approxEqual(pos.availableQuantity, 1, 'position available_quantity unchanged')
    const account = reloadAccount(acc.id)
    approxEqual(account.currentCash, cashAfterOpen, 'cash unchanged after rejected SELL')
    approxEqual(account.marginUsed, 0, 'margin_used unchanged after rejected SELL')
    assert.equal(getTrades(acc.id).length, 1, 'only the open trade is recorded')
    assert.equal(getOrders(acc.id).length, 1, 'rejected order is not recorded')
  })
})
