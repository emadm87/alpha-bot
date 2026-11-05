/**
 * Task 009D, function 3: C1 exits (stop at 2 ATR, trailing exit at 3 ATR) on
 * the original engine of ac66d28, run from the margin monitor tick.
 *
 * Run: npx tsx --test src/services/c1Exits.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, synthetic 1 h
 * candles with a known ATR, fake AI endpoint (as shortOneX.test.ts), no network.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
let decision: Record<string, unknown> = {}
globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, c1Exits, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { getPortfolioData } = await import('./aiDecision.js')
const { TaskScheduler } = await import('./scheduler.js')
const C = await import('./c1Exits.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const H = 3_600_000
let seq = 0
function newAccount(ai = false): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db.insert(accounts).values({
    userId: user.id, name: `c1-${++seq}`, accountType: 'AI', isActive: ai ? 'true' : 'false',
    apiKey: ai ? 'fake-key-for-test' : 'default', model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
const closeTrades = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all().filter((t) => t.side === 'SELL' || t.side === 'BUY')
const plan = (id: number, symbol: string) => db.select().from(c1Exits).where(and(eq(c1Exits.accountId, id), eq(c1Exits.symbol, symbol))).get()!
async function engine(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
/** Closed 1 h bars before now with a constant true range of 2 x half: ATR(14) = 2 x half. */
function candles(coin: string, price: number, half: number, n = 150) {
  const last = Math.floor(Date.now() / H) * H - H
  return Array.from({ length: n }, (_, k) => {
    const t = last - (n - 1 - k) * H
    return { t, T: t + H - 1, s: coin, i: '1h', o: String(price), c: String(price), h: String(price + half), l: String(price - half), v: '1', n: 1 }
  })
}
let marks: Record<string, number | Error> = {}
let candleRows: Record<string, unknown[] | Error> = {}
let clock = Date.now()
const deps: import('./c1Exits.js').C1Deps = {
  fetchCandles: async (coin) => { const r = candleRows[coin]; if (!r || r instanceof Error) throw r ?? new Error('no candles'); return r },
  price: async (s) => { const m = marks[s]; if (m === undefined || m instanceof Error) throw m ?? new Error('no price'); cachePrice(s, 'CRYPTO', m); return m },
  now: () => clock,
}
const pass = (aiRunning = false) => C.runC1Pass(() => aiRunning, deps)
const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)

beforeEach(() => {
  rawDb.exec("DELETE FROM c1_exits; DELETE FROM ai_decision_logs; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; UPDATE accounts SET is_active='false'")
  C.resetC1State()
  marks = {}
  candleRows = { BTC: candles('BTC', 80000, 200), ETH: candles('ETH', 2400, 10) }
  clock = Date.now()
})

test('1. LONG: plan from the 1 h bars before the opening (ATR 400 -> stop 79200, trailing 1200); trailing exit after a rise; one full close at the original fee; books as the estimate', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.01, 4, 80000)
  marks.BTC = 80000
  await pass()
  const p0 = plan(id, 'BTC')
  assert.deepEqual([p0.status, p0.atr, p0.stopPrice, p0.trailDistance, p0.exitLevel], ['active', 400, 79200, 1200, 79200])
  marks.BTC = 81000; await pass()
  near(plan(id, 'BTC').exitLevel!, 79800, 'trailing level = best 81000 - 1200')
  marks.BTC = 79900; await pass()
  assert.equal(position(id, 'BTC')!.quantity, 0.01, 'above the level: kept')
  marks.BTC = 79800
  cachePrice('BTC', 'CRYPTO', 79800)
  const estimate = (await getPortfolioData(account(id))).positions.BTC!.estimated_net_pnl_if_closed_now!
  const s = await pass()
  assert.deepEqual([s.closed, position(id, 'BTC')!.quantity], [1, 0])
  const r = plan(id, 'BTC')
  assert.equal(r.status, 'closed')
  assert.match(r.closeReason!, /^C1 trailing exit at 3 ATR from the best price 81000: price 79800 <= exit level 79800/)
  assert.deepEqual([r.closePrice, r.closeQuantity], [79800, 0.01])
  const [t] = closeTrades(id)
  assert.deepEqual([t!.side, t!.price, t!.quantity], ['SELL', 79800, 0.01])
  near(t!.commission, 79800 * 0.01 * 0.0007, 'original 0.07% fee')
  near(account(id).currentCash - 1000, estimate, 'cash booked = estimated net (P&L - fees - interest)', 1e-3)
  near(account(id).marginUsed, 0, 'margin released')
})

test('2. SHORT: the stop at 2 ATR (entry 2400, ATR 20 -> 2440); a price that improves moves the trailing level down; one full close', async () => {
  const id = newAccount()
  await engine(id, 'ETH', 'SHORT', 0.1, 2, 2400)
  marks.ETH = 2400; await pass()
  assert.deepEqual([plan(id, 'ETH').stopPrice, plan(id, 'ETH').exitLevel], [2440, 2440])
  marks.ETH = 2439; await pass()
  assert.equal(position(id, 'ETH')!.quantity, 0.1)
  marks.ETH = 2441; await pass()
  assert.equal(position(id, 'ETH')!.quantity, 0)
  assert.match(plan(id, 'ETH').closeReason!, /^C1 stop at 2 ATR: price 2441 >= exit level 2440/)
  assert.equal(closeTrades(id)[0]!.side, 'BUY')
  // trailing for a short: best 2300 -> level min(2440, 2360) = 2360
  const id2 = newAccount()
  await engine(id2, 'ETH', 'SHORT', 0.1, 2, 2400)
  marks.ETH = 2300; await pass()
  near(plan(id2, 'ETH').exitLevel!, 2360, 'short trailing level')
})

