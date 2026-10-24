/**
 * Tests for hyperliquidCrossAdapter.ts (Task 006G-3).
 *
 * Run: npx tsx --test src/services/hyperliquidCrossAdapter.test.ts
 *
 * Rows come from the real engine (placeAndExecuteCrypto) and orderMatching
 * on a throwaway SQLite file, prices are injected in the price cache, the
 * network is disabled. Margin tables are the official meta sample of
 * 2026-10-24 (006G-1). Expected values reproduce the 006G-2 comparison:
 * "close" values are the existing engine closing the positions at the
 * Hyperliquid threshold price (an ordinary close, not Hyperliquid's
 * liquidation procedure).
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-adapter-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}
console.warn = () => {}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, positions, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto, calculatePositionInterest } = await import('./orderExecutorLeverage.js')
const { createOrder, checkAndExecuteOrder } = await import('./orderMatching.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { getAccountRiskSnapshot } = await import('./accountRisk.js')
const { TaskScheduler } = await import('./scheduler.js')
const { liquidationPrice } = await import('./hyperliquidMargin.js')
const { marksFromAssetContexts, parseMetaResponse } = await import('./hyperliquidMarginData.js')
const { crossInputFromAccount } = await import('./hyperliquidCrossAdapter.js')
const { utcNow } = await import('../utils/datetime.js')

const META = {
  universe: [
    { name: 'BTC', maxLeverage: 40, marginTableId: 56 },
    { name: 'ETH', maxLeverage: 25, marginTableId: 55 },
    { name: 'SOL', maxLeverage: 20, marginTableId: 54 },
    { name: 'BNB', maxLeverage: 10, marginTableId: 51 },
  ],
  marginTables: [
    [51, { description: 'tiered 10x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 10 }, { lowerBound: '3000000.0', maxLeverage: 5 }] }],
    [54, { description: 'tiered 20x (2)', marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '70000000.0', maxLeverage: 10 }] }],
    [55, { description: 'tiered 25x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 25 }, { lowerBound: '100000000.0', maxLeverage: 15 }] }],
    [56, { description: 'tiered 40x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 40 }, { lowerBound: '150000000.0', maxLeverage: 20 }] }],
  ],
}
const NOW = Date.UTC(2026, 9, 24, 12, 0, 0)
const TABLES = parseMetaResponse(META, NOW - 60_000) as Exclude<ReturnType<typeof parseMetaResponse>, { error: string }>
assert.ok(!('error' in TABLES))

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

let seq = 0
function newAccount(capital = 1000) {
  // retire earlier scenarios so the monitor only sees this account
  rawDb.prepare('UPDATE positions SET quantity = 0, available_quantity = 0').run()
  return db.insert(accounts).values({
    userId: user.id, name: `xa-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const rows = (id: number) => db.select().from(positions).where(eq(positions.accountId, id)).all()
async function open(id: number, coin: string, side: string, N: number, L: number) {
  cachePrice(coin, 'CRYPTO', 100)
  await placeAndExecuteCrypto({ account: account(id), symbol: coin, name: coin, side, orderType: 'MARKET', price: null, quantity: N / 100, leverage: L })
}
async function spotBuy(id: number, coin: string, q: number) {
  cachePrice(coin, 'CRYPTO', 100)
  assert.equal(await checkAndExecuteOrder(await createOrder({ account: account(id), symbol: coin, name: coin, side: 'BUY', orderType: 'MARKET', price: null, quantity: q })), true)
}
/** Mark quotes as kept by the price path (006E), received ageMs before NOW. */
const quotes = (marks: Record<string, number | null>, ageMs = 1000) =>
  marksFromAssetContexts(Object.keys(marks), (coin) => ({
    info: { name: coin, markPx: marks[coin] === null ? null : String(marks[coin]) },
    receivedAt: NOW - ageMs,
  }))
function adapt(id: number, marks: Record<string, number | null>, extra: Partial<Parameters<typeof crossInputFromAccount>[0]> = {}) {
  return crossInputFromAccount({ account: account(id), positions: rows(id), marks: quotes(marks), tables: TABLES, now: NOW, ...extra })
}
function ready(r: ReturnType<typeof crossInputFromAccount>) {
  assert.equal(r.status, 'ready', JSON.stringify(r))
  return r as Extract<typeof r, { status: 'ready' }>
}
function near(actual: number | null | undefined, expected: number, what: string, eps = 0.005) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** The existing engine closes every perpetual at the given prices. */
async function closeAll(id: number, prices: Record<string, number>) {
  for (const [c, p] of Object.entries(prices)) cachePrice(c, 'CRYPTO', p)
  for (const p of rows(id).filter((r) => r.quantity > 0 && r.side)) {
    await placeAndExecuteCrypto({ account: account(id), symbol: p.symbol, name: p.symbol, side: p.side === 'LONG' ? 'SELL' : 'BUY', orderType: 'MARKET', price: null, quantity: p.quantity, leverage: p.leverage })
  }
  return account(id).currentCash
}

