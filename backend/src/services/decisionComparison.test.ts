/**
 * Task 009H: one prompt rule asking to compare the best LONG, the best SHORT
 * and HOLD (and CLOSE against HOLD for open positions), none by default.
 * Only the prompt text changes; these tests check it is there once and that
 * every operation still executes as before (nothing forced), with the 25% cap
 * of 009G, the 009F technical section and the News Guard unchanged.
 * They do not show any effect on decisions or profits (no AI is called).
 *
 * Run: npx tsx --test src/services/decisionComparison.test.ts
 *
 * Offline: throwaway SQLite file, prices in the price cache, a fake
 * ccxt.hyperliquid that never answers, a fixed RSS and a fake AI endpoint.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-cmp-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}
;(ccxt as any).hyperliquid = class {
  async fetchTickers() { throw new ccxt.NetworkError('offline test') }
  async publicPostInfo() { throw new ccxt.NetworkError('offline test') }
}

const AI_URL = 'http://fake-ai.test/v1'
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Bitcoin holds above $80,000 as ETF inflows continue</title>
<description>BTC trades above $80,000.</description><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`
let decision: Record<string, unknown> = {}
const prompts: string[] = []
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response(RSS, { status: 200 })
  if (url.startsWith(AI_URL)) {
    prompts.push(JSON.parse(String(init?.body)).messages[0].content)
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, orders, positions, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
const id = db.insert(accounts).values({
  userId: user.id, name: 'decision-cmp', accountType: 'AI', isActive: 'true', apiKey: 'fake-key-for-test', model: 'fake', baseUrl: AI_URL,
  initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
}).returning().get().id
const prices = () => { for (const [c, p] of Object.entries({ BTC: 76000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p) }
const pos = (s: string) => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const orderCount = () => db.select().from(orders).where(eq(orders.accountId, id)).all().length
async function cycle(d: Record<string, unknown>) {
  prices()
  decision = d
  await placeAIDrivenCryptoOrder()
  return prompts.at(-1)!
}

const RULE = '- Decision comparison: every cycle, with the data given here, find the best LONG candidate and the best SHORT candidate among the six coins (or note that a side has none), ' +
  'and weigh HOLD against them with the same data, costs and risks; with open positions, also weigh CLOSE against HOLD for each. ' +
  'A downtrend is a reason to examine a SHORT as carefully as it is a reason to avoid a LONG, and an uptrend likewise for a LONG. ' +
  'None of these is the default: choose the action the data support best (HOLD when no candidate is justified) and say briefly in reason why it was preferred.\n'
const FORMAT = '{\n  "operation": "open" or "close" or "hold",\n  "symbol": "BTC" or "ETH" or "SOL" or "BNB" or "XRP" or "DOGE",\n  "direction": "long" or "short",\n' +
  '  "target_portion_of_balance": 0.2,\n  "leverage": 3,\n  "reason": "Brief explanation of your decision"\n}'

test('1. the rule once, among the rules after the 009F rule; answer format, six coins, 009F section, cap line and News Guard unchanged', async () => {
  const p = await cycle({ operation: 'hold', reason: 'hold' })
  assert.equal(p.split(RULE).length - 1, 1, 'the rule, once')
  assert.ok(p.indexOf(RULE) > p.indexOf('Rules:'))
  assert.ok(p.indexOf(RULE) > p.indexOf('- Technical data vs news:'), 'after the 009F rule')
  assert.ok(p.includes(FORMAT), 'JSON answer format unchanged, all six coins')
  assert.equal(p.split('Technical Summary (Hyperliquid 1h candles, closed bars only):\n').length - 1, 1)
  assert.equal(p.split('  - engine limit: the notional of a new open (quantity x fill price) is capped at 25% of the current account equity').length - 1, 1)
  assert.equal(p.split('- News vs current data: news items report past events').length - 1, 1)
  assert.equal(p.split('- Each cycle, review every open position with its current data and memory').length - 1, 1)
  assert.ok(!/"alternatives"|"case_for"|"case_against"/.test(p), 'no v4 answer structure')
  assert.equal(orderCount(), 0, 'hold: nothing executed, nothing forced')
})

test('2. OPEN LONG, OPEN SHORT, HOLD and CLOSE all execute as before; the 25% cap still applies', async () => {
  await cycle({ operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, leverage: 3, reason: 'long' })
  assert.equal(pos('BTC')!.side, 'LONG')
  assert.equal(pos('BTC')!.quantity, Math.floor((0.25 * 1000) / 76000 * 1e6) / 1e6, 'cap 25% of the equity (009G)')
  await cycle({ operation: 'open', symbol: 'ETH', direction: 'short', target_portion_of_balance: 0.1, leverage: 2, reason: 'short' })
  assert.equal(pos('ETH')!.side, 'SHORT')
  const n = orderCount()
  const p = await cycle({ operation: 'hold', reason: 'hold with two positions' })
  assert.equal(orderCount(), n, 'hold with open positions: nothing closed or opened')
  assert.equal(p.split(RULE).length - 1, 1)
  await cycle({ operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, reason: 'close' })
  assert.equal(pos('BTC')!.quantity, 0, 'full close')
  await cycle({ operation: 'close', symbol: 'ETH', direction: 'short', target_portion_of_balance: 0.5, reason: 'half' })
  assert.ok(pos('ETH')!.quantity > 0, 'partial close')
})
