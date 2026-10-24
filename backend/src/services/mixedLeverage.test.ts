/**
 * Adding to a position at different leverages (Task 006G-4): the margin
 * actually posted is recorded and released, instead of being rebuilt from a
 * truncated average leverage.
 *
 * Run: npx tsx --test src/services/mixedLeverage.test.ts
 *
 * Throwaway SQLite file created with the positions table as it was before
 * the margin column (ensureSchema must add it without touching rows), prices
 * injected into the price cache, no network. Engine fee 0.07% of notional;
 * expected balances are worked out by hand.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-leverage-test-'))
const dbFile = path.join(tmpDir, 'test.db')
// A database created before Task 006G-4: positions without `margin`, one row
{
  const old = new Database(dbFile)
  old.exec(`CREATE TABLE positions (
	id INTEGER NOT NULL, version VARCHAR(100) NOT NULL, account_id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL, name VARCHAR(100) NOT NULL, market VARCHAR(10) NOT NULL,
	quantity DECIMAL(18, 8) NOT NULL, available_quantity DECIMAL(18, 8) NOT NULL,
	avg_cost DECIMAL(18, 6) NOT NULL, leverage INTEGER NOT NULL, side VARCHAR(10),
	accumulated_interest DECIMAL(18, 6) NOT NULL, last_interest_time DATETIME, update_time DATETIME,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id))`)
  old.prepare("INSERT INTO positions (version, account_id, symbol, name, market, quantity, available_quantity, avg_cost, leverage, side, accumulated_interest) VALUES ('v1', 999, 'OLD', 'OLD', 'CRYPTO', 2, 2, 50, 3, 'LONG', 0)").run()
  old.close()
}
process.env.DATABASE_PATH = dbFile
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
const { createOrder, checkAndExecuteOrder } = await import('./orderMatching.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { TaskScheduler } = await import('./scheduler.js')
const { utcNow } = await import('../utils/datetime.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

let seq = 0
const newAccount = () =>
  db.insert(accounts).values({
    userId: user.id, name: `ml-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()!
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()

async function trade(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  await placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
function near(actual: number | null | undefined, expected: number, what: string, eps = 1e-6) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** Booked figures, and equity = cash + margin + unrealized P&L at `price`; returns fees + interest paid. */
async function check(id: number, symbol: string, price: number, what: string, expected: { cash: number; margin: number | null; marginUsed: number; quantity: number }) {
  const a = account(id)
  near(a.currentCash, expected.cash, `${what}: cash`)
  near(a.marginUsed, expected.marginUsed, `${what}: marginUsed`)
  assert.ok(a.marginUsed >= -1e-9, `${what}: marginUsed negative`)
  const p = position(id, symbol)
  near(p.quantity, expected.quantity, `${what}: quantity`)
  if (expected.margin === null) assert.equal(p.margin, null, `${what}: margin`)
  else near(p.margin, expected.margin, `${what}: margin`)
  cachePrice(symbol, 'CRYPTO', price)
  const costs = fills(id).reduce((s, t) => s + t.commission + t.interestCharged, 0)
  const sign = p.side === 'SHORT' ? -1 : 1
  const upnl = p.quantity > 0 ? sign * p.quantity * (price - p.avgCost) : 0
  near((await calcAccountEquity(a)).equity, a.currentCash + (p.quantity > 0 ? p.margin! : 0) + upnl, `${what}: equity = cash + margin + uPnL`)
  return { costs }
}

