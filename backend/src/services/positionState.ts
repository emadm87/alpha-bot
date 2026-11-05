/**
 * Real state, memory and costs of the open positions, as shown to the AI
 * (Task 009D-clean). Read only: nothing here changes the engine, its fees,
 * its interest or how orders execute.
 *
 * 1. Position data: current price, P&L (LONG and SHORT), fees, interest and
 *    duration, from the positions and trades the engine records.
 * 2. Memory: the reason given when the position was opened and the last
 *    decisions with their reasons, read from ai_decision_logs (persistent,
 *    already written for every decision); bounded.
 * 4. Costs: the engine's own taker fee and interest, and an estimate of the
 *    exit spread from Hyperliquid's impact prices already received with the
 *    prices (this paper engine fills at the last price and charges no spread).
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiDecisionLogs, CRYPTO_TAKER_FEE_RATE, trades, type Position } from '../db/schema.js'
import { dbDateMs } from '../utils/datetime.js'
import { getAssetContext } from './hyperliquid.js'
import { calculatePositionInterest } from './orderExecutorLeverage.js'
import { TICKER_MAX_AGE_MS } from './quantData.js'

export const MEMORY_LIMITS = { recentDecisions: 3, maxReasonChars: 160, maxEntryReasonChars: 240 } as const

const r4 = (x: number) => Math.round(x * 1e4) / 1e4
const r6 = (x: number) => Math.round(x * 1e6) / 1e6
const cut = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}

/** Fills of the current position (since the coin was last flat): opening time, fees and gross P&L of partial closes. */
export function positionLifecycle(accountId: number, symbol: string) {
  const rows = db.select().from(trades).where(and(eq(trades.accountId, accountId), eq(trades.symbol, symbol)))
    .orderBy(asc(trades.tradeTime), asc(trades.id)).all()
  let qty = 0, avg = 0, openedAt: number | null = null, fees = 0, realized = 0, side: string | null = null
  for (const t of rows) {
    if (t.side === 'LONG' || t.side === 'SHORT') {
      if (qty <= 1e-12) { openedAt = dbDateMs(t.tradeTime); fees = 0; realized = 0; avg = 0; side = t.side }
      avg = (avg * qty + t.price * t.quantity) / (qty + t.quantity)
      qty += t.quantity
      fees += t.commission
    } else if (t.side === 'SELL' || t.side === 'BUY') {
      const q = Math.min(t.quantity, qty)
      realized += side === 'SHORT' ? (avg - t.price) * q : (t.price - avg) * q
      fees += t.commission
      qty -= q
    }
  }
  return { openedAt: qty > 1e-12 ? openedAt : null, feesPaid: fees, realizedGross: realized }
}

/** Estimated half spread per unit from Hyperliquid's impact bid/ask, if received in the last minute; else null. */
function halfSpread(symbol: string, now: number): number | null {
  const ctx = getAssetContext(symbol)
  const imp = ctx?.info?.impactPxs
  if (!ctx || now - ctx.receivedAt > TICKER_MAX_AGE_MS || !Array.isArray(imp) || imp.length !== 2) return null
  const bid = Number(imp[0]), ask = Number(imp[1])
  return Number.isFinite(bid) && Number.isFinite(ask) && ask >= bid && bid > 0 ? (ask - bid) / 2 : null
}

export interface PositionState {
  side: string
  quantity: number
  leverage: number
  avg_cost: number
  current_price: number | null
  entry_value: number
  current_value: number | null
  unrealized_pnl: number | null
  realized_pnl_partial_closes: number
  fees_paid: number
  estimated_exit_fee: number | null
  interest_charged: number
  interest_accrued: number
  estimated_net_pnl_if_closed_now: number | null
  estimated_exit_spread_usdc: number | null
  opened_at: string | null
  holding_minutes: number | null
  price_issue?: string
}