test('1. spot only: excluded from collateral and from liquidation, with a note', async () => {
  const id = newAccount()
  await spotBuy(id, 'SOL', 5) // cash 499.5
  const r = ready(adapt(id, {}))
  assert.deepEqual(r.spotExcluded, [{ symbol: 'SOL', quantity: 5, avgCost: 100 }])
  assert.deepEqual(r.input.positions, [])
  near(r.collateral.total, 499.5, 'collateral is the cash only')
  assert.equal(r.state.liquidatable, false)
  assert.ok(r.notes.some((n) => n.startsWith('spot holdings excluded from collateral (SOL)')))
})

test('2-3. 1x perpetuals: LONG never liquidated, SHORT at +98.46% (close 23.18, -97.68%)', async () => {
  let id = newAccount()
  await open(id, 'BTC', 'LONG', 990, 1)
  let r = ready(adapt(id, { BTC: 100 }))
  near(r.collateral.perpMargin, 990, '1x margin = notional')
  near(r.collateral.total, 999.307, 'collateral = 1000 - fee')
  assert.equal(liquidationPrice(r.input, 'BTC').price, null)

  id = newAccount()
  await open(id, 'BTC', 'SHORT', 990, 1)
  r = ready(adapt(id, { BTC: 100 }))
  const lp = liquidationPrice(r.input, 'BTC').price!
  near(lp, 198.46, 'SHORT 1x threshold')
  near(await closeAll(id, { BTC: lp }), 23.18, 'engine close at the threshold')
})

const LEVERED: [string, 'LONG' | 'SHORT', number, number, number, number][] = [
  // coin, side, leverage, notional, threshold, engine close (006G-2)
  ['BTC', 'LONG', 2, 1000, 0.07, 0.01], ['BTC', 'SHORT', 2, 1000, 197.46, 23.30],
  ['BTC', 'LONG', 3, 1500, 33.83, 5.99], ['BTC', 'SHORT', 3, 1500, 164.54, 29.12],
  ['BTC', 'LONG', 5, 2500, 60.83, 17.94], ['BTC', 'SHORT', 5, 2500, 138.20, 40.77],
  ['BTC', 'LONG', 5, 4950, 80.88, 47.24], ['BTC', 'SHORT', 5, 4950, 118.65, 69.30],
  ['ETH', 'LONG', 5, 4950, 81.50, 77.86], ['ETH', 'SHORT', 5, 4950, 117.78, 112.52],
  ['SOL', 'LONG', 5, 4950, 81.92, 98.53], ['SOL', 'SHORT', 5, 4950, 117.20, 140.98],
  ['BNB', 'LONG', 5, 4950, 84.07, 205.16], ['BNB', 'SHORT', 5, 4950, 114.41, 279.20],
]
for (const [coin, side, L, N, threshold, close] of LEVERED) {
  test(`4/6. ${coin} ${side} ${L}x N=${N}: collateral reconciles with calcAccountEquity, threshold ${threshold}, close ${close}`, async (t) => {
    const id = newAccount()
    await open(id, coin, side, N, L)
    const r = ready(adapt(id, { [coin]: 100 }))
    near(r.collateral.perpMargin, N / L, 'margin booked at open')
    near(r.collateral.total, 1000 - 0.0007 * N, 'cash + margin = capital - opening fee')
    cachePrice(coin, 'CRYPTO', 100)
    near(r.state.accountValue, (await calcAccountEquity(account(id))).equity, 'account value = original equity (no spot)', 1e-9)
    const lp = liquidationPrice(r.input, coin).price!
    near(lp, threshold, 'Hyperliquid threshold')
    const final = await closeAll(id, { [coin]: lp })
    near(final, close, 'engine close at the threshold')
    t.diagnostic(`final ${final.toFixed(2)}: P&L ${(final - 1000).toFixed(2)} USDC (${((final - 1000) / 10).toFixed(2)}%)`)
  })
}

test('5. same notional at different leverage: same collateral and threshold', async () => {
  const values = []
  for (const L of [2, 3, 5]) {
    const id = newAccount()
    await open(id, 'BTC', 'SHORT', 1500, L)
    const r = ready(adapt(id, { BTC: 100 }))
    values.push([r.collateral.total, liquidationPrice(r.input, 'BTC').price!])
  }
  for (const [collateral, lp] of values) {
    near(collateral, 998.95, 'collateral')
    near(lp, 164.54, 'threshold')
  }
})

