/**
 * Stale account snapshot tests (Task 003K, bug E9).
 *
 * `placeAndExecuteCrypto` takes an `account` object from its caller and
 * writes back `currentCash` / `marginUsed` computed from that object's
 * values. These tests check what happens when the object is older than the
 * row in the database: sequential reuse, a liquidation in between, and two
 * orders started concurrently.
 *
 * Expected values follow the engine's own model (fee = notional *
 * CRYPTO_TAKER_FEE_RATE; open: cash -= notional / leverage + fee and
 * margin_used += margin when leverage > 1; close: cash += margin + P&L - fee,
 * margin_used -= margin). Interest accrued over the test's milliseconds is
 * < 1e-6 and is covered by the tolerance.
 *
 * Offline: throwaway SQLite file (`ensureSchema()` only, no seed), prices
 * from the real price cache, `globalThis.fetch` throws. Log output silenced.
 *
 * Run with: npx tsx --test src/services/staleAccount.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-stale-test-'))
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
const { and, asc, eq } = await import('drizzle-orm')
const { accounts, orders, positions, trades, users, CRYPTO_TAKER_FEE_RATE } =
  await import('../db/schema.js')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')

type AccountRow = typeof accounts.$inferSelect

const INITIAL_CASH = 1000
const EPS = 1e-6
const fee = (notional: number) => notional * CRYPTO_TAKER_FEE_RATE
const fmt = (n: number) => Number(n.toFixed(6))

function approxEqual(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${label}: actual=${actual} expected=${expected}`,
  )
}

function createAccount(): AccountRow {
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

const ordersOf = (accountId: number) =>
  db.select().from(orders).where(eq(orders.accountId, accountId)).orderBy(asc(orders.id)).all()

const tradesOf = (accountId: number) =>
  db.select().from(trades).where(eq(trades.accountId, accountId)).orderBy(asc(trades.id)).all()

function exec(
  account: AccountRow,
  symbol: string,
  side: 'LONG' | 'SHORT' | 'BUY' | 'SELL',
  quantity: number,
  leverage: number,
) {
  return placeAndExecuteCrypto({
    account,
    symbol,
    name: symbol,
    side,
    orderType: 'MARKET',
    price: null,
    quantity,
    leverage,
  })
}

/** Removes an account's positions so later monitor passes ignore it. */
function retire(accountId: number): void {
  db.delete(positions).where(eq(positions.accountId, accountId)).run()
}

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

// Two opens: LONG 2x 1 BTC @100 (margin 50, fee 0.07) and
// LONG 2x 1 ETH @200 (margin 100, fee 0.14).
const OPEN_EXPECTED_CASH = INITIAL_CASH - 50 - fee(100) - 100 - fee(200) // 849.79
const OPEN_EXPECTED_MARGIN = 150

describe('E9-A — two opens with the same snapshot read before the first', () => {
  let accId: number

  before(async () => {
    const snapshot = createAccount()
    accId = snapshot.id
    cachePrice('BTC', 'CRYPTO', 100)
    cachePrice('ETH', 'CRYPTO', 200)
    await exec(snapshot, 'BTC', 'LONG', 1, 2)
    await exec(snapshot, 'ETH', 'LONG', 1, 2) // stale: still cash 1000, margin 0
  })
  after(() => retire(accId))

  test('cash reflects both margins and fees', (t) => {
    const acc = reloadAccount(accId)
    t.diagnostic(
      `cash=${fmt(acc.currentCash)} expected=${fmt(OPEN_EXPECTED_CASH)} | ` +
        `margin_used=${acc.marginUsed} expected=${OPEN_EXPECTED_MARGIN}`,
    )
    approxEqual(acc.currentCash, OPEN_EXPECTED_CASH, 'cash')
  })

  test('margin_used reflects both positions', () => {
    approxEqual(reloadAccount(accId).marginUsed, OPEN_EXPECTED_MARGIN, 'margin_used')
  })

  test('control: both positions, orders and trades are recorded', () => {
    approxEqual(positionOf(accId, 'BTC')!.quantity, 1, 'BTC qty')
    approxEqual(positionOf(accId, 'ETH')!.quantity, 1, 'ETH qty')
    assert.deepEqual(ordersOf(accId).map((o) => [o.symbol, o.status]), [['BTC', 'FILLED'], ['ETH', 'FILLED']])
    assert.equal(tradesOf(accId).length, 2)
  })

  test('cash ledger is consistent with recorded trades and open margin', () => {
    // initial - fees recorded on trades - margin of open positions
    const fees = tradesOf(accId).reduce((s, tr) => s + tr.takerFee + tr.interestCharged, 0)
    const openMargin = ['BTC', 'ETH'].reduce((s, sym) => {
      const p = positionOf(accId, sym)!
      return s + (p.quantity * p.avgCost) / p.leverage
    }, 0)
    approxEqual(reloadAccount(accId).currentCash, INITIAL_CASH - fees - openMargin, 'cash vs ledger')
  })
})

