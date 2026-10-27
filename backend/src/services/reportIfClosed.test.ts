/**
 * Pilot report: result if every open position were closed now (Task 006H-5).
 *
 * pilot/report.mjs keeps the recorded result (equity, P&L, fees and interest
 * already charged) and adds `if_closed`: the engine's closing fee on each
 * open position at the final price plus the interest accrued and not yet
 * charged. Fees and interest already in cash are not counted again.
 *
 * Run: npx tsx --test src/services/reportIfClosed.test.ts
 *
 * Throwaway SQLite file, real engine fills at prices injected into the cache,
 * last_interest_time moved back to accrue interest, no network. Expected
 * values are worked out here from the engine's rules.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-if-closed-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, users, CRYPTO_TAKER_FEE_RATE, CRYPTO_INTEREST_RATE_HOURLY } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { utcNow } = await import('../utils/datetime.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport, engineConstant } = (await import(reportModule)) as {
  buildReport: (o: Record<string, unknown>) => any
  engineConstant: (name: string, text?: string) => number
}

ensureSchema()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const FEE = 0.0007
const RATE = 0.0000125
const AT = new Date()
const at = AT.toISOString()

let seq = 0
function newAccount(): number {
  return db.insert(accounts).values({
    userId: user.id, name: `rep-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
async function fill(id: number, symbol: string, side: string, quantity: number, leverage: number, price: number) {
  cachePrice(symbol, 'CRYPTO', price)
  await placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
/** Moves the position's last interest charge `hours` before `from`. */
function back(id: number, symbol: string, hours: number, from = Date.now()) {
  rawDb.prepare('UPDATE positions SET last_interest_time = ? WHERE account_id = ? AND symbol = ?')
    .run(utcNow(new Date(from - hours * 3_600_000)), id, symbol)
}
function near(actual: unknown, expected: number, what: string, eps = 1e-4) {
  assert.equal(typeof actual, 'number', `${what}: ${actual}`)
  assert.ok(Math.abs((actual as number) - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
const report = (id: number, prices: Record<string, number>) => buildReport({ dbFile, accountId: id, prices, at })

/** The recorded result is unchanged and if_closed = recorded - closing fees - accrued interest. */
function assertIdentity(rep: any) {
  assert.equal(rep.reconciliation.ok, true, JSON.stringify(rep.issues))
  const c = rep.if_closed
  assert.equal(c.complete, true)
  near(c.final_equity_usdc, rep.capital.final_equity - c.closing_fees_estimated - c.accrued_interest_not_charged, 'equity if closed')
  near(c.net_usdc, rep.pnl.net_usdc - c.closing_fees_estimated - c.accrued_interest_not_charged, 'net if closed')
  near(c.net_pct, (c.net_usdc / 1000) * 100, 'net % if closed')
  near(c.accrued_interest_not_charged, rep.pnl.accrued_interest_not_charged, 'same accrued figure as the pnl section', 1e-6)
  near(rep.pnl.net_usdc, rep.pnl.gross_usdc - rep.pnl.fees - rep.pnl.interest_charged, 'recorded net')
}

test('0. the report reads the engine constants from src/db/schema.ts', () => {
  assert.equal(engineConstant('CRYPTO_TAKER_FEE_RATE'), CRYPTO_TAKER_FEE_RATE)
  assert.equal(engineConstant('CRYPTO_INTEREST_RATE_HOURLY'), CRYPTO_INTEREST_RATE_HOURLY)
  assert.throws(() => engineConstant('CRYPTO_TAKER_FEE_RATE', 'export const OTHER = 1'), /non trovata/)
})

test('1. LONG open (the 24 h pilot case): about -0.16 USDC if closed', async () => {
  // 500 USDC BTC LONG 2x: fee 0.35, borrowed 250; 23.9168 h -> 250 * 0.0000125 * h = 0.07474
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.00625, 2, 80000)
  back(id, 'BTC', 23.9168, AT.getTime())
  const finalBtc = 80000 + (0.2676 + 0.35) / 0.00625 // recorded net +0.2676 -> 80098.816
  const rep = report(id, { BTC: finalBtc })
  near(rep.capital.final_equity, 1000.2676, 'recorded equity')
  near(rep.pnl.net_usdc, 0.2676, 'recorded net')
  near(rep.pnl.fees, 0.35, 'fees charged')
  near(rep.pnl.interest_charged, 0, 'interest charged')
  const c = rep.if_closed
  near(c.closing_fees_estimated, 0.00625 * finalBtc * FEE, 'closing fee', 1e-6) // 0.350432
  near(c.accrued_interest_not_charged, 250 * RATE * 23.9168, 'accrued', 1e-6) // 0.07474
  near(c.net_usdc, 0.2676 - 0.350432 - 0.07474, 'net if closed') // -0.157572
  near(c.final_equity_usdc, 1000 - 0.157572, 'equity if closed')
  assert.deepEqual(c.positions.map((p: any) => [p.symbol, p.side]), [['BTC', 'LONG']])
  assertIdentity(rep)
})

test('2. SHORT open in profit', async () => {
  const id = newAccount()
  await fill(id, 'ETH', 'SHORT', 0.1, 3, 2400) // fee 0.168, borrowed 160
  back(id, 'ETH', 10, AT.getTime())
  const rep = report(id, { ETH: 2300 })
  near(rep.pnl.unrealized, 10, 'unrealized')
  near(rep.pnl.net_usdc, 10 - 0.168, 'recorded net')
  near(rep.if_closed.closing_fees_estimated, 0.1 * 2300 * FEE, 'closing fee', 1e-6) // 0.161
  near(rep.if_closed.accrued_interest_not_charged, 160 * RATE * 10, 'accrued', 1e-6) // 0.02
  near(rep.if_closed.net_usdc, 10 - 0.168 - 0.161 - 0.02, 'net if closed') // 9.651
  assertIdentity(rep)
})

test('3. several positions at once (LONG 2x, SHORT 3x, LONG 1x without interest)', async () => {
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.005, 2, 80000) // 400, fee 0.28, borrowed 200
  await fill(id, 'ETH', 'SHORT', 0.1, 3, 2400) // 240, fee 0.168, borrowed 160
  await fill(id, 'SOL', 'LONG', 2, 1, 100) // 200, fee 0.14, 1x: no interest
  back(id, 'BTC', 5, AT.getTime())
  back(id, 'ETH', 8, AT.getTime())
  back(id, 'SOL', 8, AT.getTime())
  const prices = { BTC: 78000, ETH: 2450, SOL: 105 }
  const rep = report(id, prices)
  near(rep.pnl.unrealized, -10 - 5 + 10, 'unrealized')
  const closingFee = FEE * (0.005 * 78000 + 0.1 * 2450 + 2 * 105)
  const accrued = 200 * RATE * 5 + 160 * RATE * 8
  near(rep.if_closed.closing_fees_estimated, closingFee, 'closing fees', 1e-6)
  near(rep.if_closed.accrued_interest_not_charged, accrued, 'accrued', 1e-6)
  near(rep.if_closed.net_usdc, -5 - FEE * 840 - closingFee - accrued, 'net if closed')
  assert.equal(rep.if_closed.positions.find((p: any) => p.symbol === 'SOL').accrued_interest, 0)
  assert.equal(rep.if_closed.open_positions, 3)
  assertIdentity(rep)
})

test('4. no open position: if_closed equals the recorded result', async () => {
  const id = newAccount()
  await fill(id, 'SOL', 'LONG', 2, 2, 100)
  await fill(id, 'SOL', 'SELL', 2, 2, 110)
  const rep = report(id, {})
  assert.equal(rep.if_closed.open_positions, 0)
  near(rep.if_closed.closing_fees_estimated, 0, 'no closing fee')
  near(rep.if_closed.accrued_interest_not_charged, 0, 'no accrued interest')
  near(rep.if_closed.net_usdc, rep.pnl.net_usdc, 'net unchanged')
  near(rep.if_closed.final_equity_usdc, rep.capital.final_equity, 'equity unchanged')
  assertIdentity(rep)
})

test('5. interest charged on a partial close is not counted again; only the rest accrues', async () => {
  const id = newAccount()
  await fill(id, 'BTC', 'LONG', 0.01, 4, 80000) // 800, fee 0.56, borrowed 600
  back(id, 'BTC', 10) // the partial close charges 600 * RATE * 10 = 0.075
  await fill(id, 'BTC', 'SELL', 0.005, 4, 80000) // fee 0.28, P&L 0
  back(id, 'BTC', 6, AT.getTime()) // remaining 0.005: borrowed 300 -> 300 * RATE * 6 = 0.0225
  const rep = report(id, { BTC: 80000 })
  near(rep.pnl.interest_charged, 0.075, 'charged', 1e-5)
  near(rep.pnl.fees, 0.84, 'fees charged')
  near(rep.pnl.net_usdc, -0.84 - 0.075, 'recorded net', 1e-5)
  near(rep.if_closed.accrued_interest_not_charged, 0.0225, 'accrued only on the rest', 1e-6)
  near(rep.if_closed.closing_fees_estimated, 0.28, 'closing fee', 1e-6)
  near(rep.if_closed.net_usdc, -0.84 - 0.075 - 0.28 - 0.0225, 'net if closed', 1e-5)
  assertIdentity(rep)
})

test('6. missing final price: no estimate, flagged', async () => {
  const id = newAccount()
  await fill(id, 'XRP', 'LONG', 100, 2, 1.3)
  const rep = report(id, {})
  assert.equal(rep.if_closed.complete, false)
  assert.equal(rep.if_closed.net_usdc, null)
  assert.equal(rep.if_closed.final_equity_usdc, null)
  assert.equal(rep.if_closed.positions[0].closing_fee, null)
  assert.ok(rep.issues.some((i: string) => i.includes('XRP: prezzo finale mancante')))
})

test('7. the report does not change the database', async () => {
  const dump = () =>
    (rawDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, rawDb.prepare(`SELECT * FROM ${name}`).all()])
  const before = JSON.stringify(dump())
  for (let id = 1; id <= seq; id++) report(id, { BTC: 80000, ETH: 2400, SOL: 100, XRP: 1.3 })
  assert.equal(JSON.stringify(dump()), before)
})
