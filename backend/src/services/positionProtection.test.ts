/**
 * Profit protection and the corrected AI position information against the
 * real engine, database and monitor (Task 007A).
 *
 * Run: npx tsx --test src/services/positionProtection.test.ts
 *
 * Throwaway SQLite file; the ccxt exchange is the stub of the cross-margin
 * tests (chosen mid/mark prices, zero-spread l2Book at the mid, the real
 * `meta` snapshot); no network. Account of 1000 USDC, BTC 0.01 at 80000 with
 * 4x leverage: notional 800, margin 200, opening fee 0.36 (0.045%), so
 * R = min(2% x 1000, 50% x 200) = 20 USDC and 1000 USDC of price move = 10 USDC
 * of P&L. The estimated exit fee is 0.045% of the notional at the mark. The
 * base of R is the account value without unrealized P&L when the position is
 * first seen, i.e. after the opening fee: 999.64, so R = 19.9928.
 */
import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protection-test-'))
const dbFile = path.join(tmpDir, 'test.db')
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, fundingPayments, orders, positionProtection, positions, protectionEvents, trades, users } = await import('../db/schema.js')
const { and, eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { TaskScheduler } = await import('./scheduler.js')
const { resetMarginTables } = await import('./hyperliquidMarket.js')
const { resetFundingRates } = await import('./fundingSettlement.js')
const { runProtectionPass, foldLifecycle } = await import('./positionProtection.js')
const { buildPrompt, getPortfolioData } = await import('./aiDecision.js')
const { hyperliquidStub, installHyperliquidStub, quote, clearPrices } = await import('./__fixtures__/hyperliquidStub.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

ensureSchema()
installHyperliquidStub()
const user = db.insert(users).values({ username: 'default', isActive: 'true' }).returning().get()
after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const setEnv = (protection: 'on' | 'off', config?: object, info: 'v1' | 'v2' = 'v1') => {
  process.env.ALPHA_PROTECTION = protection
  process.env.ALPHA_POSITION_INFO = info
  if (config) process.env.ALPHA_PROTECTION_CONFIG = JSON.stringify(config)
  else delete process.env.ALPHA_PROTECTION_CONFIG
}
beforeEach(() => {
  rawDb.exec(
    'DELETE FROM protection_events; DELETE FROM position_protection; DELETE FROM liquidation_events; DELETE FROM funding_payments; ' +
      'DELETE FROM funding_oracle_prices; DELETE FROM book_fills; DELETE FROM trades; DELETE FROM positions; DELETE FROM orders; DELETE FROM accounts',
  )
  hyperliquidStub.quotes = {}
  hyperliquidStub.failTickers = false
  hyperliquidStub.failMeta = false
  hyperliquidStub.failBook = false
  hyperliquidStub.books = {}
  resetMarginTables()
  resetFundingRates()
  clearPrices()
  setEnv('on')
})

let seq = 0
function newAccount(costModel: 'original' | 'hyperliquid' = 'hyperliquid', capital = 1000): number {
  return db.insert(accounts).values({
    userId: user.id, name: `p-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
    initialCapital: capital, currentCash: capital, maintenanceMarginRatio: 0.5, costModel,
  }).returning().get().id
}
const account = (id: number) => db.select().from(accounts).where(eq(accounts.id, id)).get()!
const position = (id: number, s = 'BTC') => db.select().from(positions).where(and(eq(positions.accountId, id), eq(positions.symbol, s))).get()
const events = (id: number) => db.select().from(protectionEvents).where(eq(protectionEvents.accountId, id)).all()
const kinds = (id: number) => events(id).map((e) => `${e.kind}:${e.status}`)
const stateOf = (id: number) => db.select().from(positionProtection).where(eq(positionProtection.accountId, id)).all()
const closes = (id: number) => db.select().from(trades).where(eq(trades.accountId, id)).all().filter((t) => t.side === 'SELL' || t.side === 'BUY')
async function open(id: number, side: 'LONG' | 'SHORT', price: number, quantity = 0.01, leverage = 4, symbol = 'BTC') {
  quote(symbol, price)
  return placeAndExecuteCrypto({ account: account(id), symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage })
}
const monitor = () => (new TaskScheduler() as any).checkMarginLevels() as Promise<void>
/** Moves the market and lets the real monitor run once (5 s in production). */
async function step(price: number) {
  quote('BTC', price)
  await monitor()
}
const R = 0.02 * (1000 - 0.36)
const near = (a: number, b: number, what: string, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
function reconciled(id: number, price: number) {
  const rep = buildReport({ dbFile, accountId: id, prices: { BTC: price }, at: new Date().toISOString() })
  assert.deepEqual(rep.issues, [], 'report issues')
  assert.equal(rep.reconciliation.ok, true)
  return rep
}

test('1. off by default: the same loss that triggers an exit when on changes nothing', async () => {
  setEnv('off')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await step(77800) // -22 USDC, past the loss limit
  assert.equal(position(id)!.quantity, 0.01)
  assert.deepEqual(events(id), [])
  assert.deepEqual(stateOf(id), [])
})

test('2. LONG: break-even and trailing armed in turn, then a profit protection exit; costs, accounting and trail recorded', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await step(82000) // +20 gross, net 19.27: below +1R
  assert.deepEqual(kinds(id), [])
  await step(82300) // +23: net 22.27 >= 1R -> break-even floor
  assert.deepEqual(kinds(id), ['breakeven_armed:info'])
  await step(84500) // +45: net 44.14 >= 2R -> trailing, floor = peak x 0.5
  assert.deepEqual(kinds(id), ['breakeven_armed:info', 'trailing_armed:info'])
  const [s] = stateOf(id)
  assert.equal(s!.stage, 2)
  near(s!.peakNet, 45 - 0.36 - 0.01 * 84500 * 0.00045, 'peak net')
  await step(83000) // net 29.1 > floor 22.07: held
  assert.equal(position(id)!.quantity, 0.01)
  await step(82000) // net 19.27 <= 22.07 -> exit
  assert.equal(position(id)!.quantity, 0)
  assert.deepEqual(kinds(id), ['breakeven_armed:info', 'trailing_armed:info', 'exit_profit_protection:executed'])
  const exit = events(id).at(-1)!
  assert.match(exit.orderNo!, /^PRT-/)
  near(exit.fillPrice!, 82000, 'exit fill (book at the mid)')
  near(exit.filledQuantity!, 0.01, 'filled')
  assert.equal(exit.fraction, 1)
  assert.equal(exit.stage, 2)
  near(exit.riskUsdc, R, 'R')
  assert.match(exit.reason, /profit protection exit: .* trailing floor .* = peak .* x \(1 - 0\.5\)/)
  const detail = JSON.parse(exit.detail)
  assert.equal(detail.input.side, 'LONG')
  assert.equal(detail.config.giveBackFraction, 0.5)
  // the close is a normal engine close: taker fee on the notional, margin released, state closed
  const [close] = closes(id)
  near(close!.commission, 0.01 * 82000 * 0.00045, 'closing fee')
  near(account(id).currentCash, 1000 + 20 - 0.36 - 0.369, 'cash = capital + P&L - both fees')
  assert.notEqual(stateOf(id)[0]!.closedAt, null)
  const order = db.select().from(orders).where(eq(orders.accountId, id)).all().find((o) => o.orderNo === exit.orderNo)!
  assert.equal(order.side, 'SELL')
  assert.equal(order.status, 'FILLED')
  const rep = reconciled(id, 82000)
  // the report shows the protection decisions and one timeline with the AI's
  assert.deepEqual(rep.protection.counts, { 'breakeven_armed:info': 1, 'trailing_armed:info': 1, 'exit_profit_protection:executed': 1 })
  assert.equal(rep.protection.positions[0].stage, 2)
  assert.deepEqual(rep.decision_trace.map((d: any) => `${d.source}:${d.action}`), ['protection:exit_profit_protection'])
  // flat: nothing more happens
  await step(90000)
  assert.equal(events(id).length, 3)
})

test('3. SHORT: risk exit at -R (the loss limit nothing had lifted); mirrors LONG', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await step(81000) // -10
  await step(82000) // -20 gross, net -20.73 <= -20
  assert.equal(position(id)!.quantity, 0)
  assert.deepEqual(kinds(id), ['exit_risk:executed'])
  const e = events(id)[0]!
  assert.equal(e.stage, 0)
  assert.ok(e.netPnl <= -20)
  near(e.floor, -R, 'floor = -R')
  assert.match(e.reason, /^risk exit: net result -20\.\d+ USDC <= loss limit -19\.9928/)
  near(account(id).currentCash, 1000 - 20 - 0.36 - 0.369, 'cash')
  reconciled(id, 82000)
})

test('4. SHORT profit protection (break-even floor): a short that was winning is not allowed to turn into a loss', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await step(77700) // +23 gross: net ~22.3 >= 1R
  assert.deepEqual(kinds(id), ['breakeven_armed:info'])
  await step(79990) // +0.1 gross: net -0.6 <= 0 -> exit at break-even
  assert.equal(position(id)!.quantity, 0)
  assert.equal(events(id).at(-1)!.kind, 'exit_profit_protection')
  assert.equal(events(id).at(-1)!.stage, 1)
  reconciled(id, 79990)
})

test('5. partial close: trailing exit of 50%, margin released pro rata, no second exit at once, accounting reconciles', async () => {
  setEnv('on', { trailExitFraction: 0.5, retryAfterMs: 1000 })
  const id = newAccount()
  await open(id, 'LONG', 80000, 0.02, 4) // notional 1600, margin 400: R = min(20, 200) = 20; 1000 move = 20
  await step(81500) // +30
  await step(82500) // +50: net ~49 >= 2R
  assert.equal(stateOf(id)[0]!.stage, 2)
  const peak = stateOf(id)[0]!.peakNet
  await step(81800) // +36 -> net 34.8 > floor 24.6: held
  assert.equal(position(id)!.quantity, 0.02)
  await step(81200) // +24 -> net 23.0 <= floor 24.6 -> partial exit
  const e = events(id).at(-1)!
  assert.equal(e.kind, 'exit_profit_protection')
  assert.equal(e.status, 'executed')
  assert.equal(e.fraction, 0.5)
  near(e.filledQuantity!, 0.01, 'half closed')
  near(position(id)!.quantity, 0.01, 'half left')
  near(position(id)!.margin!, 200, 'margin released pro rata')
  const [s] = stateOf(id)
  assert.equal(s!.partialExits, 1)
  assert.equal(s!.closedAt, null)
  assert.ok(s!.peakNet < peak, 'the peak restarted from the net result')
  const exits = events(id).length
  await step(81200) // same market, next monitor run: no second exit
  assert.equal(events(id).length, exits)
  assert.equal(closes(id).length, 1)
  reconciled(id, 81200)
  // the second half goes later by the same rules (net > 0: another 50% of what is left)
  await new Promise((r) => setTimeout(r, 1100)) // after the pause between two exit attempts
  await step(83500)
  await step(81000)
  assert.ok(closes(id).length >= 2, 'a later exit of the rest')
  reconciled(id, 81000)
})

test('6. stale or missing mark: no protection decision (the monitor cannot evaluate), no event, no close', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await step(84500)
  assert.equal(stateOf(id)[0]!.stage, 2)
  const before = events(id).length
  quote('BTC', 81000, undefined) // no markPx in the asset context: the monitor skips
  await monitor()
  assert.equal(position(id)!.quantity, 0.01)
  assert.equal(events(id).length, before)
  // and the direct pass without a mark does not decide either
  const summary = await runProtectionPass(account(id), db.select().from(positions).where(eq(positions.accountId, id)).all(), { BTC: null })
  assert.equal(summary.evaluated, 0)
  assert.match(summary.skipped.join(), /BTC: no valid mark price/)
})

test('7. original cost model: untouched even with the module on', async () => {
  const id = newAccount('original')
  await open(id, 'LONG', 80000)
  await step(77000)
  assert.equal(position(id)!.quantity, 0.01)
  assert.deepEqual(events(id), [])
  const summary = await runProtectionPass(account(id), db.select().from(positions).where(eq(positions.accountId, id)).all(), { BTC: 77000 })
  assert.deepEqual(summary, { evaluated: 0, exits: 0, failed: 0, skipped: [] })
})

test('8. execution failure (no book): failed event, position kept, retry only after the pause, then it closes', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  const rows = () => db.select().from(positions).where(eq(positions.accountId, id)).all()
  quote('BTC', 82500)
  hyperliquidStub.failBook = true
  const t0 = Date.now()
  const first = await runProtectionPass(account(id), rows(), { BTC: 82500 }, t0)
  assert.equal(first.failed, 1)
  assert.equal(position(id)!.quantity, 0.01)
  assert.deepEqual(kinds(id), ['exit_risk:failed'])
  assert.match(JSON.parse(events(id)[0]!.detail).error, /book/i)
  await runProtectionPass(account(id), rows(), { BTC: 82500 }, t0 + 5_000)
  assert.equal(events(id).length, 1, 'no new attempt within the pause')
  hyperliquidStub.failBook = false
  const later = await runProtectionPass(account(id), rows(), { BTC: 82500 }, t0 + 20_000)
  assert.equal(later.exits, 1)
  assert.equal(position(id)!.quantity, 0)
  assert.deepEqual(kinds(id), ['exit_risk:failed', 'exit_risk:executed'])
  reconciled(id, 82500)
})

test('9. funding counts: funding paid since the open brings the position to its loss limit', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  const opened = trades_firstFillMs(id)
  // -14 gross, -0.36 entry fee, -0.36 exit fee: net -14.7, above the limit
  await step(78600)
  assert.equal(position(id)!.quantity, 0.01)
  db.insert(fundingPayments).values({
    accountId: id, symbol: 'BTC', fundingTime: Math.floor(opened / 3_600_000) * 3_600_000 + 3_600_000, status: 'settled',
    side: 'LONG', quantity: 0.01, oraclePrice: 80000, fundingRate: 0.00625, amount: -5.5,
  }).run()
  await step(78600)
  assert.equal(position(id)!.quantity, 0, 'funding of -5.5 pushed the net result to about -20.2')
  const e = events(id).at(-1)!
  assert.equal(e.kind, 'exit_risk')
  near(JSON.parse(e.detail).input.fundingNet, -5.5, 'funding in the decision')
  // a funding row of another coin or not settled is not counted
})

function trades_firstFillMs(id: number): number {
  const t = db.select().from(trades).where(eq(trades.accountId, id)).all()[0]!
  return Date.parse(String(t.tradeTime).replace(' ', 'T') + (String(t.tradeTime).includes('Z') ? '' : 'Z'))
}

test('10. an AI close first: the state closes quietly, no protection event, no second close', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await step(84500)
  assert.equal(stateOf(id)[0]!.stage, 2)
  quote('BTC', 84000)
  await placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'SELL', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 4 })
  const n = events(id).length
  await step(70000) // flat: the monitor has nothing to evaluate for this account
  assert.equal(events(id).length, n)
  assert.equal(closes(id).length, 1)
  assert.equal(position(id)!.quantity, 0)
})

test('11. a position reopened after a close is a new position with its own R, peak and fees', async () => {
  const id = newAccount()
  await open(id, 'LONG', 80000)
  await step(84500)
  const first = stateOf(id)[0]!
  quote('BTC', 84500)
  await placeAndExecuteCrypto({ account: account(id), symbol: 'BTC', name: 'BTC', side: 'SELL', orderType: 'MARKET', price: null, quantity: 0.01, leverage: 4 })
  await new Promise((r) => setTimeout(r, 1100)) // trade times have a resolution of one second
  await open(id, 'SHORT', 84500)
  await step(84500)
  const states = stateOf(id)
  assert.equal(states.length, 2)
  assert.notEqual(first && stateOf(id).find((s) => s.side === 'LONG')!.closedAt, null, 'the closed position state is closed by the next pass')
  const second = states.find((s) => s.side === 'SHORT')!
  assert.equal(second.stage, 0)
  assert.ok(second.peakNet < first.peakNet)
  assert.notEqual(second.openedAt, first.openedAt)
})

test('12. concurrent passes close the position once', async () => {
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  quote('BTC', 82500)
  const rows = () => db.select().from(positions).where(eq(positions.accountId, id)).all()
  await Promise.all([runProtectionPass(account(id), rows(), { BTC: 82500 }), runProtectionPass(account(id), rows(), { BTC: 82500 })])
  assert.equal(position(id)!.quantity, 0)
  assert.equal(closes(id).length, 1)
  assert.equal(events(id).filter((e) => e.status === 'executed').length, 1)
  reconciled(id, 82500)
})

test('13. lifecycle from the fills: fees, partial realized P&L, reset on a full close', () => {
  const t = (side: string, price: number, quantity: number, ms: number, commission = 0.1) => ({ side, price, quantity, commission, ms })
  const life = foldLifecycle([t('LONG', 100, 2, 1), t('LONG', 110, 2, 2), t('SELL', 120, 1, 3)])
  assert.equal(life.openedAt, 1)
  near(life.feesPaid, 0.3, 'fees')
  near(life.realizedGross, 15, 'realized on 1 unit at average 105')
  near(life.quantity, 3, 'quantity left')
  const flat = foldLifecycle([t('SHORT', 100, 1, 1), t('BUY', 90, 1, 2), t('LONG', 50, 1, 5)])
  assert.equal(flat.openedAt, 5)
  near(flat.feesPaid, 0.1, 'a new position starts its own fees')
  assert.equal(foldLifecycle([t('LONG', 100, 1, 1), t('SELL', 101, 1, 2)]).openedAt, null)
})

// --- what the AI is shown ------------------------------------------------------------------

const promptOf = (p: Awaited<ReturnType<typeof getPortfolioData>>) => buildPrompt(p, { BTC: 80000 }, 'news')

test('14. v1 (default): the AI sees exactly the original fields, current_value = quantity x avg_cost, the original header', async () => {
  setEnv('off', undefined, 'v1')
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  await step(82000)
  const p = await getPortfolioData(account(id))
  assert.deepEqual(p.positions.BTC, { quantity: 0.01, avg_cost: 80000, current_value: 800, side: 'SHORT', leverage: 4 })
  assert.ok(promptOf(p).includes('- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):'))
})

test('15. v2: entry value apart from current value, price, P&L, costs, funding and holding time (SHORT)', async () => {
  setEnv('off', undefined, 'v2')
  const id = newAccount()
  await open(id, 'SHORT', 80000)
  const opened = trades_firstFillMs(id)
  db.insert(fundingPayments).values({
    accountId: id, symbol: 'BTC', fundingTime: Math.floor(opened / 3_600_000) * 3_600_000 + 3_600_000, status: 'settled',
    side: 'SHORT', quantity: 0.01, oraclePrice: 80000, fundingRate: -0.0001, amount: 0.08,
  }).run()
  quote('BTC', 78000, 78100) // mid 78000, mark 78100
  await monitor()
  const p = await getPortfolioData(account(id))
  const v = p.positions.BTC as any
  assert.equal(v.entry_value, 800)
  assert.equal(v.avg_cost, 80000)
  assert.equal(v.current_price, 78100)
  assert.equal(v.price_basis, 'mark')
  near(v.current_value, 781, 'current value = quantity x mark')
  assert.notEqual(v.current_value, v.entry_value)
  near(v.unrealized_pnl, 19, 'SHORT gains when the price falls')
  near(v.fees_paid, 0.36, 'entry fee')
  near(v.estimated_exit_fee, 781 * 0.00045, 'exit fee at the current value')
  near(v.financing_net, 0.08, 'funding received')
  near(v.estimated_net_pnl_if_closed_now, 19 - 0.36 - 781 * 0.00045 + 0.08, 'net if closed now', 1e-4)
  near(v.return_on_margin_pct, (v.estimated_net_pnl_if_closed_now / 200) * 100, 'return on margin', 1e-3)
  assert.equal(v.margin, 200)
  assert.equal(v.side, 'SHORT')
  assert.ok(v.holding_minutes >= 0 && v.holding_minutes <= 1)
  assert.equal(new Date(v.opened_at).getTime() <= Date.now(), true)
  const text = promptOf(p)
  assert.ok(text.includes('estimated_net_pnl_if_closed_now'))
  assert.ok(text.includes('entry_value (quantity x avg_cost, the value at entry)'))
  // the decision log keeps the share at entry, as before
  assert.equal(typeof v.entry_value, 'number')
})

test('16. v2 without a price: the price-based fields are null with the reason, nothing invented', async () => {
  setEnv('off', undefined, 'v2')
  const id = newAccount()
  await open(id, 'LONG', 80000)
  clearPrices()
  hyperliquidStub.failTickers = true
  const v = (await getPortfolioData(account(id))).positions.BTC as any
  assert.equal(v.current_price, null)
  assert.equal(v.current_value, null)
  assert.equal(v.unrealized_pnl, null)
  assert.equal(v.estimated_net_pnl_if_closed_now, null)
  assert.match(v.price_issue, /price unavailable/)
  assert.equal(v.entry_value, 800)
  assert.equal(v.fees_paid, 0.36)
})

test('17. v2 for the original model: interest instead of funding, fee at 0.07%', async () => {
  setEnv('off', undefined, 'v2')
  const id = newAccount('original')
  await open(id, 'LONG', 80000)
  quote('BTC', 81000)
  const v = (await getPortfolioData(account(id))).positions.BTC as any
  assert.equal(v.price_basis, 'mid')
  near(v.fees_paid, 0.56, 'original fee 0.07% of 800')
  near(v.estimated_exit_fee, 0.01 * 81000 * 0.0007, 'exit fee')
  assert.ok(v.financing_net <= 0, 'interest is a cost')
  near(v.unrealized_pnl, 10, 'LONG')
})
