/**
 * Decision memory of the v4 prompt (Task 008, ALPHA_PROMPT=v4 only).
 *
 * v3 showed the last 6 decisions with their full reason and thesis: the model
 * read its own earlier assessment every cycle (a possible anchor; observed in
 * the 2 Nov pilot as repeated bearish holds, not proven to be the cause). v4:
 * - the earlier decisions are listed WITHOUT their reasoning text (what was
 *   done and what the engine did, with the levels given for a trade);
 * - what changed since the last decision is computed for ALL six coins (v4
 *   stores a snapshot of every coin with each decision), so a HOLD with no
 *   symbol is no longer a blind spot (in v3 its price change was null).
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiDecisionsV3 } from '../db/schema.js'
import { changesSince, type BriefSnapshot } from './marketContext.js'
import { MEMORY_LIMITS, V3_COINS } from './v3Context.js'

const r2 = (x: number) => Math.round(x * 100) / 100
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export interface V4MemoryItem {
  minutes_ago: number
  operation: string | null
  symbol: string | null
  direction: string | null
  /** What the engine did (executed, hold, rejected, no_decision...). */
  outcome: string | null
  invalidation_price: number | null
  target_price: number | null
}
export interface V4CoinChange { price_then: number | null; price_now: number | null; change_pct: number | null; changes: string[] }
export interface V4Memory {
  recent: V4MemoryItem[]
  last_decision_minutes_ago: number | null
  /** Per coin, since the last recorded decision; null when there is none in the last 24 h. */
  since_last_decision: Record<string, V4CoinChange> | null
}

/** The v4 memory at `now`, from the decisions recorded in ai_decisions_v3 (v3 or v4 rows). */
export function memoryV4(accountId: number, now: number, snapshots: Record<string, BriefSnapshot>, prices: Record<string, number | null>): V4Memory {
  const rows = db.select().from(aiDecisionsV3)
    .where(and(eq(aiDecisionsV3.accountId, accountId), gte(aiDecisionsV3.at, now - MEMORY_LIMITS.maxAgeMs), lte(aiDecisionsV3.at, now)))
    .orderBy(desc(aiDecisionsV3.at), desc(aiDecisionsV3.id)).limit(MEMORY_LIMITS.maxDecisions).all()
  const recent = rows.map((r) => {
    const d = JSON.parse(r.decision) as Record<string, unknown>
    const traded = r.operation === 'open' || r.operation === 'close'
    return {
      minutes_ago: Math.round((now - r.at) / 60_000), operation: r.operation, symbol: r.symbol, direction: traded ? r.direction : null,
      outcome: r.outcome ? r.outcome.split(':')[0]! : null,
      invalidation_price: traded ? num(d.invalidation_price) : null, target_price: traded ? num(d.target_price) : null,
    }
  })
  const last = rows[0]
  if (!last) return { recent, last_decision_minutes_ago: null, since_last_decision: null }
  const c = JSON.parse(last.context) as { prices?: Record<string, number | null>; snapshots?: Record<string, BriefSnapshot> }
  const since: Record<string, V4CoinChange> = {}
  for (const coin of V3_COINS) {
    const then = c.prices?.[coin] ?? null, nowP = prices[coin] ?? null
    const snapThen = c.snapshots?.[coin], snapNow = snapshots[coin]
    since[coin] = {
      price_then: then, price_now: nowP, change_pct: then && nowP ? r2((nowP / then - 1) * 100) : null,
      // full comparison when the earlier decision stored the snapshots (v4); otherwise the price only
      changes: snapThen && snapNow ? changesSince(snapThen, snapNow) : [],
    }
  }
  return { recent, last_decision_minutes_ago: Math.round((now - last.at) / 60_000), since_last_decision: since }
}
