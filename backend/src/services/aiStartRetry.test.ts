/**
 * Reliable start of the AI job (Task 006H-4).
 *
 * resetAutoTradingJob checks that every AI symbol has a price before it
 * schedules the 300 s job. When the check failed it only logged the error:
 * at startup the job was never created and the bot stayed idle until an
 * account was saved. It now retries, bounded, without trading on incomplete
 * prices, and never falls back to random spot orders.
 *
 * Run: npx tsx --test src/services/aiStartRetry.test.ts
 *
 * Throwaway SQLite file, Hyperliquid prices from a stub of the client, fake
 * AI endpoint that always answers "hold", setTimeout/setInterval mocked so
 * minutes pass instantly, no network. The real startup (initializeServices)
 * and shutdown (shutdownServices) are used.
 */
import { test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-start-retry-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL = 'error'
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
/** API key of every AI request received. */
const aiRequests: string[] = []
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) {
    aiRequests.push(String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', ''))
    const decision = { operation: 'hold', reason: 'test' }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, aiDecisionLogs, orders, users } = await import('../db/schema.js')
const { priceCache } = await import('./priceCache.js')
const { hyperliquidClient } = await import('./hyperliquid.js')
const scheduler = await import('./scheduler.js')
const { taskScheduler, resetAutoTradingJob } = scheduler
const { initializeServices, shutdownServices } = await import('./startup.js')
const { AI_TRADE_JOB_ID, AUTO_TRADE_JOB_ID } = await import('./tradingCommands.js')

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  shutdownServices()
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// --- Hyperliquid price stub ------------------------------------------------------
const PRICES: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }
/**
 * Requests made to the stub, and which symbols it leaves without a price at
 * a given start attempt (a failed attempt asks once per unpriced symbol).
 */
let priceRequests = 0
let unpriced: (attempt: number) => string[] = () => []
;(hyperliquidClient as any).getLastPrices = async (symbols: string[]) => {
  priceRequests++
  const missing = unpriced(status()?.attempts ?? 1)
  return Object.fromEntries(symbols.map((s) => [s, missing.includes(s) ? null : PRICES[s]!]))
}
const ALL = Object.keys(PRICES)

// --- helpers ---------------------------------------------------------------------
const keys = ['key-a', 'key-b']
for (const [i, key] of keys.entries()) {
  db.insert(accounts).values({
    userId: user.id, name: `start-${i}`, accountType: 'AI', isActive: 'true',
    apiKey: key, model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).run()
}
const status = () => (scheduler as any).getAutoTradingStatus?.()
const aiJob = () => taskScheduler.getJob(AI_TRADE_JOB_ID)
const requestsFor = (key: string) => aiRequests.filter((k) => k === key).length

async function settle(turns = 100) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r))
}
/**
 * Waits (real time) until `cond` holds: module loading under tsx and a busy
 * machine can delay the work a timer starts, so tests wait on its result
 * rather than on a fixed number of turns.
 */
async function waitFor(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}
/** Real-time pause, to check that nothing else happens. */
async function pause(ms = 200) {
  const end = Date.now() + ms
  while (Date.now() < end) await new Promise((r) => setImmediate(r))
}
/** Lets `seconds` pass on the mocked clock. */
async function advance(seconds: number, step = 5) {
  for (let t = 0; t < seconds; t += step) {
    mock.timers.tick(step * 1000)
    await settle(10)
  }
}
/** Attempt `n + 1` has finished: it planned the next retry, or the series ended. */
const attemptDone = (n: number) => () =>
  status().attempts > n && (status().state !== 'retrying' || status().nextRetryAt !== null)
/** Fires each planned retry in turn until the series ends. */
async function runRetries() {
  while (status().state === 'retrying') {
    const n = status().attempts
    await advance(scheduler.AI_START_RETRY_DELAYS[Math.min(n - 1, scheduler.AI_START_RETRY_DELAYS.length - 1)]!)
    await waitFor(attemptDone(n), `attempt ${n + 1}`)
  }
}
const cycles = (counts: number[]) => () => keys.map(requestsFor).join() === counts.join()
function assertNoSpotFallback(what: string) {
  assert.equal(taskScheduler.getJob(AUTO_TRADE_JOB_ID), undefined, `${what}: no random trading job`)
  assert.equal(db.select().from(orders).all().length, 0, `${what}: no order of any kind`)
}

/** Fresh state, mocked timers, and the real startup. */
async function start(missing: (attempt: number) => string[]) {
  shutdownServices()
  ;(priceCache as any).cache.clear()
  priceRequests = 0
  aiRequests.length = 0
  rawDb.prepare('DELETE FROM ai_decision_logs').run()
  unpriced = missing
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  await initializeServices() // waits for the first start attempt
}
function stop() {
  shutdownServices()
  mock.timers.reset()
}

