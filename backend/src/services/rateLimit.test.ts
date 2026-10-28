/**
 * Hyperliquid request volume and the cross-margin monitor under HTTP 429
 * (Task 006J-2).
 *
 * Run: npx tsx --test src/services/rateLimit.test.ts
 *
 * A real ccxt hyperliquid instance is used, with only its transport
 * (publicPostInfo) replaced by a stub that counts every request and its
 * official weight (l2Book 2, the other info requests used here 20) and can
 * answer like the 006J-1 pilot did: RateLimitExceeded "429 Too Many
 * Requests". So the counts below are ccxt's own requests, not a fake
 * fetchTickers. The clock is mocked; no network, no timer.
 */
import { test, after, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

let clock = Date.parse('2026-10-28T20:00:30Z')
mock.method(Date, 'now', () => clock)
const advance = (ms: number) => { clock += ms }

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, liquidationEvents, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { hyperliquidClient, getAssetContext, MAINSTREAM_CRYPTOS } = await import('./hyperliquid.js')
const { getLastPrice, refreshStats, resetPriceRefreshState, RATE_LIMIT_BACKOFF_MS } = await import('./marketData.js')
const { priceCache, getCachedPrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler, hyperliquidMonitorStats } = await import('./scheduler.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { defaultFundingDeps, captureFundingOracle } = await import('./fundingSettlement.js')

const META = JSON.parse(fs.readFileSync(new URL('./__fixtures__/hyperliquid-meta.json', import.meta.url), 'utf8'))
const WEIGHT: Record<string, number> = { l2Book: 2 }
const DEXES = [null, ...['xyz', 'flx', 'vntl', 'hyna', 'km', 'abcd', 'cash', 'para', 'mkts', 'io'].map((name) => ({ name }))]

/** What the stub answers and what it saw. */
const hl = {
  mid: {} as Record<string, number>,
  mark: {} as Record<string, number>,
  oracle: {} as Record<string, number>,
  limited: false,
  calls: [] as string[],
}
const requests = (type?: string) => hl.calls.filter((c) => !type || c === type).length
const weight = () => hl.calls.reduce((s, c) => s + (WEIGHT[c] ?? 20), 0)
const MARKET: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, DOGE: 0.08, BNB: 740, XRP: 1.3 }

function ctx(coin: string) {
  const mid = hl.mid[coin] ?? 1
  const mark = hl.mark[coin] ?? mid
  return {
    markPx: String(mark), midPx: String(mid), oraclePx: String(hl.oracle[coin] ?? mark), funding: '0.0000125',
    openInterest: '1', prevDayPx: String(mid), dayNtlVlm: '1', premium: '0', impactPxs: [String(mid), String(mid)], dayBaseVlm: '1',
  }
}

/** A fresh ccxt instance on the stub transport, as after a restart. */
function newExchange() {
  const ex = new (ccxt as any).hyperliquid({ enableRateLimit: false })
  ex.publicPostInfo = async (body: any) => {
    hl.calls.push(body.type)
    if (hl.limited) throw new ccxt.RateLimitExceeded('hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null')
    switch (body.type) {
      case 'metaAndAssetCtxs':
        return body.dex
          ? [{ universe: [], collateralToken: 0 }, []]
          : [{ universe: META.universe }, META.universe.map((u: { name: string }) => ctx(u.name))]
      case 'spotMetaAndAssetCtxs': return [{ universe: [], tokens: [] }, []]
      case 'spotMeta': return { universe: [], tokens: [] }
      case 'perpDexs': return DEXES
      case 'meta': return META
      case 'l2Book': {
        const mid = hl.mid[body.coin]!
        const level = [{ px: String(mid), sz: '1000000000', n: 1 }]
        return { coin: body.coin, time: clock, levels: [level, level] }
      }
      case 'fundingHistory': return [{ coin: body.coin, fundingRate: '0.0000125', premium: '0', time: body.startTime }]
      default: throw new Error(`stub: ${body.type} not served`)
    }
  }
  return ex
}

/** Restart: new exchange (markets loaded again), empty caches and backoff. */
async function restart() {
  ;(hyperliquidClient as any).exchange = newExchange()
  ;(priceCache as any).cache.clear()
  resetPriceRefreshState()
  resetMarginTables()
  hl.limited = false
  await getLastPrice('BTC', 'CRYPTO') // loads the markets once (13 requests) and the prices
  hl.calls = []
}
const expirePrices = () => advance(31_000) // past the 30 s price cache

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  mock.restoreAll()
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(async () => {
  rawDb.exec('DELETE FROM liquidation_events; DELETE FROM funding_oracle_prices; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts')
  hl.mid = { ...MARKET }
  hl.mark = {}
  hl.oracle = {}
  await restart()
  Object.assign(hyperliquidMonitorStats, { evaluated: 0, skipped: 0 })
})

let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `rl-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const events = (id: number) => db.select().from(liquidationEvents).where(eq(liquidationEvents.accountId, id)).all()
const open = (id: number, symbol: string, side: string, quantity: number, leverage: number) =>
  placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
const monitor = () => (new TaskScheduler() as any).checkMarginLevels() as Promise<void>

test('1. six markets: one metaAndAssetCtxs request (weight 20) per refresh instead of 12 (weight 240)', async (t) => {
  for (let i = 0; i < 3; i++) {
    expirePrices()
    for (const s of MAINSTREAM_CRYPTOS) assert.equal(await getLastPrice(s, 'CRYPTO'), MARKET[s])
  }
  assert.deepEqual(hl.calls, ['metaAndAssetCtxs', 'metaAndAssetCtxs', 'metaAndAssetCtxs'])
  assert.equal(weight(), 60)
  for (const s of MAINSTREAM_CRYPTOS) assert.equal(Number(getAssetContext(s)!.info.markPx), MARKET[s], `${s} mark kept`)

  // the request made before this task, on the same ccxt instance
  hl.calls = []
  const ex = (hyperliquidClient as any).exchange
  const tickers = await ex.fetchTickers(MAINSTREAM_CRYPTOS.map((s) => `${s}/USDC:USDC`))
  t.diagnostic(`fetchTickers without type: ${requests()} requests, weight ${weight()}: ${hl.calls.join(', ')}`)
  assert.equal(requests(), 12)
  assert.equal(weight(), 240)
  assert.equal(Object.keys(tickers).length, 6, 'the same six tickers')
})

test('2. AI cycle, monitor, funding capture and the API at the same time share one request', async () => {
  const id = newAccount()
  await open(id, 'BTC', 'LONG', 0.001, 2)
  expirePrices()
  hl.calls = []
  await Promise.all([
    ...MAINSTREAM_CRYPTOS.map((s) => getLastPrice(s, 'CRYPTO')), // AI cycle
    monitor(),
    defaultFundingDeps.fetchOraclePrices(),
    getLastPrice('ETH', 'CRYPTO'), // API
  ])
  assert.deepEqual(hl.calls, ['metaAndAssetCtxs'])
  assert.equal(hyperliquidMonitorStats.evaluated, 1)
})

test('3. 429 sequence: pauses of 5, 10, 20, 30, 30 s, no request during a pause, no timer left', async (t) => {
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  hl.limited = true
  expirePrices()
  const sent: number[] = []
  const start = clock
  // the monitor asks every 5 s for two minutes
  for (let s = 0; s <= 120; s += 5) {
    clock = start + s * 1000
    const before = requests()
    await assert.rejects(getLastPrice('BTC', 'CRYPTO'), /429|paused/)
    if (requests() > before) sent.push(s)
  }
  t.diagnostic(`requests at s=${sent.join(', ')} (without backoff: one every 5 s, 25)`)
  assert.deepEqual(sent, [0, 5, 15, 35, 65, 95])
  assert.deepEqual(RATE_LIMIT_BACKOFF_MS, [5_000, 10_000, 20_000, 30_000])
  assert.equal(refreshStats.rateLimited, 6)
  assert.equal(refreshStats.skippedWhilePaused, 25 - 6)
  for (const s of MAINSTREAM_CRYPTOS) assert.equal(getCachedPrice(s, 'CRYPTO'), null, `${s}: no price invented`)
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  assert.ok(timersAfter <= timersBefore, 'no timer created by the backoff')
})

test('4. recovery: the first answer after the pause resets the backoff', async () => {
  hl.limited = true
  expirePrices()
  for (const wait of [0, 5_000, 10_000]) {
    advance(wait)
    await assert.rejects(getLastPrice('BTC', 'CRYPTO'))
  }
  assert.equal(refreshStats.rateLimited, 3) // next pause 20 s
  hl.limited = false
  advance(19_000)
  await assert.rejects(getLastPrice('BTC', 'CRYPTO'), /paused/)
  advance(1_000)
  assert.equal(await getLastPrice('BTC', 'CRYPTO'), 80000)
  assert.equal(await getLastPrice('DOGE', 'CRYPTO'), 0.08, 'the six cached together')
  // a new 429 starts again from 5 s
  hl.limited = true
  expirePrices()
  const n = requests()
  await assert.rejects(getLastPrice('BTC', 'CRYPTO'))
  advance(5_000)
  await assert.rejects(getLastPrice('BTC', 'CRYPTO'), /429/)
  assert.equal(requests(), n + 2)
})

test('5. monitor: valid mark evaluated, stale mark skipped and counted, evaluated again after recovery', async (t) => {
  const id = newAccount()
  await open(id, 'BTC', 'LONG', 0.001, 2)
  expirePrices()
  await monitor()
  assert.deepEqual(hyperliquidMonitorStats, { evaluated: 1, skipped: 0 })

  hl.limited = true
  // checks every 5 s: within 60 s the last mark is still valid, after it is not
  for (let i = 0; i < 24; i++) {
    advance(5_000)
    await monitor()
  }
  const { evaluated, skipped } = hyperliquidMonitorStats
  t.diagnostic(`25 checks in 120 s of 429s: evaluated ${evaluated} (mark <= 60 s old), skipped ${skipped}`)
  // the mark of 0 s is valid up to 60 s: checks at 5..60 s evaluated, 65..120 s skipped
  assert.deepEqual({ evaluated, skipped }, { evaluated: 13, skipped: 12 })
  assert.equal(events(id).length, 0)
  assert.ok(position(id, 'BTC')!.quantity > 0)

  hl.limited = false
  advance(30_000) // the longest pause
  await monitor()
  assert.equal(hyperliquidMonitorStats.evaluated, evaluated + 1, 'evaluated again')
})

test('6. near liquidation during 429s: no liquidation on a stale mark, one liquidation on a fresh one', async () => {
  // 0.01 BTC at 80000, 20x, 50 USDC: liquidated at a mark near 75985 (mmr 1/80)
  const id = newAccount('hyperliquid', 50)
  await open(id, 'BTC', 'LONG', 0.01, 20)
  expirePrices()
  await monitor()
  assert.equal(events(id).length, 0)

  hl.limited = true
  hl.mid.BTC = 75000
  hl.mark.BTC = 75000
  for (let i = 0; i < 20; i++) {
    advance(5_000)
    await monitor()
  }
  assert.equal(events(id).length, 0, 'no decision without a fresh mark')
  assert.ok(hyperliquidMonitorStats.skipped > 0)

  hl.limited = false
  advance(30_000)
  await Promise.all([monitor(), monitor()])
  advance(5_000)
  await monitor()
  assert.equal(events(id).length, 1, 'liquidated once')
  assert.equal(position(id, 'BTC')?.quantity ?? 0, 0)
})

test('7. funding and orders keep their own data: oracle price, fundingHistory, l2Book', async () => {
  hl.mark.BTC = 80010
  hl.oracle.BTC = 79990
  expirePrices()
  const oracles = (await defaultFundingDeps.fetchOraclePrices())!
  assert.equal(oracles.BTC!.oraclePx, 79990, 'oracle, not mark or mid')
  assert.deepEqual(hl.calls, ['metaAndAssetCtxs'])

  hl.calls = []
  await defaultFundingDeps.fetchFundingHistory('BTC', clock - 3_600_000, clock)
  assert.deepEqual(hl.calls, ['fundingHistory'])

  hl.calls = []
  const id = newAccount()
  hl.mid.ETH = 2400
  await open(id, 'ETH', 'LONG', 0.1, 2)
  assert.ok(hl.calls.includes('l2Book'), 'order filled against the book')
  assert.equal(db.select().from(trades).where(eq(trades.accountId, id)).get()!.price, 2400)

  // during a pause the capture makes no request and stores nothing invented
  hl.limited = true
  clock = Math.floor(clock / 3_600_000 + 1) * 3_600_000 + 10_000 // 10 s after the next hour
  hl.calls = []
  await assert.rejects(getLastPrice('BTC', 'CRYPTO'))
  assert.equal(await captureFundingOracle(clock), 0)
  assert.equal(requests(), 1, 'only the first, rate-limited request')
})

test('8. original model unchanged: mid price, no book, no cross monitor', async () => {
  const id = newAccount('original')
  await open(id, 'SOL', 'LONG', 1, 2)
  assert.ok(!hl.calls.includes('l2Book'))
  hl.mark.SOL = 99
  hl.mid.SOL = 101
  expirePrices()
  hl.calls = []
  await monitor()
  assert.equal(hyperliquidMonitorStats.evaluated + hyperliquidMonitorStats.skipped, 0)
  assert.deepEqual(hl.calls, ['metaAndAssetCtxs'])
  assert.equal(await getLastPrice('SOL', 'CRYPTO'), 101, 'mid for the original model')
})

test('9. after a restart the volume is the same: markets once, then one request per refresh', async () => {
  const perRefresh: number[] = []
  for (let run = 0; run < 2; run++) {
    hl.calls = []
    ;(hyperliquidClient as any).exchange = newExchange()
    ;(priceCache as any).cache.clear()
    resetPriceRefreshState()
    await getLastPrice('BTC', 'CRYPTO')
    const startup = requests()
    for (let i = 0; i < 5; i++) {
      expirePrices()
      await getLastPrice('ETH', 'CRYPTO')
    }
    perRefresh.push(startup, (requests() - startup) / 5)
  }
  assert.deepEqual(perRefresh, [14, 1, 14, 1], 'loadMarkets 13 + 1 at start, then 1 per refresh')
})
