/**
 * Cost models 'original' and 'hyperliquid' (Task 006I-1).
 *
 * 'original' keeps the author's rules (taker fee 0.07%); 'hyperliquid' only
 * changes the perpetual taker fee to 0.045% (base tier). The model is chosen
 * when the account is created and cannot change; every engine fill records
 * the rate it applied; the pilot report reads the account's model.
 *
 * Run: npx tsx --test src/services/costModel.test.ts
 *
 * Throwaway SQLite file, prices injected into the price cache, fake AI
 * endpoint, no network. Expected values are worked out by hand.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-model-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
delete process.env.ALPHA_COST_MODEL
console.error = () => {}

const AI_URL = 'http://fake-ai.test/v1'
const prompts: Record<string, string> = {}
let decision: Record<string, unknown> = {}
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('coinjournal')) return new Response('', { status: 404 })
  if (url.startsWith(AI_URL)) {
    const key = String((init?.headers as Record<string, string>).Authorization).replace('Bearer ', '')
    prompts[key] = JSON.parse(String(init?.body)).messages[0].content
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] })
  }
  throw new Error(`network disabled in tests: ${url}`)
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, positions, trades, users, HL_PERP_TAKER_FEE_RATE, CRYPTO_TAKER_FEE_RATE, takerFeeRate } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { placeAIDrivenCryptoOrder } = await import('./tradingCommands.js')
const { TaskScheduler, stopScheduler } = await import('./scheduler.js')
const { updateAccount } = await import('../repositories/account.js')
const { accountRoutes } = await import('../api/account.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
// Hyperliquid prices and metadata from the offline stub (006I-3 checks the leverage on opens)
const { installHyperliquidStub, quote } = await import('./__fixtures__/hyperliquidStub.js')
installHyperliquidStub()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  stopScheduler()
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const PRICES: Record<string, number> = { BTC: 80000, ETH: 2400, SOL: 100, BNB: 740, XRP: 1.3, DOGE: 0.08 }
const cacheAll = (p = PRICES) => {
  for (const [s, v] of Object.entries(p)) cachePrice(s, 'CRYPTO', v)
}
const OG = 0.0007
const HL = 0.00045

let seq = 0
function newAccount(costModel?: 'original' | 'hyperliquid', ai = false): number {
  if (ai) rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
  return db.insert(accounts).values({
    userId: user.id, name: `cm-${++seq}`, accountType: 'AI', isActive: ai ? 'true' : 'false',
    apiKey: ai ? `key-${seq}` : 'default', model: 'fake', baseUrl: AI_URL,
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
    ...(costModel ? { costModel } : {}),
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s: string) =>
  db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()!
const fills = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all()
async function fill(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number, orderNo?: string) {
  cachePrice(symbol, 'CRYPTO', price)
  await placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage, orderNo })
}
function near(actual: number, expected: number, what: string, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
function assertReconciled(id: number, prices: Record<string, number>) {
  const rep = buildReport({ dbFile, accountId: id, prices, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}

/** Same scenario under either model: LONG 2x opened, partly closed, closed; SHORT 3x round trip. */
async function scenario(id: number) {
  await fill(id, 'BTC', 'LONG', 0.00625, 2, 80000) // notional 500, margin 250
  await fill(id, 'BTC', 'SELL', 0.0025, 2, 82000) // partial: notional 205, P&L +5
  await fill(id, 'BTC', 'SELL', 0.00375, 2, 79000) // rest: notional 296.25, P&L -3.75
  await fill(id, 'ETH', 'SHORT', 0.1, 3, 2400) // notional 240, margin 80
  await fill(id, 'ETH', 'BUY', 0.1, 3, 2300) // notional 230, P&L +10
}
const NOTIONALS = [500, 205, 296.25, 240, 230]
const scenarioCash = (rate: number) => 1000 + 5 - 3.75 + 10 - rate * NOTIONALS.reduce((s, n) => s + n, 0)
/** Interest the engine charged (a few milliseconds of holding: ~1e-8). */
const interestOf = (id: number) => fills(id).reduce((s, t) => s + t.interestCharged, 0)

test('0. fee rate per model; new accounts default to original', () => {
  assert.equal(takerFeeRate('original'), CRYPTO_TAKER_FEE_RATE)
  assert.equal(CRYPTO_TAKER_FEE_RATE, OG)
  assert.equal(takerFeeRate('hyperliquid'), HL_PERP_TAKER_FEE_RATE)
  assert.equal(HL_PERP_TAKER_FEE_RATE, HL)
  assert.throws(() => takerFeeRate('other'), /Unknown cost model/)
  assert.equal(account(newAccount()).costModel, 'original')
})

