/**
 * Deterministic tests for the margin monitor's equity and liquidation
 * trigger (TaskScheduler.checkMarginLevels).
 *
 * Run: npx tsx --test src/services/marginMonitor.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, network
 * blocked, scheduler never started (one manual pass per test). The
 * liquidation path itself is out of scope here: liquidatePositions is
 * replaced on the test instance by a spy that only records the call.
 *
 * Expected values come from closed-form formulas written here:
 *   fee      = 0.0007 * quantity * entry          (charged at open)
 *   margin   = quantity * entry / leverage         (leverage > 1 only)
 *   pnl      = LONG q * (price - entry), SHORT q * (entry - price)
 *   equity   = capital - fees + pnl                (all open positions)
 *   level    = equity / margin, liquidate when level < 0.5
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
// Debug level so the monitor's own equity line can be read; output is captured
process.env.LOG_LEVEL = 'debug'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const captured: string[] = []
for (const method of ['log', 'warn', 'error'] as const) {
  console[method] = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '))
  }
}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
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

const CAPITAL = 1000
const FEE_RATE = 0.0007
const MAINTENANCE = 0.5
const EPS = 1e-9

let seq = 0

interface Leg {
  side: 'LONG' | 'SHORT'
  leverage: number
  quantity: number
  entry: number
  price: number
}

/** Opens every leg on a fresh account, then moves each leg to its price. */
async function setup(legs: Leg[]) {
  const account = db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `monitor-${++seq}`,
      accountType: 'AI',
      apiKey: 'test-placeholder',
      initialCapital: CAPITAL,
      currentCash: CAPITAL,
      maintenanceMarginRatio: MAINTENANCE,
    })
    .returning()
    .get()

  const symbols = legs.map((_, i) => `M${seq}x${i}`)
  for (const [i, leg] of legs.entries()) {
    cachePrice(symbols[i]!, 'CRYPTO', leg.entry)
    await placeAndExecuteCrypto({
      account: db.select().from(accounts).where(eq(accounts.id, account.id)).get()!,
      symbol: symbols[i]!,
      name: symbols[i]!,
      side: leg.side,
      orderType: 'MARKET',
      price: null,
      quantity: leg.quantity,
      leverage: leg.leverage,
    })
  }
  for (const [i, leg] of legs.entries()) cachePrice(symbols[i]!, 'CRYPTO', leg.price)

  let fees = 0
  let pnl = 0
  let margin = 0
  for (const leg of legs) {
    fees += FEE_RATE * leg.quantity * leg.entry
    pnl +=
      leg.side === 'LONG'
        ? leg.quantity * (leg.price - leg.entry)
        : leg.quantity * (leg.entry - leg.price)
    if (leg.leverage > 1) margin += (leg.quantity * leg.entry) / leg.leverage
  }
  const equity = CAPITAL - fees + pnl
  return { id: account.id, name: account.name, equity, margin, level: equity / margin }
}

/** One pass of the real monitor; reports whether it asked to liquidate. */
async function runMonitor(accountName: string) {
  const scheduler = new TaskScheduler() as any
  assert.equal(scheduler.isRunning(), false)
  const liquidated: string[] = []
  scheduler.liquidatePositions = async (
    account: { name: string },
    positions: { symbol: string }[],
  ) => {
    if (account.name !== accountName) return
    liquidated.push(...positions.map((p) => p.symbol))
  }
  captured.length = 0
  await scheduler.checkMarginLevels()
  const line = captured.find((l) => l.includes(`Account ${accountName}: equity=$`))
  const monitorEquity = line ? Number(/equity=\$(-?[\d.]+)/.exec(line)![1]) : NaN
  return { liquidated: liquidated.length > 0, monitorEquity }
}

async function check(
  t: { diagnostic: (msg: string) => void },
  legs: Leg[],
  expectLiquidation: boolean,
) {
  const s = await setup(legs)
  assert.equal(s.level < MAINTENANCE, expectLiquidation, 'expected outcome matches the formula')
  const account = db.select().from(accounts).where(eq(accounts.id, s.id)).get()!
  assert.ok(Math.abs(account.marginUsed - s.margin) < EPS, 'engine margin_used')
  assert.ok(
    Math.abs((await calcAccountEquity(account)).equity - s.equity) < EPS,
    `calcAccountEquity=${(await calcAccountEquity(account)).equity} expected=${s.equity}`,
  )

  const r = await runMonitor(s.name)
  t.diagnostic(
    `expected equity=${s.equity.toFixed(4)} level=${(s.level * 100).toFixed(2)}% ` +
      `monitor equity=${r.monitorEquity} liquidated=${r.liquidated}`,
  )
  // The monitor logs equity rounded to 2 decimals
  assert.ok(
    Math.abs(r.monitorEquity - s.equity) <= 0.005,
    `monitor equity=${r.monitorEquity} expected=${s.equity.toFixed(4)}`,
  )
  assert.equal(r.liquidated, expectLiquidation, 'liquidation decision')
  // Keep later monitor passes focused on their own account
  rawDb.prepare('DELETE FROM positions WHERE account_id = ?').run(s.id)
}

