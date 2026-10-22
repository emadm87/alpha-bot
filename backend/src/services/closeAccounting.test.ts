/**
 * Deterministic tests for closing positions with placeAndExecuteCrypto:
 * floating-point residues after partial closes, and accrued interest larger
 * than the free cash before the margin is released.
 *
 * Run: npx tsx --test src/services/closeAccounting.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, network
 * blocked, no AI. Close quantities follow tradingCommands exactly:
 * min(round6(position quantity * portion), position quantity).
 * Expected values are closed-form:
 *   fee      = 0.0007 * quantity * price, on every fill
 *   interest = quantity * entry * (leverage - 1) / leverage * 0.0000125 * hours
 *   close    : cash += quantity * entry / leverage + pnl - fee - interest
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
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

const FEE = 0.0007
const RATE = 0.0000125
const BTC = 84621.5
const round6 = (v: number) => Number(v.toFixed(6))
const aiClose = (quantity: number, portion: number) =>
  Math.min(round6(quantity * portion), quantity)

let seq = 0
function newAccount(capital: number) {
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `close-${++seq}`,
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

function backdateInterest(id: number, symbol: string, hours: number) {
  rawDb
    .prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ? AND symbol = ?')
    .run(utcNow(new Date(Date.now() - hours * 3_600_000)), id, symbol)
}

// --- A2': partial close, then 100% close ------------------------------------

// Sizes from Task 005E-C: AI opens with 1,000 USDC at 10/25/50/100% of cash
// (round6(1000 * p / price)), plus 0.05 and 0.1 BTC.
const SIZES = [0.1, 0.25, 0.5, 1]
  .map((p) => round6((1000 * p) / BTC))
  .concat([0.05, 0.1])
const PORTIONS = [0.25, 0.5, 0.75, 0.9, 0.95, 0.99]
const MIN = 0.0001

for (const side of ['LONG', 'SHORT'] as const) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY'

  test(`${side} 3x: partial close then 100% close leaves no residue`, async (t) => {
    let fullyClosed = 0
    let dust = 0
    for (const size of SIZES) {
      for (const portion of PORTIONS) {
        const id = newAccount(100_000)
        const symbol = `R${seq}`
        await trade(id, symbol, side, size, 3, BTC)

        const first = aiClose(size, portion)
        await trade(id, symbol, closeSide, first, 3, BTC)
        const rest = position(id, symbol).quantity
        assert.equal(rest, round6(size - first), 'remaining quantity is the 6-decimal difference')

        // Real residues below the 0.0001 minimum close too: a 100% close
        // of a smaller position is allowed (Task 005G)
        if (rest < MIN) dust++

        const second = aiClose(rest, 1)
        await trade(id, symbol, closeSide, second, 3, BTC)
        const p = position(id, symbol)
        assert.equal(p.quantity, 0, `${size} @${portion}: quantity`)
        assert.equal(p.availableQuantity, 0, `${size} @${portion}: available`)
        assert.equal(p.side, null, `${size} @${portion}: side`)
        assert.equal(p.leverage, 1, `${size} @${portion}: leverage`)
        close(account(id).marginUsed, 0, `${size} @${portion}: margin_used`, 1e-9)

        // Price unchanged: only fees leave the account
        const fees = FEE * BTC * (size + first + second)
        close(account(id).currentCash, 100_000 - fees, `${size} @${portion}: cash`)
        close(
          accountTrades(id).reduce((s, x) => s + x.takerFee, 0),
          fees,
          `${size} @${portion}: fees recorded once`,
        )
        fullyClosed++
      }
    }
    t.diagnostic(`fully closed=${fullyClosed} of which below the minimum=${dust}`)
    assert.equal(fullyClosed, SIZES.length * PORTIONS.length)
    assert.equal(dust, 4, 'the four real residues below 0.0001 of Task 005E-C')
  })
}

test('repeated 50% closes: every remaining quantity stays on 6 decimals', async () => {
  const id = newAccount(100_000)
  await trade(id, 'H1', 'LONG', 0.005909, 3, BTC)
  const expected = [0.002954, 0.001477, 0.000738, 0.000369, 0.000184]
  for (const remaining of expected) {
    const q = position(id, 'H1').quantity
    await trade(id, 'H1', 'SELL', aiClose(q, 0.5), 3, BTC)
    assert.equal(position(id, 'H1').quantity, remaining)
  }
  await trade(id, 'H1', 'SELL', aiClose(position(id, 'H1').quantity, 1), 3, BTC)
  assert.equal(position(id, 'H1').quantity, 0)
  assert.equal(position(id, 'H1').side, null)
})

test('1x LONG: partial close then 100% close leaves no residue', async () => {
  const id = newAccount(1000)
  await trade(id, 'S1', 'LONG', 0.001182, 1, BTC)
  await trade(id, 'S1', 'SELL', aiClose(0.001182, 0.25), 1, BTC)
  assert.equal(position(id, 'S1').quantity, 0.000886)
  await trade(id, 'S1', 'SELL', aiClose(position(id, 'S1').quantity, 1), 1, BTC)
  assert.equal(position(id, 'S1').quantity, 0)
  assert.equal(position(id, 'S1').availableQuantity, 0)
})

// --- B1: interest larger than the free cash ---------------------------------

test('AI close: interest above free cash is paid from the released margin', async () => {
  const id = newAccount(1000)
  await trade(id, 'I1', 'LONG', 19.9, 2, 100) // cash left 3.607
  backdateInterest(id, 'I1', 400)
  const interest = ((19.9 * 100 * (2 - 1)) / 2) * RATE * 400 // 4.975

  await trade(id, 'I1', 'SELL', 19.9, 2, 110)

  const cash = 3.607 + 995 + 19.9 * (110 - 100) - FEE * 19.9 * 110 - interest
  close(account(id).currentCash, cash, 'cash', 1e-5) // 1191.0997
  close(account(id).marginUsed, 0, 'margin_used')
  const closeTrade = accountTrades(id).find((x) => x.side === 'SELL')!
  close(closeTrade.interestCharged, interest, 'interest recorded', 1e-5)
  close(position(id, 'I1').accumulatedInterest, interest, 'accumulated once', 1e-5)
  assert.equal(position(id, 'I1').quantity, 0)
  assert.equal(position(id, 'I1').side, null)
})

test('liquidation: interest above free cash no longer blocks the close', async () => {
  const id = newAccount(1000)
  await trade(id, 'I2', 'LONG', 19.9, 2, 100)
  backdateInterest(id, 'I2', 400)
  const interest = ((19.9 * 100) / 2) * RATE * 400
  cachePrice('I2', 'CRYPTO', 70)
  const open = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, id))
    .all()
  await (new TaskScheduler() as any).liquidatePositions(account(id), open, 'test')

  const cash = 3.607 + 995 + 19.9 * (70 - 100) - FEE * 19.9 * 70 - interest
  close(account(id).currentCash, cash, 'cash', 1e-5) // 395.6569
  close(account(id).marginUsed, 0, 'margin_used')
  assert.equal(position(id, 'I2').quantity, 0)
})

test('negative cash after the first liquidation close: the second still closes', async () => {
  const id = newAccount(1000)
  await trade(id, 'NA', 'LONG', 15, 2, 100)
  await trade(id, 'NB', 'SHORT', 2, 2, 100)
  rawDb
    .prepare('UPDATE positions SET quantity = 0, available_quantity = 0 WHERE account_id <> ?')
    .run(id)
  cachePrice('NA', 'CRYPTO', 40)
  cachePrice('NB', 'CRYPTO', 100)
  await (new TaskScheduler() as any).checkMarginLevels()

  // opens: 1000 - 750 - 1.05 - 100 - 0.14 = 148.81
  // A: + 750 - 900 - 0.42 -> -1.61 ; B: + 100 + 0 - 0.14 -> 98.25 (interest ~0)
  close(account(id).currentCash, 98.25, 'cash', 1e-5)
  close(account(id).marginUsed, 0, 'margin_used')
  assert.equal(position(id, 'NA').quantity, 0)
  assert.equal(position(id, 'NB').quantity, 0)
  assert.equal(position(id, 'NB').side, null)
})
