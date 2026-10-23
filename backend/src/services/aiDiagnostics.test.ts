/**
 * Deterministic tests for the AI diagnostics trace (AI_DIAGNOSTICS_FILE).
 *
 * Run: npx tsx --test src/services/aiDiagnostics.test.ts
 *
 * Every scenario runs the real placeAIDrivenCryptoOrder twice, with the trace
 * off and on, on two fresh accounts: the request sent to the model, the
 * decision log, the orders and the account state must be identical. The model
 * endpoint and the news feed are fake fetch responses; ccxt is a fake
 * exchange. No network, no AI calls.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ccxt from 'ccxt'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
delete process.env.AI_DIAGNOSTICS_FILE
console.error = () => {}

const API_KEY = 'sk-test-SECRET-0123456789'
const BASE_URL = 'http://fake-ai.test/v1'
const MODEL = 'fake-model-1'
const NEWS = `<?xml version="1.0"?><rss><channel>
<item><title>Bitcoin steady</title><pubDate>Wed, 21 Oct 2026 07:09:18 +0000</pubDate>
<description>BTC above its 50-day EMA.</description></item>
</channel></rss>`
const PRICES: Record<string, number> = {
  BTC: 81336.5, ETH: 2500, SOL: 108, BNB: 750, XRP: 1.4, DOGE: 0.08,
}

;(ccxt as any).hyperliquid = class {
  async fetchTickers(symbols: string[]) {
    return Object.fromEntries(
      symbols.map((s) => [s, { symbol: s, last: PRICES[s.split('/')[0]!] }]),
    )
  }
}

/** What the fake model endpoint does on the next call. */
type Reply =
  | { kind: 'json'; decision: Record<string, unknown> }
  | { kind: 'status'; status: number; body: string }
  | { kind: 'network' }
let reply: Reply = { kind: 'status', status: 500, body: '' }
let aiRequests: { body: unknown; auth: string | null }[] = []

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response(NEWS, { status: 200 })
  if (url.startsWith(BASE_URL)) {
    const headers = new Headers(init?.headers)
    aiRequests.push({ body: JSON.parse(String(init?.body)), auth: headers.get('authorization') })
    if (reply.kind === 'network') throw new TypeError('fetch failed (simulated)')
    if (reply.kind === 'status') return new Response(reply.body, { status: reply.status })
    return Response.json({
      id: 'resp-1',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply.decision) } }],
    })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, orders, positions, trades, users } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { priceCache } = await import('./priceCache.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()

after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  ;(priceCache as any).cache.clear()
  aiRequests = []
})

let seq = 0
function newAccount(): number {
  rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db
    .insert(accounts)
    .values({
      userId: user.id, name: `diag-${++seq}`, accountType: 'AI', model: MODEL,
      baseUrl: BASE_URL, apiKey: API_KEY, initialCapital: 1000, currentCash: 1000,
    })
    .returning()
    .get().id
}

/**
 * Account state with ids and timestamps removed, comparable across accounts.
 * Numbers are rounded to 6 decimals: interest accrues per second of wall
 * clock (~1e-9 USDC between two runs), independently of the trace.
 */
function snapshot(id: number) {
  const a = db.select().from(accounts).where(eq(accounts.id, id)).get()!
  const r6 = (v: unknown) => (typeof v === 'number' ? Number(v.toFixed(6)) : v)
  const strip = (rows: Record<string, unknown>[], keys: string[]) =>
    rows.map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)).map(([k, v]) => [k, r6(v)])),
    )
  const volatile = ['id', 'accountId', 'orderId', 'orderNo', 'userId', 'createdAt', 'updatedAt',
    'updateTime', 'orderTime', 'decisionTime', 'tradeTime', 'lastInterestTime', 'openedAt']
  return {
    cash: r6(a.currentCash),
    marginUsed: r6(a.marginUsed),
    decisions: strip(db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, id)).all(), volatile),
    orders: strip(db.select().from(orders).where(eq(orders.accountId, id)).all(), volatile),
    trades: strip(db.select().from(trades).where(eq(trades.accountId, id)).all(), volatile),
    positions: strip(db.select().from(positions).where(eq(positions.accountId, id)).all(), volatile),
  }
}

/** Runs the given AI replies on a fresh account, cycle by cycle. */
async function runCycles(replies: Reply[], traceFile?: string) {
  if (traceFile) process.env.AI_DIAGNOSTICS_FILE = traceFile
  else delete process.env.AI_DIAGNOSTICS_FILE
  const id = newAccount()
  aiRequests = []
  try {
    for (const r of replies) {
      reply = r
      ;(priceCache as any).cache.clear()
      await placeAIDrivenCryptoOrder()
    }
  } finally {
    delete process.env.AI_DIAGNOSTICS_FILE
  }
  return { id, state: snapshot(id), requests: aiRequests.map((r) => r.body) }
}

const readTrace = (file: string) =>
  fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

