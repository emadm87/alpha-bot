/**
 * Margin monitor tests (Task 003G, bug E1).
 *
 * Runs one pass of the real margin check (`TaskScheduler.checkMarginLevels`)
 * on a fresh TaskScheduler instance: no job is scheduled and no timer is
 * started. `checkMarginLevels` is TypeScript-private, so it is reached via a
 * cast; this is a compile-time modifier only, the production code is untouched.
 *
 * Same offline setup as services/accounting.test.ts:
 *  - DATABASE_PATH points at a throwaway SQLite file in a fresh temp dir,
 *    set before any module opens the DB; only `ensureSchema()` runs (no seed).
 *  - Prices come from the real price cache (`cachePrice`).
 *  - `globalThis.fetch` throws, so any accidental network call fails loudly.
 *
 * Positions are opened with the real `placeAndExecuteCrypto`, so cash and
 * margin_used are exactly what the engine records. The monitor's own equity
 * and margin level are read from its debug log line and reported as test
 * diagnostics; assertions are on behaviour (liquidation orders, position).
 *
 * Correct equity, per the engine's accounting (cash had the entry margin
 * deducted on open):
 *   equity       = cash + margin_used + unrealised P&L
 *   margin level = equity / margin_used
 * The liquidation threshold is the fork's own `maintenance_margin_ratio`
 * (0.5) and is NOT assumed to match Hyperliquid; it is only used as given.
 *
 * Run with: npx tsx --test src/services/scheduler.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-margin-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
// The monitor reports equity/margin level only at debug level.
process.env.LOG_LEVEL = 'debug'

const networkCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  networkCalls.push(String(input))
  throw new Error(`Network access is not allowed in tests: ${String(input)}`)
}) as typeof fetch

// Capture (and silence) log output so the monitor's computed values can be read.
const logLines: string[] = []
const originalLog = console.log
const originalWarn = console.warn
console.log = (...args: unknown[]) => void logLines.push(args.map(String).join(' '))
console.warn = (...args: unknown[]) => void logLines.push(args.map(String).join(' '))

// Imported after env setup so db/client.ts opens the temp file.
const { db, rawDb, ensureSchema, DATABASE_PATH } = await import('../db/client.js')
const { eq, like, and } = await import('drizzle-orm')
const { accounts, orders, positions, users, CRYPTO_TAKER_FEE_RATE } = await import(
  '../db/schema.js'
)
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
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

const liquidationOrders = (accountId: number) =>
  db
    .select()
    .from(orders)
    .where(and(eq(orders.accountId, accountId), like(orders.orderNo, 'LIQ-%')))
    .all()

/** One margin-monitor pass, exactly as the scheduled job would run it. */
async function runMarginCheckOnce(): Promise<void> {
  const scheduler = new TaskScheduler()
  await (scheduler as unknown as { checkMarginLevels(): Promise<void> }).checkMarginLevels()
  assert.equal(scheduler.isRunning(), false, 'scheduler must not have been started')
}

/** Monitor's own reported values for an account, from its debug log line. */
function monitorReport(accountName: string): { equity: number; marginLevelPct: number } | null {
  const line = [...logLines]
    .reverse()
    .find((l) => l.includes(`Account ${accountName}: equity=`))
  if (!line) return null
  const equity = Number(/equity=\$(-?[\d.]+)/.exec(line)![1])
  const marginLevelPct = Number(/margin_level=(-?[\d.]+)%/.exec(line)![1])
  return { equity, marginLevelPct }
}

interface Scenario {
  symbol: string
  quantity: number
  entry: number
  leverage: number
  current: number
}

/**
 * Opens a LONG with the real engine, moves the price, runs one monitor pass.
 * Returns the documented figures; asserts the engine's open state first.
 */
