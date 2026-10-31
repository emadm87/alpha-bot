/**
 * Runtime of the profit protection module (Task 007A, experimental): reads
 * positions, fills and funding from the database, applies the pure rules of
 * profitProtection.ts at fresh mark prices, executes an exit through the
 * normal engine close path and records every change in protection_events.
 * Also builds the corrected position information sent to the AI.
 *
 * Off unless ALPHA_PROTECTION=on and only for the 'hyperliquid' cost model;
 * ALPHA_POSITION_INFO=v2 switches the AI's position information. With both
 * at their defaults nothing here runs and the original behaviour is intact.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  fundingPayments,
  positionProtection,
  positions as positionsTable,
  protectionEvents,
  takerFeeRate,
  trades,
  type Account,
  type Position,
} from '../db/schema.js'
import { dbDateMs } from '../utils/datetime.js'
import { getLogger } from '../utils/logger.js'
import { positionMargin } from './assetCalculator.js'
import { marksFromAssetContexts } from './hyperliquidMarginData.js'
import { getLastPrice } from './marketData.js'
import { TICKER_MAX_AGE_MS } from './quantData.js'
import {
  afterPartialExit,
  evaluate,
  foldLifecycle,
  initialState,
  loadProtectionConfig,
  netResult,
  type Lifecycle,
  type ProtectionConfig,
  type ProtectionDecision,
  type ProtectionInput,
  type ProtectionState,
  type Side,
} from './profitProtection.js'

const logger = getLogger('services.positionProtection')

// ---------------------------------------------------------------- lifecycle

export { foldLifecycle, type FillRow, type Lifecycle } from './profitProtection.js'

export function positionLifecycle(accountId: number, symbol: string): Lifecycle & { fundingNet: number } {
  const rows = db.select().from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.symbol, symbol)))
    .orderBy(asc(trades.tradeTime), asc(trades.id)).all()
  const life = foldLifecycle(rows.map((t) => ({
    side: t.side, price: t.price, quantity: t.quantity, commission: t.commission, ms: dbDateMs(t.tradeTime),
  })))
  let fundingNet = 0
  if (life.openedAt !== null) {
    for (const f of db.select().from(fundingPayments)
      .where(and(eq(fundingPayments.accountId, accountId), eq(fundingPayments.symbol, symbol))).all()) {
      if (f.status === 'settled' && f.fundingTime >= life.openedAt) fundingNet += f.amount
    }
  }
  return { ...life, fundingNet }
}

// ---------------------------------------------------------------- the pass

export interface ProtectionSummary {
  evaluated: number
  exits: number
  failed: number
  skipped: string[]
}

/** Counters since start (pilot report, tests). */
export const protectionStats = { passes: 0, evaluations: 0, holds: 0, exits: 0, failedExits: 0, skippedNoMark: 0 }

const asSide = (s: string | null): Side | null => (s === 'LONG' || s === 'SHORT' ? s : null)

function recordEvent(
  account: Account, p: { symbol: string; side: Side; openedAt: number }, now: number,
  kind: string, status: string, mark: number, d: ProtectionDecision,
  extra: { fraction?: number; quantityRequested?: number; orderNo?: string; filledQuantity?: number; fillPrice?: number } = {},
  detail: unknown = {},
): void {
  db.insert(protectionEvents).values({
    accountId: account.id, symbol: p.symbol, side: p.side, openedAt: p.openedAt, triggeredAt: now,
    kind, status, markPrice: mark, netPnl: d.net, peakNet: d.peakNet, floor: d.floor, riskUsdc: d.riskUsdc,
    rMultiple: d.rMultiple, stage: d.stage, fraction: extra.fraction ?? null, quantityRequested: extra.quantityRequested ?? null,
    orderNo: extra.orderNo ?? null, filledQuantity: extra.filledQuantity ?? null, fillPrice: extra.fillPrice ?? null,
    reason: d.reason, detail: JSON.stringify(detail),
  }).run()
}

/**
 * One protection pass for an account at the marks given (valid and fresh:
 * the margin monitor only calls this when it could evaluate every position).
 * Never throws: a failure is logged and the monitor goes on.
 */