test('7. several perpetuals: BTC LONG 3x + ETH SHORT 2x, ETH threshold 236.25, close 55.95', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'LONG', 1500, 3)
  await open(id, 'ETH', 'SHORT', 800, 2)
  const r = ready(adapt(id, { BTC: 110, ETH: 100 }))
  near(r.collateral.perpMargin, 500 + 400, 'both margins once')
  near(r.collateral.total, 1000 - 0.0007 * 2300, 'collateral')
  const lp = liquidationPrice(r.input, 'ETH')
  near(lp.price, 236.25, 'ETH threshold')
  assert.equal(lp.conditional, true)
  near(await closeAll(id, { BTC: 110, ETH: lp.price! }), 55.95, 'engine close of both')
})

test('8. mixed spot + perpetual: spot is not collateral; difference to the original equity is the spot value', async () => {
  const id = newAccount()
  await spotBuy(id, 'SOL', 3) // 300.3 out of cash
  await open(id, 'BTC', 'SHORT', 1500, 3) // margin 500, fee 1.05
  cachePrice('SOL', 'CRYPTO', 100)
  cachePrice('BTC', 'CRYPTO', 100)
  const r = ready(adapt(id, { BTC: 100 }))
  near(r.collateral.cash, 198.65, 'cash shared with the spot purchase')
  near(r.collateral.total, 698.65, 'collateral without spot')
  const original = (await calcAccountEquity(account(id))).equity
  near(original - r.state.accountValue!, 300, 'difference = spot value 3 x 100', 1e-9)
  near(liquidationPrice(r.input, 'BTC').price, 144.77, 'Hyperliquid threshold')
  const snap = await getAccountRiskSnapshot(id)
  near(snap.positions.find((p) => p.symbol === 'BTC')!.liquidation.price, 149.91, 'original rule (accountRisk)')
})

test('9. booked marginUsed that the rows do not rebuild: not evaluable', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'SHORT', 1500, 3)
  rawDb.prepare('UPDATE accounts SET margin_used = 123 WHERE id = ?').run(id)
  const r = adapt(id, { BTC: 100 })
  assert.equal(r.status, 'not_evaluable')
  if (r.status === 'not_evaluable') assert.match(r.anomalies[0]!, /^margin not reconstructable: rows give 500 above 1x, account marginUsed is 123/)
  assert.ok(!('input' in r))
})

test('10. fills at different leverages: exact collateral from the recorded margin; older rows and manual leveraged rows refused', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'LONG', 300, 3) // margin 100
  await open(id, 'BTC', 'LONG', 300, 2) // margin 150 -> 250 posted
  assert.equal(rows(id)[0]!.margin, 250)
  const r = ready(adapt(id, { BTC: 100 }))
  near(r.collateral.perpMargin, 250, 'posted margin')
  near(r.collateral.total, 1000 - 0.0007 * 600, 'collateral = capital - fees')
  cachePrice('BTC', 'CRYPTO', 100)
  near(r.state.accountValue, (await calcAccountEquity(account(id))).equity, 'account value = original equity', 1e-9)

  // the same row as written before 006G-4: no margin, leverage truncated to 2
  rawDb.prepare('UPDATE positions SET margin = NULL, leverage = 2 WHERE account_id = ?').run(id)
  const old = adapt(id, { BTC: 100 })
  assert.equal(old.status, 'not_evaluable')
  if (old.status === 'not_evaluable') assert.match(old.anomalies[0]!, /rows give 300 above 1x, account marginUsed is 250/)

  const m = newAccount()
  rawDb.prepare("INSERT INTO positions (version, account_id, symbol, name, market, quantity, available_quantity, avg_cost, leverage, side, accumulated_interest) VALUES ('v1', ?, 'BTC', 'BTC', 'CRYPTO', 3, 3, 100, 3, NULL, 0)").run(m)
  const manual = adapt(m, { BTC: 100 })
  assert.equal(manual.status, 'not_evaluable')
  if (manual.status === 'not_evaluable') assert.deepEqual(manual.anomalies, ['BTC: manual leveraged row (side null, leverage 3) cannot be classified'])
})

