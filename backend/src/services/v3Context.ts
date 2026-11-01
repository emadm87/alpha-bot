/**
 * Decision context of the v3 prompt (Task 007F, ALPHA_PROMPT=v3 only).
 *
 * Gathers, at the moment of the decision and from data available then:
 * - the account and every open position with its net result, holding time,
 *   highest/lowest price since entry, exit plan, risk on the account, the
 *   reason given at entry and what changed in the market since;
 * - the last decisions (at most 6, at most 24 h old) with what happened since;
 * - the market brief of the six coins from the local 1 h history (refreshed
 *   here, closed bars only) and the live asset context of the price path;
 * - the news of the last 24 h about the six coins or the market.
 * Nothing is invented: what is missing is null and said so.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  aiDecisionLogs, aiDecisionsV3, positions as positionsTable, positionWatch, takerFeeRate, type Account, type Position,
} from '../db/schema.js'
import { dbDateMs } from '../utils/datetime.js'
import { getLogger } from '../utils/logger.js'
import { loadExitConfig, type ExitConfig } from './exitRules.js'
import { getAssetContext, getCandleSnapshotFromHyperliquid } from './hyperliquid.js'
import { briefSnapshot, changesSince, coinBrief, sig, type BriefSnapshot, type CoinBrief, type LiveContext } from './marketContext.js'
import { HISTORY, loadHistory, refreshHistory, type FetchCandles, type HourBar } from './marketHistory.js'
import { fetchNewsItems, selectNews, type NewsItem, type NewsSelection } from './newsFeed.js'
import { calculatePositionInterest } from './orderExecutorLeverage.js'
import { activeCooldowns, buildPositionView, currentPriceFor, type PositionView } from './positionProtection.js'

const logger = getLogger('services.v3Context')

export const V3_COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'] as const
export const MEMORY_LIMITS = { maxDecisions: 6, maxAgeMs: 24 * 3_600_000, maxReasonChars: 220, maxThesisChars: 160 } as const

/** External inputs, replaced in tests (no network there). */
export interface V3Deps {
  fetchCandles: FetchCandles
  fetchNews: () => Promise<{ items: NewsItem[]; error?: string }>
  live: (symbol: string) => LiveContext
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** The live asset context kept by the last price request (no request is made). */
export function liveFromAssetContext(symbol: string): LiveContext {
  const ctx = getAssetContext(symbol)
  const i = ctx?.info ?? {}
  const imp = Array.isArray(i.impactPxs) ? i.impactPxs.map(num) : null
  return {
    markPx: num(i.markPx), midPx: num(i.midPx), funding: num(i.funding), premium: num(i.premium),
    openInterest: num(i.openInterest), dayNtlVlm: num(i.dayNtlVlm),
    impactPxs: imp && imp.length === 2 && imp[0] != null && imp[1] != null ? [imp[0], imp[1]] : null,
    receivedAt: ctx?.receivedAt ?? null,
  }
}

export const v3Deps: V3Deps = {
  fetchCandles: getCandleSnapshotFromHyperliquid,
  fetchNews: fetchNewsItems,
  live: liveFromAssetContext,
}

/** News already shown, by key -> first time (marks items as not new; bounded by selectNews). */
const newsSeen = new Map<string, number>()
export function resetV3State(): void {
  newsSeen.clear()
}

const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100)
const r4 = (x: number) => Math.round(x * 1e4) / 1e4
const cut = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > n ? `${t.slice(0, n - 3)}...` : t
}

/** Keeps the highest and lowest price seen while the position is open; returns them. */
export function watchPosition(accountId: number, symbol: string, openedAt: number, price: number, now: number) {
  const key = and(eq(positionWatch.accountId, accountId), eq(positionWatch.symbol, symbol), eq(positionWatch.openedAt, openedAt))
  const row = db.select().from(positionWatch).where(key).get()
  if (!row) {
    db.insert(positionWatch).values({ accountId, symbol, openedAt, maxPrice: price, minPrice: price, updatedAt: now }).run()
    return { maxPrice: price, minPrice: price }
  }
  const maxPrice = Math.max(row.maxPrice, price), minPrice = Math.min(row.minPrice, price)
  db.update(positionWatch).set({ maxPrice, minPrice, updatedAt: now }).where(key).run()
  return { maxPrice, minPrice }
}

