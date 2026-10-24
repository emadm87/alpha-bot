/**
 * Deterministic tests for the account risk snapshot (accountRisk.ts).
 *
 * Run: npx tsx --test src/services/accountRisk.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, a fake
 * ccxt exchange counting requests, no network, no AI. Expected values are
 * worked out by hand from the engine's rules:
 *   open : cash -= q*p/L + 0.0007*q*p      margin = q*entry/L
 *   close: cash += margin released + pnl - 0.0007*q*p - interest
 *   equity = cash + sum(margin) + sum(uPnL); monitor liquidates when
 *   equity / marginUsed < 0.5
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
console.error = () => {}

const provider = { tickersCalls: 0, tickerCalls: 0, candleCalls: 0 }
;(ccxt as any).hyperliquid = class {
  async fetchTicker(symbol: string) {
    provider.tickerCalls++
    return { symbol, last: undefined } // no price: the symbol is "missing"
  }
  async fetchTickers(symbols: string[]) {
    provider.tickersCalls++
    return Object.fromEntries(symbols.map((s) => [s, { symbol: s, last: 50, info: { markPx: '50.5' } }]))
  }
  async publicPostInfo() {
    provider.candleCalls++
    return []
  }
}

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, trades, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { cachePrice, priceCache } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity } = await import('./assetCalculator.js')
const { getAccountRiskSnapshot, safeAccountRiskSnapshot } = await import('./accountRisk.js')
const { TaskScheduler } = await import('./scheduler.js')
const { getLastPrice } = await import('./marketData.js')
const { utcNow } = await import('../utils/datetime.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
beforeEach(() => {
  ;(priceCache as any).cache.clear()
  provider.tickersCalls = 0
  provider.tickerCalls = 0
  provider.candleCalls = 0
})

let seq = 0
function newAccount(capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `risk-${++seq}`, accountType: 'AI', apiKey: 'test-placeholder',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!

async function trade(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({
    account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage,
  })
}

function near(actual: number | null | undefined, expected: number, what: string, eps = 1e-6) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}

const snap = (id: number, opts?: { maxPriceAgeSeconds?: number }) => getAccountRiskSnapshot(id, opts)
const pos = (s: Awaited<ReturnType<typeof snap>>, symbol: string) => s.positions.find((p) => p.symbol === symbol)!
const monitor = () => (new TaskScheduler() as any).checkMarginLevels() as Promise<void>
const openQty = (id: number, symbol: string) =>
  db.select().from(positions).where(eq(positions.accountId, id)).all().find((p) => p.symbol === symbol)?.quantity ?? 0

// BTC LONG 0.006 @ 80,000, 3x: notional 480, margin 160, fee 0.336, cash 839.664
async function btcLong(id: number) {
  await trade(id, 'BTC', 'LONG', 0.006, 3, 80000)
}

test('1. empty 1,000 USDC account', async () => {
  const s = await snap(newAccount())
  assert.equal(s.openPositions, 0)
  assert.deepEqual(s.booked, { initialCapital: 1000, cash: 1000, marginUsed: 0, feesPaid: 0, interestCharged: 0, realizedPnl: 0 })
  assert.equal(s.estimated.equity, 1000)
  assert.equal(s.estimated.returnUsdc, 0)
  assert.equal(s.estimated.returnPct, 0)
  assert.equal(s.estimated.notionalExposure, 0)
  assert.equal(s.estimated.equityToMarginRatio, null, 'no margin: ratio undefined, not 0')
  assert.equal(s.monitor.marginLevel, null)
  assert.equal(s.monitor.wouldLiquidate, false)
  assert.equal(s.prices.status, 'ok')
  assert.equal(s.reliable, true)
})

test('2. BTC LONG 3x at entry price', async () => {
  const id = newAccount()
  await btcLong(id)
  const s = await snap(id)
  near(s.booked.cash, 839.664, 'cash')
  near(s.booked.marginUsed, 160, 'marginUsed')
  near(s.booked.feesPaid, 0.336, 'fees')
  near(s.booked.realizedPnl, 0, 'realized')
  near(s.estimated.equity, 999.664, 'equity')
  near(s.estimated.unrealizedPnl, 0, 'uPnL')
  near(s.estimated.notionalExposure, 480, 'exposure')
  near(s.estimated.returnUsdc, -0.336, 'return')
  near(s.estimated.returnPct, -0.0336, 'return %')
  near(s.estimated.equityToMarginRatio, 999.664 / 160, 'ratio')
  near(s.monitor.bufferUsdc, 999.664 - 80, 'buffer')
  const p = pos(s, 'BTC')
  assert.equal(p.side, 'LONG')
  assert.equal(p.leverage, 3)
  near(p.margin, 160, 'margin')
  near(p.notional, 480, 'notional')
  near(p.feesPaid, 0.336, 'position fees')
  near(p.interestCharged, 0, 'interest charged')
  assert.equal(p.priceStatus, 'ok')
  assert.ok(p.openedAt && p.durationMinutes !== null && p.durationMinutes < 1)
  // 80,000 - 919.664 / 0.006 < 0: cross margin, a fall to 0 does not trigger it
  assert.equal(p.liquidation.price, null)
  assert.match(p.liquidation.note, /not reachable/)
  assert.equal(p.liquidation.conditional, false)
  assert.equal(s.reliable, true)
})

test('3-5. SHORT 5x: profit when the price falls, loss when it rises', async () => {
  const id = newAccount()
  // 2 @ 2,000, 5x: notional 4,000, margin 800, fee 2.8, cash 197.2
  await trade(id, 'XSH', 'SHORT', 2, 5, 2000)
  cachePrice('XSH', 'CRYPTO', 1900)
  let s = await snap(id)
  let p = pos(s, 'XSH')
  near(p.unrealizedPnl, 200, 'short profit')
  near(p.unrealizedPnlPctOfMargin, 25, 'profit % of margin')
  near(s.estimated.equity, 197.2 + 800 + 200, 'equity in profit')
  cachePrice('XSH', 'CRYPTO', 2100)
  s = await snap(id)
  p = pos(s, 'XSH')
  near(p.unrealizedPnl, -200, 'short loss')
  near(p.unrealizedPnlPctOfMargin, -25, 'loss % of margin')
  near(s.estimated.equity, 797.2, 'equity in loss')
  // buffer 797.2 - 400 = 397.2 -> liquidation at 2,100 + 397.2 / 2 = 2,298.6 (same as from 2,000)
  near(p.liquidation.price, 2298.6, 'short liquidation price', 1e-6)
  // and a LONG in profit / loss
  const id2 = newAccount()
  await btcLong(id2)
  cachePrice('BTC', 'CRYPTO', 84000)
  near(pos(await snap(id2), 'BTC').unrealizedPnl, 24, 'long profit')
  cachePrice('BTC', 'CRYPTO', 76000)
  const l = pos(await snap(id2), 'BTC')
  near(l.unrealizedPnl, -24, 'long loss')
  near(l.unrealizedPnlPctOfMargin, -15, 'long loss % of margin')
})

test('6-7. partial then full close: realized P&L, fees and margin', async () => {
  const id = newAccount()
  await btcLong(id)
  await trade(id, 'BTC', 'SELL', 0.003, 3, 84000) // pnl 12, release 80, fee 0.1764
  let s = await snap(id)
  near(s.booked.cash, 839.664 + 12 + 80 - 0.1764, 'cash after partial', 1e-4)
  near(s.booked.marginUsed, 80, 'marginUsed after partial')
  near(s.booked.realizedPnl, 12, 'realized after partial', 1e-4)
  const p = pos(s, 'BTC')
  near(p.quantity, 0.003, 'remaining')
  near(p.margin, 80, 'remaining margin')
  near(p.unrealizedPnl, 12, 'uPnL of the rest at 84,000')
  near(p.feesPaid, 0.336 + 0.1764, 'fees since open', 1e-9)
  near(s.estimated.equity, 931.4876 + 80 + 12, 'equity', 1e-4)

  await trade(id, 'BTC', 'SELL', 0.003, 3, 84000)
  s = await snap(id)
  assert.equal(s.openPositions, 0)
  near(s.booked.marginUsed, 0, 'no margin left')
  near(s.booked.realizedPnl, 24, 'realized after full close', 1e-4)
  near(s.booked.feesPaid, 0.336 + 2 * 0.1764, 'all fees', 1e-9)
  near(s.estimated.equity, 1000 + 24 - 0.6888, 'equity = capital + realized - fees', 1e-4)
  near(s.estimated.returnUsdc, 24 - 0.6888, 'return', 1e-4)
})

test('8. accrued interest is shown apart and booked at close', async () => {
  const id = newAccount()
  await btcLong(id)
  rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ?')
    .run(utcNow(new Date(Date.now() - 10 * 3_600_000)), id)
  let s = await snap(id)
  const accrued = 0.006 * 80000 * (2 / 3) * 0.0000125 * 10 // 0.04
  near(pos(s, 'BTC').interestAccrued, accrued, 'accrued', 1e-7)
  near(s.accrued.interest, accrued, 'account accrued', 1e-7)
  near(s.booked.interestCharged, 0, 'nothing booked yet')
  near(s.estimated.equity, 999.664, 'equity excludes accrued interest (as the monitor)')
  near(s.estimated.returnAfterAccruedUsdc, -0.336 - accrued, 'return after accrued', 1e-7)

  await trade(id, 'BTC', 'SELL', 0.006, 3, 80000)
  s = await snap(id)
  near(s.booked.interestCharged, accrued, 'booked at close', 1e-7)
  near(s.accrued.interest, 0, 'nothing accrued once closed')
  near(s.booked.realizedPnl, 0, 'realized P&L excludes interest and fees', 1e-6)
  near(s.estimated.equity, 1000 - 0.336 * 2 - accrued, 'equity', 1e-6)
})

test('9. two positions share the margin: conditional liquidation prices match the real monitor', async () => {
  const id = newAccount()
  await btcLong(id)
  // + 0.5 @ 2,000 SHORT 5x: margin 200, fee 0.7 -> cash 638.964, marginUsed 360
  await trade(id, 'XSH2', 'SHORT', 0.5, 5, 2000)
  const s = await snap(id)
  near(s.booked.marginUsed, 360, 'shared marginUsed')
  near(s.estimated.equity, 638.964 + 360, 'equity')
  near(s.monitor.bufferUsdc, 998.964 - 180, 'buffer')
  const sh = pos(s, 'XSH2')
  near(sh.liquidation.price, 2000 + 818.964 / 0.5, 'conditional short liquidation') // 3,637.928
  assert.equal(sh.liquidation.conditional, true)
  assert.match(sh.liquidation.note, /other positions/)
  assert.equal(pos(s, 'BTC').liquidation.price, null)

  // The real monitor agrees: just below no liquidation, just above both close
  cachePrice('BTC', 'CRYPTO', 80000)
  cachePrice('XSH2', 'CRYPTO', 3637.9)
  assert.equal((await snap(id)).monitor.wouldLiquidate, false)
  await monitor()
  assert.equal(openQty(id, 'XSH2'), 0.5)
  cachePrice('XSH2', 'CRYPTO', 3638)
  assert.equal((await snap(id)).monitor.wouldLiquidate, true)
  await monitor()
  assert.equal(openQty(id, 'XSH2'), 0)
  assert.equal(openQty(id, 'BTC'), 0)
})

test('10. missing or stale price: unknown values stay null, nothing reliable', async () => {
  const id = newAccount()
  await btcLong(id)
  await trade(id, 'NOPX', 'LONG', 1, 2, 10) // margin 5, fee 0.007
  for (const key of [...(priceCache as any).cache.keys()]) if (String(key).startsWith('NOPX')) (priceCache as any).cache.delete(key)
  cachePrice('BTC', 'CRYPTO', 80000)
  let s = await snap(id)
  const p = pos(s, 'NOPX')
  assert.equal(p.price, null)
  assert.equal(p.priceStatus, 'missing')
  assert.equal(p.unrealizedPnl, null)
  assert.equal(p.notional, null)
  near(p.margin, 5, 'margin still known')
  assert.equal(s.estimated.equity, null)
  assert.equal(s.estimated.unrealizedPnl, null)
  assert.equal(s.estimated.returnPct, null)
  assert.equal(s.prices.status, 'missing')
  assert.equal(s.reliable, false)
  assert.equal(pos(s, 'BTC').liquidation.price, null)
  assert.match(pos(s, 'BTC').liquidation.note, /price is missing/)
  // the monitor's own view: margin counted, unpriced P&L taken as 0
  near(s.monitor.equity, (await calcAccountEquity(account(id))).equity, 'monitor equity')

  // stale: a 20 s old price with a 10 s limit
  const id2 = newAccount()
  await btcLong(id2)
  for (const entry of (priceCache as any).cache.values()) entry.timestamp -= 20
  s = await snap(id2, { maxPriceAgeSeconds: 10 })
  assert.equal(pos(s, 'BTC').priceStatus, 'stale')
  assert.equal(s.prices.status, 'stale')
  assert.ok(s.prices.oldestAgeSeconds! >= 20)
  assert.equal(s.reliable, false)
  assert.ok(s.issues.some((i) => i.includes('stale')))
})

test('11. equity near the threshold and below zero', async () => {
  const id = newAccount()
  await trade(id, 'XNEAR', 'SHORT', 2, 5, 2000) // liquidation at 2,298.6
  cachePrice('XNEAR', 'CRYPTO', 2298.5)
  let s = await snap(id)
  near(s.monitor.marginLevel, (197.2 + 800 - 597) / 800, 'margin level just above 0.5')
  assert.equal(s.monitor.wouldLiquidate, false)
  near(s.monitor.bufferUsdc, 0.2, 'buffer 0.20 USDC', 1e-6)
  cachePrice('XNEAR', 'CRYPTO', 2600) // uPnL -1,200 -> equity -202.8
  s = await snap(id)
  near(s.estimated.equity, -202.8, 'negative equity')
  near(s.estimated.returnPct, -120.28, 'return %')
  assert.equal(s.monitor.wouldLiquidate, true)
  assert.equal(pos(s, 'XNEAR').liquidation.price, 2600)
  assert.match(pos(s, 'XNEAR').liquidation.note, /already below/)
  assert.ok(s.issues.includes('equity is zero or negative'))
  assert.equal(s.reliable, false)
})

test('12-13. consistent with calcAccountEquity, no margin or notional counted twice', async () => {
  const id = newAccount(5000)
  await trade(id, 'BTC', 'LONG', 0.01, 3, 80000)
  await trade(id, 'XS3', 'SHORT', 3, 4, 100)
  await trade(id, 'XSPOT', 'LONG', 2, 1, 50) // 1x: full notional posted, not in marginUsed
  cachePrice('BTC', 'CRYPTO', 81000)
  cachePrice('XS3', 'CRYPTO', 95)
  cachePrice('XSPOT', 'CRYPTO', 55)
  const s = await snap(id)
  const e = await calcAccountEquity(account(id))
  near(s.estimated.equity, e.equity, 'equity')
  near(s.estimated.unrealizedPnl, e.unrealizedPnl, 'uPnL')
  near(s.estimated.postedMargin, e.postedMargin, 'posted margin')
  near(s.estimated.notionalExposure, e.exposure, 'exposure')
  const margins = s.positions.reduce((t, p) => t + p.margin, 0)
  const pnls = s.positions.reduce((t, p) => t + p.unrealizedPnl!, 0)
  near(s.estimated.equity, s.booked.cash + margins + pnls, 'equity = cash + margins + uPnL')
  near(margins, 0.01 * 80000 / 3 + 300 / 4 + 100, 'margins by hand')
  near(pnls, 10 + 15 + 10, 'uPnL by hand')
  near(s.estimated.notionalExposure, 810 + 285 + 110, 'exposure by hand')
  assert.ok(s.estimated.equity! < s.booked.cash + s.estimated.notionalExposure!, 'exposure not added')
  near(s.booked.marginUsed, 0.01 * 80000 / 3 + 75, 'marginUsed excludes 1x')
  assert.equal(pos(s, 'XSPOT').liquidatable, false)
  assert.match(pos(s, 'XSPOT').liquidation.note, /1x/)
  assert.deepEqual(s.issues, [])
})

test('adding at another leverage: the recorded margin matches marginUsed (006G-4)', async () => {
  const id = newAccount()
  await trade(id, 'XMIX', 'LONG', 3, 3, 80) // margin 80
  await trade(id, 'XMIX', 'LONG', 3, 2, 80) // margin 120 -> 200 posted
  const s = await snap(id)
  near(s.booked.marginUsed, 200, 'booked marginUsed')
  near(pos(s, 'XMIX').margin, 200, 'recorded margin')
  assert.equal(pos(s, 'XMIX').leverage, 3) // effective 480 / 200 = 2.4, rounded up
  assert.deepEqual(s.issues, [])
  assert.equal(s.reliable, true)
})

test('older row without a recorded margin and an inconsistent marginUsed is flagged', async () => {
  const id = newAccount()
  await trade(id, 'XOLD', 'LONG', 3, 3, 80)
  await trade(id, 'XOLD', 'LONG', 3, 2, 80)
  // as written before 006G-4: no margin, leverage truncated to 2
  rawDb.prepare('UPDATE positions SET margin = NULL, leverage = 2 WHERE account_id = ?').run(id)
  const s = await snap(id)
  near(pos(s, 'XOLD').margin, 240, 'rebuilt as quantity * avgCost / leverage')
  assert.ok(s.issues.some((i) => i.startsWith('account marginUsed 200 differs')))
  assert.ok(s.issues.some((i) => i.startsWith('margin not recorded for XOLD')))
  assert.equal(s.reliable, false)
})

test('14. snapshots write nothing and do not change orders or decisions', async () => {
  const run = async (withSnapshots: boolean) => {
    const id = newAccount()
    const steps: [string, string, number, number, number][] = [
      ['BTC', 'LONG', 0.006, 3, 80000], ['XS4', 'SHORT', 1, 2, 300], ['BTC', 'SELL', 0.002, 3, 82000], ['XS4', 'BUY', 1, 2, 290],
    ]
    for (const step of steps) {
      if (withSnapshots) await snap(id)
      await trade(id, ...step)
      if (withSnapshots) await snap(id)
    }
    // Rounded to 6 decimals: interest accrues per millisecond of wall clock
    const r6 = (v: unknown) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) =>
        !['id', 'accountId', 'orderId', 'orderNo', 'orderTime', 'tradeTime', 'createdAt', 'updatedAt', 'updateTime', 'lastInterestTime'].includes(k))
        .map(([k, v]) => [k, r6(v)])))
    const a = account(id)
    return {
      cash: r6(a.currentCash), marginUsed: r6(a.marginUsed),
      orders: strip(db.select().from(orders).where(eq(orders.accountId, id)).all()),
      trades: strip(db.select().from(trades).where(eq(trades.accountId, id)).all()),
      positions: strip(db.select().from(positions).where(eq(positions.accountId, id)).all()),
    }
  }
  const plain = await run(false)
  const observed = await run(true)
  assert.deepEqual(observed, plain)

  const id = newAccount()
  await btcLong(id)
  const count = (t: string) => (rawDb.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n
  const before = ['accounts', 'orders', 'trades', 'positions'].map(count)
  const accountBefore = account(id)
  await snap(id)
  await safeAccountRiskSnapshot(id)
  assert.deepEqual(['accounts', 'orders', 'trades', 'positions'].map(count), before)
  assert.deepEqual(account(id), accountBefore)
  assert.deepEqual(await safeAccountRiskSnapshot(999999), { accountId: 999999, error: 'Error: Account 999999 not found' })
})

test('15. no extra request: cached prices cost nothing, original paths unchanged', async () => {
  const id = newAccount()
  await btcLong(id)
  await snap(id)
  assert.deepEqual([provider.tickersCalls, provider.tickerCalls, provider.candleCalls], [0, 0, 0])

  // Original paths with the module loaded: same single ticker call, no candles
  ;(priceCache as any).cache.clear()
  for (const s of ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP']) await getLastPrice(s, 'CRYPTO')
  assert.equal(provider.tickersCalls, 1)
  // A snapshot right after reuses the cached price, and the mark price kept
  // from that same response is shown for information only
  const s = await snap(id)
  assert.equal(provider.tickersCalls, 1)
  assert.equal(provider.candleCalls, 0)
  assert.equal(pos(s, 'BTC').price, 50)
  assert.equal(pos(s, 'BTC').markPrice, 50.5)
  near(pos(s, 'BTC').unrealizedPnl, 0.006 * (50 - 80000), 'P&L on the last price, not the mark')
})