/**
 * One open position as the AI sees it. The net result is what this engine
 * would book if it closed the whole position now at `price`: P&L of the
 * remaining quantity and of partial closes, minus the fees paid and the exit
 * fee, minus the interest charged and accrued. The exit spread is NOT in it
 * (this engine charges none); its estimate is given apart.
 */
export function positionState(accountId: number, pos: Position, price: number | null, now = Date.now(), priceIssue?: string): PositionState {
  const side = (pos.side ?? 'LONG').toUpperCase()
  const life = positionLifecycle(accountId, pos.symbol)
  const accrued = calculatePositionInterest(pos)
  const base: PositionState = {
    side, quantity: pos.quantity, leverage: pos.leverage, avg_cost: pos.avgCost, current_price: null,
    entry_value: r4(pos.quantity * pos.avgCost), current_value: null, unrealized_pnl: null,
    realized_pnl_partial_closes: r6(life.realizedGross), fees_paid: r6(life.feesPaid), estimated_exit_fee: null,
    interest_charged: r6(pos.accumulatedInterest), interest_accrued: r6(accrued), estimated_net_pnl_if_closed_now: null,
    estimated_exit_spread_usdc: null,
    opened_at: life.openedAt === null ? null : new Date(life.openedAt).toISOString(),
    holding_minutes: life.openedAt === null ? null : Math.max(0, Math.round((now - life.openedAt) / 60_000)),
  }
  if (price === null || !(price > 0)) return { ...base, price_issue: priceIssue ?? 'no current price' }
  const unrealized = side === 'SHORT' ? (pos.avgCost - price) * pos.quantity : (price - pos.avgCost) * pos.quantity
  const exitFee = price * pos.quantity * CRYPTO_TAKER_FEE_RATE
  const hs = halfSpread(pos.symbol, now)
  return {
    ...base, current_price: price, current_value: r4(pos.quantity * price), unrealized_pnl: r4(unrealized), estimated_exit_fee: r6(exitFee),
    estimated_net_pnl_if_closed_now: r4(unrealized + life.realizedGross - life.feesPaid - exitFee - pos.accumulatedInterest - accrued),
    estimated_exit_spread_usdc: hs === null ? null : r6(hs * pos.quantity),
  }
}

export interface PositionMemory {
  entry_reason: string | null
  entry_note?: string
  decisions_since_entry: Record<string, number>
  recent_decisions: { minutes_ago: number; operation: string; symbol: string | null; executed: boolean; reason: string }[]
}

/** The reason that opened the position and the decisions since (bounded), from ai_decision_logs. */
export function positionMemory(accountId: number, symbol: string, openedAt: number, now = Date.now()): PositionMemory {
  const logs = db.select().from(aiDecisionLogs).where(eq(aiDecisionLogs.accountId, accountId))
    .orderBy(desc(aiDecisionLogs.id)).limit(500).all()
    .map((l) => ({ ...l, at: dbDateMs(l.decisionTime) }))
    .filter((l) => l.at >= openedAt - 600_000)
  const entry = logs.find((l) => l.operation === 'open' && l.symbol === symbol && l.executed === 'true' && l.at <= openedAt + 120_000)
  const since = logs.filter((l) => (entry ? l.id > entry.id : l.at >= openedAt))
  const counts: Record<string, number> = {}
  for (const l of since) counts[l.operation] = (counts[l.operation] ?? 0) + 1
  return {
    entry_reason: entry ? cut(entry.reason, MEMORY_LIMITS.maxEntryReasonChars) : null,
    ...(entry ? {} : { entry_note: 'the decision that opened this position is not recorded' }),
    decisions_since_entry: counts,
    recent_decisions: since.slice(0, MEMORY_LIMITS.recentDecisions).map((l) => ({
      minutes_ago: Math.max(0, Math.round((now - l.at) / 60_000)), operation: l.operation, symbol: l.symbol,
      executed: l.executed === 'true', reason: cut(l.reason, MEMORY_LIMITS.maxReasonChars),
    })),
  }
}