/** The reason given when the position was opened: the v3 record, else the original decision log. */
function entryReason(accountId: number, symbol: string, openedAt: number) {
  const v3 = db.select().from(aiDecisionsV3)
    .where(and(eq(aiDecisionsV3.accountId, accountId), eq(aiDecisionsV3.symbol, symbol), eq(aiDecisionsV3.operation, 'open'),
      eq(aiDecisionsV3.executed, 1), lte(aiDecisionsV3.at, openedAt + 120_000), gte(aiDecisionsV3.at, openedAt - 600_000)))
    .orderBy(desc(aiDecisionsV3.at)).get()
  if (v3) {
    const d = JSON.parse(v3.decision) as Record<string, unknown>
    const c = JSON.parse(v3.context) as { snapshot?: BriefSnapshot | null }
    return {
      source: 'v3 decision' as const, reason: cut(d.reason, MEMORY_LIMITS.maxReasonChars), thesis: cut(d.thesis, MEMORY_LIMITS.maxThesisChars),
      invalidation_price: num(d.invalidation_price), target_price: num(d.target_price), snapshot: c.snapshot ?? null,
    }
  }
  const logs = db.select().from(aiDecisionLogs)
    .where(and(eq(aiDecisionLogs.accountId, accountId), eq(aiDecisionLogs.symbol, symbol), eq(aiDecisionLogs.operation, 'open'), eq(aiDecisionLogs.executed, 'true')))
    .orderBy(desc(aiDecisionLogs.id)).limit(20).all()
  const log = logs.find((l) => {
    const t = dbDateMs(l.decisionTime)
    return t <= openedAt + 120_000 && t >= openedAt - 600_000
  })
  return log ? { source: 'original decision log' as const, reason: cut(log.reason, MEMORY_LIMITS.maxReasonChars), thesis: null, invalidation_price: null, target_price: null, snapshot: null } : null
}

export interface V3Position {
  symbol: string
  side: string
  quantity: number
  entry_price: number
  current_price: number | null
  price_basis: string | null
  leverage: number
  margin_usdc: number
  entry_value_usdc: number
  net_pnl_usdc_if_closed_now: number | null
  net_pnl_pct_of_entry_value: number | null
  net_pnl_pct_of_account: number | null
  costs_so_far_usdc: { fees_paid: number; financing_net: number; estimated_exit_fee: number | null }
  opened_at: string | null
  holding_hours: number | null
  since_entry: {
    highest_price: number | null; lowest_price: number | null
    max_profit_usdc_gross: number | null; max_loss_usdc_gross: number | null
    basis: string
  }
  exit_plan: (PositionView['exit_plan'] & { distance_to_stop_pct: number | null; distance_to_stop_atr: number | null; r_multiple_now: number | null }) | null
  risk_on_account: string
  entry: { source: string; reason: string; thesis: string | null; invalidation_price: number | null; target_price: number | null } | null
  market_changes_since_entry: string[]
  price_issue?: string
}

