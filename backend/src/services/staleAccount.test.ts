/**
 * Stale account rows given to the perpetual engine (Task 006H-1).
 *
 * placeAndExecuteCrypto used to start from the caller's account.currentCash
 * and account.marginUsed and write them back. The AI path reads the account
 * at the start of the cycle, before the AI call; the margin monitor can
 * liquidate in between, and the AI fill then overwrote the liquidation's cash
 * and margin. These tests hand the engine account rows read before another
 * fill and check that no update is lost.
 *
 * Run: npx tsx --test src/services/staleAccount.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, fake AI
 * endpoint, no network. Every account is also reconciled by the pilot's own
 * report (pilot/report.mjs), which replays the fills from the database.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-account-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
let decision: Record<string, unknown> = {}
/** Runs while the fake AI is "thinking", i.e. after the cycle read the account. */
let duringAICall: (() => Promise<void>) | null = null
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) {
    if (duringAICall) await duringAICall()
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, orders, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { TaskScheduler } = await import('./scheduler.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as {
  buildReport: (o: Record<string, unknown>) => { reconciliation: { ok: boolean }; issues: string[] }
}

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const FEE = 0.0007
const PRICES: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }

let seq = 0
function newAccount(ai = false): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  // the monitor scans every account: leave only this one's positions open
  rawDb.prepare('UPDATE positions SET quantity = 0, available_quantity = 0').run()
  return db.insert(accounts).values({
    userId: user.id, name: `stale-${++seq}`, accountType: 'AI', isActive: ai ? 'true' : 'false',
    apiKey: ai ? 'fake-key-for-test' : 'default', model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
const accountTrades = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const cacheAll = (prices: Record<string, number>) => {
  for (const [s, p] of Object.entries(prices)) cachePrice(s, 'CRYPTO', p)
}

function near(actual: number, expected: number, what: string, eps = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}

/**
 * Cash and margin agree with the fills: replayed by the pilot report, and
 * marginUsed equal to the margin of the open positions above 1x.
 */
function assertReconciled(id: number, prices: Record<string, number>, what: string) {
  const report = buildReport({ dbFile, accountId: id, prices })
  assert.deepEqual(report.issues, [], `${what}: report issues`)
  assert.equal(report.reconciliation.ok, true, `${what}: reconciliation`)
  const open = db.select().from(positions).where(eq(positions.accountId, id)).all()
    .filter((p) => p.quantity > 0 && p.leverage > 1)
  near(account(id).marginUsed, open.reduce((s, p) => s + (p.margin ?? 0), 0), `${what}: marginUsed vs positions`)
  assert.ok(account(id).currentCash >= 0, `${what}: cash not negative`)
}

async function engine(
  acc: ReturnType<typeof account>, symbol: string, side: string, quantity: number, leverage: number,
  price: number, orderNo?: string,
) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
    account: acc, symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage, orderNo,
  })
}

test('1. AI path: liquidation between the cycle reading the account and the AI fill', async () => {
  const id = newAccount(true)
  cacheAll(PRICES)
  // SOL LONG 10x 90 @100: margin 900, fee 6.3 -> cash 93.7, marginUsed 900
  await engine(account(id), 'SOL', 'LONG', 90, 10, 100)
  near(account(id).currentCash, 93.7, 'cash after SOL open')
  assertReconciled(id, PRICES, 'before')

  // While the AI answers, SOL falls to 93 and the real monitor liquidates it:
  // equity 993.7 - 630 = 363.7 < 0.5 * 900
  let cashAfterLiquidation = NaN
  duringAICall = async () => {
    duringAICall = null
    cacheAll({ ...PRICES, SOL: 93 })
    await (new TaskScheduler() as any).checkMarginLevels()
    assert.equal(position(id, 'SOL')!.quantity, 0, 'SOL liquidated during the AI call')
    near(account(id).marginUsed, 0, 'marginUsed after liquidation')
    cashAfterLiquidation = account(id).currentCash // ~357.841
  }
  decision = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'test' }
  await placeAIDrivenCryptoOrder()

  // Sizing still uses the cash the AI was shown (93.7), as in the original:
  // 46.85 / 80000 -> 0.000586 BTC, notional 46.88, margin 23.44, fee 0.032816
  const btc = position(id, 'BTC')!
  assert.deepEqual([btc.quantity, btc.side, btc.leverage], [0.000586, 'LONG', 2])
  near(cashAfterLiquidation, 93.7 + 900 - 630 - FEE * 8370, 'cash after liquidation', 1e-4)
  near(account(id).currentCash, cashAfterLiquidation - 23.44 - 0.032816, 'cash keeps the liquidation')
  near(account(id).marginUsed, 23.44, 'marginUsed is only the BTC margin')
  const logs = db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, id)).all()
  assert.deepEqual(logs.map((l) => [l.operation, l.executed]), [['open', 'true']])
  assertReconciled(id, { ...PRICES, SOL: 93 }, 'after')
})