const OPEN: Reply = { kind: 'json', decision: { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 3, reason: 'test open' } }
const HOLD: Reply = { kind: 'json', decision: { operation: 'hold', symbol: 'BTC', reason: 'test hold' } }
const CLOSE: Reply = { kind: 'json', decision: { operation: 'close', symbol: 'BTC', direction: 'long', target_portion_of_balance: 1, leverage: 3, reason: 'test close' } }
const REJECT: Reply = { kind: 'json', decision: { operation: 'close', symbol: 'ETH', direction: 'long', target_portion_of_balance: 1, reason: 'nothing to close' } }
const API_ERROR: Reply = { kind: 'status', status: 401, body: `{"error":"API key not valid: ${API_KEY}"}` }
const NETWORK: Reply = { kind: 'network' }

const SCENARIOS: [string, Reply[]][] = [
  ['OPEN, HOLD, CLOSE', [OPEN, HOLD, CLOSE]],
  ['rejected order', [REJECT]],
  ['API error', [API_ERROR]],
  ['network error', [NETWORK]],
]

for (const [name, replies] of SCENARIOS) {
  test(`${name}: identical prompt, decisions and execution with the trace on`, async () => {
    const file = path.join(tmpDir, `trace-${seq + 1}.jsonl`)
    const off = await runCycles(replies)
    const on = await runCycles(replies, file)
    assert.deepEqual(on.requests, off.requests, 'request sent to the model')
    assert.deepEqual(on.state, off.state, 'decision log, orders, trades, positions, cash')
    assert.ok(fs.existsSync(file), 'trace written')
  })
}

test('trace off by default: no file is written', async () => {
  const before = fs.readdirSync(tmpDir).length
  await runCycles([OPEN])
  assert.equal(fs.readdirSync(tmpDir).length, before)
})

test('trace links prompt, response, decision and outcome by cycle id', async () => {
  const file = path.join(tmpDir, 'linked.jsonl')
  const replies = [OPEN, HOLD, CLOSE, REJECT]
  const { requests } = await runCycles(replies, file)
  // callAIForDecision fills leverage and direction defaults before returning
  const normalized = [{}, { leverage: 1, direction: 'long' }, {}, { leverage: 1 }]
  const records = readTrace(file)
  const cycles = [...new Set(records.map((r) => r.cycle_id))]
  assert.equal(cycles.length, 4)

  const expected = [
    ['executed', 'LONG BTC quantity=0.006147 leverage=3x'],
    ['hold', 'No order placed'],
    ['executed', 'SELL BTC quantity=0.006147 leverage=3x'],
    ['rejected', 'No position available to close for ETH'],
  ]
  cycles.forEach((cycleId, i) => {
    const own = records.filter((r) => r.cycle_id === cycleId)
    assert.deepEqual(own.map((r) => r.event), ['request', 'response', 'decision', 'outcome'])
    const [request, response, decision, outcome] = own
    assert.equal(request.model, MODEL)
    assert.ok(!Number.isNaN(Date.parse(request.ts)))
    assert.deepEqual(request.payload, requests[i], 'the exact payload sent, prompt included')
    const prompt = request.payload.messages[0].content as string
    for (const part of ['Cash Available', '"BTC": 81336.5', 'Bitcoin steady']) {
      assert.ok(prompt.includes(part), `prompt contains ${part}`)
    }
    assert.ok(response.response.choices[0].message.content.includes('"operation"'))
    assert.deepEqual(decision.decision, { ...(replies[i] as any).decision, ...normalized[i] })
    assert.equal(outcome.status, expected[i]![0])
    assert.ok(outcome.detail.startsWith(expected[i]![1]!), outcome.detail)
    if (outcome.status === 'executed') assert.equal(typeof outcome.order_id, 'number')
  })
})

test('API and network errors are recorded with the cycle outcome', async () => {
  const file = path.join(tmpDir, 'errors.jsonl')
  await runCycles([API_ERROR, NETWORK], file)
  const records = readTrace(file)
  const apiErrors = records.filter((r) => r.event === 'api_error')
  assert.equal(apiErrors[0].status, 401)
  assert.match(apiErrors[1].error, /fetch failed \(simulated\)/)
  assert.deepEqual(
    records.filter((r) => r.event === 'outcome').map((r) => r.status),
    ['no_decision', 'no_decision'],
  )
})

test('no secret is written: API key and authorization header never appear', async () => {
  const file = path.join(tmpDir, 'secrets.jsonl')
  await runCycles([OPEN, API_ERROR, NETWORK], file)
  assert.ok(aiRequests.some((r) => r.auth === `Bearer ${API_KEY}`), 'the key was really sent')
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes(API_KEY), 'API key')
  assert.ok(!text.includes('SECRET-0123'), 'part of the API key')
  assert.ok(!/authorization/i.test(text), 'authorization header')
  assert.ok(text.includes('[REDACTED]'), 'the echoed key was redacted')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})

test('a failing recorder does not stop trading', async () => {
  const blocker = path.join(tmpDir, 'not-a-dir')
  fs.writeFileSync(blocker, '')
  const off = await runCycles([OPEN, CLOSE])
  const broken = await runCycles([OPEN, CLOSE], path.join(blocker, 'trace.jsonl'))
  assert.deepEqual(broken.requests, off.requests)
  assert.deepEqual(broken.state, off.state)
  assert.equal(broken.state.trades.length, 2)
})