function positionContext(account: Account, pos: Position, view: PositionView, brief: CoinBrief, h1: readonly HourBar[], equity: number, now: number): V3Position {
  const openedAt = view.opened_at ? Date.parse(view.opened_at) : null
  const price = view.current_price
  const long = view.side === 'LONG'
  // highest / lowest since entry: prices seen at the cycles (position_watch) and the 1 h bars that began after the entry
  let hi: number | null = null, lo: number | null = null
  if (openedAt !== null) {
    const after = h1.filter((b) => b.openTime >= openedAt)
    const seen = price !== null ? watchPosition(account.id, pos.symbol, openedAt, price, now) : null
    const highs = [pos.avgCost, ...(seen ? [seen.maxPrice] : []), ...after.map((b) => b.high)]
    const lows = [pos.avgCost, ...(seen ? [seen.minPrice] : []), ...after.map((b) => b.low)]
    hi = Math.max(...highs); lo = Math.min(...lows)
  }
  const move = (p: number | null) => (p === null ? null : r4((long ? p - pos.avgCost : pos.avgCost - p) * pos.quantity))
  const atr = 'volatility' in brief ? brief.volatility.atr14_1h : null
  const net = view.estimated_net_pnl_if_closed_now
  const plan = view.exit_plan
  const entry = openedAt !== null ? entryReason(account.id, pos.symbol, openedAt) : null
  // what changed since entry: the snapshot stored with the v3 entry decision, else the brief rebuilt from bars closed at the entry
  let changes: string[] = []
  if (openedAt !== null) {
    let then = entry?.snapshot ?? null
    if (!then) {
      const atEntry = coinBrief(h1, { markPx: null, midPx: null, funding: null, premium: null, openInterest: null, dayNtlVlm: null, impactPxs: null, receivedAt: null }, openedAt, { feeRate: takerFeeRate(account.costModel), equityBase: equity })
      then = 'trend' in atEntry ? briefSnapshot(atEntry) : null
    }
    changes = then ? changesSince(then, briefSnapshot(brief)) : ['no market snapshot at entry (not enough history before the entry)']
  }
  const riskLine = plan
    ? `${plan.risk_at_stop_usdc} USDC at the stop ${plan.stop_price} (${plan.risk_at_stop_pct_of_account}% of the account${plan.oversized_vs_1pct ? ', above the 1% reference' : ''})`
    : atr !== null
      ? `no stop in force (exit module off); a 1 ATR move (${atr}) is ${r4(atr * pos.quantity)} USDC, ${r2(((atr * pos.quantity) / equity) * 100)}% of the account`
      : 'no stop in force (exit module off); ATR unavailable'
  return {
    symbol: pos.symbol, side: view.side, quantity: pos.quantity, entry_price: pos.avgCost,
    current_price: price, price_basis: view.price_basis, leverage: pos.leverage, margin_usdc: view.margin, entry_value_usdc: view.entry_value,
    net_pnl_usdc_if_closed_now: net, net_pnl_pct_of_entry_value: net === null ? null : r2((net / view.entry_value) * 100),
    net_pnl_pct_of_account: net === null ? null : r2((net / equity) * 100),
    costs_so_far_usdc: { fees_paid: view.fees_paid, financing_net: view.financing_net, estimated_exit_fee: view.estimated_exit_fee },
    opened_at: view.opened_at, holding_hours: view.holding_minutes === null ? null : r2(view.holding_minutes / 60),
    since_entry: {
      highest_price: sig(hi), lowest_price: sig(lo),
      max_profit_usdc_gross: move(long ? hi : lo), max_loss_usdc_gross: move(long ? lo : hi),
      basis: 'prices seen at each cycle since entry and 1 h bar highs/lows after entry; gross = price move only, before fees and funding',
    },
    exit_plan: plan ? {
      ...plan,
      distance_to_stop_pct: price === null ? null : r2((Math.abs(price - plan.stop_price) / price) * 100),
      distance_to_stop_atr: price === null || atr === null ? null : r2(Math.abs(price - plan.stop_price) / atr),
      r_multiple_now: net === null || !(plan.risk_at_stop_usdc > 0) ? null : r2(net / plan.risk_at_stop_usdc),
    } : null,
    risk_on_account: riskLine,
    entry: entry ? { source: entry.source, reason: entry.reason, thesis: entry.thesis, invalidation_price: entry.invalidation_price, target_price: entry.target_price } : null,
    market_changes_since_entry: changes,
    ...(view.price_issue ? { price_issue: view.price_issue } : {}),
  }
}

export interface MemoryItem {
  minutes_ago: number
  operation: string | null
  symbol: string | null
  direction: string | null
  outcome: string | null
  valid: boolean
  reason: string
  thesis: string | null
  invalidation_price: number | null
  target_price: number | null
  price_then: number | null
  price_now: number | null
  change_since_pct: number | null
}

/** The last decisions (newest first) with the price of their coin then and now. */
export function decisionMemory(accountId: number, now: number, priceNow: Record<string, number | null>): MemoryItem[] {
  const rows = db.select().from(aiDecisionsV3)
    .where(and(eq(aiDecisionsV3.accountId, accountId), gte(aiDecisionsV3.at, now - MEMORY_LIMITS.maxAgeMs), lte(aiDecisionsV3.at, now)))
    .orderBy(desc(aiDecisionsV3.at), desc(aiDecisionsV3.id)).limit(MEMORY_LIMITS.maxDecisions).all()
  return rows.map((r) => {
    const d = JSON.parse(r.decision) as Record<string, unknown>
    const c = JSON.parse(r.context) as { prices?: Record<string, number | null> }
    const then = r.symbol ? c.prices?.[r.symbol] ?? null : null
    const nowP = r.symbol ? priceNow[r.symbol] ?? null : null
    return {
      minutes_ago: Math.round((now - r.at) / 60_000), operation: r.operation, symbol: r.symbol, direction: r.operation === 'hold' ? null : r.direction,
      outcome: r.outcome ? r.outcome.split(':')[0]! : null, valid: r.valid === 1,
      reason: cut(d.reason, MEMORY_LIMITS.maxReasonChars), thesis: cut(d.thesis, MEMORY_LIMITS.maxThesisChars) || null,
      invalidation_price: num(d.invalidation_price), target_price: num(d.target_price),
      price_then: then, price_now: nowP, change_since_pct: then && nowP ? r2((nowP / then - 1) * 100) : null,
    }
  })
}