describe('E9-B — control: account re-read before the second open', () => {
  let accId: number

  before(async () => {
    accId = createAccount().id
    cachePrice('SOL', 'CRYPTO', 100)
    cachePrice('XRP', 'CRYPTO', 200)
    await exec(reloadAccount(accId), 'SOL', 'LONG', 1, 2)
    await exec(reloadAccount(accId), 'XRP', 'LONG', 1, 2)
  })
  after(() => retire(accId))

  test('cash and margin_used reflect both opens', (t) => {
    const acc = reloadAccount(accId)
    t.diagnostic(`cash=${fmt(acc.currentCash)} margin_used=${acc.marginUsed}`)
    approxEqual(acc.currentCash, OPEN_EXPECTED_CASH, 'cash')
    approxEqual(acc.marginUsed, OPEN_EXPECTED_MARGIN, 'margin_used')
  })
})

describe('E9-C — two closes with the same snapshot read before the first', () => {
  let accId: number
  // After both opens (fresh): cash 849.79, margin 150.
  // Close BTC @110: +50 +10 -0.077; close ETH @220: +100 +20 -0.154.
  const expectedCash = OPEN_EXPECTED_CASH + 50 + 10 - fee(110) + 100 + 20 - fee(220) // 1029.559

  before(async () => {
    accId = createAccount().id
    cachePrice('DOGE', 'CRYPTO', 100)
    cachePrice('BNB', 'CRYPTO', 200)
    await exec(reloadAccount(accId), 'DOGE', 'LONG', 1, 2)
    await exec(reloadAccount(accId), 'BNB', 'LONG', 1, 2)
    const snapshot = reloadAccount(accId)
    cachePrice('DOGE', 'CRYPTO', 110)
    cachePrice('BNB', 'CRYPTO', 220)
    await exec(snapshot, 'DOGE', 'SELL', 1, 2)
    await exec(snapshot, 'BNB', 'SELL', 1, 2) // stale: cash 849.79, margin 150
  })
  after(() => retire(accId))

  test('cash reflects both closes', (t) => {
    const acc = reloadAccount(accId)
    t.diagnostic(
      `cash=${fmt(acc.currentCash)} expected=${fmt(expectedCash)} | margin_used=${acc.marginUsed} expected=0 | ` +
        `qty DOGE=${positionOf(accId, 'DOGE')!.quantity} BNB=${positionOf(accId, 'BNB')!.quantity} | ` +
        `orders=${ordersOf(accId).length} trades=${tradesOf(accId).length}`,
    )
    approxEqual(acc.currentCash, expectedCash, 'cash')
  })

  test('margin_used is 0 after both closes', () => {
    approxEqual(reloadAccount(accId).marginUsed, 0, 'margin_used')
  })

  test('control: both positions closed, 4 orders FILLED, 4 trades', () => {
    approxEqual(positionOf(accId, 'DOGE')!.quantity, 0, 'DOGE qty')
    approxEqual(positionOf(accId, 'BNB')!.quantity, 0, 'BNB qty')
    assert.deepEqual(ordersOf(accId).map((o) => o.status), ['FILLED', 'FILLED', 'FILLED', 'FILLED'])
    assert.equal(tradesOf(accId).length, 4)
  })
})

/**
 * AI cycle pattern: tradingCommands reads the account at cycle start, then
 * awaits the LLM; meanwhile the margin monitor liquidates a position; then
 * the AI order executes with the old snapshot (cash 3.607, margin_used 995).
 */
