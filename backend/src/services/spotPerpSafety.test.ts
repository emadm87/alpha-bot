/**
 * Spot/perpetual collisions and older perpetual rows (Task 006G-6A).
 *
 * Run: npx tsx --test src/services/spotPerpSafety.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, no network.
 * Every account starts from 1,000 USDC. Engine fee 0.07% of notional,
 * manual order commission 0.1% (min 0.1); expected balances are worked out
 * by hand. "Legacy" rows are positions written before 006G-4 (margin NULL):
 * they are reproduced with the state the old engine left (weighted average
 * leverage truncated, marginUsed the sum of the margins actually posted).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-perp-safety-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}
console.warn = () => {}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto, legacyMarginIssue } = await import('./orderExecutorLeverage.js')
const { createOrder, checkAndExecuteOrder } = await import('./orderMatching.js')
const { TaskScheduler } = await import('./scheduler.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const CAPITAL = 1000
let seq = 0
function newAccount() {
  // retire earlier scenarios so the margin monitor only sees this account
  rawDb.prepare('UPDATE positions SET quantity = 0, available_quantity = 0').run()
  return db.insert(accounts).values({
    userId: user.id, name: `sp-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: CAPITAL, currentCash: CAPITAL, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
const engine = (id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) => {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
async function manual(id: number, symbol: string, side: string, quantity: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  const o = await createOrder({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity })
  assert.equal(await checkAndExecuteOrder(o), true, `manual ${side} filled`)
}
function near(actual: number | null | undefined, expected: number, what: string, eps = 1e-4) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** Everything an operation may change: account, positions, orders, trades. */
function snapshot(id: number) {
  return JSON.stringify({
    account: account(id),
    positions: db.select().from(positions).where(eq(positions.accountId, id)).all(),
    orders: db.select().from(orders).where(eq(orders.accountId, id)).all(),
    trades: db.select().from(trades).where(eq(trades.accountId, id)).all(),
  })
}
/** The operation is refused with `message` and leaves nothing behind. */
async function refused(id: number, run: () => Promise<unknown>, message: RegExp) {
  const before = snapshot(id)
  await assert.rejects(run, message)
  assert.equal(snapshot(id), before, 'state changed by a refused operation')
}
const report = (what: string, id: number) => {
  const cash = account(id).currentCash
  return `${what}: ${CAPITAL} -> ${cash.toFixed(4)} USDC (${(((cash - CAPITAL) / CAPITAL) * 100).toFixed(4)}%)`
}
/** A perpetual row as the engine before 006G-4 left it (margin NULL). */
function legacy(id: number, row: { symbol: string; quantity: number; avgCost: number; leverage: number; side: 'LONG' | 'SHORT' }, booked: { cash: number; marginUsed: number }) {
  db.insert(positions).values({
    version: 'v1', accountId: id, symbol: row.symbol, name: row.symbol, market: 'CRYPTO',
    quantity: row.quantity, availableQuantity: row.quantity, avgCost: row.avgCost, leverage: row.leverage,
    side: row.side, accumulatedInterest: 0, margin: null,
  }).run()
  db.update(accounts).set({ currentCash: booked.cash, marginUsed: booked.marginUsed }).where(eq(accounts.id, id)).run()
}

// --- B1: spot holding and perpetual on the same symbol ---------------------------

test('1. spot BTC then LONG BTC: refused, spot intact; allowed once the spot is sold', async () => {
  const id = newAccount()
  await manual(id, 'BTC', 'BUY', 1, 100) // 100 + 0.1 commission
  near(account(id).currentCash, 899.9, 'cash after spot buy')
  await refused(id, () => engine(id, 'BTC', 'LONG', 2, 2, 100), /holds a spot position of 1/)
  assert.equal(position(id, 'BTC')!.quantity, 1)
  assert.equal(position(id, 'BTC')!.side, null)
  await manual(id, 'BTC', 'SELL', 1, 110) // +110 - 0.11
  near(account(id).currentCash, 1009.79, 'cash after spot sell')
  await engine(id, 'BTC', 'LONG', 2, 2, 110) // margin 110, fee 0.154
  await engine(id, 'BTC', 'SELL', 2, 2, 110) // P&L 0, fee 0.154
  near(account(id).currentCash, 1009.482, 'final cash')
  console.log(report('1. spot +10%, then LONG 2x flat', id))
})

