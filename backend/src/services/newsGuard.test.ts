/**
 * Task 009E: the rule that separates news (past events) from current data in
 * the trading prompt. The 009D case: a news item about BTC above $80,000 while
 * the current price is 76,008.5.
 *
 * Run: npx tsx --test src/services/newsGuard.test.ts
 *
 * Throwaway SQLite file, prices in the price cache, a fixed CoinJournal RSS and
 * a fake AI endpoint answering fixed decisions (as shortOneX.test.ts); no network.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsguard-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
const RSS = `<?xml version="1.0"?><rss><channel><item><title>Bitcoin holds above $80,000 as ETF inflows continue</title>
<description>BTC trades above $80,000 with strong momentum.</description><pubDate>Mon, 02 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`
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
const { accounts, positions, users } = await import('../db/schema.js')
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
  userId: user.id, name: 'news-guard', accountType: 'AI', isActive: 'true', apiKey: 'fake-key-for-test', model: 'fake', baseUrl: AI_URL,
  initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
}).returning().get().id
const prices = (btc: number) => { for (const [c, p] of Object.entries({ BTC: btc, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p) }
const btc = () => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, 'BTC'))).get()

const RULE = '- News vs current data: news items report past events and may be old; prices, momentum or technical levels they mention are not necessarily valid now. ' +
  'Current Market Prices and Current Positions are the current facts and take priority: check any price or level taken from the news against them before relying on it. ' +
  'Re-evaluate open positions on the current data, not only on the reason given when they were opened. Open, close and hold all remain valid choices.'

test('1. the prompt carries the old news, the current price and the rule that current data take priority', async () => {
  prices(76008.5)
  decision = { operation: 'hold', reason: 'test' }
  await placeAIDrivenCryptoOrder()
  const p = prompts.at(-1)!
  assert.ok(p.includes('Bitcoin holds above $80,000 as ETF inflows continue'), 'news unchanged (collection not altered)')
  assert.ok(p.includes('Current Market Prices:\n{\n  "BTC": 76008.5,'), 'current price in the prompt')
  assert.equal(p.split(RULE).length - 1, 1, 'the rule, once')
  // the rule sits with the other rules, after the data and the answer format
  assert.ok(p.indexOf(RULE) > p.indexOf('Latest Crypto News (CoinJournal):') && p.indexOf(RULE) > p.indexOf('Rules:'))
  // the three operations are still offered
  assert.ok(p.includes('"operation": "open" or "close" or "hold"'))
  for (const s of ['- For "open": Open a new position.', '- For "close": Close an existing position', '- For "hold": no action taken']) assert.ok(p.includes(s), s)
})

test('2. open, hold and close all still execute: nothing is forced', async () => {
  prices(76008.5)
  decision = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'open' }
  await placeAIDrivenCryptoOrder()
  assert.equal(btc()!.quantity, Math.floor((1000 * 0.25) / 76008.5 * 1e6) / 1e6, 'open: 50% asked, capped at 25% of the equity (009G)')
  prices(76100)
  decision = { operation: 'hold', reason: 'hold' }
  await placeAIDrivenCryptoOrder()
  assert.ok(btc()!.quantity > 0, 'hold keeps it')
  assert.ok(prompts.at(-1)!.includes(RULE) && prompts.at(-1)!.includes('"current_price": 76100'), 'the rule with an open position and its current data')
  prices(76200)
  decision = { operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, reason: 'close' }
  await placeAIDrivenCryptoOrder()
  assert.equal(btc()!.quantity, 0, 'close executed')
})
