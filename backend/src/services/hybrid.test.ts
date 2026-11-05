/**
 * Task 009D: the hybrid version (ALPHA_PROMPT=hybrid, ALPHA_POSITION_INFO=v2,
 * ALPHA_PROTECTION=C1, cost model hyperliquid), offline.
 *
 * Run: npx tsx --test src/services/hybrid.test.ts
 *
 * Throwaway SQLite file, the exchange stub (quotes, books, meta), and a local
 * fake AI server on 127.0.0.1 answering fixed JSON: no Gemini, no decision of
 * the model is simulated, the tests check what is sent, recorded and executed.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
for (const k of ['ALPHA_PROMPT', 'ALPHA_POSITION_INFO', 'ALPHA_PROTECTION', 'ALPHA_PROTECTION_CONFIG']) delete process.env[k]
const realFetch = globalThis.fetch
const noNetwork = (() => { throw new Error('network disabled in tests') }) as typeof fetch
globalThis.fetch = noNetwork

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const S = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { resetFundingRates } = await import('./fundingSettlement.js')
const { resetQuantData } = await import('./quantData.js')
const P = await import('./positionProtection.js')
const { loadExitConfig } = await import('./exitRules.js')
const { buildPrompt, getPortfolioData } = await import('./aiDecision.js')
const { placeAIDrivenCryptoOrder, AI_TRADING_SYMBOLS } = await import('./tradingCommands.js')
const PR = await import('./promptV3.js')
const PH = await import('./promptHybrid.js')
const HC = await import('./hybridContext.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
installHyperliquidStub()
const user = db.insert(S.users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const BASE: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 180, BNB: 600, XRP: 2.5, DOGE: 0.2 }
const NEWS = 'No recent CoinJournal news available.'
let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid'): number {
  return db.insert(S.accounts).values({
    userId: user.id, name: `h-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(S.accounts).where(eq(S.accounts.id, id)).get()!
const position = (id: number, s = 'BTC') => db.select().from(S.positions).where(and(eq(S.positions.accountId, id), eq(S.positions.symbol, s))).get()
const rows = (id: number) => db.select().from(S.positions).where(eq(S.positions.accountId, id)).all()
const decisions = (id: number) => db.select().from(S.aiDecisionsV3).where(eq(S.aiDecisionsV3.accountId, id)).all()
const quoteAll = (btc = 80000) => { for (const c of COINS) quote(c, c === 'BTC' ? btc : BASE[c]!) }
async function open(id: number, side: 'LONG' | 'SHORT', price: number, quantity = 0.01, leverage = 4, symbol = 'BTC') {
  quote(symbol, price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
/** A book with a real spread: bids below and asks above the mid. */
function book(coin: string, mid: number, spreadBps: number, depth = 1000) {
  const half = (mid * spreadBps) / 2e4
  const side = (dir: number) => Array.from({ length: 5 }, (_, k) => ({ px: String(mid + dir * (half + k * mid * 1e-4)), sz: String(depth), n: 1 }))
  hyperliquidStub.books[coin] = { coin, time: Date.now(), levels: [side(-1), side(1)] }
}
const setEnv = (prompt?: string, info?: string, protection = 'off') => {
  for (const [k, v] of [['ALPHA_PROMPT', prompt], ['ALPHA_POSITION_INFO', info]] as const) { if (v) process.env[k] = v; else delete process.env[k] }
  process.env.ALPHA_PROTECTION = protection
}
const ATR: Record<string, number> = { BTC: 400, ETH: 20 }
const atrDeps = { atr: async (s: string, asOf: number) => ({ atr: ATR[s]!, asOf: Math.floor(asOf / 3_600_000) * 3_600_000, bars: 30 }), sizeDecimals: P.defaultExitDeps.sizeDecimals }

/** A local fake AI that answers a script of (status, decision) in order and records each request. */
async function fakeAI(id: number, script: { status: number; decision?: Record<string, unknown> }[]) {
  const requests: any[] = []
  let i = 0
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const step = script[Math.min(i++, script.length - 1)]!
      res.writeHead(step.status, { 'Content-Type': 'application/json' })
      res.end(step.status === 200
        ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(step.decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
        : JSON.stringify({ error: { code: step.status } }))
    })
  }).listen(0, '127.0.0.1')
  await new Promise((r) => srv.once('listening', r))
  rawDb.prepare("UPDATE accounts SET is_active='true', api_key='test-key-hybrid', base_url=?, model='fake' WHERE id=?").run(`http://127.0.0.1:${(srv.address() as any).port}/v1`, id)
  globalThis.fetch = ((input: any, init?: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('network disabled in test'))
    return realFetch(input, init)
  }) as typeof fetch
  return { requests, close: () => { srv.close(); globalThis.fetch = noNetwork; rawDb.prepare("UPDATE accounts SET is_active='false' WHERE id=?").run(id) } }
}