test('schema: the margin column is added to an existing database, old rows untouched', () => {
  const cols = (rawDb.prepare('PRAGMA table_info(positions)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(cols.includes('margin'))
  const old = rawDb.prepare("SELECT quantity, avg_cost, leverage, side, margin FROM positions WHERE symbol = 'OLD'").get()
  assert.deepEqual(old, { quantity: 2, avg_cost: 50, leverage: 3, side: 'LONG', margin: null })
  ensureSchema() // idempotent
})

test('1. LONG 3x + LONG 2x: 250 posted and returned, no fictitious profit', async () => {
  const id = newAccount()
  await trade(id, 'A', 'LONG', 3, 3, 100) // margin 100, fee 0.21
  await trade(id, 'A', 'LONG', 3, 2, 100) // margin 150, fee 0.21
  await check(id, 'A', 100, 'after add', { cash: 749.58, margin: 250, marginUsed: 250, quantity: 6 })
  assert.equal(position(id, 'A').leverage, 3) // effective 600 / 250 = 2.4, rounded up
  near((await calcAccountEquity(account(id))).equity, 999.58, 'equity = 1000 - fees')
  await trade(id, 'A', 'SELL', 6, 3, 100)
  await check(id, 'A', 100, 'closed', { cash: 999.16, margin: null, marginUsed: 0, quantity: 0 }) // was 1,049.16 (+50 fictitious)
})

test('2. SHORT 3x + SHORT 2x: closes at +60 without margin drift', async () => {
  const id = newAccount()
  await trade(id, 'B', 'SHORT', 3, 3, 100)
  await trade(id, 'B', 'SHORT', 3, 2, 100)
  await check(id, 'B', 100, 'after add', { cash: 749.58, margin: 250, marginUsed: 250, quantity: 6 })
  await trade(id, 'B', 'BUY', 6, 3, 90) // pnl +60, fee 0.378
  await check(id, 'B', 90, 'closed', { cash: 749.58 + 250 + 60 - 0.378, margin: null, marginUsed: 0, quantity: 0 }) // 1059.202
})

test('2b. SHORT 2x + SHORT 4x (the averaging that lost 25 USDC)', async () => {
  const id = newAccount()
  await trade(id, 'B2', 'SHORT', 3, 2, 100) // 150
  await trade(id, 'B2', 'SHORT', 3, 4, 100) // 75
  await check(id, 'B2', 100, 'after add', { cash: 1000 - 150.21 - 75.21, margin: 225, marginUsed: 225, quantity: 6 })
  await trade(id, 'B2', 'BUY', 6, 3, 100)
  await check(id, 'B2', 100, 'closed', { cash: 999.16, margin: null, marginUsed: 0, quantity: 0 }) // was 974.16
})

test('3. additions at different prices: weighted cost, exact P&L of both fills', async () => {
  const id = newAccount()
  await trade(id, 'C', 'LONG', 3, 3, 100) // N 300, margin 100
  await trade(id, 'C', 'LONG', 2, 2, 150) // N 300, margin 150
  near(position(id, 'C').avgCost, 120, 'average cost')
  await check(id, 'C', 120, 'after add', { cash: 749.58, margin: 250, marginUsed: 250, quantity: 5 })
  await trade(id, 'C', 'SELL', 5, 3, 130) // fill 1 +90, fill 2 -40 -> +50; fee 0.455
  await check(id, 'C', 130, 'closed', { cash: 749.58 + 250 + 50 - 0.455, margin: null, marginUsed: 0, quantity: 0 }) // 1049.125
})

for (const fraction of [0.25, 0.5, 1]) {
  test(`4. close ${fraction * 100}% then the rest: margin released in proportion`, async () => {
    const id = newAccount()
    await trade(id, 'D', 'LONG', 3, 3, 100)
    await trade(id, 'D', 'LONG', 3, 2, 100)
    const first = 6 * fraction
    await trade(id, 'D', 'SELL', first, 3, 110) // pnl 10 per coin
    const left = 6 - first
    await check(id, 'D', 110, `after ${fraction * 100}%`, {
      cash: 749.58 + 250 * fraction + 10 * first - 0.0007 * 110 * first,
      margin: left === 0 ? null : 250 * (1 - fraction),
      marginUsed: 250 * (1 - fraction),
      quantity: left,
    })
    if (left > 0) await trade(id, 'D', 'SELL', left, 3, 110)
    await check(id, 'D', 110, 'all closed', { cash: 749.58 + 250 + 60 - 0.462, margin: null, marginUsed: 0, quantity: 0 }) // 1059.118
  })
}

test('5. same leverage on every addition: identical to the original formula', async () => {
  const id = newAccount()
  await trade(id, 'E', 'LONG', 3, 3, 100)
  await trade(id, 'E', 'LONG', 3, 3, 110)
  near(position(id, 'E').margin, (3 * 100 + 3 * 110) / 3, 'margin = quantity * avgCost / leverage')
  assert.equal(position(id, 'E').leverage, 3)
  await trade(id, 'E', 'SELL', 6, 3, 105)
  // pnl 15 - 15 = 0; fees 0.21 + 0.231 + 0.441
  await check(id, 'E', 105, 'closed', { cash: 1000 - 0.21 - 0.231 - 0.441, margin: null, marginUsed: 0, quantity: 0 })
})

test('6. single 1x LONG / SHORT, and a 1x position increased at 2x (no longer overwritten)', async () => {
  let id = newAccount()
  await trade(id, 'F', 'LONG', 3, 1, 100)
  await check(id, 'F', 100, '1x long', { cash: 699.79, margin: 300, marginUsed: 0, quantity: 3 })
  await trade(id, 'F', 'SELL', 3, 1, 110)
  await check(id, 'F', 110, '1x long closed', { cash: 1000 - 0.21 + 30 - 0.231, margin: null, marginUsed: 0, quantity: 0 }) // 1029.559
  id = newAccount()
  await trade(id, 'G', 'SHORT', 3, 1, 100)
  await trade(id, 'G', 'BUY', 3, 1, 90)
  await check(id, 'G', 90, '1x short closed', { cash: 1000 - 0.21 + 30 - 0.189, margin: null, marginUsed: 0, quantity: 0 }) // 1029.601

  id = newAccount()
  await trade(id, 'H', 'LONG', 3, 1, 100) // margin 300, not in marginUsed
  await trade(id, 'H', 'LONG', 3, 2, 100) // margin 150 -> 450, position now above 1x
  const p = position(id, 'H')
  assert.deepEqual([p.quantity, p.availableQuantity, p.leverage], [6, 6, 2]) // was quantity 3: 300 USDC lost
  await check(id, 'H', 100, '1x + 2x', { cash: 549.58, margin: 450, marginUsed: 450, quantity: 6 })
  await trade(id, 'H', 'SELL', 6, 2, 100)
  await check(id, 'H', 100, '1x + 2x closed', { cash: 999.16, margin: null, marginUsed: 0, quantity: 0 })

  id = newAccount()
  await trade(id, 'I', 'LONG', 3, 1, 100)
  await trade(id, 'I', 'LONG', 3, 1, 100)
  await check(id, 'I', 100, '1x + 1x', { cash: 399.58, margin: 600, marginUsed: 0, quantity: 6 })
  assert.equal(position(id, 'I').leverage, 1)
  await trade(id, 'I', 'SELL', 6, 1, 100)
  await check(id, 'I', 100, '1x + 1x closed', { cash: 999.16, margin: null, marginUsed: 0, quantity: 0 })
})

test('7. several symbols: marginUsed is the sum of the recorded margins', async () => {
  const id = newAccount()
  await trade(id, 'J', 'LONG', 3, 3, 100)
  await trade(id, 'J', 'LONG', 3, 2, 100) // 250
  await trade(id, 'K', 'SHORT', 2, 5, 100) // 40
  await trade(id, 'L', 'LONG', 1, 1, 100) // 100, not in marginUsed
  near(account(id).marginUsed, 290, 'marginUsed')
  cachePrice('J', 'CRYPTO', 100); cachePrice('K', 'CRYPTO', 100); cachePrice('L', 'CRYPTO', 100)
  const e = await calcAccountEquity(account(id))
  near(e.postedMargin, 390, 'posted margin')
  near(e.equity, 1000 - 0.0007 * (300 + 300 + 200 + 100), 'equity = capital - fees')
  await trade(id, 'J', 'SELL', 6, 3, 100); await trade(id, 'K', 'BUY', 2, 5, 100); await trade(id, 'L', 'SELL', 1, 1, 100)
  near(account(id).currentCash, 1000 - 0.0007 * 2 * 900, 'all closed flat: only fees')
  near(account(id).marginUsed, 0, 'marginUsed')
})

test('8-9. interest on the real borrowed part, charged once; fees once; equity consistent', async () => {
  const id = newAccount()
  await trade(id, 'M', 'LONG', 3, 3, 100) // borrowed 200
  const back = (h: number) =>
    rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ?').run(utcNow(new Date(Date.now() - h * 3_600_000)), id)
  back(10)
  await trade(id, 'M', 'LONG', 3, 2, 100) // settles 200 * 0.0000125 * 10 = 0.025 on the first fill
  near(fills(id)[1]!.interestCharged, 0.025, 'interest settled at the addition', 1e-6)
  back(10)
  await trade(id, 'M', 'SELL', 6, 3, 100) // borrowed 600 - 250 = 350 -> 0.04375
  near(fills(id)[2]!.interestCharged, 0.04375, 'interest at close on the borrowed part', 1e-6)
  const { costs } = await check(id, 'M', 100, 'closed', { cash: 1000 - 0.84 - 0.025 - 0.04375, margin: null, marginUsed: 0, quantity: 0 })
  near(costs, 0.84 + 0.06875, 'fees and interest, each once')
  assert.equal(fills(id).length, 3)
})

test('10. the monitor still liquidates a mixed position, and marginUsed never goes negative', async () => {
  const id = newAccount()
  await trade(id, 'N', 'LONG', 12, 3, 100) // N 1200, margin 400, fee 0.84
  await trade(id, 'N', 'LONG', 9, 2, 100) // N 900, margin 450, fee 0.63 -> posted 850
  near(account(id).marginUsed, 850, 'marginUsed')
  // equity 998.53 + 21 (P - 100) < 0.5 * 850 -> P < 72.69 (the old engine rebuilt 1050: P < 63.17)
  cachePrice('N', 'CRYPTO', 72.7)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'N').quantity, 21)
  cachePrice('N', 'CRYPTO', 72.6)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'N').quantity, 0)
  near(account(id).marginUsed, 0, 'marginUsed after liquidation')
  near(account(id).currentCash, 998.53 + 21 * (72.6 - 100) - 0.0007 * 21 * 72.6, 'cash after liquidation (422.06)', 1e-6)
})