export async function runProtectionPass(
  account: Account,
  rows: Position[],
  marks: Record<string, number | null | undefined>,
  now = Date.now(),
  config: ProtectionConfig = loadProtectionConfig(),
): Promise<ProtectionSummary> {
  const summary: ProtectionSummary = { evaluated: 0, exits: 0, failed: 0, skipped: [] }
  if (!config.enabled || account.costModel !== 'hyperliquid') return summary
  protectionStats.passes++
  try {
    const open = rows.filter((r) => r.quantity > 0 && asSide(r.side))
    const equityBase = account.currentCash + rows.filter((r) => r.quantity > 0).reduce((s, r) => s + positionMargin(r), 0)
    const openKeys = new Set<string>()

    for (const pos of open) {
      const side = asSide(pos.side)!
      const markValue = marks[pos.symbol]
      const mark = typeof markValue === 'number' && markValue > 0 ? markValue : 0
      const life = positionLifecycle(account.id, pos.symbol)
      if (life.openedAt === null) { summary.skipped.push(`${pos.symbol}: no fills found for the open position`); continue }
      openKeys.add(`${pos.symbol}:${life.openedAt}`)
      if (!(mark > 0)) {
        protectionStats.skippedNoMark++
        summary.skipped.push(`${pos.symbol}: no valid mark price`)
        continue
      }
      const input: ProtectionInput = {
        side, quantity: pos.quantity, avgCost: pos.avgCost, price: mark, margin: positionMargin(pos),
        equityBase, realizedGross: life.realizedGross, feesPaid: life.feesPaid, fundingNet: life.fundingNet,
        exitFeeRate: takerFeeRate(account.costModel),
      }
      const stored = db.select().from(positionProtection).where(and(
        eq(positionProtection.accountId, account.id), eq(positionProtection.symbol, pos.symbol),
        eq(positionProtection.openedAt, life.openedAt))).get()
      const prev: ProtectionState = stored
        ? { stage: stored.stage as 0 | 1 | 2, riskUsdc: stored.riskUsdc, peakNet: stored.peakNet, partialExits: stored.partialExits }
        : initialState(input, config)
      // the risk base is fixed when the position is first seen, not moved by later marks
      const evalInput = stored ? { ...input, equityBase: stored.equityBase } : input
      const { state, decision } = evaluate(prev, evalInput, config)
      summary.evaluated++
      protectionStats.evaluations++

      const keyRow = { accountId: account.id, symbol: pos.symbol, openedAt: life.openedAt }
      db.insert(positionProtection).values({
        ...keyRow, side, riskUsdc: state.riskUsdc, equityBase: stored?.equityBase ?? equityBase, stage: state.stage,
        peakNet: state.peakNet, partialExits: state.partialExits, lastNet: decision.net, lastFloor: decision.floor,
        lastMark: mark, updatedAt: now,
      }).onConflictDoUpdate({
        target: [positionProtection.accountId, positionProtection.symbol, positionProtection.openedAt],
        set: {
          riskUsdc: state.riskUsdc, stage: state.stage, peakNet: state.peakNet, partialExits: state.partialExits,
          lastNet: decision.net, lastFloor: decision.floor, lastMark: mark, updatedAt: now,
        },
      }).run()

      const detail = { input: evalInput, config, lifecycle: life }
      for (const t of decision.transitions) {
        recordEvent(account, { symbol: pos.symbol, side, openedAt: life.openedAt }, now, t, 'info', mark, decision, {}, detail)
        logger.info(`🛡️ Protection ${t}: ${account.name} ${side} ${pos.symbol} net ${decision.net.toFixed(4)} peak ${decision.peakNet.toFixed(4)} R ${decision.riskUsdc.toFixed(4)}`)
      }

      if (decision.action !== 'exit') { protectionStats.holds++; continue }
      if (stored?.lastExitAttempt && now - stored.lastExitAttempt < config.retryAfterMs) continue
      db.update(positionProtection).set({ lastExitAttempt: now }).where(and(
        eq(positionProtection.accountId, account.id), eq(positionProtection.symbol, pos.symbol),
        eq(positionProtection.openedAt, life.openedAt))).run()

      const result = await executeExit(account, pos.symbol, side, decision, mark, now, life.openedAt, detail)
      if (result.ok) {
        summary.exits++
        protectionStats.exits++
        if (result.closedAll) {
          db.update(positionProtection).set({ closedAt: now }).where(and(
            eq(positionProtection.accountId, account.id), eq(positionProtection.symbol, pos.symbol),
            eq(positionProtection.openedAt, life.openedAt))).run()
        } else if ((decision.fraction ?? 1) < 1 && result.filled > 0) {
          const next = afterPartialExit(state, decision.net)
          db.update(positionProtection).set({ peakNet: next.peakNet, partialExits: next.partialExits }).where(and(
            eq(positionProtection.accountId, account.id), eq(positionProtection.symbol, pos.symbol),
            eq(positionProtection.openedAt, life.openedAt))).run()
        }
      } else {
        summary.failed++
        protectionStats.failedExits++
      }
    }

    // positions that are no longer open: close their state
    for (const s of db.select().from(positionProtection)
      .where(and(eq(positionProtection.accountId, account.id), isNull(positionProtection.closedAt))).all()) {
      if (!openKeys.has(`${s.symbol}:${s.openedAt}`)) {
        db.update(positionProtection).set({ closedAt: now }).where(and(
          eq(positionProtection.accountId, s.accountId), eq(positionProtection.symbol, s.symbol),
          eq(positionProtection.openedAt, s.openedAt))).run()
      }
    }
  } catch (e) {
    logger.error(`Profit protection pass failed for account ${account.name}: ${e}`)
  }
  return summary
}