export interface V3Context {
  now: number
  account: { cash_usdc: number; frozen_cash_usdc: number; total_assets_usdc: number; cost_model: string; taker_fee_pct_each_side: number; open_positions: number }
  positions: V3Position[]
  cooldowns: { symbol: string; side: string; until: string }[]
  exitModule: ExitConfig
  memory: MemoryItem[]
  markets: Record<string, CoinBrief & { mid_price: number | null }>
  news: NewsSelection
  /** Per coin: price and compact snapshot, stored with the decision. */
  snapshots: Record<string, BriefSnapshot>
  prices: Record<string, number | null>
  history: Record<string, { requested: boolean; stored: number; refused: number; error?: string }>
}

/**
 * Builds the context of one decision at `now`. History refresh failures and
 * a missing news feed do not stop the cycle: they are reported in the data.
 */
export async function buildV3Context(
  account: Account, totals: { cash: number; frozen_cash: number; total_assets: number }, mids: Record<string, number>,
  now = Date.now(), deps: V3Deps = v3Deps,
): Promise<V3Context> {
  const feeRate = takerFeeRate(account.costModel)
  const history: V3Context['history'] = {}
  await Promise.all(V3_COINS.map(async (c) => {
    const r = await refreshHistory(c, now, deps.fetchCandles)
    history[c] = { requested: r.requested, stored: r.stored, refused: r.refused.length, ...(r.error ? { error: r.error } : {}) }
  }))
  const bars: Record<string, HourBar[]> = {}
  const markets: V3Context['markets'] = {}
  const snapshots: Record<string, BriefSnapshot> = {}
  const prices: Record<string, number | null> = {}
  const equity = totals.total_assets
  for (const c of V3_COINS) {
    bars[c] = loadHistory(c, now).filter((b) => b.openTime >= now - HISTORY.keepDays * 86_400_000)
    const b = coinBrief(bars[c]!, deps.live(c), now, { feeRate, equityBase: equity })
    markets[c] = { ...b, mid_price: mids[c] ?? null }
    snapshots[c] = briefSnapshot(b)
    prices[c] = b.price
  }
  const rows = db.select().from(positionsTable).where(and(eq(positionsTable.accountId, account.id), eq(positionsTable.market, 'CRYPTO'))).all()
  const positions: V3Position[] = []
  for (const pos of rows) {
    if (!(pos.quantity > 0) || !pos.side) continue
    const view = buildPositionView(account, pos, await currentPriceFor(account, pos.symbol), calculatePositionInterest(pos), now)
    const brief = markets[pos.symbol] ?? coinBrief([], deps.live(pos.symbol), now, { feeRate, equityBase: equity })
    positions.push(positionContext(account, pos, view, brief, bars[pos.symbol] ?? [], equity, now))
  }
  let news: NewsSelection
  try {
    const fetched = await deps.fetchNews()
    news = selectNews(fetched.items, now, newsSeen, fetched.error)
  } catch (e) {
    news = selectNews([], now, newsSeen, String(e))
  }
  const exitModule = loadExitConfig()
  for (const [c, h] of Object.entries(history)) if (h.error) logger.warning(`v3 context: history of ${c} not refreshed (${h.error}); stored bars used`)
  return {
    now,
    account: {
      cash_usdc: r2(totals.cash)!, frozen_cash_usdc: r2(totals.frozen_cash)!, total_assets_usdc: r2(totals.total_assets)!,
      cost_model: account.costModel, taker_fee_pct_each_side: Math.round(feeRate * 1e5) / 1e3, open_positions: positions.length,
    },
    positions,
    cooldowns: exitModule.mode === 'off' ? [] : activeCooldowns(account.id, now, exitModule),
    exitModule, memory: decisionMemory(account.id, now, prices), markets, news, snapshots, prices, history,
  }
}