beforeEach(() => {
  rawDb.exec('DELETE FROM exit_events; DELETE FROM exit_plans; DELETE FROM funding_payments; DELETE FROM ai_decision_logs; DELETE FROM ai_decisions_v3; ' +
    "DELETE FROM book_fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; UPDATE accounts SET is_active='false'")
  Object.assign(hyperliquidStub, { quotes: {}, failTickers: false, failMeta: false, failBook: false, books: {}, candles: {} })
  resetMarginTables(); resetFundingRates(); resetQuantData(); clearPrices()
  setEnv()
})

// ------------------------------------------------------------------ selection

test('1. hybrid only on explicit choice, and only with the corrected position view (v2); v1 stays the default', () => {
  assert.equal(PR.promptVersion({}), 'v1')
  assert.equal(PR.promptVersion({ ALPHA_PROMPT: 'Hybrid' }), 'hybrid')
  assert.throws(() => P.describeExperiment({ ALPHA_PROMPT: 'hybrid' }), /needs ALPHA_POSITION_INFO=v2/)
  assert.match(P.describeExperiment({ ALPHA_PROMPT: 'hybrid', ALPHA_POSITION_INFO: 'v2', ALPHA_PROTECTION: 'C1' }), /^Experiment config: position_info=v2 protection=C1 prompt=hybrid config=/)
  assert.throws(() => PR.promptVersion({ ALPHA_PROMPT: 'v9' }), /must be v1 or v3 \(or hybrid\)/)
})

// ------------------------------------------------------------------ prompt

test('2. entries unchanged: every line of the original prompt is in the hybrid one, in order; prices, news, format and rules verbatim', async () => {
  setEnv('hybrid', 'v2', 'C1')
  const id = newAccount()
  quoteAll()
  const p = await getPortfolioData(account(id))
  const prices = Object.fromEntries(AI_TRADING_SYMBOLS.map((s) => [s, BASE[s]!]))
  const original = buildPrompt(p, prices, NEWS)
  const hybrid = PH.buildPromptHybrid(original, { positions: [], costs: HC.accountCosts(account(id), Date.now()), exitModule: loadExitConfig() })
  const o = original.split('\n'), h = hybrid.split('\n')
  let j = 0
  for (const line of h) if (j < o.length && line === o[j]) j++
  assert.equal(j, o.length, `original line not found in order: ${JSON.stringify(o[j])}`)
  assert.ok(hybrid.includes(`Current Market Prices:\n${JSON.stringify(prices, null, 2)}`))
  assert.ok(hybrid.includes(`Latest Crypto News (CoinJournal):\n${NEWS}`))
  assert.ok(hybrid.includes('  - target_portion_of_balance: % of available cash to use (0.0-1.0)'))
  for (const s of ['Position memory: no open position.', 'Trading costs (paper engine, 0.045% taker fee', '"invalidation":', '"position_review":',
    'Review every open position each cycle', 'Neither is required', 'Exit module: ON (C1)']) assert.ok(hybrid.includes(s), s)
  // a changed original (anchor missing) is refused instead of producing a broken prompt
  assert.throws(() => PH.buildPromptHybrid(original.replace('Current Market Prices:', 'Prices:'), { positions: [], costs: HC.accountCosts(account(id), Date.now()), exitModule: loadExitConfig() }), /anchor found 0 times/)
})

// ------------------------------------------------------------------ position state and P&L

test('3. position state shown: entry and current price, P&L with the right sign for LONG and SHORT, net after costs, holding time', async () => {
  setEnv('hybrid', 'v2', 'off')
  const id = newAccount()
  await open(id, 'LONG', 80000, 0.01, 4)
  await open(id, 'SHORT', 2400, 0.1, 2, 'ETH')
  quote('BTC', 81000); quote('ETH', 2300)
  const p = await getPortfolioData(account(id))
  const btc = p.positions.BTC as any, eth = p.positions.ETH as any
  assert.deepEqual([btc.side, btc.avg_cost, btc.current_price, btc.unrealized_pnl], ['LONG', 80000, 81000, 10])
  assert.deepEqual([eth.side, eth.avg_cost, eth.current_price, eth.unrealized_pnl], ['SHORT', 2400, 2300, 10])
  for (const x of [btc, eth]) {
    assert.ok(Math.abs(x.estimated_net_pnl_if_closed_now - (x.unrealized_pnl - x.fees_paid - x.estimated_exit_fee + x.financing_net)) < 1e-3, 'net = P&L - fees - exit fee + funding')
    assert.ok(x.holding_minutes !== null && x.holding_minutes >= 0)
  }
  quote('BTC', 79000); quote('ETH', 2500)
  const q = await getPortfolioData(account(id))
  assert.deepEqual([(q.positions.BTC as any).unrealized_pnl, (q.positions.ETH as any).unrealized_pnl], [-10, -10])
  assert.ok(q.total_assets > 0 && q.cash >= 0)
})

