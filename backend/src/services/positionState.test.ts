/**
 * Task 009D-clean: real state, memory and costs of the open positions shown to
 * the AI (functions 1, 2 and 4), on the original engine of ac66d28.
 *
 * Run: npx tsx --test src/services/positionState.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, fake AI endpoint
 * (as shortOneX.test.ts), no network. Engine fee 0.07% of notional, interest
 * 0.00125% per hour on the borrowed part.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posstate-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
let decision: Record<string, unknown> = {}
const prompts: string[] = []
globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
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
const { placeAndExecuteCrypto, calculatePositionInterest } = await import('./orderExecutorLeverage.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { getPortfolioData } = await import('./aiDecision.js')
const { hyperliquidClient } = await import('./hyperliquid.js')
const S = await import('./positionState.js')

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
    userId: user.id, name: `ps-${++seq}`, accountType: 'AI', isActive: ai ? 'true' : 'false',
    apiKey: ai ? 'fake-key-for-test' : 'default', model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, symbol: string) => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, symbol))).get()
async function engine(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
const prices = () => { for (const [c, p] of Object.entries({ BTC: 80000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 })) cachePrice(c, 'CRYPTO', p) }
const near = (a: number | null, b: number, what: string, eps = 1e-4) => assert.ok(a !== null && Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)

// ------------------------------------------------------------------ function 1 + 4: real state and costs

for (const [side, closeSide, symbol, entry, move] of [['LONG', 'SELL', 'BTC', 80000, 1000], ['SHORT', 'BUY', 'ETH', 2400, -100]] as const) {
  test(`1. ${side}: current price, P&L with the right sign, fees, interest, duration; the estimated net equals what the engine books on closing`, async () => {
    const id = newAccount()
    const qty = side === 'LONG' ? 0.01 : 0.1
    await engine(id, symbol, side, qty, 4, entry)
    const price = entry + move
    cachePrice(symbol, 'CRYPTO', price)
    const p = (await getPortfolioData(account(id))).positions[symbol]!
    assert.deepEqual([p.side, p.avg_cost, p.current_price, p.leverage], [side, entry, price, 4])
    near(p.unrealized_pnl, Math.abs(move) * qty, 'unrealized P&L (gain on both sides)')
    near(p.fees_paid, entry * qty * 0.0007, 'opening fee paid')
    near(p.estimated_exit_fee, price * qty * 0.0007, 'exit fee')
    near(p.interest_accrued, calculatePositionInterest(position(id, symbol)!), 'interest accrued', 1e-6)
    assert.ok(p.holding_minutes !== null && p.holding_minutes >= 0 && p.opened_at !== null)
    near(p.current_value, qty * price, 'current value at the current price')
    near(p.entry_value, qty * entry, 'value at entry')
    // close the whole position at the same price: the engine's booked result = the estimate
    await engine(id, symbol, closeSide, qty, 4, price)
    assert.equal(position(id, symbol)!.quantity, 0)
    near(account(id).currentCash - 1000, p.estimated_net_pnl_if_closed_now!, 'net booked by the engine vs estimate', 1e-3)
    // the other direction loses
    const id2 = newAccount()
    await engine(id2, symbol, side, qty, 4, entry)
    cachePrice(symbol, 'CRYPTO', entry - move)
    near((await getPortfolioData(account(id2))).positions[symbol]!.unrealized_pnl, -Math.abs(move) * qty, 'unrealized loss')
  })
}

test('2. partial close: realized part and remaining part both in the estimate, still equal to what the engine books', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.02, 2, 80000)
  await engine(id, 'BTC', 'SELL', 0.01, 2, 81000)
  cachePrice('BTC', 'CRYPTO', 82000)
  const p = (await getPortfolioData(account(id))).positions.BTC!
  near(p.realized_pnl_partial_closes, 10, 'realized on the partial close')
  near(p.unrealized_pnl, 20, 'unrealized on the rest')
  near(p.fees_paid, 80000 * 0.02 * 0.0007 + 81000 * 0.01 * 0.0007, 'fees of both fills')
  await engine(id, 'BTC', 'SELL', 0.01, 2, 82000)
  near(account(id).currentCash - 1000, p.estimated_net_pnl_if_closed_now!, 'net booked vs estimate', 1e-3)
})

test('3. exit spread: estimated from Hyperliquid impact prices already received with the prices, null when older than a minute; never charged by the engine', async () => {
  const id = newAccount()
  await engine(id, 'BTC', 'LONG', 0.01, 4, 80000)
  const real = (hyperliquidClient as any).exchange
  ;(hyperliquidClient as any).exchange = { fetchTickers: async (syms: string[]) => Object.fromEntries(syms.map((s) => [s, { last: 80000, info: { impactPxs: ['79996', '80004'] } }])) }
  try {
    await hyperliquidClient.getLastPrices(['BTC'])
  } finally {
    ;(hyperliquidClient as any).exchange = real
  }
  const now = Date.now()
  near(S.positionState(id, position(id, 'BTC')!, 80000, now).estimated_exit_spread_usdc, 0.01 * 4, 'half spread x quantity')
  assert.equal(S.positionState(id, position(id, 'BTC')!, 80000, now + 61_000).estimated_exit_spread_usdc, null, 'stale: not used')
  assert.equal(S.positionState(id, position(id, 'BTC')!, null, now).price_issue, 'no current price')
})

// ------------------------------------------------------------------ function 2: memory; prompt

const ORIGINAL_LINES: string[] = [
  "You are a cryptocurrency trading AI. Based on the following portfolio and market data, decide on a trading action.",
  "",
  "Portfolio Data:",
  "- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):",
  "",
  "Current Market Prices:",
  "",
  "Latest Crypto News (CoinJournal):",
  "",
  "Analyze the market and portfolio, then respond with ONLY a JSON object in this exact format:",
  "{",
  "  \"operation\": \"open\" or \"close\" or \"hold\",",
  "  \"symbol\": \"BTC\" or \"ETH\" or \"SOL\" or \"BNB\" or \"XRP\" or \"DOGE\",",
  "  \"direction\": \"long\" or \"short\",",
  "  \"target_portion_of_balance\": 0.2,",
  "  \"leverage\": 3,",
  "  \"reason\": \"Brief explanation of your decision\"",
  "}",
  "",
  "Rules:",
  "- Only ONE position per coin allowed.",
  "- operation must be \"open\", \"close\", or \"hold\"",
  "- direction must be \"long\" or \"short\"",
  "- For \"open\": Open a new position. You can open LONG (betting price goes up) or SHORT (betting price goes down)",
  "  - symbol: which coin to trade",
  "  - direction: \"long\" or \"short\"",
  "  - target_portion_of_balance: % of available cash to use (0.0-1.0)",
  "  - leverage: leverage multiplier (1-10, higher = more risk/reward)",
  "- For \"close\": Close an existing position",
  "  - symbol: which coin position to close",
  "  - direction: must match the position side you want to close (\"long\" or \"short\")",
  "  - target_portion_of_balance: % of position to close (0.0-1.0, use 1.0 to close entire position)",
  "- For \"hold\": no action taken, direction can be omitted",
  "- IMPORTANT: You can only hold ONE position per coin at a time (either long OR short, not both)",
  "- Before opening a new position, check Current Positions to see if you already have a position on that coin",
  "- You can only close positions that you currently hold (check Current Positions for side: \"LONG\" or \"SHORT\")",
  "- leverage is typically 1-10x; only use high leverage (>5x) if you're very confident",
  "- Only choose symbols you have price data for"
]
const OLD_HEADER = '- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):'

test('4. memory: the reason that opened the position and the last decisions, in the prompt of later cycles; persistent (database) and bounded; original prompt otherwise unchanged', async () => {
  const id = newAccount(true)
  prices()
  decision = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'breakout above the range ' + 'z'.repeat(400) }
  await placeAIDrivenCryptoOrder()
  assert.equal(position(id, 'BTC')!.quantity, Math.floor((1000 * 0.25) / 80000 * 1e6) / 1e6, 'size = cash x portion, capped at 25% of the equity (009G)')
  for (let k = 1; k <= 4; k++) {
    decision = { operation: 'hold', reason: `hold number ${k} ` + 'y'.repeat(300) }
    prices()
    await placeAIDrivenCryptoOrder()
  }
  prices()
  decision = { operation: 'hold', reason: 'last' }
  await placeAIDrivenCryptoOrder()
  const prompt = prompts.at(-1)!
  const mem = S.positionMemory(id, 'BTC', Date.parse((await getPortfolioData(account(id))).positions.BTC!.opened_at!))
  assert.ok(mem.entry_reason!.startsWith('breakout above the range') && mem.entry_reason!.length <= S.MEMORY_LIMITS.maxEntryReasonChars)
  assert.deepEqual(mem.decisions_since_entry, { hold: 5 })
  assert.equal(mem.recent_decisions.length, S.MEMORY_LIMITS.recentDecisions)
  assert.ok(mem.recent_decisions.every((d) => d.reason.length <= S.MEMORY_LIMITS.maxReasonChars))
  assert.match(prompt, /"entry_reason": "breakout above the range z+\.\.\."/)
  assert.match(prompt, /"hold": 4/)
  assert.match(prompt, /"reason": "hold number 4 y+\.\.\."/)
  assert.match(prompt, /"current_price": 80000/)
  assert.ok(prompt.includes('- Trading costs in this paper engine: taker fee 0.07% of the notional on each side'))
  assert.ok(prompt.includes('- Each cycle, review every open position with its current data and memory'))
  assert.ok(prompt.includes('interest 0.00125% per hour on the borrowed part'), 'interest rate shown rounded')
  // the original prompt: every line kept, in order, except the position header replaced by function 1
  const out = prompt.split('\n')
  let j = 0
  for (const line of out) if (j < ORIGINAL_LINES.length && (line === ORIGINAL_LINES[j] || (ORIGINAL_LINES[j] === OLD_HEADER && line.startsWith('- Current Positions (each shows side')))) j++
  assert.equal(j, ORIGINAL_LINES.length, `original line missing or out of order: ${JSON.stringify(ORIGINAL_LINES[j])}`)
  assert.ok(prompt.includes('Current Market Prices:\n{\n  "BTC": 80000,'))
  // no position: memory empty, nothing invented
  const id2 = newAccount()
  assert.deepEqual((await getPortfolioData(account(id2))).memory, {})
  const id3 = newAccount()
  await engine(id3, 'ETH', 'SHORT', 0.1, 2, 2400)
  const m3 = (await getPortfolioData(account(id3))).memory!.ETH!
  assert.equal(m3.entry_reason, null)
  assert.match(m3.entry_note!, /not recorded/)
})

// ------------------------------------------------------------------ paper only

test('5. paper only: the exchange is used only through public read-only calls, with no credentials', () => {
  const dir = new URL('.', import.meta.url)
  const used = new Set<string>()
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
    for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/getExchange\(\)\.([A-Za-z]+)/g)) used.add(m[1]!)
  }
  const readOnly = new Set(['fetchTickers', 'fetchTicker', 'fetchOHLCV', 'loadMarkets', 'publicPostInfo'])
  assert.deepEqual([...used].filter((m) => !readOnly.has(m)), [], [...used].join(', '))
  const hl = fs.readFileSync(new URL('hyperliquid.ts', dir), 'utf8')
  const at = hl.indexOf('new ccxt.hyperliquid')
  assert.ok(at > 0 && !/apiKey|secret|privateKey|walletAddress/.test(hl.slice(at, at + 200)), 'no credentials given to the exchange')
})