// --- reproduction of the 004D case -----------------------------------------

test('two LONG 2x at 100% of cash, prices unchanged: healthy, not liquidated', async (t) => {
  // Same sizing as tradingCommands: quantity = currentCash * portion / price
  const q1 = 10 // 1000 * 1.0 / 100
  const cashAfterFirst = CAPITAL - (q1 * 100) / 2 - FEE_RATE * q1 * 100
  const q2 = Number((cashAfterFirst / 100).toFixed(6))
  await check(t, [
    { side: 'LONG', leverage: 2, quantity: q1, entry: 100, price: 100 },
    { side: 'LONG', leverage: 2, quantity: q2, entry: 100, price: 100 },
  ], false)
})

// --- single LONG ------------------------------------------------------------

test('LONG 2x all cash, price unchanged: not liquidated', async (t) => {
  await check(t, [{ side: 'LONG', leverage: 2, quantity: 10, entry: 100, price: 100 }], false)
})

test('LONG 2x all cash, price +20% (favorable): not liquidated', async (t) => {
  await check(t, [{ side: 'LONG', leverage: 2, quantity: 10, entry: 100, price: 120 }], false)
})

test('LONG 2x all cash, price -30%: healthy, not liquidated', async (t) => {
  await check(t, [{ side: 'LONG', leverage: 2, quantity: 10, entry: 100, price: 70 }], false)
})

test('LONG 2x all cash, price -70%: level 59.86%, not liquidated', async (t) => {
  await check(t, [{ side: 'LONG', leverage: 2, quantity: 10, entry: 100, price: 30 }], false)
})

test('LONG 2x all cash, price -76%: level 47.86%, liquidated', async (t) => {
  await check(t, [{ side: 'LONG', leverage: 2, quantity: 10, entry: 100, price: 24 }], true)
})

// --- single SHORT -----------------------------------------------------------

test('SHORT 5x all cash, price -10% (favorable): not liquidated', async (t) => {
  await check(t, [{ side: 'SHORT', leverage: 5, quantity: 10, entry: 100, price: 90 }], false)
})

test('SHORT 5x all cash, price +85%: level 74.65%, not liquidated', async (t) => {
  await check(t, [{ side: 'SHORT', leverage: 5, quantity: 10, entry: 100, price: 185 }], false)
})

test('SHORT 5x all cash, price +95%: level 24.65%, liquidated', async (t) => {
  await check(t, [{ side: 'SHORT', leverage: 5, quantity: 10, entry: 100, price: 195 }], true)
})

test('SHORT 3x, price unchanged: not liquidated', async (t) => {
  await check(t, [{ side: 'SHORT', leverage: 3, quantity: 5, entry: 100, price: 100 }], false)
})

// --- several positions ------------------------------------------------------

test('LONG 3x + SHORT 5x + LONG 1x, mixed moves: not liquidated', async (t) => {
  await check(t, [
    { side: 'LONG', leverage: 3, quantity: 3, entry: 100, price: 90 },
    { side: 'SHORT', leverage: 5, quantity: 2, entry: 200, price: 210 },
    { side: 'LONG', leverage: 1, quantity: 1, entry: 50, price: 55 },
  ], false)
})

test('LONG 3x + SHORT 5x + LONG 1x, all against: level below 50%, liquidated', async (t) => {
  // equity = 1000 - 0.525 - 3*(100-10) - 2*(500-200) - 1*(50-5) = 84.475
  // margin = 300/3 + 400/5 = 180 -> level 46.93%
  await check(t, [
    { side: 'LONG', leverage: 3, quantity: 3, entry: 100, price: 10 },
    { side: 'SHORT', leverage: 5, quantity: 2, entry: 200, price: 500 },
    { side: 'LONG', leverage: 1, quantity: 1, entry: 50, price: 5 },
  ], true)
})

test('only 1x positions: monitor does not evaluate the account (unchanged)', async () => {
  const s = await setup([{ side: 'LONG', leverage: 1, quantity: 5, entry: 100, price: 10 }])
  const r = await runMonitor(s.name)
  assert.equal(r.liquidated, false)
  assert.ok(Number.isNaN(r.monitorEquity), 'no equity line for this account')
})
