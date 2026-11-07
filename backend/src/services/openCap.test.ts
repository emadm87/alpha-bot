/**
 * Task 009G: hard cap on the notional of a new AI open,
 * quantity x fill price <= 25% of the current equity (cash + posted margin
 * + unrealized P&L), LONG and SHORT, any leverage. Closes, C1 exits and the
 * other callers of the engine are not capped.
 *
 * Run: npx tsx --test src/services/openCap.test.ts
 *
 * Offline: throwaway SQLite file, prices in the price cache, a fake
 * ccxt.hyperliquid that never answers (no network), a fixed CoinJournal RSS
 * and a fake AI endpoint answering fixed decisions. A different fill price
 * is simulated by changing the cached price while the AI answers, i.e.
 * between the prices the decision is sized on and the engine's own fetch.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencap-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'info'
const logs: string[] = []
console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
console.warn = console.log
console.error = console.log

;(ccxt as any).hyperliquid = class {
  async fetchTickers() { throw new ccxt.NetworkError('offline test') }
  async fetchTicker() { throw new ccxt.NetworkError('offline test') }
  async publicPostInfo() { throw new ccxt.NetworkError('offline test') }
}

const AI_URL = 'http://fake-ai.test/v1'
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Bitcoin holds above $80,000 as ETF inflows continue</title>
<description>BTC trades above $80,000.</description><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`
let decision: Record<string, unknown> = {}
/** Runs while the AI answers: after the cycle's prices, before the engine fetches the fill price. */
let onAI: () => void = () => {}
const prompts: string[] = []
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response(RSS, { status: 200 })
  if (url.startsWith(AI_URL)) {
    prompts.push(JSON.parse(String(init?.body)).messages[0].content)
    onAI()
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, orders, positions, trades, users, c1Exits, CRYPTO_TAKER_FEE_RATE } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice, priceCache } = await import('./priceCache.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { maxQuantityWithin, verifiedEquity, OPEN_NOTIONAL_CAP } = await import('./openCap.js')
const C1 = await import('./c1Exits.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const BASE = { BTC: 76000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 }
let seq = 0
function newAccount(cash = 1000): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db.insert(accounts).values({
    userId: user.id, name: `cap-${++seq}`, accountType: 'AI', isActive: 'true', apiKey: 'fake-key-for-test', model: 'fake', baseUrl: AI_URL,
    initialCapital: cash, currentCash: cash, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const pos = (id: number, s: string) => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const tradesOf = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const ordersOf = (id: number) => db.select().from(orders).where(eq(orders.accountId, id)).all()
const lastLog = (id: number) => db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, id)).all().at(-1)!
const setPrices = (p: Partial<typeof BASE> = {}) => { for (const [c, v] of Object.entries({ ...BASE, ...p })) cachePrice(c, 'CRYPTO', v) }

/** Equity computed here from the rows and the cached prices (cash + margin + unrealized), independently of openCap.ts. */
function equityNow(id: number, px: Record<string, number>) {
  let e = account(id).currentCash
  for (const p of db.select().from(positions).where(eq(positions.accountId, id)).all()) {
    if (!(p.quantity > 0)) continue
    e += p.margin! + (p.side === 'SHORT' ? p.quantity * (p.avgCost - px[p.symbol]!) : p.quantity * (px[p.symbol]! - p.avgCost))
  }
  return e
}

/** One AI cycle with the given decision; `fill` changes the cached price of the symbol while the AI answers. */
async function cycle(d: Record<string, unknown>, opts: { prices?: Partial<typeof BASE>; fill?: Partial<typeof BASE> } = {}) {
  setPrices(opts.prices)
  decision = d
  onAI = () => { for (const [c, v] of Object.entries(opts.fill ?? {})) cachePrice(c, 'CRYPTO', v) }
  logs.length = 0
  await placeAIDrivenCryptoOrder()
  onAI = () => {}
}
const open = (symbol: string, direction: string, portion: unknown, leverage = 1) =>
  ({ operation: 'open', symbol, direction, target_portion_of_balance: portion, leverage, reason: `open ${portion}` })
const lastOpenTrade = (id: number) => tradesOf(id).filter((t) => t.side === 'LONG' || t.side === 'SHORT').at(-1)!
const floor6 = (x: number) => Math.floor(x * 1e6) / 1e6
const round6 = (x: number) => Math.round(x * 1e6) / 1e6

beforeEach(() => {
  rawDb.exec('DELETE FROM c1_exits; DELETE FROM ai_decision_logs; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders')
  ;(priceCache as any).cache.clear()
})

test('1-2. under the cap: the original quantity; exactly 25%: kept, and a rounding up past the cap is cut', async () => {
  let id = newAccount()
  await cycle(open('BTC', 'long', 0.1))
  assert.equal(lastOpenTrade(id).quantity, round6(100 / 76000), '10%: cash x portion, original rounding')
  id = newAccount()
  await cycle(open('BTC', 'long', 0.25), { prices: { BTC: 80000 } })
  assert.equal(lastOpenTrade(id).quantity, 0.003125, '25% at 80000: 250 USDC exactly')
  assert.equal(lastOpenTrade(id).quantity * 80000, 250)
  // at 77000, round6(250 / 77000) = 0.003247 -> 250.019 USDC > 250: cut to 0.003246
  id = newAccount()
  await cycle(open('BTC', 'long', 0.25), { prices: { BTC: 77000 } })
  assert.equal(round6(250 / 77000), 0.003247)
  assert.equal(lastOpenTrade(id).quantity, 0.003246)
  assert.ok(lastOpenTrade(id).quantity * 77000 <= 250)
})

test('3-7. 50% and 100% reduced to 25% of the equity, LONG and SHORT, at 1x, 3x and 10x; quantities in 6 decimals, rounded down', async () => {
  for (const portion of [0.5, 1]) {
    for (const direction of ['long', 'short']) {
      for (const leverage of [1, 3, 10]) {
        const id = newAccount()
        await cycle(open('ETH', direction, portion, leverage))
        const t = lastOpenTrade(id)
        const what = `${portion} ${direction} ${leverage}x`
        assert.equal(t.side, direction.toUpperCase(), what)
        assert.equal(t.quantity, floor6(250 / 2400), `${what}: 25% of 1000 at 2400, whatever the leverage`)
        assert.equal(Number(t.quantity.toFixed(6)), t.quantity, 'six decimals')
        assert.ok(t.price * t.quantity <= 0.25 * 1000, `${what}: notional within the cap`)
        assert.equal(pos(id, 'ETH')!.leverage, leverage, 'the leverage asked is kept')
        // margin = notional / leverage; cash = 1000 - margin - fee (the engine's own accounting)
        const notional = t.price * t.quantity
        assert.ok(Math.abs(pos(id, 'ETH')!.margin! - notional / leverage) < 1e-9, `${what}: margin`)
        assert.ok(Math.abs(account(id).currentCash - (1000 - notional / leverage - notional * CRYPTO_TAKER_FEE_RATE)) < 1e-9, `${what}: cash`)
        assert.ok(Math.abs(t.commission - notional * 0.0007) < 1e-12, `${what}: fee 0.07% unchanged`)
        assert.ok(Math.abs(account(id).marginUsed - (leverage > 1 ? notional / leverage : 0)) < 1e-9, `${what}: marginUsed as before`)
      }
    }
  }
})

test('8. fill price above the decision price: the quantity is reduced again at the fill price', async () => {
  const id = newAccount()
  await cycle(open('BTC', 'long', 0.5, 3), { fill: { BTC: 80000 } })
  const t = lastOpenTrade(id)
  assert.equal(t.price, 80000, 'filled at the price the engine fetched')
  assert.equal(t.quantity, floor6(250 / 80000), 'not the 0.003289 sized at 76000')
  assert.ok(t.price * t.quantity <= 250)
  assert.equal(ordersOf(id).at(-1)!.quantity, t.quantity, 'the order row records the executed quantity')
  assert.ok(logs.some((l) => /quantity reduced at the fill price 80000 from 0\.003289 to 0\.003125/.test(l)), 'reduction logged')
  assert.match(lastLog(id).reason!, /open 0.5/)
})

test('9. fill price below the decision price: not raised, still within the cap', async () => {
  const id = newAccount()
  await cycle(open('BTC', 'short', 1, 10), { fill: { BTC: 70000 } })
  const t = lastOpenTrade(id)
  assert.equal(t.price, 70000)
  assert.equal(t.quantity, floor6(250 / 76000), 'the quantity sized at 76000, not raised')
  assert.ok(t.price * t.quantity <= 250)
})

test('10. other open positions with a gain or a loss: the cap follows the current equity', async () => {
  for (const [eth, label] of [[2640, 'gain'], [2160, 'loss']] as const) {
    const id = newAccount()
    await cycle(open('ETH', 'long', 0.2, 2)) // 200 USDC notional, margin 100
    const px = { ...BASE, ETH: eth }
    const equity = equityNow(id, px)
    assert.ok(label === 'gain' ? equity > 1000 : equity < 1000, label)
    await cycle(open('BTC', 'long', 1, 5), { prices: { ETH: eth } })
    const t = lastOpenTrade(id)
    assert.equal(t.symbol, 'BTC')
    assert.equal(t.quantity, floor6((0.25 * equity) / 76000), `${label}: 25% of ${equity}`)
    assert.ok(t.price * t.quantity <= 0.25 * equity)
    assert.ok(logs.some((l) => l.includes(`equity ${equity.toFixed(4)}`) && l.includes(`cap 25% = ${(0.25 * equity).toFixed(4)}`)), `${label}: equity and cap logged`)
    assert.ok(logs.some((l) => /requested notional \d+\.\d+ \(cash .* x portion 1\).*authorized notional .*\(reduced; checked again at the fill price\)/.test(l)), 'requested and authorized logged')
  }
})

test('11. equity not verifiable, zero, negative or not finite: no open', async () => {
  // the price of another open position is missing: refused, P&L never taken as 0
  const id = newAccount()
  await cycle(open('ETH', 'long', 0.2, 2))
  ;(priceCache as any).cache.clear()
  for (const [c, v] of Object.entries(BASE)) if (c !== 'ETH') cachePrice(c, 'CRYPTO', v)
  logs.length = 0
  decision = open('BTC', 'long', 0.2)
  await placeAIDrivenCryptoOrder()
  assert.equal(pos(id, 'BTC'), undefined, 'no BTC position')
  assert.equal(lastLog(id).executed, 'false')
  assert.ok(logs.some((l) => /Open refused for BTC: equity not verifiable \(no price for open position ETH/.test(l)))
  // verifiedEquity directly: zero, negative, not finite (NaN cannot be stored: current_cash is NOT NULL)
  for (const cash of [0, -10, Number.POSITIVE_INFINITY]) {
    const a = newAccount()
    rawDb.prepare('UPDATE accounts SET current_cash = ? WHERE id = ?').run(cash, a)
    const v = await verifiedEquity(a)
    assert.ok('error' in v, `cash ${cash}`)
  }
  assert.match((await verifiedEquity(999999) as { error: string }).error, /account not found/)
  // an open position whose loss makes the equity negative
  const b = newAccount(100)
  setPrices()
  await placeAndExecuteCrypto({ account: account(b), symbol: 'BTC', name: 'BTC', side: 'SHORT', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 10 })
  cachePrice('BTC', 'CRYPTO', 90000)
  assert.match((await verifiedEquity(b) as { error: string }).error, /^equity not positive/)
  // the engine refuses an invalid cap itself
  for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(placeAndExecuteCrypto({ account: account(b), symbol: 'ETH', name: 'ETH', side: 'LONG', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 1, maxNotional: cap }), /invalid notional cap/)
  }
})

test('12. invalid numbers in the request: refused, nothing executed', async () => {
  for (const portion of ['abc', null, -0.5, 0, 1.5, Number.POSITIVE_INFINITY]) {
    const id = newAccount()
    await cycle(open('BTC', 'long', portion, 3))
    assert.equal(ordersOf(id).length, 0, `portion ${portion}: no order`)
    assert.equal(account(id).currentCash, 1000)
    assert.equal(pos(id, 'BTC'), undefined)
    if (portion === 'abc') assert.ok(logs.some((l) => l.includes('Open refused for BTC: requested notional not finite (portion abc)')), 'NaN portion refused by the cap')
  }
  assert.ok(Number.isNaN(Number('abc')))
  assert.equal(maxQuantityWithin(Number.NaN, 100), 0)
  assert.equal(maxQuantityWithin(100, 0), 0)
  // the engine refuses a non-finite quantity under a cap
  const id = newAccount()
  setPrices()
  await assert.rejects(placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'LONG', orderType: 'MARKET', price: null, quantity: Number.NaN, leverage: 1, maxNotional: 250 }), /notional not finite/)
  assert.equal(ordersOf(id).length, 0)
})