test('11. missing, invalid or stale mark price: not evaluable; the last price is not used', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'SHORT', 1500, 3)
  cachePrice('BTC', 'CRYPTO', 200) // a last price exists, but is not a mark price
  for (const [marks, age, reason] of [
    [{ BTC: null }, 1000, 'BTC: markPx missing or invalid'],
    [{ BTC: 0 }, 1000, 'BTC: markPx missing or invalid'],
    [{ BTC: 200 }, 90_000, 'BTC: mark price 90 s old'],
  ] as const) {
    const r = crossInputFromAccount({ account: account(id), positions: rows(id), marks: quotes(marks, age), tables: TABLES, now: NOW })
    assert.equal(r.status, 'not_evaluable')
    if (r.status === 'not_evaluable') {
      assert.ok(r.reasons.includes(reason), JSON.stringify(r.reasons))
      assert.deepEqual(r.anomalies, [])
    }
  }
  const none = crossInputFromAccount({ account: account(id), positions: rows(id), marks: {}, tables: TABLES, now: NOW })
  assert.equal(none.status, 'not_evaluable')
})

test('12. invalid or old margin tables: not evaluable', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'SHORT', 1500, 3)
  const old = parseMetaResponse(META, NOW - 25 * 3_600_000) as typeof TABLES
  const r = adapt(id, { BTC: 100 }, { tables: old })
  assert.equal(r.status, 'not_evaluable')
  if (r.status === 'not_evaluable') assert.ok(r.reasons.includes('margin tables 25 h old'))
  const broken = parseMetaResponse({ ...META, marginTables: [[56, { marginTiers: [{ lowerBound: '5', maxLeverage: 40 }] }]] }, NOW) as typeof TABLES
  assert.ok(broken.issues.includes('margin table 56 rejected: first tier does not start at 0'))
  const b = adapt(id, { BTC: 100 }, { tables: broken })
  assert.equal(b.status, 'not_evaluable')
  if (b.status === 'not_evaluable') assert.ok(b.reasons.includes('BTC unsupported'))
})

test('13. accrued interest and funding are reported as not included', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'LONG', 1500, 3)
  rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ?').run(utcNow(new Date(Date.now() - 10 * 3_600_000)), id)
  const pos = rows(id)[0]!
  const accrued = calculatePositionInterest(pos) // 1500 * 2/3 * 0.0000125 * 10 = 0.125
  near(accrued, 0.125, 'accrued interest', 1e-4)
  const r = ready(adapt(id, { BTC: 100 }, { accruedInterest: { BTC: accrued } }))
  near(r.collateral.total, 998.95, 'collateral unchanged by accrued interest')
  assert.ok(r.notes.some((n) => n.startsWith('accrued interest not included in collateral: 0.12')))
  assert.ok(r.notes.some((n) => n.startsWith('funding is not modelled')))
  const without = ready(adapt(id, { BTC: 100 }))
  assert.ok(without.notes.includes('accrued interest not provided: collateral excludes any interest still to be charged'))
})

test('14. gap beyond the threshold: negative value and backstop reported, balances untouched', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'SHORT', 1500, 3)
  const before = account(id)
  const r = ready(adapt(id, { BTC: 200 }))
  near(r.state.accountValue, -501.05, 'account value')
  assert.equal(r.state.liquidatable, true)
  assert.equal(r.state.belowBackstop, true)
  near(r.state.shortfall, 501.05, 'shortfall')
  assert.ok(r.notes.some((n) => n.startsWith('account value is negative')))
  assert.ok(r.notes.includes('below the backstop level (2/3 of maintenance): reported only, no backstop is executed'))
  assert.deepEqual(account(id), before, 'nothing written')
  near(await closeAll(id, { BTC: 200 }), -503.15, 'an engine close still leaves negative cash')
})

test('15. a position open under the original monitor that the new model would liquidate', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'SHORT', 990, 1)
  cachePrice('BTC', 'CRYPTO', 199)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(rows(id)[0]!.quantity, 9.9, 'original monitor leaves it open')
  const r = ready(adapt(id, { BTC: 199 }))
  assert.equal(r.state.liquidatable, true)
  assert.equal(r.state.belowBackstop, false)
})

test('the adapter is pure: inputs untouched, no database or network access needed', () => {
  const accountRow = Object.freeze({ currentCash: 500, marginUsed: 166.66666666666666 })
  const positionRows = Object.freeze([Object.freeze({ symbol: 'BTC', market: 'CRYPTO', quantity: 5, avgCost: 100, leverage: 3, side: 'SHORT', margin: 166.66666666666666 })])
  const marks = quotes({ BTC: 100 })
  const copy = structuredClone({ accountRow, positionRows, marks })
  const r = ready(crossInputFromAccount({ account: accountRow, positions: positionRows as any, marks, tables: TABLES, now: NOW }))
  near(r.collateral.total, 666.67, 'collateral', 0.01)
  assert.deepEqual({ accountRow, positionRows, marks }, copy)
})