test('2. spot BTC then SHORT BTC: refused, spot intact', async () => {
  const id = newAccount()
  await manual(id, 'BTC', 'BUY', 1, 100)
  await refused(id, () => engine(id, 'BTC', 'SHORT', 1, 3, 100), /Cannot open SHORT on BTC: it holds a spot position/)
  const p = position(id, 'BTC')!
  assert.deepEqual([p.quantity, p.avgCost, p.leverage, p.side, p.margin], [1, 100, 1, null, null])
  await manual(id, 'BTC', 'SELL', 1, 100)
  near(account(id).currentCash, 999.8, 'final cash (two 0.1 commissions)')
  console.log(report('2. spot flat after refused SHORT', id))
})

test('3. perpetual BTC then a manual order on BTC: refused (006F-3C guard unchanged)', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 1, 2, 100)
  const before = snapshot(id)
  cachePrice('BTC', 'CRYPTO', 100)
  await assert.rejects(
    createOrder({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'BUY', orderType: 'MARKET', price: null, quantity: 1 }),
    /open LONG perpetual position: manual orders are not allowed/,
  )
  assert.equal(snapshot(id), before)
})

test('4. spot BTC and LONG ETH 3x: both allowed', async () => {
  const id = newAccount()
  await manual(id, 'BTC', 'BUY', 1, 100) // 899.9
  await engine(id, 'ETH', 'LONG', 3, 3, 100) // margin 100, fee 0.21 -> 799.69
  near(account(id).marginUsed, 100, 'marginUsed')
  await engine(id, 'ETH', 'SELL', 3, 3, 110) // +30 +100 -0.231
  await manual(id, 'BTC', 'SELL', 1, 100) // +100 -0.1
  near(account(id).currentCash, 1029.359, 'final cash')
  near(account(id).marginUsed, 0, 'marginUsed')
  console.log(report('4. spot BTC flat + ETH LONG 3x +10%', id))
})

test('5. LONG and SHORT 1x unchanged', async () => {
  const long = newAccount()
  await engine(long, 'SOL', 'LONG', 5, 1, 100) // 500 + 0.35
  await engine(long, 'SOL', 'SELL', 5, 1, 110) // +550 - 0.385
  near(account(long).currentCash, 1049.265, 'LONG 1x')
  console.log(report('5. LONG 1x +10%', long))
  const short = newAccount()
  await engine(short, 'SOL', 'SHORT', 5, 1, 100)
  await engine(short, 'SOL', 'BUY', 5, 1, 90) // +50 P&L +500 margin -0.315
  near(account(short).currentCash, 1049.335, 'SHORT 1x')
  console.log(report('5. SHORT 1x -10%', short))
})

test('6. mixed leverage 3x + 2x (006G-4) unchanged', async () => {
  const id = newAccount()
  await engine(id, 'ETH', 'LONG', 3, 3, 100) // margin 100, fee 0.21
  await engine(id, 'ETH', 'LONG', 2, 2, 100) // margin 100, fee 0.14
  const p = position(id, 'ETH')!
  near(p.margin, 200, 'recorded margin')
  near(account(id).marginUsed, 200, 'marginUsed')
  await engine(id, 'ETH', 'SELL', 5, p.leverage, 110) // +50 +200 -0.385
  near(account(id).currentCash, 1049.265, 'final cash')
  console.log(report('6. 3x + 2x LONG +10%', id))
})

// --- B2: perpetual rows written before 006G-4 ------------------------------------

test('7. legacy row with NULL margin that rebuilds marginUsed: closes normally', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 3, 3, 100) // margin 100, fee 0.21
  rawDb.prepare('UPDATE positions SET margin = NULL WHERE account_id = ?').run(id)
  assert.equal(legacyMarginIssue(account(id).marginUsed, db.select().from(positions).where(eq(positions.accountId, id)).all()), null)
  await engine(id, 'BTC', 'SELL', 3, 3, 110) // +30 +100 rebuilt -0.231
  near(account(id).currentCash, 1029.559, 'final cash')
  near(account(id).marginUsed, 0, 'marginUsed')
  console.log(report('7. legacy 3x LONG +10%', id))
})