async function executeExit(
  account: Account, symbol: string, side: Side, d: ProtectionDecision, mark: number, now: number,
  openedAt: number, detail: unknown,
): Promise<{ ok: boolean; filled: number; closedAll: boolean }> {
  const kind = d.kind === 'risk' ? 'exit_risk' : 'exit_profit_protection'
  const orderNo = `PRT-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`
  const key = { symbol, side, openedAt }
  let requested = 0
  try {
    // re-read: the AI cycle or another close may have changed the position
    const current = db.select().from(positionsTable).where(and(
      eq(positionsTable.accountId, account.id), eq(positionsTable.symbol, symbol), eq(positionsTable.market, 'CRYPTO'))).get()
    const latest = db.select().from(accounts).where(eq(accounts.id, account.id)).get()
    if (!current || current.quantity <= 0 || current.side !== side || !latest) {
      recordEvent(account, key, now, kind, 'failed', mark, d, { fraction: d.fraction, orderNo }, { ...(detail as object), error: 'position already closed or changed' })
      return { ok: false, filled: 0, closedAll: false }
    }
    const fraction = d.fraction ?? 1
    requested = fraction >= 1 ? current.quantity : Number((current.quantity * fraction).toFixed(6))
    const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
    const order = await placeAndExecuteCrypto({
      account: latest, symbol, name: current.name, side: side === 'LONG' ? 'SELL' : 'BUY', orderType: 'MARKET',
      price: null, quantity: requested, leverage: current.leverage, orderNo,
    })
    const after = db.select().from(positionsTable).where(eq(positionsTable.id, current.id)).get()
    const closedAll = !after || after.quantity <= 1e-9
    const status = order.filledQuantity + 1e-12 >= requested ? 'executed' : 'partial'
    recordEvent(account, key, now, kind, status, mark, d,
      { fraction, quantityRequested: requested, orderNo, filledQuantity: order.filledQuantity, fillPrice: order.price ?? undefined },
      { ...(detail as object), remaining: after?.quantity ?? 0 })
    logger.warning(
      `🛡️ PROTECTION EXIT (${d.kind}): ${account.name} ${side === 'LONG' ? 'SELL' : 'BUY'} ${order.filledQuantity} ${symbol} ` +
        `at ${order.price}${status === 'partial' ? ` (book filled only part of ${requested}; ${after?.quantity ?? 0} still open)` : ''}. ${d.reason}`,
    )
    return { ok: true, filled: order.filledQuantity, closedAll }
  } catch (e) {
    recordEvent(account, key, now, kind, 'failed', mark, d,
      { fraction: d.fraction, quantityRequested: requested || undefined, orderNo }, { ...(detail as object), error: String(e) })
    logger.error(`Protection exit failed for ${account.name} ${symbol}: ${e}`)
    return { ok: false, filled: 0, closedAll: false }
  }
}

// ---------------------------------------------------------------- AI position information

/**
 * Price of a position for the AI: the same basis as the account equity
 * (calcAccountEquity): the mark price of the 'hyperliquid' model when valid
 * and fresh, otherwise the last (mid) price; an error is reported, not hidden.
 */