test('13. below the minimum quantity: refused (at the decision price or at the fill price)', async () => {
  // 20 USDC: 100% would be 0.000263 BTC, the cap (5 USDC) gives 0.000065 < 0.0001
  let id = newAccount(20)
  await cycle(open('BTC', 'long', 1, 2))
  assert.equal(pos(id, 'BTC'), undefined)
  assert.equal(account(id).currentCash, 20)
  // 30.5 USDC: cap 7.625 -> 0.0001 at 76000; filled at 80000 it allows 0.000095: refused, nothing booked
  id = newAccount(30.5)
  await cycle(open('BTC', 'long', 1, 2), { fill: { BTC: 80000 } })
  assert.equal(pos(id, 'BTC'), undefined)
  assert.equal(ordersOf(id).length, 0, 'refused before any row')
  assert.equal(account(id).currentCash, 30.5)
  assert.ok(logs.some((l) => /Open refused: at the fill price 80000 the notional cap 7\.625 allows quantity 0\.000095, below the minimum 0\.0001/.test(l)))
})

test('14. closes are never capped: partial and full, also of a position now above 25% after a rise', async () => {
  const id = newAccount()
  await cycle(open('ETH', 'long', 1, 3))
  const q = pos(id, 'ETH')!.quantity
  // ETH +60%: the position is worth 400 USDC, above 25% of the equity; a hold keeps it
  await cycle({ operation: 'hold', reason: 'hold' }, { prices: { ETH: 3840 } })
  assert.equal(pos(id, 'ETH')!.quantity, q, 'not closed or reduced by the cap')
  assert.ok(q * 3840 > 0.25 * equityNow(id, { ...BASE, ETH: 3840 }))
  await cycle({ operation: 'close', symbol: 'ETH', direction: 'long', target_portion_of_balance: 0.5, reason: 'half' }, { prices: { ETH: 3840 } })
  assert.equal(pos(id, 'ETH')!.quantity, round6(q - round6(q * 0.5)), 'half closed, quantity not cut')
  await cycle({ operation: 'close', symbol: 'ETH', direction: 'long', target_portion_of_balance: 1, reason: 'all' }, { prices: { ETH: 3840 } })
  assert.equal(pos(id, 'ETH')!.quantity, 0, 'full close')
  const closes = tradesOf(id).filter((t) => t.side === 'SELL')
  assert.equal(closes.length, 2)
  assert.ok(closes[1]!.price * closes[1]!.quantity > 0, 'close notional not limited')
})