test('8. legacy row from fills at 3x + 2x (old engine): close and add refused, nothing changes', async () => {
  const id = newAccount()
  // old engine: 3 @100 3x (margin 100, fee 0.21) + 2 @100 2x (margin 100, fee 0.14);
  // leverage trunc((300*3 + 200*2) / 500) = 2, so the row rebuilds 250 instead of 200
  legacy(id, { symbol: 'ETH', quantity: 5, avgCost: 100, leverage: 2, side: 'LONG' }, { cash: 799.65, marginUsed: 200 })
  const rows = db.select().from(positions).where(eq(positions.accountId, id)).all()
  assert.match(legacyMarginIssue(200, rows)!, /margin not recorded for ETH .* the perpetual rows give 250, account marginUsed is 200/)
  await refused(id, () => engine(id, 'ETH', 'SELL', 5, 2, 110), /Cannot SELL ETH: margin not recorded for ETH/)
  await refused(id, () => engine(id, 'ETH', 'SELL', 2, 2, 110), /not reconcilable/)
  await refused(id, () => engine(id, 'ETH', 'LONG', 1, 2, 110), /Cannot LONG ETH: margin not recorded/)
  near(account(id).currentCash, 799.65, 'cash untouched')
  // the old formula would have released 250: 799.65 + 50 + 250 - 0.385 = 1099.265 (50 USDC created)
  console.log('8. legacy 3x+2x: close refused; cash stays 799.65 USDC (old formula would give 1099.265, +50 fictitious)')

  // a perpetual with recorded margin on the same account still trades
  await engine(id, 'SOL', 'SHORT', 2, 2, 100) // margin 100, fee 0.14
  await engine(id, 'SOL', 'BUY', 2, 2, 90) // +20 +100 -0.126
  near(account(id).currentCash, 819.384, 'cash after the SOL round trip')
  near(account(id).marginUsed, 200, 'marginUsed back to the legacy booking')
  assert.equal(position(id, 'ETH')!.quantity, 5)
})

test('9. refused legacy close is not liquidated by the monitor either: balances untouched', async () => {
  const id = newAccount()
  // old engine: 12 @100 3x (margin 400, fee 0.84) + 6 @100 2x (margin 300, fee 0.42)
  legacy(id, { symbol: 'DOGE', quantity: 18, avgCost: 100, leverage: 2, side: 'LONG' }, { cash: 298.74, marginUsed: 700 })
  cachePrice('DOGE', 'CRYPTO', 50) // equity 298.74 + 900 - 900 = 298.74 < 350: margin call
  const before = snapshot(id)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(snapshot(id), before)
})

test('10. legacy row that reconciles is still liquidated by the monitor', async () => {
  const id = newAccount()
  await engine(id, 'XRP', 'LONG', 9, 3, 100) // margin 300, fee 0.63 -> 699.37
  rawDb.prepare('UPDATE positions SET margin = NULL WHERE account_id = ?').run(id)
  cachePrice('XRP', 'CRYPTO', 5) // equity 699.37 + 300 - 855 = 144.37 < 150
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'XRP')!.quantity, 0)
  near(account(id).currentCash, 144.3385, 'cash after liquidation') // -855 +300 -0.0315
  near(account(id).marginUsed, 0, 'marginUsed')
  console.log(report('10. legacy 3x LONG liquidated at -95%', id))
})

test('legacyMarginIssue: only perpetual rows count; recorded rows are never flagged', () => {
  const row = (o: Partial<{ symbol: string; quantity: number; avgCost: number; leverage: number; side: string | null; margin: number | null }>) => ({
    symbol: 'X', quantity: 1, avgCost: 100, leverage: 2, side: 'LONG', margin: null, ...o,
  })
  assert.equal(legacyMarginIssue(0, []), null)
  assert.equal(legacyMarginIssue(999, [row({ margin: 50 })]), null) // nothing legacy
  assert.equal(legacyMarginIssue(50, [row({})]), null)
  assert.equal(legacyMarginIssue(50, [row({}), row({ symbol: 'S', side: null, leverage: 3 })]), null) // manual rows ignored
  assert.equal(legacyMarginIssue(0, [row({ leverage: 1 })]), null) // 1x: not in marginUsed
  assert.ok(legacyMarginIssue(60, [row({})]))
  assert.equal(legacyMarginIssue(50, [row({ quantity: 0 })]), null)
})
