/**
 * One AI cycle at a time per account (Task 006H-2).
 *
 * The 300 s job, the immediate run of resetAutoTradingJob (after each account
 * save) and the startup run do not share the job's in-flight flag, so two
 * placeAIDrivenCryptoOrder calls could work on the same account at once: two
 * AI requests, two decisions, and two fills where the original expects one.
 *
 * Run: npx tsx --test src/services/aiCycleLock.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, fake AI
 * endpoint held open by the test (no timers), setInterval mocked for the
 * scheduler tick, no network. Accounts are reconciled by pilot/report.mjs.
 */
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cycle-lock-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
/** AI requests received, each held until released (when `hold` is on). */
const calls: { key: string; release: () => void }[] = []
let hold = true
/** Answer of the fake AI for an API key; may throw to fail the request. */
let answer: (key: string) => Response = () => new Response('unset', { status: 500 })
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) {
    const key = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '')
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    calls.push({ key, release })
    if (hold) await gate
    return answer(key)
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, positions, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { resetAutoTradingJob, taskScheduler } = await import('./scheduler.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as {
  buildReport: (o: Record<string, unknown>) => { reconciliation: { ok: boolean }; issues: string[] }
}

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  taskScheduler.shutdown()
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const PRICES: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }
const cacheAll = () => {
  for (const [s, p] of Object.entries(PRICES)) cachePrice(s, 'CRYPTO', p)
}
const decide = (d: Record<string, unknown>) =>
  Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(d) } }] })
const openBTC = { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.1, leverage: 2, reason: 'test' }

let seq = 0
/** A new active AI account; with `alone`, every other account is deactivated. */
function newAccount(alone = true): { id: number; key: string } {
  if (alone) rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  const key = `fake-key-${++seq}`
  const id = db.insert(accounts).values({
    userId: user.id, name: `lock-${seq}`, accountType: 'AI', isActive: 'true',
    apiKey: key, model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
  return { id, key }
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const logs = (id: number) =>
  db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, id)).all().map((l) => [l.operation, l.executed])
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
const callsFor = (key: string) => calls.filter((c) => c.key === key).length

/** Lets pending promise chains run (no timers involved). */
async function settle(turns = 50) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r))
}
/** Waits (real time, up to 10 s) until `cond` holds: a busy machine can slow the cycles. */
async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}
async function untilCalls(n: number) {
  await waitFor(() => calls.length >= n, `${n} AI requests (got ${calls.length})`)
}
/** Releases every held request and stops holding new ones. */
function releaseAll() {
  hold = false
  for (const c of calls) c.release()
}
function reset() {
  calls.length = 0
  hold = true
}

/** One BTC LONG 2x of 100 USDC: 0.00125 BTC, margin 50, fee 0.07. */
function assertOneOpen(id: number, what: string) {
  assert.deepEqual(logs(id), [['open', 'true']], `${what}: one decision`)
  assert.equal(fills(id).length, 1, `${what}: one fill`)
  const btc = db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, 'BTC'))).get()!
  assert.deepEqual([btc.quantity, btc.side, btc.leverage], [0.00125, 'LONG', 2], `${what}: BTC position`)
  assert.ok(Math.abs(account(id).currentCash - (1000 - 50 - 0.07)) < 1e-6, `${what}: cash ${account(id).currentCash}`)
  assert.ok(Math.abs(account(id).marginUsed - 50) < 1e-6, `${what}: marginUsed ${account(id).marginUsed}`)
  const report = buildReport({ dbFile, accountId: id, prices: PRICES })
  assert.deepEqual(report.issues, [], `${what}: report issues`)
  assert.equal(report.reconciliation.ok, true, `${what}: reconciliation`)
}

test('1. scheduler tick and immediate reset run starting together: one cycle', async () => {
  reset()
  const { id } = newAccount()
  cacheAll()
  answer = () => decide(openBTC)
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    await resetAutoTradingJob() // schedules the 300 s job and starts the immediate run
    await untilCalls(1) // the immediate run is waiting for the AI
    mock.timers.tick(300_000) // the job's first tick fires meanwhile
    await settle()
    assert.equal(calls.length, 1, 'the tick does not send a second AI request')
    releaseAll()
    await waitFor(() => logs(id).length === 1, 'the decision of the immediate run')
    assertOneOpen(id, 'tick + reset')

    // The cadence is unchanged: the next tick runs a normal cycle
    hold = false
    answer = () => decide({ operation: 'hold', reason: 'test' })
    mock.timers.tick(300_000)
    await waitFor(() => logs(id).length === 2, 'the decision of the next tick')
    assert.equal(calls.length, 2, 'next tick asks the AI again')
    assert.deepEqual(logs(id), [['open', 'true'], ['hold', 'true']])
  } finally {
    releaseAll()
    taskScheduler.shutdown()
    mock.timers.reset()
    await settle()
  }
})

test('2. two concurrent cycles on the same account: one AI request, one fill', async () => {
  reset()
  const { id } = newAccount()
  cacheAll()
  answer = () => decide(openBTC)
  const first = placeAIDrivenCryptoOrder()
  await untilCalls(1)
  const second = placeAIDrivenCryptoOrder() // the account is taken: nothing to do
  try {
    await settle()
    assert.equal(calls.length, 1, 'second cycle sent no AI request')
  } finally {
    releaseAll()
    await Promise.all([first, second])
  }
  assertOneOpen(id, 'concurrent cycles')
})

test('3. two accounts: the second is not blocked and each is served once', async () => {
  reset()
  const a = newAccount()
  const b = newAccount(false)
  cacheAll()
  answer = () => decide(openBTC)
  const first = placeAIDrivenCryptoOrder() // takes A first, waits on its AI
  let second: Promise<void> = Promise.resolve()
  try {
    await untilCalls(1)
    assert.equal(calls[0]!.key, a.key)
    second = placeAIDrivenCryptoOrder() // skips A, serves B now
    await untilCalls(2)
    assert.equal(calls[1]!.key, b.key, 'B served while A is still waiting')
    calls[1]!.release()
    await second
    assertOneOpen(b.id, 'account B')
  } finally {
    releaseAll()
    await Promise.all([first, second])
  }
  // the first cycle reached B after the newer cycle served it: skipped
  assert.equal(callsFor(a.key), 1, 'one AI request for A')
  assert.equal(callsFor(b.key), 1, 'one AI request for B')
  assertOneOpen(a.id, 'account A')
})

test('4. AI error, failed execution and timeout release the account; next cycle recovers', async () => {
  reset()
  hold = false
  const { id } = newAccount()
  cacheAll()

  answer = () => new Response('server error', { status: 500 })
  await placeAIDrivenCryptoOrder()
  assert.deepEqual(logs(id), [], 'AI error: no decision')

  answer = () => decide({ ...openBTC, leverage: 99 }) // engine refuses leverage > 50
  await placeAIDrivenCryptoOrder()
  assert.deepEqual(logs(id), [['open', 'false']], 'execution failed')
  assert.equal(fills(id).length, 0)

  answer = () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }
  await placeAIDrivenCryptoOrder() // 3 attempts with the original back-off (~3-5 s)
  assert.deepEqual(logs(id), [['open', 'false']], 'timeout: no decision')

  answer = () => decide(openBTC)
  await placeAIDrivenCryptoOrder()
  assert.deepEqual(logs(id), [['open', 'false'], ['open', 'true']], 'recovered')
  assert.equal(fills(id).length, 1)
  assert.equal(calls.length, 1 + 1 + 3 + 1, 'every cycle reached the AI')
})