export async function currentPriceFor(
  account: Account, symbol: string,
): Promise<{ value: number; basis: 'mark' | 'mid' } | { issue: string }> {
  try {
    let value = await getLastPrice(symbol, 'CRYPTO')
    let basis: 'mark' | 'mid' = 'mid'
    if (account.costModel === 'hyperliquid') {
      const quote = marksFromAssetContexts([symbol])[symbol]!
      const age = quote.receivedAt === null ? Infinity : Date.now() - quote.receivedAt
      if (quote.markPrice !== null && age <= TICKER_MAX_AGE_MS) { value = quote.markPrice; basis = 'mark' }
    }
    return { value, basis }
  } catch (e) {
    return { issue: `price unavailable: ${e}` }
  }
}

const r6 = (x: number) => Number(x.toFixed(6))
const r4 = (x: number) => Number(x.toFixed(4))

export interface PositionView {
  quantity: number
  avg_cost: number
  side: string
  leverage: number
  entry_value: number
  current_price: number | null
  price_basis: 'mark' | 'mid' | null
  current_value: number | null
  unrealized_pnl: number | null
  margin: number
  fees_paid: number
  estimated_exit_fee: number | null
  financing_net: number
  realized_pnl_partial_closes: number
  estimated_net_pnl_if_closed_now: number | null
  return_on_margin_pct: number | null
  opened_at: string | null
  holding_minutes: number | null
  price_issue?: string
}

/**
 * The position as the AI is shown it with ALPHA_POSITION_INFO=v2. The
 * original `current_value` was quantity * avg_cost, i.e. the value at ENTRY
 * whatever the price did; here `entry_value` is that and `current_value` is
 * quantity * current price. Without a valid price the price-based fields are
 * null and the reason is given: nothing is invented.
 *
 * estimated_net_pnl_if_closed_now = unrealized P&L at the current price +
 * realized P&L of partial closes - all fees paid - estimated exit fee +
 * financing (hyperliquid: funding settled; original: interest charged and
 * accrued, negative). Spread and book depth of the exit are not included.
 */
export function buildPositionView(
  account: Account, pos: Position, price: { value: number; basis: 'mark' | 'mid' } | { issue: string },
  accruedInterest: number, now = Date.now(),
): PositionView {
  const side = asSide(pos.side) ?? 'LONG'
  const life = positionLifecycle(account.id, pos.symbol)
  const margin = positionMargin(pos)
  const financing = account.costModel === 'hyperliquid' ? life.fundingNet : -(pos.accumulatedInterest + accruedInterest)
  const view: PositionView = {
    quantity: pos.quantity, avg_cost: pos.avgCost, side, leverage: pos.leverage,
    entry_value: r4(pos.quantity * pos.avgCost),
    current_price: null, price_basis: null, current_value: null, unrealized_pnl: null, margin: r4(margin),
    fees_paid: r6(life.feesPaid), estimated_exit_fee: null, financing_net: r6(financing),
    realized_pnl_partial_closes: r6(life.realizedGross),
    estimated_net_pnl_if_closed_now: null, return_on_margin_pct: null,
    opened_at: life.openedAt === null ? null : new Date(life.openedAt).toISOString(),
    holding_minutes: life.openedAt === null ? null : Math.max(0, Math.round((now - life.openedAt) / 60_000)),
  }
  if ('issue' in price) {
    view.price_issue = price.issue
    return view
  }
  const net = netResult({
    side, quantity: pos.quantity, avgCost: pos.avgCost, price: price.value, margin, equityBase: 0,
    realizedGross: life.realizedGross, feesPaid: life.feesPaid, fundingNet: financing, exitFeeRate: takerFeeRate(account.costModel),
  })
  view.current_price = price.value
  view.price_basis = price.basis
  view.current_value = r4(pos.quantity * price.value)
  view.unrealized_pnl = r4(net.unrealized)
  view.estimated_exit_fee = r6(net.exitFee)
  view.estimated_net_pnl_if_closed_now = r4(net.net)
  view.return_on_margin_pct = margin > 0 ? r4((net.net / margin) * 100) : null
  return view
}

/** Writes the experiment configuration to the log at startup, so a run says what it ran. */
export function describeExperiment(env: Record<string, string | undefined> = process.env): string {
  const cfg = loadProtectionConfig(env)
  const info = (env.ALPHA_POSITION_INFO ?? 'v1').trim().toLowerCase()
  return `Experiment config: position_info=${info} protection=${cfg.enabled ? 'on' : 'off'}${cfg.enabled ? ` config=${JSON.stringify(cfg)}` : ''}`
}
