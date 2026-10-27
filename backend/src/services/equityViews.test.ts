/**
 * One account value on every screen (Task 006H-3): /overview, the account
 * list, the WebSocket snapshot, the last point of both asset curves (REST and
 * WebSocket) and the pilot report all show calcAccountEquity; the curve's
 * history is the same equity rebuilt from the fills at each kline close.
 * Also: accumulatedInterest starts from 0 when a closed row is reopened.
 *
 * Run: npx tsx --test src/services/equityViews.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, klines served
 * by a stub of the Hyperliquid client, no network. Expected values are worked
 * out here from the fills: equity = capital + realized - fees - interest +
 * unrealized, unrealized LONG q * (p - entry), SHORT q * (entry - p).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'equity-views-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { getAllAssetCurvesDataNew } = await import('./assetCurveCalculator.js')
const { hyperliquidClient } = await import('./hyperliquid.js')
const { accountRoutes } = await import('../api/account.js')
const { manager, sendSnapshot } = await import('../api/ws.js')
const { taskScheduler } = await import('./scheduler.js')
const { utcNow } = await import('../utils/datetime.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as {
  buildReport: (o: Record<string, unknown>) => { capital: { final_equity: number }; reconciliation: { ok: boolean }; issues: string[] }
}

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  taskScheduler.shutdown()
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const FEE = 0.0007
const HOUR = 3600
/** 20 hourly kline timestamps (seconds), the last one the current hour. */
const T0 = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 19 * HOUR
const ts = (k: number) => T0 + k * HOUR

// --- kline stub ----------------------------------------------------------------
type K = { timestamp: number; datetime_str: string; open: number; high: number; low: number; close: number; volume: number; amount: number }
const klineCloses: Record<string, (k: number) => number> = {}
const missingKline: Record<string, number[]> = {}
;(hyperliquidClient as any).getKlineData = async (symbol: string): Promise<K[]> => {
  const close = klineCloses[symbol]
  if (!close) return []
  return Array.from({ length: 20 }, (_, k) => k)
    .filter((k) => !(missingKline[symbol] ?? []).includes(k))
    .map((k) => ({
      timestamp: ts(k), datetime_str: new Date(ts(k) * 1000).toISOString(),
      open: close(k), high: close(k), low: close(k), close: close(k), volume: 1, amount: 1,
    }))
}

