/**
 * Closing PERPETUAL SHORT positions at 1x (Task 006F-3) and the paths that
 * must stay unchanged: spot (orderMatching), LONG 1x, 3x, the margin monitor.
 *
 * Run: npx tsx --test src/services/shortOneX.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, fake AI
 * endpoint, no network. Fees: engine 0.07% of notional, orderMatching 0.1%
 * (min 0.1). Expected balances are worked out by hand.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'short1x-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
let decision: Record<string, unknown> = {}
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) {
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { createOrder, checkAndExecuteOrder } = await import('./orderMatching.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { TaskScheduler } = await import('./scheduler.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

let seq = 0
function newAccount(ai = false): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db.insert(accounts).values({
    userId: user.id, name: `s1x-${++seq}`, accountType: 'AI', isActive: ai ? 'true' : 'false',
    apiKey: ai ? 'fake-key-for-test' : 'default', model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
const tradeCount = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all().length

async function engine(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
    account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage,
  })
}
async function manual(id: number, symbol: string, side: string, quantity: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  const order = await createOrder({
    account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity,
  })
  assert.equal(await checkAndExecuteOrder(order), true, `manual ${side} filled`)
}
function near(actual: number, expected: number, what: string, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
function balance(id: number, cash: number, what: string) {
  near(account(id).currentCash, cash, `${what} cash`)
  near(account(id).marginUsed, 0, `${what} marginUsed`)
}

test('1. SHORT 1x 2 @100 closed with BUY @90: +20 profit', async () => {
  const id = newAccount()
  await engine(id, 'SA', 'SHORT', 2, 1, 100)
  balance(id, 1000 - 200 - 0.14, 'after open') // 799.86, marginUsed stays 0
  await engine(id, 'SA', 'BUY', 2, 1, 90)
  balance(id, 799.86 + 200 + 20 - 0.126, 'after close') // 1019.734 (+1.9734%)
  const p = position(id, 'SA')!
  assert.deepEqual([p.quantity, p.availableQuantity, p.side, p.leverage], [0, 0, null, 1])
})

test('2. SHORT 1x 2 @100 closed with BUY @110: -20 loss', async () => {
  const id = newAccount()
  await engine(id, 'SB', 'SHORT', 2, 1, 100)
  await engine(id, 'SB', 'BUY', 2, 1, 110)
  balance(id, 799.86 + 200 - 20 - 0.154, 'after close') // 979.706 (-2.0294%)
})

test('3. SHORT 1x partial then full close', async () => {
  const id = newAccount()
  await engine(id, 'SC', 'SHORT', 2, 1, 100)
  await engine(id, 'SC', 'BUY', 0.5, 1, 90) // pnl +5, margin back 50, fee 0.0315
  balance(id, 799.86 + 55 - 0.0315, 'after partial') // 854.8285
  let p = position(id, 'SC')!
  assert.deepEqual([p.quantity, p.availableQuantity, p.side, p.leverage], [1.5, 1.5, 'SHORT', 1])
  await engine(id, 'SC', 'BUY', 1.5, 1, 95) // pnl +7.5, margin back 150, fee 0.09975
  balance(id, 854.8285 + 157.5 - 0.09975, 'after full close') // 1012.22875
  p = position(id, 'SC')!
  assert.deepEqual([p.quantity, p.side], [0, null])
})

test('4. SELL on a SHORT 1x is rejected and changes nothing', async () => {
  const id = newAccount()
  await engine(id, 'SD', 'SHORT', 2, 1, 100)
  const before = { account: account(id), position: position(id, 'SD'), trades: tradeCount(id) }
  await assert.rejects(engine(id, 'SD', 'SELL', 2, 1, 90), /Cannot SELL to close a SHORT position/)
  assert.deepEqual({ account: account(id), position: position(id, 'SD'), trades: tradeCount(id) }, before)
})

test('5. AI path: open short without leverage, then close it (executed=true)', async () => {
  const id = newAccount(true)
  const prices = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }
  for (const [s, p] of Object.entries(prices)) cachePrice(s, 'CRYPTO', p)
  decision = { operation: 'open', symbol: 'SOL', direction: 'short', target_portion_of_balance: 0.1, reason: 'test' }
  await placeAIDrivenCryptoOrder()
  const opened = position(id, 'SOL')!
  assert.deepEqual([opened.quantity, opened.side, opened.leverage], [1, 'SHORT', 1]) // 100 USDC / 100
  for (const [s, p] of Object.entries({ ...prices, SOL: 90 })) cachePrice(s, 'CRYPTO', p)
  decision = { operation: 'close', symbol: 'SOL', direction: 'short', target_portion_of_balance: 1, reason: 'test' }
  await placeAIDrivenCryptoOrder()
  const logs = db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, id)).all()
  assert.deepEqual(logs.map((l) => [l.operation, l.executed]), [['open', 'true'], ['close', 'true']])
  balance(id, 1000 - 100 - 0.07 + 100 + 10 - 0.063, 'after AI close') // 1009.867
  assert.equal(position(id, 'SOL')!.quantity, 0)
})

test('6. S1 SPOT (orderMatching) unchanged', async () => {
  const id = newAccount()
  await manual(id, 'SP', 'BUY', 2, 100)
  balance(id, 1000 - 200 - 0.2, 'after spot BUY')
  await manual(id, 'SP', 'SELL', 2, 110)
  balance(id, 1019.58, 'after spot SELL')
  assert.equal(position(id, 'SP')!.side, null)
})

test('7. S2 PERP LONG 1x unchanged', async () => {
  const id = newAccount()
  await engine(id, 'L1', 'LONG', 2, 1, 100)
  await engine(id, 'L1', 'SELL', 2, 1, 110)
  balance(id, 1019.706, 'after close')
  const p = position(id, 'L1')!
  assert.deepEqual([p.quantity, p.side], [0, 'LONG']) // spot branch, as before
  await assert.rejects(engine(id, 'L1', 'BUY', 1, 1, 110), /No position to close/)
})

test('8. S4 LONG / SHORT 3x unchanged', async () => {
  let id = newAccount()
  await engine(id, 'L3', 'LONG', 2, 3, 100)
  near(account(id).marginUsed, 200 / 3, 'LONG 3x marginUsed')
  await engine(id, 'L3', 'SELL', 2, 3, 110)
  balance(id, 1019.706, 'LONG 3x closed')
  id = newAccount()
  await engine(id, 'S3', 'SHORT', 2, 3, 100)
  near(account(id).marginUsed, 200 / 3, 'SHORT 3x marginUsed')
  await engine(id, 'S3', 'BUY', 2, 3, 90)
  balance(id, 1019.734, 'SHORT 3x closed')
})

test('9. S5a SHORT 1x row written before the fix closes correctly', async () => {
  const id = newAccount()
  // Row and cash as the engine left them before the fix (open SHORT 2 @100 1x)
  rawDb.prepare('UPDATE accounts SET current_cash = 799.86 WHERE id = ?').run(id)
  rawDb.prepare(
    "INSERT INTO positions (version, account_id, symbol, name, market, quantity, available_quantity, avg_cost, leverage, side, accumulated_interest, last_interest_time) VALUES ('v1', ?, 'SE', 'SE', 'CRYPTO', 2, 2, 100, 1, 'SHORT', 0, '2026-10-01 00:00:00')",
  ).run(id)
  await engine(id, 'SE', 'BUY', 2, 1, 90)
  balance(id, 1019.734, 'after close')
  assert.equal(position(id, 'SE')!.quantity, 0)
})

test('10a. S5b historical row {q 0, side SHORT} + manual spot BUY, closed as a spot sale', async () => {
  const id = newAccount()
  rawDb.prepare(
    "INSERT INTO positions (version, account_id, symbol, name, market, quantity, available_quantity, avg_cost, leverage, side, accumulated_interest) VALUES ('v1', ?, 'ST', 'ST', 'CRYPTO', 0, 0, 100, 1, 'SHORT', 0)",
  ).run(id)
  await manual(id, 'ST', 'BUY', 1, 100) // spot holding of 1 coin, cash 899.9
  balance(id, 899.9, 'after spot BUY')
  // The AI closes what it sees as a long holding: SELL at 110
  cachePrice('ST', 'CRYPTO', 110)
  await engine(id, 'ST', 'SELL', 1, 1, 110)
  balance(id, 899.9 + 110 - 0.077, 'spot holding sold') // 1009.823
})

test('10b. S5b a manual SELL can no longer turn an open SHORT 1x into a stale row', async () => {
  const id = newAccount()
  await engine(id, 'SF', 'SHORT', 1, 1, 100) // AI-style SHORT 1x
  const before = { account: account(id), position: position(id, 'SF'), trades: tradeCount(id) }
  cachePrice('SF', 'CRYPTO', 100)
  await assert.rejects(
    createOrder({ account: account(id), symbol: 'SF', name: 'SF', side: 'SELL', orderType: 'MARKET', price: null, quantity: 1 }),
    /open SHORT perpetual position/,
  )
  assert.deepEqual({ account: account(id), position: position(id, 'SF'), trades: tradeCount(id) }, before)
  await engine(id, 'SF', 'BUY', 1, 1, 90)
  balance(id, 1000 - 0.07 + 10 - 0.063, 'closed by the AI') // 1009.867
})

test('11. S5c spot holding (side null) closed by the engine SELL', async () => {
  const id = newAccount()
  await manual(id, 'SG', 'BUY', 2, 100)
  await engine(id, 'SG', 'SELL', 2, 1, 110)
  balance(id, 799.8 + 220 - 0.154, 'after close') // 1019.646
})

test('12. margin monitor unchanged: SHORT 1x still not liquidated, SHORT 3x liquidated', async () => {
  const a1 = newAccount()
  await engine(a1, 'X1', 'SHORT', 9, 1, 100)
  const a3 = newAccount()
  await engine(a3, 'X3', 'SHORT', 9, 3, 100)
  cachePrice('X1', 'CRYPTO', 250)
  cachePrice('X3', 'CRYPTO', 250)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(a1, 'X1')!.quantity, 9)
  assert.equal(position(a3, 'X3')!.quantity, 0)
})