test('1. prices ready at once: normal start, one cycle per account, then every 300 s', async () => {
  await start(() => [])
  try {
    assert.ok(aiJob(), 'AI job scheduled')
    assert.equal(aiJob()!.intervalSeconds, 300)
    assert.equal(priceRequests, 1, 'one price request')
    await waitFor(cycles([1, 1]), 'immediate cycle for each account')
    await advance(300)
    await waitFor(cycles([2, 2]), 'next 300 s cycle')
    assert.equal(status().state, 'scheduled')
    assertNoSpotFallback('normal start')
  } finally {
    stop()
  }
})

test('2. prices missing at startup, back on the 3rd attempt: automatic recovery', async () => {
  await start((n) => (n <= 2 ? ALL : []))
  try {
    assert.equal(aiJob(), undefined, 'no job with missing prices')
    assert.equal(aiRequests.length, 0, 'no AI decision with missing prices')
    await advance(15)
    await waitFor(attemptDone(1), 'attempt 2')
    assert.equal(status().state, 'retrying', 'attempt 2 fails')
    assert.equal(aiJob(), undefined)
    assert.equal(aiRequests.length, 0)
    await advance(30)
    await waitFor(attemptDone(2), 'attempt 3')
    assert.ok(aiJob(), 'AI job scheduled after recovery')
    assert.equal(status().attempts, 3, 'recovered on the third attempt')
    await waitFor(cycles([1, 1]), 'one cycle per account after recovery')
    await advance(300)
    await waitFor(cycles([2, 2]), 'then every 300 s')
    await waitFor(() => db.select().from(aiDecisionLogs).all().length === 4, 'one decision per account per cycle')
    await pause()
    assert.deepEqual(keys.map(requestsFor), [2, 2], 'no duplicate')
    assert.deepEqual([status().state, status().attempts], ['scheduled', 3])
    assertNoSpotFallback('recovery')
  } finally {
    stop()
  }
})

test('3. prices never available: bounded retries, then a visible failure and no trading', async () => {
  await start(() => ALL)
  try {
    assert.equal(status().state, 'retrying')
    await runRetries()
    assert.equal(status().attempts, scheduler.AI_START_MAX_ATTEMPTS, 'attempts stop at the limit')
    assert.equal(status().state, 'failed')
    const requestsAtFailure = priceRequests
    assert.match(status().lastError, /Market data not ready for symbols: BNB, BTC, DOGE, ETH, SOL, XRP/)
    assert.equal(status().nextRetryAt, null)
    await advance(3600, 60)
    await pause()
    assert.equal(priceRequests, requestsAtFailure, 'no retry after giving up')
    assert.equal(aiJob(), undefined)
    assert.equal(aiRequests.length, 0)
    assertNoSpotFallback('outage')
  } finally {
    stop()
  }
})

test('4. one symbol never priced while the others are: treated as permanent, stops early', async () => {
  await start(() => ['DOGE'])
  try {
    await runRetries()
    assert.equal(status().attempts, scheduler.AI_START_MAX_PARTIAL, 'stops after the same symbol failed 3 times')
    assert.equal(status().state, 'failed')
    const requestsAtFailure = priceRequests
    await advance(600)
    await pause()
    assert.equal(priceRequests, requestsAtFailure, 'no retry after giving up')
    assert.match(status().lastError, /DOGE/)
    assert.equal(aiJob(), undefined)
    assert.equal(aiRequests.length, 0)
    assertNoSpotFallback('permanent')
  } finally {
    stop()
  }
})

test('5. account saved during the retries: one job, the pending retry is dropped', async () => {
  await start(() => ALL)
  try {
    assert.equal(status().state, 'retrying')
    unpriced = () => [] // prices are back when the account is saved
    await resetAutoTradingJob() // what the account API does on save
    assert.ok(aiJob(), 'scheduled by the save')
    const requestsAtSave = priceRequests
    await waitFor(cycles([1, 1]), 'one cycle per account')
    await advance(60) // the old retry would have fired at 15 s
    await pause()
    assert.equal(priceRequests, requestsAtSave, 'old retry cancelled')
    assert.deepEqual(keys.map(requestsFor), [1, 1], 'no extra cycle')
    assert.equal(taskScheduler.getJobInfo().filter((j) => j.id === AI_TRADE_JOB_ID).length, 1)
    await advance(240)
    await waitFor(cycles([2, 2]), 'one cycle each at 300 s')
  } finally {
    stop()
  }
})

test('6. shutdown during the retries leaves no timer; a restart starts normally', async () => {
  await start(() => ALL)
  assert.equal(status().state, 'retrying')
  shutdownServices()
  unpriced = () => [] // prices come back after the shutdown
  const requestsAtShutdown = priceRequests
  try {
    await advance(3600, 15)
    await pause()
    assert.equal(priceRequests, requestsAtShutdown, 'no attempt after shutdown')
    assert.equal(taskScheduler.isRunning(), false, 'scheduler stopped')
    assert.deepEqual(taskScheduler.getJobInfo(), [], 'no job left')
    assert.equal(aiRequests.length, 0)
    assert.equal(status().state, 'idle')
  } finally {
    mock.timers.reset()
  }
  await start(() => [])
  try {
    assert.ok(aiJob(), 'restart schedules the job')
    await waitFor(cycles([1, 1]), 'one cycle per account after restart')
  } finally {
    stop()
  }
})