async function runScenario(t: TestContext, s: Scenario) {
  const acc = createAccount()
  cachePrice(s.symbol, 'CRYPTO', s.entry)
  await placeAndExecuteCrypto({
    account: reloadAccount(acc.id),
    symbol: s.symbol,
    name: s.symbol,
    side: 'LONG',
    orderType: 'MARKET',
    price: null,
    quantity: s.quantity,
    leverage: s.leverage,
  })

  const notional = s.entry * s.quantity
  const margin = notional / s.leverage
  const fee = notional * CRYPTO_TAKER_FEE_RATE
  const opened = reloadAccount(acc.id)
  approxEqual(opened.currentCash, INITIAL_CASH - margin - fee, 'cash after open')
  approxEqual(opened.marginUsed, margin, 'margin_used after open')

  cachePrice(s.symbol, 'CRYPTO', s.current)
  const pnl = s.quantity * (s.current - s.entry)
  const correctEquity = opened.currentCash + opened.marginUsed + pnl
  const correctLevel = correctEquity / opened.marginUsed

  await runMarginCheckOnce()

  const report = monitorReport(opened.name)
  const liq = liquidationOrders(acc.id)
  const pos = db.select().from(positions).where(eq(positions.accountId, acc.id)).get()!
  const afterCheck = reloadAccount(acc.id)

  t.diagnostic(
    `cash=${opened.currentCash.toFixed(4)} margin_used=${opened.marginUsed.toFixed(4)} ` +
      `pnl=${pnl.toFixed(4)} correct_equity=${correctEquity.toFixed(4)} ` +
      `correct_level=${(correctLevel * 100).toFixed(2)}% | monitor_equity=${report?.equity} ` +
      `monitor_level=${report?.marginLevelPct}% | liquidation_orders=${liq.length} ` +
      `position_qty_after=${pos.quantity} cash_after=${afterCheck.currentCash.toFixed(4)} ` +
      `margin_used_after=${afterCheck.marginUsed.toFixed(4)}`,
  )

  assert.ok(report, 'monitor must have evaluated the account')
  // The log line rounds to 2 decimals.
  assert.ok(
    Math.abs(report.equity - correctEquity) <= 0.005 + EPS,
    `monitor equity: actual=${report.equity} expected=${correctEquity.toFixed(4)}`,
  )
  return { acc, correctEquity, correctLevel, report, liq, pos }
}

before(() => {
  assert.ok(
    DATABASE_PATH.startsWith(tmpDir),
    `Refusing to run: DATABASE_PATH is not the temp DB (${DATABASE_PATH})`,
  )
  ensureSchema()
})

after(() => {
  console.log = originalLog
  console.warn = originalWarn
  assert.deepEqual(networkCalls, [], 'No network calls should have been made')
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('E1 — margin monitor omits posted margin from equity', () => {
  test('LONG 2x 19.9 @100 (margin 995), price unchanged -> equity ~998.6, no liquidation', async (t) => {
    const r = await runScenario(t, { symbol: 'BTC', quantity: 19.9, entry: 100, leverage: 2, current: 100 })
    assert.ok(r.correctLevel >= 0.5, 'scenario must be above maintenance')
    assert.equal(r.liq.length, 0, `unexpected liquidation (monitor equity=${r.report!.equity})`)
    approxEqual(r.pos.quantity, 19.9, 'position still open')
  })

  test('LONG 2x 19.9 @100 (margin 995), price 90 -> equity ~799.6, no liquidation', async (t) => {
    const r = await runScenario(t, { symbol: 'ETH', quantity: 19.9, entry: 100, leverage: 2, current: 90 })
    assert.ok(r.correctLevel >= 0.5, 'scenario must be above maintenance')
    assert.equal(r.liq.length, 0, `unexpected liquidation (monitor equity=${r.report!.equity})`)
    approxEqual(r.pos.quantity, 19.9, 'position still open')
  })
})

describe('Controls — behaviour that must not change', () => {
  test('LONG 2x 1 @100 (margin 50, cash ~950), price 90 -> no liquidation', async (t) => {
    const r = await runScenario(t, { symbol: 'SOL', quantity: 1, entry: 100, leverage: 2, current: 90 })
    assert.equal(r.liq.length, 0, 'unexpected liquidation')
    approxEqual(r.pos.quantity, 1, 'position still open')
  })

  test('LONG 2x 19.9 @100 (margin 995), price 70 -> equity ~401.6 < 50% of margin, liquidated', async (t) => {
    const r = await runScenario(t, { symbol: 'DOGE', quantity: 19.9, entry: 100, leverage: 2, current: 70 })
    assert.ok(r.correctLevel < 0.5, 'scenario must be below maintenance')
    assert.equal(r.liq.length, 1, 'one liquidation order expected')
    assert.equal(r.liq[0]!.side, 'SELL', 'liquidation closes the LONG with SELL')
  })
})