async function snapshotThenLiquidation(symbol: string) {
  const accId = createAccount().id
  cachePrice(symbol, 'CRYPTO', 100)
  await exec(reloadAccount(accId), symbol, 'LONG', 19.9, 2)
  const snapshot = reloadAccount(accId)
  cachePrice(symbol, 'CRYPTO', 70)
  const scheduler = new TaskScheduler()
  await (scheduler as unknown as { checkMarginLevels(): Promise<void> }).checkMarginLevels()
  assert.equal(scheduler.isRunning(), false)
  const a = reloadAccount(accId)
  return { accId, snapshot, afterLiquidation: { cash: a.currentCash, margin: a.marginUsed } }
}

describe('E9-D — snapshot before a liquidation, small AI order afterwards (overwrite)', () => {
  let accId: number
  let afterLiquidation: { cash: number; margin: number }

  before(async () => {
    const r = await snapshotThenLiquidation('LTC')
    accId = r.accId
    afterLiquidation = r.afterLiquidation
    // LONG 1x 0.03 ADA @100: cost 3 + 0.0021 fits the stale cash of 3.607
    cachePrice('ADA', 'CRYPTO', 100)
    await exec(r.snapshot, 'ADA', 'LONG', 0.03, 1)
  })
  after(() => retire(accId))

  test('liquidation result is not overwritten by the later AI order', (t) => {
    const acc = reloadAccount(accId)
    const expectedCash = afterLiquidation.cash - 3 - fee(3)
    t.diagnostic(
      `after liquidation: cash=${fmt(afterLiquidation.cash)} margin_used=${afterLiquidation.margin} | ` +
        `after AI order: cash=${fmt(acc.currentCash)} expected=${fmt(expectedCash)} ` +
        `margin_used=${acc.marginUsed} expected=0 | LTC qty=${positionOf(accId, 'LTC')!.quantity}`,
    )
    approxEqual(acc.currentCash, expectedCash, 'cash')
    approxEqual(acc.marginUsed, 0, 'margin_used')
  })
})

describe('E9-D2 — snapshot before a liquidation, larger AI order afterwards (false rejection)', () => {
  let accId: number
  let afterLiquidation: { cash: number; margin: number }
  let error: unknown = null

  before(async () => {
    const r = await snapshotThenLiquidation('ATOM')
    accId = r.accId
    afterLiquidation = r.afterLiquidation
    // LONG 1x 1 NEAR @100: cost 100.07 <= real cash ~400.63, > stale cash 3.607
    cachePrice('NEAR', 'CRYPTO', 100)
    try {
      await exec(r.snapshot, 'NEAR', 'LONG', 1, 1)
    } catch (e) {
      error = e
    }
  })
  after(() => retire(accId))

  test('order affordable with the real cash is accepted', (t) => {
    t.diagnostic(
      `real cash=${fmt(afterLiquidation.cash)} | error=${error ? String(error) : 'none'} | ` +
        `NEAR qty=${positionOf(accId, 'NEAR')?.quantity ?? 0}`,
    )
    assert.equal(error, null, `rejected: ${String(error)}`)
    approxEqual(reloadAccount(accId).currentCash, afterLiquidation.cash - 100 - fee(100), 'cash')
  })
})

describe('E9-E — two orders started concurrently, each with a freshly read account', () => {
  let accId: number

  before(async () => {
    accId = createAccount().id
    cachePrice('DOT', 'CRYPTO', 100)
    cachePrice('AVAX', 'CRYPTO', 200)
    // Both callers read the account before either order runs (interleaving
    // at the `await getLastPrice` inside placeAndExecuteCrypto).
    await Promise.all([
      exec(reloadAccount(accId), 'DOT', 'LONG', 1, 2),
      exec(reloadAccount(accId), 'AVAX', 'LONG', 1, 2),
    ])
  })
  after(() => retire(accId))

  test('cash and margin_used reflect both opens', (t) => {
    const acc = reloadAccount(accId)
    t.diagnostic(
      `cash=${fmt(acc.currentCash)} expected=${fmt(OPEN_EXPECTED_CASH)} | ` +
        `margin_used=${acc.marginUsed} expected=${OPEN_EXPECTED_MARGIN} | ` +
        `positions DOT=${positionOf(accId, 'DOT')!.quantity} AVAX=${positionOf(accId, 'AVAX')!.quantity}`,
    )
    approxEqual(acc.currentCash, OPEN_EXPECTED_CASH, 'cash')
    approxEqual(acc.marginUsed, OPEN_EXPECTED_MARGIN, 'margin_used')
  })
})