test('15. C1 still closes the whole position', async () => {
  const id = newAccount()
  await cycle(open('BTC', 'long', 0.5, 4), { prices: { BTC: 80000 } })
  const q = pos(id, 'BTC')!.quantity
  assert.equal(q, floor6(250 / 80000))
  C1.resetC1State()
  const H = 3_600_000
  const last = Math.floor(Date.now() / H) * H - H
  const rows = Array.from({ length: 150 }, (_, k) => {
    const t = last - (149 - k) * H
    return { t, T: t + H - 1, s: 'BTC', i: '1h', o: '80000', c: '80000', h: '80200', l: '79800', v: '1', n: 1 }
  })
  let mark = 80000
  const deps = { fetchCandles: async () => rows, price: async (s: string) => { cachePrice(s, 'CRYPTO', mark); return mark }, now: () => Date.now() }
  await C1.runC1Pass(() => false, deps)
  mark = 79000 // below the stop 80000 - 2 x 400
  const r = await C1.runC1Pass(() => false, deps)
  assert.equal(r.closed, 1)
  assert.equal(pos(id, 'BTC')!.quantity, 0)
  const plan = db.select().from(c1Exits).where(eq(c1Exits.accountId, id)).get()!
  assert.equal(plan.closeQuantity, q, 'the whole quantity')
})