test('1. original: same balances as before, every fill at 0.07%', async () => {
  const id = newAccount('original')
  await scenario(id)
  near(account(id).currentCash, scenarioCash(OG) - interestOf(id), 'cash') // 1011.25 - 1.029875 = 1010.220125
  near(account(id).marginUsed, 0, 'marginUsed')
  const f = fills(id)
  assert.deepEqual(f.map((t) => t.feeRate), [OG, OG, OG, OG, OG])
  f.forEach((t, i) => near(t.commission, NOTIONALS[i]! * OG, `fill ${i} fee`, 1e-12))
  const rep = assertReconciled(id, PRICES)
  assert.equal(rep.cost_model.model, 'original')
  assert.deepEqual(rep.cost_model.fee_rates_applied, [OG])
  near(rep.pnl.fees, OG * 1471.25, 'report fees', 1e-4)
})

test('2. hyperliquid: 0.045% on open, partial close, full close, LONG and SHORT', async () => {
  const id = newAccount('hyperliquid')
  await scenario(id)
  near(account(id).currentCash, scenarioCash(HL) - interestOf(id), 'cash') // 1011.25 - 0.6620625 = 1010.5879375
  near(account(id).marginUsed, 0, 'marginUsed')
  const f = fills(id)
  assert.deepEqual(f.map((t) => t.feeRate), [HL, HL, HL, HL, HL])
  f.forEach((t, i) => {
    near(t.commission, NOTIONALS[i]! * HL, `fill ${i} commission`, 1e-12)
    near(t.takerFee, NOTIONALS[i]! * HL, `fill ${i} taker fee`, 1e-12)
  })
  near(f[0]!.commission, 0.225, '500 USDC open')
  near(f[1]!.commission, 0.09225, 'partial close')
  const rep = assertReconciled(id, PRICES)
  assert.equal(rep.cost_model.model, 'hyperliquid')
  assert.match(rep.cost_model.note, /commissione taker perpetual di Hyperliquid al livello base/)
  assert.match(rep.cost_model.note, /NON ancora modellati: esecuzione al bid\/ask e slippage/)
  assert.ok(fills(id).every((t) => t.interestCharged === 0), 'no original interest (funding instead, 006I-2)')
  // the gap between the models is only the fee difference
  near(account(id).currentCash + interestOf(id) - scenarioCash(OG), (OG - HL) * 1471.25, 'difference = fees only', 1e-9)
})

test('3. hyperliquid: liquidation fill at 0.045% (cross margin rule since 006I-3)', async () => {
  // the monitor scans every account: leave only this one's position open
  rawDb.prepare('UPDATE positions SET quantity = 0, available_quantity = 0').run()
  const id = newAccount('hyperliquid')
  await fill(id, 'SOL', 'LONG', 90, 10, 100) // notional 9000: fee 4.05, margin 900
  near(account(id).currentCash, 1000 - 900 - 4.05, 'cash after open')
  // at 93 the author's rule would liquidate (365.95 < 0.5 * 900); the cross rule does not:
  // account value 365.95 > maintenance 8370 / 40 = 209.25
  quote('SOL', 93)
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'SOL').quantity, 90, 'kept at 93')
  quote('SOL', 91) // account value 185.95 < maintenance 8190 / 40 = 204.75
  await (new TaskScheduler() as any).checkMarginLevels()
  assert.equal(position(id, 'SOL').quantity, 0, 'liquidated at 91')
  const liq = fills(id).at(-1)!
  near(liq.commission, 8190 * HL, 'liquidation fee') // 3.6855
  assert.equal(liq.feeRate, HL)
  near(account(id).currentCash, 1000 - 4.05 - 810 - 3.6855, 'cash after liquidation', 1e-9)
  const rep = assertReconciled(id, { ...PRICES, SOL: 91 })
  assert.equal(rep.operations.liquidations, 1)
})

test('4. report if_closed uses the account fee', async () => {
  const hl = newAccount('hyperliquid')
  await fill(hl, 'BTC', 'LONG', 0.00625, 2, 80000)
  const og = newAccount('original')
  await fill(og, 'BTC', 'LONG', 0.00625, 2, 80000)
  const hlRep = assertReconciled(hl, { BTC: 80000 })
  const ogRep = assertReconciled(og, { BTC: 80000 })
  near(hlRep.if_closed.closing_fees_estimated, 0.225, 'hyperliquid closing fee', 1e-6)
  near(ogRep.if_closed.closing_fees_estimated, 0.35, 'original closing fee', 1e-6)
  near(hlRep.if_closed.net_usdc, -0.45, 'hyperliquid net if closed', 1e-4)
  near(ogRep.if_closed.net_usdc, -0.7, 'original net if closed', 1e-4)
  assert.match(hlRep.if_closed.basis, /modello hyperliquid 0\.045%/)
  // a fill whose rate does not match the account's model is reported
  rawDb.prepare('UPDATE trades SET fee_rate = 0.0007 WHERE account_id = ?').run(hl)
  const tampered = buildReport({ dbFile, accountId: hl, prices: { BTC: 80000 } })
  assert.equal(tampered.reconciliation.ok, false)
  assert.ok(tampered.issues.some((i: string) => /diverso dal modello hyperliquid/.test(i)))
})