test('2. two opens from the same account row read before either', async () => {
  const id = newAccount()
  const stale = account(id)
  await engine(stale, 'ETH', 'LONG', 0.1, 2, 2400) // margin 120, fee 0.168
  await engine(stale, 'SOL', 'SHORT', 2, 4, 100) // margin 50, fee 0.14
  near(account(id).currentCash, 1000 - 120.168 - 50.14, 'both opens charged') // 829.692
  near(account(id).marginUsed, 170, 'both margins tracked')
  assertReconciled(id, PRICES, 'after two opens')
})

test('3. stale row with more cash than is left: refused, nothing changes', async () => {
  const id = newAccount()
  const stale = account(id) // cash 1000
  await engine(account(id), 'ETH', 'LONG', 0.375, 1, 2400) // margin 900, fee 0.63
  const before = { account: account(id), trades: accountTrades(id).length, orders: db.select().from(orders).where(eq(orders.accountId, id)).all().length }
  // needs 500 + 0.35, the stale row says 1000, the account has 99.37
  await assert.rejects(engine(stale, 'BTC', 'LONG', 0.0125, 2, 80000), /Insufficient cash/)
  assert.deepEqual(
    { account: account(id), trades: accountTrades(id).length, orders: db.select().from(orders).where(eq(orders.accountId, id)).all().length },
    before,
  )
  assert.equal(position(id, 'BTC'), undefined, 'no BTC row')
  near(account(id).currentCash, 99.37, 'cash')
  near(account(id).marginUsed, 0, 'no artificial margin')
  assertReconciled(id, PRICES, 'after refusal')
})

test('4. close from a stale row keeps an open made in between', async () => {
  const id = newAccount()
  await engine(account(id), 'SOL', 'LONG', 2, 2, 100) // margin 100, fee 0.14
  const stale = account(id) // cash 899.86, marginUsed 100
  await engine(account(id), 'ETH', 'SHORT', 0.1, 3, 2400) // margin 80, fee 0.168
  await engine(stale, 'SOL', 'SELL', 2, 2, 110) // +100 margin +20 pnl -0.154 fee
  near(account(id).currentCash, 899.86 - 80.168 + 120 - 0.154, 'cash') // 939.538
  near(account(id).marginUsed, 80, 'only the ETH margin remains')
  assertReconciled(id, { ...PRICES, SOL: 110 }, 'after stale close')
})

test('5. liquidation fill from a row read before an AI fill (LIQ- order)', async () => {
  const id = newAccount()
  await engine(account(id), 'SOL', 'SHORT', 4, 5, 100) // margin 80, fee 0.28
  const readByMonitor = account(id) // cash 919.72, marginUsed 80
  await engine(account(id), 'ETH', 'LONG', 0.1, 2, 2400) // AI fill in between: margin 120, fee 0.168
  await engine(readByMonitor, 'SOL', 'BUY', 4, 5, 120, 'LIQ-TEST000000000001') // +80 -80 pnl -0.336 fee
  near(account(id).currentCash, 919.72 - 120.168 - 0.336, 'cash keeps the AI fill') // 799.216
  near(account(id).marginUsed, 120, 'marginUsed is only the ETH margin')
  assertReconciled(id, { ...PRICES, SOL: 120 }, 'after liquidation fill')
})

test('6. no regression: LONG and SHORT open/close from fresh rows', async () => {
  const id = newAccount()
  await engine(account(id), 'BNB', 'LONG', 1, 3, 740) // margin 246.6667, fee 0.518
  await engine(account(id), 'BNB', 'SELL', 1, 3, 777) // +37 pnl, fee 0.5439
  near(account(id).currentCash, 1000 - 0.518 + 37 - 0.5439, 'LONG 3x round trip') // 1035.9381
  await engine(account(id), 'XRP', 'SHORT', 100, 1, 1.3) // margin 130, fee 0.091
  await engine(account(id), 'XRP', 'BUY', 100, 1, 1.2) // +10 pnl, fee 0.084
  near(account(id).currentCash, 1035.9381 - 0.091 + 10 - 0.084, 'SHORT 1x round trip') // 1045.7631
  near(account(id).marginUsed, 0, 'marginUsed')
  assertReconciled(id, PRICES, 'after round trips')
})
