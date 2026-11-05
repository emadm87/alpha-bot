/**
 * Context of the hybrid prompt (Task 009D, ALPHA_PROMPT=hybrid only): what the
 * original prompt (v1) lacked to manage an open position, built from data the
 * engine already records. Nothing is invented: a value that is not recorded is
 * null and said so.
 *
 * - Position memory, per open position: the decision that opened it (reason,
 *   the invalidation the model stated, the data of that moment), how many
 *   decisions since, and the last few with their reasons (bounded).
 * - Costs actually paid on the account so far (fees, spread/slippage measured
 *   on the fills, funding) and, per open position, the slippage paid at entry
 *   as the estimate of the exit slippage.
 * - Per coin: taker fee and current hourly funding (live asset context).
 *
 * Every hybrid decision is recorded in ai_decisions_v3 (the table of the v3
 * prompt, Task 007F) with the data shown at that moment; the outcome is added
 * by the order loop as for v3.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiDecisionLogs, aiDecisionsV3, bookFills, fundingPayments, positions as positionsTable, takerFeeRate, trades, type Account } from '../db/schema.js'
import { dbDateMs } from '../utils/datetime.js'
import { positionLifecycle } from './positionProtection.js'
import { liveFromAssetContext, V3_COINS } from './v3Context.js'

export const HYBRID_LIMITS = {
  /** Decisions since entry shown per position (newest first). */
  recentDecisions: 3,
  maxReasonChars: 160,
  maxEntryReasonChars: 240,
  maxInvalidationChars: 160,
} as const

const r4 = (x: number) => Math.round(x * 1e4) / 1e4
const cut = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export interface HybridEntry {
  source: 'hybrid decision' | 'original decision log'
  minutes_ago: number
  reason: string
  /** As stated by the model when opening; null when it stated none (never invented). */
  invalidation: string | null
  /** The data shown when the position was opened (hybrid decisions only). */
  at_entry: { price: number | null; total_assets_usdc: number | null; cash_usdc: number | null; target_portion: number | null; leverage: number | null } | null
}
export interface HybridMemory {
  entry: HybridEntry | null
  entry_note?: string
  decisions_since_entry: Record<string, number>
  recent_decisions: { minutes_ago: number; operation: string | null; symbol: string | null; outcome: string | null; reason: string }[]
}

/** The memory of one open position, from the recorded decisions (bounded). */
export function positionMemory(accountId: number, symbol: string, openedAt: number, now: number): HybridMemory {
  const rows = db.select().from(aiDecisionsV3)
    .where(and(eq(aiDecisionsV3.accountId, accountId), gte(aiDecisionsV3.at, openedAt - 600_000), lte(aiDecisionsV3.at, now)))
    .orderBy(desc(aiDecisionsV3.at), desc(aiDecisionsV3.id)).all()
    .filter((r) => (JSON.parse(r.context) as { prompt?: string }).prompt === 'hybrid')
  // the decision that opened it: an executed open of this coin just before the first fill
  const entryRow = rows.find((r) => r.operation === 'open' && r.symbol === symbol && r.executed === 1 && r.at <= openedAt + 120_000)
  let entry: HybridEntry | null = null
  let note: string | undefined
  if (entryRow) {
    const d = JSON.parse(entryRow.decision) as Record<string, unknown>
    const c = JSON.parse(entryRow.context) as { prices?: Record<string, number>; total_assets?: number; cash?: number }
    const inv = cut(d.invalidation, HYBRID_LIMITS.maxInvalidationChars)
    entry = {
      source: 'hybrid decision', minutes_ago: Math.round((now - entryRow.at) / 60_000), reason: cut(d.reason, HYBRID_LIMITS.maxEntryReasonChars),
      invalidation: inv || null,
      at_entry: { price: num(c.prices?.[symbol]), total_assets_usdc: num(c.total_assets), cash_usdc: num(c.cash),
        target_portion: num(d.target_portion_of_balance), leverage: num(d.leverage) },
    }
  } else {
    const log = db.select().from(aiDecisionLogs)
      .where(and(eq(aiDecisionLogs.accountId, accountId), eq(aiDecisionLogs.symbol, symbol), eq(aiDecisionLogs.operation, 'open'), eq(aiDecisionLogs.executed, 'true')))
      .orderBy(desc(aiDecisionLogs.id)).limit(20).all()
      .find((l) => { const t = dbDateMs(l.decisionTime); return t <= openedAt + 120_000 && t >= openedAt - 600_000 })
    if (log) entry = { source: 'original decision log', minutes_ago: Math.round((now - dbDateMs(log.decisionTime)) / 60_000), reason: cut(log.reason, HYBRID_LIMITS.maxEntryReasonChars), invalidation: null, at_entry: null }
    else note = 'the decision that opened this position is not recorded (e.g. opened by another process or before this run)'
  }
  const since = rows.filter((r) => r.at >= (entryRow?.at ?? openedAt) && r.id !== entryRow?.id)
  const counts: Record<string, number> = {}
  for (const r of since) counts[r.operation ?? 'none'] = (counts[r.operation ?? 'none'] ?? 0) + 1
  return {
    entry, ...(note ? { entry_note: note } : {}), decisions_since_entry: counts,
    recent_decisions: since.slice(0, HYBRID_LIMITS.recentDecisions).map((r) => ({
      minutes_ago: Math.round((now - r.at) / 60_000), operation: r.operation, symbol: r.symbol,
      outcome: r.outcome ? r.outcome.split(':')[0]! : null, reason: cut((JSON.parse(r.decision) as Record<string, unknown>).reason, HYBRID_LIMITS.maxReasonChars),
    })),
  }
}