// ------------------------------------------------------------------ end to end: memory, review, AI close, C1 close

test('4. memory across cycles: the open (reason, stated invalidation, data then), later decisions; persistent in the database; bounded', async (t) => {
  setEnv('hybrid', 'v2', 'C1')
  const id = newAccount()
  const ai = await fakeAI(id, [
    { status: 200, decision: { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'breakout above the range', invalidation: 'a close below 79000' } },
    { status: 200, decision: { operation: 'hold', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0, leverage: 1, reason: 'thesis intact, net +2', position_review: 'BTC: hold, still above 79000' } },
    { status: 200, decision: { operation: 'hold', symbol: 'BTC', reason: 'x'.repeat(400), position_review: 'BTC: hold' } },
  ])
  try {
    quoteAll(80000)
    await placeAIDrivenCryptoOrder()
    assert.equal(position(id)!.quantity, Math.round((1000 * 0.5) / 80000 * 1e6) / 1e6, 'size = cash x portion, as in the original')
    assert.equal(position(id)!.leverage, 2)
    quoteAll(80200)
    await placeAIDrivenCryptoOrder()
    quoteAll(80100)
    await placeAIDrivenCryptoOrder()
    const third = ai.requests[2].messages[0].content as string
    assert.equal(ai.requests[2].messages.length, 1, 'one user message, as the original')
    assert.match(third, /"reason": "breakout above the range",\n\s+"invalidation": "a close below 79000",\n\s+"at_entry": \{\n\s+"price": 80000,\n\s+"total_assets_usdc": 1000,\n\s+"cash_usdc": 1000,\n\s+"target_portion": 0.5,\n\s+"leverage": 2/)
    assert.match(third, /"decisions_since_entry": \{\n\s+"hold": 1\n\s+\}/)
    assert.match(third, /"reason": "thesis intact, net \+2"/)
    assert.match(third, /"current_price": 80100/)
    const original = ai.requests[0].messages[0].content as string
    t.diagnostic(`prompt sizes: first cycle (no position) ${original.length} chars ~${PR.estimateTokens(original)} tokens; with 1 position + memory ${third.length} chars ~${PR.estimateTokens(third)} tokens`)
    assert.ok(PR.estimateTokens(third) < 4000, 'bounded prompt')
    // persistence: memory read back from the database alone (a restart keeps it), bounded in size
    for (let k = 0; k < 10; k++) {
      db.insert(S.aiDecisionsV3).values({ accountId: id, at: Date.now() + 1000 + k, operation: 'hold', symbol: 'BTC', valid: 1, issues: '[]',
        decision: JSON.stringify({ reason: 'y'.repeat(500) }), context: JSON.stringify({ prompt: 'hybrid' }), executed: 0, outcome: 'hold: No order placed' }).run()
    }
    const [mem] = HC.hybridPositions(account(id), Date.now() + 60_000)
    assert.equal(mem!.memory.entry!.invalidation, 'a close below 79000')
    assert.equal(mem!.memory.recent_decisions.length, HC.HYBRID_LIMITS.recentDecisions)
    assert.ok(mem!.memory.recent_decisions.every((r) => r.reason.length <= HC.HYBRID_LIMITS.maxReasonChars))
    assert.deepEqual(mem!.memory.decisions_since_entry, { hold: 12 })
    assert.ok(JSON.stringify(mem).length < 1500, `memory of one position: ${JSON.stringify(mem).length} chars`)
    // every hybrid decision recorded with its outcome
    assert.deepEqual(decisions(id).slice(0, 3).map((r) => [r.operation, r.outcome?.split(':')[0]]), [['open', 'executed'], ['hold', 'hold'], ['hold', 'hold']])
  } finally {
    ai.close()
  }
})

test('5. nothing invented: an open without a stated invalidation keeps it null; a position opened outside the hybrid loop has no entry data', async () => {
  setEnv('hybrid', 'v2', 'off')
  const id = newAccount()
  await open(id, 'LONG', 80000) // not opened by a recorded decision
  const [mem] = HC.hybridPositions(account(id), Date.now())
  assert.equal(mem!.memory.entry, null)
  assert.match(mem!.memory.entry_note!, /not recorded/)
  const ai = await fakeAI(id, [{ status: 200, decision: { operation: 'open', symbol: 'ETH', direction: 'short', target_portion_of_balance: 0.2, leverage: 1, reason: 'r' } }])
  try {
    quoteAll(80000)
    await placeAIDrivenCryptoOrder()
    const eth = HC.hybridPositions(account(id), Date.now()).find((p) => p.symbol === 'ETH')!
    assert.equal(eth.memory.entry!.invalidation, null)
    // the BTC position was open too: its review was asked and not given
    assert.deepEqual(JSON.parse(decisions(id).at(-1)!.issues), ['no position_review with open positions', 'open without a stated invalidation'])
  } finally {
    ai.close()
  }
})

test('6. AI close executes as in the original; C1 closes on its own without Gemini; an AI close after it finds nothing and changes nothing', async () => {
  setEnv('hybrid', 'v2', 'C1')
  const id = newAccount()
  const ai = await fakeAI(id, [
    { status: 200, decision: { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'o', invalidation: 'below 79000' } },
    { status: 200, decision: { operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, reason: 'invalidated', position_review: 'BTC: close, below 79000' } },
    { status: 200, decision: { operation: 'open', symbol: 'ETH', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'o2', invalidation: 'below 2300' } },
    { status: 200, decision: { operation: 'close', symbol: 'ETH', direction: 'long', target_portion_of_balance: 1, reason: 'late close' } },
  ])
  try {
    quoteAll(80000); await placeAIDrivenCryptoOrder()
    quoteAll(78900); await placeAIDrivenCryptoOrder()
    assert.equal(position(id)?.quantity ?? 0, 0, 'AI close executed')
    assert.match(decisions(id)[1]!.outcome!, /^executed: SELL BTC/)
    quoteAll(80000); await placeAIDrivenCryptoOrder()
    assert.ok(position(id, 'ETH')!.quantity > 0)
    // C1: plan at 2 ATR, then the mark below the stop -> the module closes in the monitor pass, no AI involved
    quote('ETH', 2400)
    await P.runProtectionPass(account(id), rows(id), { ETH: 2400 }, Date.now(), loadExitConfig(), atrDeps)
    const plan = db.select().from(S.exitPlans).where(eq(S.exitPlans.accountId, id)).all().find((r) => r.symbol === 'ETH')!
    assert.equal(plan.mode, 'C1')
    quote('ETH', plan.stopPrice - 5)
    await P.runProtectionPass(account(id), rows(id), { ETH: plan.stopPrice - 5 }, Date.now(), loadExitConfig(), atrDeps)
    assert.equal(position(id, 'ETH')!.quantity, 0, 'C1 stop executed')
    const tradesBefore = db.select().from(S.trades).where(eq(S.trades.accountId, id)).all().length
    quoteAll(80000); quote('ETH', plan.stopPrice - 5); await placeAIDrivenCryptoOrder()
    assert.match(decisions(id).at(-1)!.outcome!, /^rejected: No position available to close for ETH/)
    assert.equal(db.select().from(S.trades).where(eq(S.trades.accountId, id)).all().length, tradesBefore, 'no extra fill')
    const kinds = db.select().from(S.exitEvents).where(eq(S.exitEvents.accountId, id)).all().map((e) => `${e.kind}:${e.status}`)
    assert.ok(kinds.includes('exit_stop:executed'), kinds.join(', '))
    const rep = buildReport({ dbFile, accountId: id, prices: { BTC: 80000, ETH: plan.stopPrice - 5 }, at: new Date().toISOString() })
    assert.equal(rep.reconciliation.ok, true, JSON.stringify(rep.issues))
    // the read-only evaluation summary of a run (pilot/hybrid-summary.mjs) on the same data
    const { summarizeHybrid } = await import(new URL('../../pilot/hybrid-summary.mjs', import.meta.url).href)
    const sum = summarizeHybrid({ dbFile, accountId: id, report: rep, attemptsText: '{"result":"sent"}\n{"result":"response","class":"ok"}' })
    assert.deepEqual(sum.by_operation, { open: 2, close: 2 })
    assert.deepEqual(sum.closes.by_ai_executed, 1)
    assert.ok(sum.closes.by_exit_module.some((e: any) => e.kind === 'exit_stop' && e.status === 'executed'))
    // open BTC (no position), close BTC (BTC open, reviewed), open ETH (none), close ETH (already closed by C1: none)
    assert.deepEqual([sum.memory_use.decisions_with_open_positions, sum.memory_use.with_position_review, sum.memory_use.opens_with_stated_invalidation], [1, 1, 2])
    assert.ok(typeof sum.costs.spread_and_depth_vs_mid_usdc === 'number' && sum.costs.fees_usdc > 0)
    assert.equal(sum.reconciliation_ok, true)
    assert.equal(sum.api_attempts.sent, 1)
  } finally {
    ai.close()
  }
})

// ------------------------------------------------------------------ errors of the model

test('7. HTTP 503/429: hybrid retries a 503 like a 429 (at most 3 attempts per cycle); the original keeps giving up at once on a 503', async () => {
  const ok = { status: 200, decision: { operation: 'hold', symbol: 'BTC', reason: 'after retry' } }
  setEnv('hybrid', 'v2', 'off')
  let id = newAccount()
  let ai = await fakeAI(id, [{ status: 503 }, { status: 503 }, ok])
  try {
    quoteAll(); await placeAIDrivenCryptoOrder()
    assert.equal(ai.requests.length, 3)
    assert.equal(decisions(id).at(-1)!.outcome, 'hold: No order placed')
  } finally { ai.close() }
  id = newAccount()
  ai = await fakeAI(id, [{ status: 503 }, { status: 503 }, { status: 503 }, ok])
  try {
    quoteAll(); await placeAIDrivenCryptoOrder()
    assert.equal(ai.requests.length, 3, 'three attempts, then no decision')
    assert.equal(decisions(id).length, 0)
  } finally { ai.close() }
  setEnv(undefined, undefined, 'off') // original
  id = newAccount()
  ai = await fakeAI(id, [{ status: 503 }, ok])
  try {
    quoteAll(); await placeAIDrivenCryptoOrder()
    assert.equal(ai.requests.length, 1, 'original: no retry on 503')
  } finally { ai.close() }
})

// ------------------------------------------------------------------ costs

test('8. costs: fees and spread measured on the fills, exit spread estimated from the entry, funding per coin; shown in the prompt', async () => {
  setEnv('hybrid', 'v2', 'off')
  const id = newAccount()
  book('BTC', 80000, 10) // 10 bps spread
  await open(id, 'LONG', 80000, 0.01, 4)
  const [p] = HC.hybridPositions(account(id), Date.now())
  const fill = db.select().from(S.bookFills).where(eq(S.bookFills.accountId, id)).get()!
  const slip = Math.abs(fill.avgPrice - fill.mid) * fill.filledQuantity
  assert.ok(slip > 0)
  assert.equal(p!.costs.entry_slippage_usdc, Math.round(slip * 1e4) / 1e4)
  assert.equal(p!.costs.estimated_exit_slippage_usdc, Math.round(slip * 1e4) / 1e4, 'same per-unit slippage on the same quantity')
  const c = HC.accountCosts(account(id), Date.now())
  const fees = db.select().from(S.trades).where(eq(S.trades.accountId, id)).all().reduce((s, t) => s + t.commission, 0)
  assert.equal(c.fees_paid_usdc, Math.round(fees * 1e4) / 1e4)
  assert.equal(c.taker_fee_pct_each_side, 0.045)
  assert.deepEqual([c.opens, c.closes], [1, 0])
  // original cost model: no book, nothing measured, said as such
  const id2 = newAccount('original')
  await open(id2, 'LONG', 80000)
  assert.deepEqual(HC.hybridPositions(account(id2), Date.now())[0]!.costs, { entry_slippage_usdc: null, estimated_exit_slippage_usdc: null })
})

// ------------------------------------------------------------------ no real orders

test('9. no path to a real order: the exchange is used only through public read-only calls, with no credentials', () => {
  const dir = new URL('.', import.meta.url)
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const used = new Set<string>()
  for (const f of files) for (const m of fs.readFileSync(new URL(f, dir), 'utf8').matchAll(/getExchange\(\)\.([A-Za-z]+)/g)) used.add(m[1]!)
  const readOnly = new Set(['fetchTickers', 'fetchTicker', 'fetchOHLCV', 'loadMarkets', 'publicPostInfo', 'fetchOrderBook', 'fetchFundingRate', 'fetchFundingRates'])
  assert.deepEqual([...used].filter((m) => !readOnly.has(m)), [], `exchange methods: ${[...used].join(', ')}`)
  const hl = fs.readFileSync(new URL('hyperliquid.ts', dir), 'utf8')
  assert.ok(!/apiKey|secret|privateKey|walletAddress/.test(hl.slice(hl.indexOf('new ccxt.hyperliquid'), hl.indexOf('new ccxt.hyperliquid') + 200)), 'no credentials given to the exchange')
})