// --- helpers -----------------------------------------------------------------------
let seq = 0
function newAccount(): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db.insert(accounts).values({
    userId: user.id, name: `eq-${++seq}`, accountType: 'AI', isActive: 'true',
    apiKey: 'fake-key', model: 'fake', baseUrl: 'http://fake-ai.test/v1',
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()!

/** Fill through the engine at `price`, dated just before kline k. */
async function fill(id: number, k: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  const order = await placeAndExecuteCrypto({
    account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage,
  })
  const at = utcNow(new Date((ts(k) - 60) * 1000))
  rawDb.prepare('UPDATE trades SET trade_time = ? WHERE order_id = ?').run(at, order.id)
}
function near(actual: unknown, expected: number, what: string, eps = 1e-6) {
  assert.equal(typeof actual, 'number', `${what}: not a number (${actual})`)
  assert.ok(Math.abs((actual as number) - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
async function json(pathname: string) {
  const res = await accountRoutes.request(pathname)
  assert.equal(res.status, 200, `${pathname} status`)
  return res.json() as Promise<any>
}
/** The snapshot the WebSocket sends to an open connection of this account. */
async function wsSnapshot(id: number) {
  const sent: any[] = []
  const ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } as any
  manager.register(id, ws)
  try {
    await sendSnapshot(id)
  } finally {
    manager.unregister(id, ws)
  }
  assert.equal(sent.length, 1, 'one snapshot sent')
  return sent[0]
}

// --- the scenario ------------------------------------------------------------------
// Entries, all opened before kline 10 and still open at the end:
//   SOL  LONG  1x  2    @100    (k 3)  live 110  -> +20
//   ETH  LONG  3x  0.1  @2400   (k 5)  live 2300 -> -10
//   BNB  SHORT 1x  0.5  @740    (k 7)  live 700  -> +20
//   XRP  SHORT 5x  100  @1.3    (k 9)  live 1.4  -> -10
// DOGE LONG 2x 1000 @0.08 (k 9), closed @0.09 (k 12, +10), reopened 2x @0.1 (k 14), live 0.095 -> -5
const ENTRY: Record<string, number> = { SOL: 100, ETH: 2400, BNB: 740, XRP: 1.3 }
const LIVE: Record<string, number> = { SOL: 110, ETH: 2300, BNB: 700, XRP: 1.4, DOGE: 0.095, BTC: 80000 }
const QTY: Record<string, number> = { SOL: 2, ETH: 0.1, BNB: 0.5, XRP: 100 }
const SIGN: Record<string, number> = { SOL: 1, ETH: 1, BNB: -1, XRP: -1 }
const MARGIN: Record<string, number> = { SOL: 200, ETH: 80, BNB: 370, XRP: 26 }
// kline closes move away from the entries, so each point has its own P&L
for (const s of Object.keys(ENTRY)) klineCloses[s] = (k) => ENTRY[s]! * (1 + 0.01 * (k - 8))
klineCloses.DOGE = (k) => 0.08 + 0.001 * k

const id = newAccount()
await fill(id, 3, 'SOL', 'LONG', 2, 1, 100)
await fill(id, 5, 'ETH', 'LONG', 0.1, 3, 2400)
await fill(id, 7, 'BNB', 'SHORT', 0.5, 1, 740)
await fill(id, 9, 'XRP', 'SHORT', 100, 5, 1.3)
await fill(id, 9, 'DOGE', 'LONG', 1000, 2, 0.08)
await fill(id, 12, 'DOGE', 'SELL', 1000, 2, 0.09)
await fill(id, 14, 'DOGE', 'LONG', 1000, 2, 0.1)
for (const [s, p] of Object.entries(LIVE)) cachePrice(s, 'CRYPTO', p)

const openFees = FEE * (200 + 240 + 370 + 130 + 80)
const dogeCloseFee = FEE * 90
const dogeReopenFee = FEE * 100
const interest = db.select().from(trades).where(eq(trades.accountId, id)).all().reduce((s, t) => s + t.interestCharged, 0)
const LIVE_EQUITY = 1000 + 20 - 10 + 20 - 10 + 10 - 5 - openFees - dogeCloseFee - dogeReopenFee - interest

test('1. live equity worked out from the fills', async () => {
  near((await calcAccountEquity(account(id))).equity, LIVE_EQUITY, 'calcAccountEquity')
  const report = buildReport({ dbFile, accountId: id, prices: LIVE })
  assert.deepEqual(report.issues, [], 'report issues')
  assert.equal(report.reconciliation.ok, true)
  near(report.capital.final_equity, LIVE_EQUITY, 'pilot report final equity', 1e-4)
})

test('2. same Total Assets on /overview, account list, WebSocket and both curves', async () => {
  near((await json('/overview')).portfolio.total_assets, LIVE_EQUITY, '/overview')
  near((await json(`/${id}/overview`)).total_assets, LIVE_EQUITY, `/${id}/overview`)
  const listed = (await json('/list')).find((a: any) => a.id === id)
  near(listed.total_assets, LIVE_EQUITY, '/list total_assets (account selector)')

  const snap = await wsSnapshot(id)
  near(snap.overview.total_assets, LIVE_EQUITY, 'WebSocket overview total_assets')
  const wsCurve = (snap.all_asset_curves as any[]).filter((p) => p.account_id === id)
  near(wsCurve.at(-1).total_assets, LIVE_EQUITY, 'WebSocket curve, last point')

  const restCurve = ((await json('/asset-curve/timeframe?timeframe=1h')) as any[]).filter((p) => p.username === `eq-${seq}`)
  assert.equal(restCurve.length, 20)
  near(restCurve.at(-1).total_assets, LIVE_EQUITY, 'REST curve, last point')
  near(restCurve.at(-1).cash, account(id).currentCash, 'REST curve, last cash')
})

/** Equity at kline k from the scenario, priced at the kline closes. */
function expectedAt(k: number) {
  let equity = 1000
  let margin = 0
  for (const [s, openedAt] of [['SOL', 3], ['ETH', 5], ['BNB', 7], ['XRP', 9]] as const) {
    if (k < openedAt) continue
    equity += SIGN[s]! * QTY[s]! * (klineCloses[s]!(k) - ENTRY[s]!) - FEE * QTY[s]! * ENTRY[s]!
    margin += MARGIN[s]!
  }
  if (k >= 9) equity -= FEE * 80
  if (k >= 9 && k < 12) { equity += 1000 * (klineCloses.DOGE!(k) - 0.08); margin += 40 }
  if (k >= 12) equity += 10 - dogeCloseFee
  if (k >= 14) { equity += 1000 * (klineCloses.DOGE!(k) - 0.1) - dogeReopenFee; margin += 50 }
  return { equity, margin }
}

test('3. curve history: equity rebuilt from the fills at every kline close (LONG/SHORT, 1x and leveraged)', async () => {
  const curve = (await getAllAssetCurvesDataNew('1h')).filter((p) => p.account_id === id)
  assert.equal(curve.length, 20)
  for (let k = 0; k < 19; k++) {
    const { equity, margin } = expectedAt(k)
    near(curve[k]!.total_assets, equity, `point ${k} total_assets`, 1e-6)
    const unrealized = curve[k]!.positions_value - margin
    near(curve[k]!.cash, equity - margin - unrealized, `point ${k} cash`, 1e-6)
    near(curve[k]!.profit, equity - 1000, `point ${k} profit`, 1e-6)
  }
  near(curve[0]!.total_assets, 1000, 'before any fill')
  // point 10: margin 200 + 80 + 370 + 26 + 40 posted, cash 1000 - margins - fees
  near(curve[10]!.cash, 1000 - 716 - openFees, 'point 10 cash')
})

test('4. a missing kline is flagged, never replaced by another price', async () => {
  missingKline.ETH = [10]
  try {
    const curve = (await getAllAssetCurvesDataNew('1h')).filter((p) => p.account_id === id)
    const p10 = curve.find((p) => p.timestamp === ts(10))!
    assert.deepEqual(p10.missing_prices, ['ETH'])
    // ETH keeps its margin, without unrealized P&L
    const eth = 0.1 * (klineCloses.ETH!(10) - 2400)
    near(p10.total_assets, expectedAt(10).equity - eth, 'point 10 without ETH P&L')
    assert.equal(curve.find((p) => p.timestamp === ts(11))!.missing_prices, undefined)
  } finally {
    delete missingKline.ETH
  }
})

test('5. accumulatedInterest restarts from 0 when a closed row is reopened', async () => {
  const id2 = newAccount()
  const back = (hours: number) =>
    rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ? AND symbol = ?')
      .run(utcNow(new Date(Date.now() - hours * 3_600_000)), id2, 'BTC')
  cachePrice('BTC', 'CRYPTO', 80000)
  const open = () => placeAndExecuteCrypto({ account: account(id2), symbol: 'BTC', name: 'BTC', side: 'LONG', orderType: 'MARKET', price: null, quantity: 0.005, leverage: 4 })
  const close = () => placeAndExecuteCrypto({ account: account(id2), symbol: 'BTC', name: 'BTC', side: 'SELL', orderType: 'MARKET', price: null, quantity: 0.005, leverage: 4 })
  // borrowed 400 * 3/4 = 300; 300 * 0.0000125 * 10 h = 0.0375
  await open(); back(10); await close()
  const first = position(id2, 'BTC').accumulatedInterest
  near(first, 0.0375, 'first position interest', 1e-6)
  await open()
  assert.equal(position(id2, 'BTC').accumulatedInterest, 0, 'reopened row starts from 0')
  back(5); await close() // 300 * 0.0000125 * 5 h = 0.01875
  near(position(id2, 'BTC').accumulatedInterest, 0.01875, 'second position interest only', 1e-6)
  const charged = db.select().from(trades).where(eq(trades.accountId, id2)).all().map((t) => t.interestCharged)
  assert.equal(charged.length, 4)
  near(charged[1]!, 0.0375, 'first close charged', 1e-6)
  near(charged[3]!, 0.01875, 'second close charged', 1e-6)
  near(account(id2).currentCash, 1000 - 4 * FEE * 400 - 0.0375 - 0.01875, 'cash', 1e-6)
  const report = buildReport({ dbFile, accountId: id2, prices: LIVE })
  assert.equal(report.reconciliation.ok, true)
})
