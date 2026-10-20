/**
 * Liquidation path tests (Task 003I, bug E2).
 *
 * Exercises the real liquidation path: one pass of
 * `TaskScheduler.checkMarginLevels` (fresh, never-started instance; the
 * TS-private method is reached via a cast) -> `liquidatePositions` ->
 * `orderMatching.checkAndExecuteOrder`. One suite calls
 * `checkAndExecuteOrder` directly with the same order `liquidatePositions`
 * builds, to show what the BUY path does to a SHORT when it can execute.
 *
 * Positions are opened with the real perpetual engine (`placeAndExecuteCrypto`),
 * so expected values check consistency with that engine's own model:
 *   close fee      = notional * CRYPTO_TAKER_FEE_RATE, recorded as taker_fee
 *   close cash     = cash + entry margin + gross P&L - fee
 *   margin_used    -= entry margin of the closed quantity
 *   full close     -> quantity 0, side null, leverage 1
 * The liquidation trigger (equity < 0.5 * margin_used, account-wide) is the
 * fork's own and is NOT assumed to match Hyperliquid; it is only used as given.
 * Expected values are deliberately not the real Hyperliquid fee/margin rules.
 *
 * Offline: throwaway SQLite file (`ensureSchema()` only, no seed), prices
 * from the real price cache, `globalThis.fetch` throws. Log output silenced.
 *
 * Run with: npx tsx --test src/services/liquidation.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-liq-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')

const networkCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  networkCalls.push(String(input))
  throw new Error(`Network access is not allowed in tests: ${String(input)}`)
}) as typeof fetch

const originalConsole = { log: console.log, warn: console.warn, error: console.error }
console.log = () => {}
console.warn = () => {}
console.error = () => {}

// Imported after env setup so db/client.ts opens the temp file.
const { db, rawDb, ensureSchema, DATABASE_PATH } = await import('../db/client.js')
const { and, asc, eq, like } = await import('drizzle-orm')
const { accounts, orders, positions, trades, users, CRYPTO_TAKER_FEE_RATE } =
  await import('../db/schema.js')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { checkAndExecuteOrder } = await import('./orderMatching.js')
const { TaskScheduler } = await import('./scheduler.js')

const INITIAL_CASH = 1000
const EPS = 1e-6

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
      name: `TEST-${user.id}`,
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

const reloadAccount = (id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get()!

const positionOf = (accountId: number, symbol: string) =>
  db
    .select()
    .from(positions)
    .where(and(eq(positions.accountId, accountId), eq(positions.symbol, symbol)))
    .get()

const liquidationOrders = (accountId: number) =>
  db
    .select()
    .from(orders)
    .where(and(eq(orders.accountId, accountId), like(orders.orderNo, 'LIQ-%')))
    .orderBy(asc(orders.id))
    .all()

const tradesOf = (accountId: number) =>
  db.select().from(trades).where(eq(trades.accountId, accountId)).orderBy(asc(trades.id)).all()

async function open(
  accountId: number,
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: number,
  price: number,
  leverage: number,
) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
    account: reloadAccount(accountId),
    symbol,
    name: symbol,
    side,
    orderType: 'MARKET',
    price: null,
    quantity,
    leverage,
  })
}

/** One margin-monitor pass, exactly as the scheduled job would run it. */
async function marginPass(): Promise<void> {
  const scheduler = new TaskScheduler()
  await (scheduler as unknown as { checkMarginLevels(): Promise<void> }).checkMarginLevels()
  assert.equal(scheduler.isRunning(), false, 'scheduler must not have been started')
}

/** Removes an account's positions so later monitor passes ignore it. */
function retire(accountId: number): void {
  db.delete(positions).where(eq(positions.accountId, accountId)).run()
}

const fmt = (n: number) => Number(n.toFixed(6))

before(() => {
  assert.ok(
    DATABASE_PATH.startsWith(tmpDir),
    `Refusing to run: DATABASE_PATH is not the temp DB (${DATABASE_PATH})`,
  )
  ensureSchema()
})