test('3. missing price or ATR: nothing invented, nothing closed; levels set once the ATR becomes available (retry at most once a minute)', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.01, 4, 80000)
  candleRows.BTC = new Error('timeout')
  marks.BTC = 70000
  await pass()
  let r = plan(id, 'BTC')
  assert.deepEqual([r.status, r.stopPrice, r.exitLevel], ['waiting_atr', null, null])
  assert.match(r.lastError!, /ATR not available: candles request failed/)
  candleRows.BTC = candles('BTC', 80000, 200, 10) // too few bars
  clock += 61_000; await pass()
  assert.match(plan(id, 'BTC').lastError!, /not enough closed 1 h bars/)
  candleRows.BTC = candles('BTC', 80000, 200)
  clock += 30_000; await pass()
  assert.equal(plan(id, 'BTC').status, 'waiting_atr', 'retry waits a minute')
  clock += 31_000
  marks.BTC = new Error('price feed down')
  await pass()
  r = plan(id, 'BTC')
  assert.equal(r.status, 'active')
  assert.match(r.lastError!, /price unavailable, not checked/)
  assert.equal(position(id, 'BTC')!.quantity, 0.01, 'no price: no close')
  assert.equal(closeTrades(id).length, 0)
})

test('4. no double close: deferred while an AI cycle runs, then closed once; two passes at the same time close once; later passes do nothing', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.01, 4, 80000)
  marks.BTC = 80000; await pass()
  marks.BTC = 79000
  const d = await pass(true)
  assert.deepEqual([d.deferred, d.closed, position(id, 'BTC')!.quantity], [1, 0, 0.01])
  assert.match(plan(id, 'BTC').lastError!, /^deferred while an AI cycle runs: C1 stop/)
  const [a, b] = await Promise.all([pass(), pass()])
  assert.equal(a.closed + b.closed, 1)
  await pass(); await pass()
  assert.equal(closeTrades(id).length, 1)
  assert.equal(plan(id, 'BTC').status, 'closed')
})

test('5. Gemini keeps HOLD and CLOSE: a Gemini close is not repeated by C1 (plan marked closed elsewhere); a Gemini close after a C1 close is refused, no extra fill', async () => {
  const id = newAccount(true)
  for (const [c, p] of Object.entries({ BTC: 80000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p)
  decision = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'open' }
  await placeAIDrivenCryptoOrder()
  marks.BTC = 80000; await pass()
  decision = { operation: 'hold', reason: 'keep' }
  cachePrice('BTC', 'CRYPTO', 80500)
  await placeAIDrivenCryptoOrder()
  assert.ok(position(id, 'BTC')!.quantity > 0, 'HOLD keeps the position')
  decision = { operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, reason: 'take profit' }
  cachePrice('BTC', 'CRYPTO', 80500)
  await placeAIDrivenCryptoOrder()
  assert.equal(position(id, 'BTC')!.quantity, 0)
  marks.BTC = 70000; await pass()
  assert.equal(closeTrades(id).length, 1, 'C1 did not close again')
  assert.equal(plan(id, 'BTC').status, 'closed_elsewhere')
  // C1 first, then Gemini asks to close the same position
  decision = { operation: 'open', symbol: 'ETH', direction: 'short', target_portion_of_balance: 0.3, leverage: 2, reason: 'open eth' }
  for (const [c, p] of Object.entries({ BTC: 80000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p)
  await placeAIDrivenCryptoOrder()
  marks.ETH = 2400; await pass()
  marks.ETH = 2450; await pass()
  assert.equal(position(id, 'ETH')!.quantity, 0, 'C1 stop')
  const before = closeTrades(id).length
  decision = { operation: 'close', symbol: 'ETH', direction: 'short', target_portion_of_balance: 1, reason: 'late close' }
  for (const [c, p] of Object.entries({ BTC: 80000, ETH: 2450, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p)
  await placeAIDrivenCryptoOrder()
  assert.equal(closeTrades(id).length, before)
  const log = rawDb.prepare("SELECT executed FROM ai_decision_logs WHERE account_id=? AND operation='close' ORDER BY id DESC LIMIT 1").get(id) as { executed: string }
  assert.equal(log.executed, 'false', 'the late Gemini close was refused by the original checks')
})

test('6. the monitor tick runs C1 after the original margin check (single connection), with the same job', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.01, 4, 80000)
  const saved = { ...C.c1Deps }
  Object.assign(C.c1Deps, deps)
  const sched = new TaskScheduler()
  try {
    sched.addMarginMonitorTask(3600)
    const job = sched.getJob('margin_monitor')!
    assert.equal(job.intervalSeconds, 3600)
    marks.BTC = 80000
    await job.fn()
    assert.equal(plan(id, 'BTC').status, 'active', 'C1 ran from the monitor job')
    marks.BTC = 79000
    cachePrice('BTC', 'CRYPTO', 79000)
    await job.fn()
    assert.equal(position(id, 'BTC')!.quantity, 0)
  } finally {
    sched.shutdown?.()
    Object.assign(C.c1Deps, saved)
  }
})