test('11. older row with a reconstructable margin (single leverage): closes exactly', async () => {
  const id = newAccount()
  await trade(id, 'O', 'SHORT', 3, 3, 100)
  rawDb.prepare('UPDATE positions SET margin = NULL WHERE account_id = ?').run(id) // as written before 006G-4
  await trade(id, 'O', 'BUY', 3, 3, 90) // rebuilt 300 / 3 = 100 = what was posted
  await check(id, 'O', 90, 'closed', { cash: 1000 - 0.21 + 30 - 0.189, margin: null, marginUsed: 0, quantity: 0 })
})

test('12. older row built from mixed leverages without a recorded margin: not reconstructable, close refused (006G-6A)', async () => {
  const id = newAccount()
  await trade(id, 'P', 'LONG', 3, 3, 100)
  await trade(id, 'P', 'LONG', 3, 2, 100)
  // as the old engine left it: no margin, leverage truncated to 2
  rawDb.prepare('UPDATE positions SET margin = NULL, leverage = 2 WHERE account_id = ?').run(id)
  const a = account(id)
  const rebuilt = (position(id, 'P').quantity * position(id, 'P').avgCost) / position(id, 'P').leverage
  near(rebuilt, 300, 'rebuilt from the row')
  near(a.marginUsed, 250, 'actually posted (marginUsed)')
  // accountRisk and the Hyperliquid adapter refuse this account (see their tests);
  // the engine refuses the close too: the old formula would release 300 and
  // end at 1049.16 instead of 999.16 (50 USDC created)
  const cash = a.currentCash
  await assert.rejects(trade(id, 'P', 'SELL', 6, 2, 100), /margin not recorded for P .* not reconcilable/)
  near(account(id).currentCash, cash, 'cash untouched')
  near(position(id, 'P').quantity, 6, 'position untouched')
})

test('13. spot rows are not touched: no margin recorded, manual buy and sell unchanged', async () => {
  const id = newAccount()
  cachePrice('Q', 'CRYPTO', 100)
  assert.equal(await checkAndExecuteOrder(await createOrder({ account: account(id), symbol: 'Q', name: 'Q', side: 'BUY', orderType: 'MARKET', price: null, quantity: 2 })), true)
  assert.equal(position(id, 'Q').margin, null)
  cachePrice('Q', 'CRYPTO', 110)
  assert.equal(await checkAndExecuteOrder(await createOrder({ account: account(id), symbol: 'Q', name: 'Q', side: 'SELL', orderType: 'MARKET', price: null, quantity: 2 })), true)
  near(account(id).currentCash, 1019.58, 'spot round trip')
})