after(() => {
  Object.assign(console, originalConsole)
  assert.deepEqual(networkCalls, [], 'No network calls should have been made')
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('E2-A — LONG 2x 19.9 @100 liquidated at 70 (fork level 40.36% < 50%)', () => {
  const S = 'BTC'
  const qty = 19.9
  const entry = 100
  const exit = 70
  const margin = (qty * entry) / 2 // 995
  let accId: number
  let cashBefore: number

  before(async () => {
    accId = createAccount().id
    await open(accId, S, 'LONG', qty, entry, 2)
    cashBefore = reloadAccount(accId).currentCash // 3.607
    cachePrice(S, 'CRYPTO', exit)
    await marginPass()
  })
  after(() => retire(accId))

  test('control: one SELL liquidation order FILLED, position quantity 0', (t) => {
    const liq = liquidationOrders(accId)
    const pos = positionOf(accId, S)!
    const acc = reloadAccount(accId)
    const tr = tradesOf(accId)
    t.diagnostic(
      `before: cash=${fmt(cashBefore)} margin_used=${margin} | after: cash=${fmt(acc.currentCash)} ` +
        `margin_used=${acc.marginUsed} qty=${pos.quantity} side=${pos.side} leverage=${pos.leverage} | ` +
        `liq_orders=${JSON.stringify(liq.map((o) => [o.side, o.status, o.leverage]))} | ` +
        `close_trade=${JSON.stringify({ side: tr[1]?.side, price: tr[1]?.price, commission: tr[1]?.commission, takerFee: tr[1]?.takerFee, interest: tr[1]?.interestCharged })}`,
    )
    assert.deepEqual(liq.map((o) => [o.side, o.status]), [['SELL', 'FILLED']])
    approxEqual(pos.quantity, 0, 'position quantity')
    assert.equal(tr.length, 2, 'open + liquidation trade recorded')
  })

  test('control: cash = cash + margin + gross P&L - fee recorded on the trade', () => {
    const closeTrade = tradesOf(accId)[1]!
    const pnl = qty * (exit - entry) // -597
    approxEqual(
      reloadAccount(accId).currentCash,
      cashBefore + margin + pnl - closeTrade.commission,
      'cash after liquidation',
    )
  })

  test('margin_used is released to 0', () => {
    approxEqual(reloadAccount(accId).marginUsed, 0, 'margin_used after liquidation')
  })

  test('closed position state is reset (side null, leverage 1)', () => {
    const pos = positionOf(accId, S)!
    assert.deepEqual([pos.side, pos.leverage], [null, 1])
  })

  test('close fee follows the perpetual engine (taker rate) and is recorded as taker_fee', () => {
    const closeTrade = tradesOf(accId)[1]!
    const expectedFee = qty * exit * CRYPTO_TAKER_FEE_RATE // 0.9751
    approxEqual(closeTrade.commission, expectedFee, 'close commission')
    approxEqual(closeTrade.takerFee, expectedFee, 'close taker_fee')
  })

  test('same coin can be reopened SHORT after the liquidation', async () => {
    cachePrice(S, 'CRYPTO', 100)
    await open(accId, S, 'SHORT', 1, 100, 2)
    assert.equal(positionOf(accId, S)!.side, 'SHORT')
  })
})

describe('E2-B — stale margin_used after liquidation hides a new under-margined LONG', () => {
  let accId: number

  before(async () => {
    accId = createAccount().id
    await open(accId, 'SOL', 'LONG', 19.9, 100, 2)
    cachePrice('SOL', 'CRYPTO', 70)
    await marginPass() // liquidates SOL, margin_used stays 995
    // New LONG 2x 7.9 @100: margin 395. At 70: P&L -237.
    // True equity = cash + 395 - 237; true level ~41% < 50% -> should liquidate.
    await open(accId, 'XRP', 'LONG', 7.9, 100, 2)
    cachePrice('XRP', 'CRYPTO', 70)
    await marginPass()
  })
  after(() => retire(accId))

  test('second position is liquidated (true margin level below the fork threshold)', (t) => {
    const acc = reloadAccount(accId)
    const trueMargin = (7.9 * 100) / 2
    const pnl = 7.9 * (70 - 100)
    const trueEquity = acc.currentCash + trueMargin + pnl
    const monitorEquity = acc.currentCash + acc.marginUsed + pnl
    t.diagnostic(
      `cash=${fmt(acc.currentCash)} margin_used=${fmt(acc.marginUsed)} true_margin=${trueMargin} pnl=${pnl} | ` +
        `true_equity=${fmt(trueEquity)} true_level=${fmt((trueEquity / trueMargin) * 100)}% | ` +
        `monitor_equity=${fmt(monitorEquity)} monitor_level=${fmt((monitorEquity / acc.marginUsed) * 100)}% | ` +
        `XRP_qty=${positionOf(accId, 'XRP')!.quantity}`,
    )
    assert.ok(trueEquity / trueMargin < 0.5, 'scenario must be below the fork threshold')
    approxEqual(positionOf(accId, 'XRP')!.quantity, 0, 'XRP position quantity')
  })
})

describe('E2-C — SHORT 2x 19.9 @100 at 130 (fork level 40.36% < 50%), two monitor passes', () => {
  const S = 'ETH'
  let accId: number
  let cashBefore: number
  let marginBefore: number

  before(async () => {
    accId = createAccount().id
    await open(accId, S, 'SHORT', 19.9, 100, 2)
    const acc = reloadAccount(accId)
    cashBefore = acc.currentCash
    marginBefore = acc.marginUsed
    cachePrice(S, 'CRYPTO', 130)
    await marginPass()
    await marginPass()
  })
  after(() => retire(accId))

  test('SHORT position is closed by the liquidation', (t) => {
    const pos = positionOf(accId, S)!
    const acc = reloadAccount(accId)
    t.diagnostic(
      `before: cash=${fmt(cashBefore)} margin_used=${marginBefore} | after 2 passes: qty=${pos.quantity} side=${pos.side} ` +
        `cash=${fmt(acc.currentCash)} margin_used=${acc.marginUsed} | ` +
        `liq_orders=${JSON.stringify(liquidationOrders(accId).map((o) => [o.side, o.status, o.leverage]))} ` +
        `trades=${tradesOf(accId).length} | BUY needs ~${fmt(19.9 * 130 * 1.001)} cash`,
    )
    approxEqual(pos.quantity, 0, 'SHORT position quantity')
  })

  test('no PENDING liquidation orders are left behind', () => {
    const pending = liquidationOrders(accId).filter((o) => o.status === 'PENDING')
    assert.equal(pending.length, 0, `pending LIQ orders: ${pending.length}`)
  })

  test('control: failed attempts leave cash, margin and trades untouched', () => {
    const acc = reloadAccount(accId)
    approxEqual(acc.currentCash, cashBefore, 'cash')
    approxEqual(acc.marginUsed, marginBefore, 'margin_used')
    assert.equal(tradesOf(accId).length, 1, 'only the open trade')
  })
})

describe('E2-D — orderMatching BUY (as built by liquidatePositions) on a SHORT, ample cash', () => {
  const S = 'DOGE'
  let accId: number
  let executed: boolean
  let cashBefore: number

  before(async () => {
    // SHORT 2x 1 @100: margin 50, cash 949.93
    accId = createAccount().id
    await open(accId, S, 'SHORT', 1, 100, 2)
    cashBefore = reloadAccount(accId).currentCash
    cachePrice(S, 'CRYPTO', 90)
    // Same order liquidatePositions inserts for a SHORT.
    const order = db
      .insert(orders)
      .values({
        version: 'v1',
        accountId: accId,
        orderNo: 'LIQ-DIRECTTEST',
        symbol: S,
        name: S,
        market: 'CRYPTO',
        side: 'BUY',
        orderType: 'MARKET',
        price: null,
        quantity: 1,
        leverage: 1,
        filledQuantity: 0,
        status: 'PENDING',
      })
      .returning()
      .get()
    executed = await checkAndExecuteOrder(order)
  })
  after(() => retire(accId))

  test('BUY closes the SHORT (quantity 0)', (t) => {
    const pos = positionOf(accId, S)!
    const acc = reloadAccount(accId)
    t.diagnostic(
      `executed=${executed} | before: qty=1 side=SHORT avg=100 lev=2 cash=${fmt(cashBefore)} margin_used=50 | ` +
        `after: qty=${pos.quantity} side=${pos.side} avg=${fmt(pos.avgCost)} lev=${pos.leverage} ` +
        `cash=${fmt(acc.currentCash)} margin_used=${acc.marginUsed}`,
    )
    approxEqual(pos.quantity, 0, 'SHORT position quantity')
  })

  test('cash = cash + margin + gross P&L - taker fee (+10 profit)', () => {
    const fee = 90 * CRYPTO_TAKER_FEE_RATE
    approxEqual(reloadAccount(accId).currentCash, cashBefore + 50 + 10 - fee, 'cash')
  })
})

describe('E2-E — two positions (LONG BNB + SHORT LTC, 2x 9.9 @100) both losing 30%', () => {
  let accId: number
  let after1: { cash: number; margin: number }

  before(async () => {
    accId = createAccount().id
    await open(accId, 'BNB', 'LONG', 9.9, 100, 2)
    await open(accId, 'LTC', 'SHORT', 9.9, 100, 2)
    cachePrice('BNB', 'CRYPTO', 70)
    cachePrice('LTC', 'CRYPTO', 130)
    await marginPass()
    const a = reloadAccount(accId)
    after1 = { cash: a.currentCash, margin: a.marginUsed }
    await marginPass()
  })
  after(() => retire(accId))

  test('all leveraged positions are closed', (t) => {
    const acc = reloadAccount(accId)
    const ltc = positionOf(accId, 'LTC')!
    const monitorEquity = acc.currentCash + acc.marginUsed + 9.9 * (100 - 130)
    t.diagnostic(
      `after pass 1: cash=${fmt(after1.cash)} margin_used=${after1.margin} | BNB_qty=${positionOf(accId, 'BNB')!.quantity} ` +
        `LTC_qty=${ltc.quantity} | pass 2 monitor_equity=${fmt(monitorEquity)} level=${fmt((monitorEquity / acc.marginUsed) * 100)}% | ` +
        `liq_orders=${JSON.stringify(liquidationOrders(accId).map((o) => [o.symbol, o.side, o.status]))}`,
    )
    approxEqual(positionOf(accId, 'BNB')!.quantity, 0, 'BNB quantity')
    approxEqual(ltc.quantity, 0, 'LTC quantity')
  })

  test('margin_used matches the margin of what is still open', () => {
    const ltc = positionOf(accId, 'LTC')!
    const openMargin = (ltc.quantity * ltc.avgCost) / ltc.leverage
    approxEqual(reloadAccount(accId).marginUsed, openMargin, 'margin_used')
  })
})

describe('E2-F — insolvency: LONG 2x 19.9 @100, price gaps to 40 (loss 1194 > margin 995)', () => {
  let accId: number

  before(async () => {
    accId = createAccount().id
    await open(accId, 'AVAX', 'LONG', 19.9, 100, 2)
    cachePrice('AVAX', 'CRYPTO', 40)
    await marginPass()
  })
  after(() => retire(accId))

  test('account cash does not go negative after liquidation', (t) => {
    const acc = reloadAccount(accId)
    t.diagnostic(
      `after: cash=${fmt(acc.currentCash)} margin_used=${acc.marginUsed} qty=${positionOf(accId, 'AVAX')!.quantity} ` +
        `liq_orders=${JSON.stringify(liquidationOrders(accId).map((o) => [o.side, o.status]))}`,
    )
    assert.ok(acc.currentCash >= 0, `cash=${acc.currentCash}`)
  })
})