test('5. the model cannot change after creation (API, repository, SQL)', async () => {
  const id = newAccount('hyperliquid')
  const put = (body: unknown) =>
    accountRoutes.request(`/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  rawDb.prepare("UPDATE accounts SET is_active = 'true' WHERE id = ?").run(id)
  cacheAll()
  const refused = await put({ cost_model: 'original' })
  assert.equal(refused.status, 400)
  assert.match(await refused.text(), /cannot be changed/)
  const same = await put({ cost_model: 'hyperliquid', name: 'renamed' })
  assert.equal(same.status, 200)
  assert.equal(((await same.json()) as any).cost_model, 'hyperliquid')
  updateAccount(id, { name: 'again' } as any)
  assert.throws(() => rawDb.prepare("UPDATE accounts SET cost_model = 'original' WHERE id = ?").run(id), /cannot be changed/)
  assert.throws(() => db.update(accounts).set({ costModel: 'original' }).where(eq(accounts.id, id)).run(), /cannot be changed/)
  assert.equal(account(id).costModel, 'hyperliquid')
  rawDb.prepare("UPDATE accounts SET is_active = 'false' WHERE id = ?").run(id)
  stopScheduler()
})

test('6. creation: request, ALPHA_COST_MODEL, default, invalid', async () => {
  cacheAll()
  const create = async (body: Record<string, unknown>) => {
    const res = await accountRoutes.request('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `c-${++seq}`, initial_capital: 1000, ...body }) })
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : await res.text() }
  }
  try {
    assert.equal((await create({})).body.cost_model, 'original', 'default')
    assert.equal((await create({ cost_model: 'hyperliquid' })).body.cost_model, 'hyperliquid', 'requested')
    process.env.ALPHA_COST_MODEL = 'hyperliquid'
    const fromEnv = await create({})
    assert.equal(fromEnv.body.cost_model, 'hyperliquid', 'environment')
    assert.equal(account(fromEnv.body.id).costModel, 'hyperliquid', 'stored')
    assert.equal((await create({ cost_model: 'original' })).body.cost_model, 'original', 'request wins over environment')
    process.env.ALPHA_COST_MODEL = 'binance'
    const badEnv = await create({})
    assert.equal(badEnv.status, 400)
    delete process.env.ALPHA_COST_MODEL
    const bad = await create({ cost_model: 'HYPERLIQUID' })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body), /Invalid cost_model/)
  } finally {
    delete process.env.ALPHA_COST_MODEL
    rawDb.prepare("UPDATE accounts SET is_active = 'false'").run()
    stopScheduler()
  }
})

test('7. AI path: same prompt, sizing and decision under both models; only the fee differs', async () => {
  cacheAll()
  decision = { operation: 'open', symbol: 'ETH', direction: 'long', target_portion_of_balance: 0.5, leverage: 2, reason: 'test' }
  const run = async (model: 'original' | 'hyperliquid') => {
    const id = newAccount(model, true)
    await placeAIDrivenCryptoOrder()
    return { id, prompt: prompts[`key-${seq}`]!, eth: position(id, 'ETH'), fill: fills(id)[0]! }
  }
  const og = await run('original')
  const hl = await run('hyperliquid')
  assert.equal(hl.prompt, og.prompt, 'identical prompt')
  assert.deepEqual(
    [hl.eth.quantity, hl.eth.leverage, hl.eth.side, hl.eth.avgCost, hl.eth.margin],
    [og.eth.quantity, og.eth.leverage, og.eth.side, og.eth.avgCost, og.eth.margin],
    'identical position',
  )
  assert.equal(og.eth.quantity, 0.208333) // 500 / 2400
  near(og.fill.commission, 0.208333 * 2400 * OG, 'original fee', 1e-12)
  near(hl.fill.commission, 0.208333 * 2400 * HL, 'hyperliquid fee', 1e-12)
  near(account(og.id).currentCash - account(hl.id).currentCash, -(OG - HL) * 0.208333 * 2400, 'cash gap = fee gap', 1e-9)
})