test('16. other callers of the engine are unchanged: no cap without maxNotional', async () => {
  const id = newAccount()
  setPrices()
  await placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'LONG', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 2 })
  const t = lastOpenTrade(id)
  assert.equal(t.quantity, 0.01, '760 USDC notional, not capped')
  assert.ok(Math.abs(account(id).currentCash - (1000 - 760 / 2 - 760 * 0.0007)) < 1e-9)
  // the cap is ignored for a close sent with it
  await placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'SELL', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 2, maxNotional: 1 })
  assert.equal(pos(id, 'BTC')!.quantity, 0)
  assert.equal(OPEN_NOTIONAL_CAP, 0.25)
})

test('17. prompt: the cap stated once; 009F technical summary, News Guard and the answer format unchanged', async () => {
  newAccount()
  await cycle({ operation: 'hold', reason: 'hold' })
  const p = prompts.at(-1)!
  const line = '  - engine limit: the notional of a new open (quantity x fill price) is capped at 25% of the current account equity, whatever the leverage (the margin is notional / leverage); a larger target_portion_of_balance is reduced by the engine\n'
  assert.equal(p.split(line).length - 1, 1)
  assert.ok(p.includes('  - target_portion_of_balance: % of available cash to use (0.0-1.0)\n'), 'meaning of the portion unchanged')
  assert.ok(p.includes('Technical Summary (Hyperliquid 1h candles, closed bars only):\n'))
  assert.ok(p.includes('1h candles unavailable from Hyperliquid'), 'offline: the summary says the data are missing')
  assert.equal(p.split('- News vs current data: news items report past events').length - 1, 1)
  assert.equal(p.split('- Technical data vs news:').length - 1, 1)
  assert.ok(p.includes('{\n  "operation": "open" or "close" or "hold",\n  "symbol": "BTC" or "ETH" or "SOL" or "BNB" or "XRP" or "DOGE",\n  "direction": "long" or "short",\n  "target_portion_of_balance": 0.2,\n  "leverage": 3,\n  "reason": "Brief explanation of your decision"\n}'))
})