/** Slippage paid on fills against the book (|average fill - mid| x quantity), from book_fills. */
function slippageOf(rows: { avgPrice: number; mid: number; filledQuantity: number }[]) {
  return rows.reduce((s, f) => s + Math.abs(f.avgPrice - f.mid) * f.filledQuantity, 0)
}

export interface HybridPositionCosts {
  /** Slippage paid by the fills that opened the position (null without book fills, e.g. the original cost model). */
  entry_slippage_usdc: number | null
  /** Exit slippage estimated with the per-unit slippage of the entry fills. */
  estimated_exit_slippage_usdc: number | null
}

/** Costs measured on one open position's entry fills. */
export function positionCosts(accountId: number, symbol: string, side: string, quantity: number, openedAt: number): HybridPositionCosts {
  const bookSide = side === 'SHORT' ? 'sell' : 'buy'
  const fills = db.select().from(bookFills)
    .where(and(eq(bookFills.accountId, accountId), eq(bookFills.symbol, symbol), eq(bookFills.bookSide, bookSide), gte(bookFills.receivedAt, openedAt - 60_000))).all()
  const qty = fills.reduce((s, f) => s + f.filledQuantity, 0)
  if (!fills.length || !(qty > 0)) return { entry_slippage_usdc: null, estimated_exit_slippage_usdc: null }
  const paid = slippageOf(fills)
  return { entry_slippage_usdc: r4(paid), estimated_exit_slippage_usdc: r4((paid / qty) * quantity) }
}

export interface AccountCosts {
  taker_fee_pct_each_side: number
  fees_paid_usdc: number
  slippage_paid_usdc: number | null
  funding_net_usdc: number
  opens: number
  closes: number
  per_coin: Record<string, { funding_hourly_pct: number | null; funding_age_s: number | null }>
}

/** What trading has cost the account so far, and the per-coin rates in force. */
export function accountCosts(account: Account, now: number): AccountCosts {
  const t = db.select().from(trades).where(eq(trades.accountId, account.id)).all()
  const fills = db.select().from(bookFills).where(eq(bookFills.accountId, account.id)).all()
  const funding = db.select().from(fundingPayments).where(eq(fundingPayments.accountId, account.id)).all().filter((f) => f.status === 'settled')
  const perCoin: AccountCosts['per_coin'] = {}
  for (const c of V3_COINS) {
    const live = liveFromAssetContext(c)
    perCoin[c] = {
      funding_hourly_pct: live.funding === null ? null : Math.round(live.funding * 1e8) / 1e6,
      funding_age_s: live.receivedAt === null ? null : Math.round((now - live.receivedAt) / 1000),
    }
  }
  return {
    taker_fee_pct_each_side: Math.round(takerFeeRate(account.costModel) * 1e5) / 1e3,
    fees_paid_usdc: r4(t.reduce((s, x) => s + (x.commission ?? 0), 0)),
    slippage_paid_usdc: fills.length ? r4(slippageOf(fills)) : null,
    funding_net_usdc: r4(funding.reduce((s, f) => s + f.amount, 0)),
    opens: t.filter((x) => x.side === 'LONG' || x.side === 'SHORT').length,
    closes: t.filter((x) => x.side === 'SELL' || x.side === 'BUY').length,
    per_coin: perCoin,
  }
}

export interface HybridPositionExtra { symbol: string; costs: HybridPositionCosts; memory: HybridMemory }

/** Memory and measured costs of every open position of the account. */
export function hybridPositions(account: Account, now: number): HybridPositionExtra[] {
  const rows = db.select().from(positionsTable).where(and(eq(positionsTable.accountId, account.id), eq(positionsTable.market, 'CRYPTO'))).all()
  const out: HybridPositionExtra[] = []
  for (const pos of rows) {
    if (!(pos.quantity > 0) || !pos.side) continue
    const openedAt = positionLifecycle(account.id, pos.symbol).openedAt
    if (openedAt === null) continue
    out.push({ symbol: pos.symbol, costs: positionCosts(account.id, pos.symbol, pos.side.toUpperCase(), pos.quantity, openedAt), memory: positionMemory(account.id, pos.symbol, openedAt, now) })
  }
  return out
}

/** Notes on a hybrid answer (recorded, never blocking: the engine's checks decide what executes). */
export function hybridNotes(decision: Record<string, unknown>, openPositions: number): string[] {
  const notes: string[] = []
  const op = typeof decision.operation === 'string' ? decision.operation.toLowerCase() : ''
  if (openPositions > 0 && !(typeof decision.position_review === 'string' && decision.position_review.trim())) notes.push('no position_review with open positions')
  if (op === 'open' && !(typeof decision.invalidation === 'string' && decision.invalidation.trim())) notes.push('open without a stated invalidation')
  return notes
}

/** Records one hybrid decision with the data shown at that moment; returns the row id. */
export function recordHybridDecision(
  accountId: number, cycleId: string | undefined, now: number, decision: Record<string, unknown>,
  shown: { prices: Record<string, number>; total_assets: number; cash: number; open_positions: string[]; prompt_chars: number }, notes: string[],
): number {
  const symbol = typeof decision.symbol === 'string' ? decision.symbol.toUpperCase().slice(0, 20) : null
  return db.insert(aiDecisionsV3).values({
    accountId, at: now, cycleId: cycleId ?? null,
    operation: typeof decision.operation === 'string' ? decision.operation.toLowerCase().slice(0, 10) : null,
    symbol, direction: typeof decision.direction === 'string' ? decision.direction.toLowerCase().slice(0, 5) : null,
    valid: 1, issues: JSON.stringify(notes), decision: JSON.stringify(decision),
    context: JSON.stringify({ prompt: 'hybrid', ...shown }), executed: null, outcome: null,
  }).returning({ id: aiDecisionsV3.id }).get().id
}
