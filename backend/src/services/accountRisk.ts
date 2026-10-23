/**
 * Informational snapshot of a simulated account: booked amounts, accrued
 * interest, mark-to-market values and the margin monitor's liquidation rule.
 * Not used by trading or the prompt; it reads the database and the price
 * cache path (getLastPrice) and never changes anything.
 *
 * Accounting it follows (no new rules):
 * - equity = cash + posted margin + unrealized P&L (calcAccountEquity, 005A);
 *   posted margin = quantity * avgCost / leverage; notional exposure is
 *   reported apart and never added to equity;
 * - prices are the last (mid) prices of getLastPrice, as for orders and the
 *   monitor; the Hyperliquid mark price is shown for information only;
 * - interest accrues on the borrowed notional and is charged only at close,
 *   so it is not part of equity nor of the liquidation check;
 * - liquidation (scheduler.checkAccountMargin): when equity / account
 *   marginUsed < maintenanceMarginRatio, every leveraged position closes.
 */
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, positions, trades, type Position } from '../db/schema.js'
import { calcAccountEquity } from './assetCalculator.js'
import { getAssetContext } from './hyperliquid.js'
import { getLastPrice } from './marketData.js'
import { calculatePositionInterest } from './orderExecutorLeverage.js'
import { getCachedPriceAge } from './priceCache.js'
import { parseDbDate } from '../utils/datetime.js'

/** Prices older than this are not reliable (the price cache TTL). */
export const PRICE_MAX_AGE_SECONDS = 30
const EPS = 1e-6

export type PriceStatus = 'ok' | 'stale' | 'missing'

export interface PositionRisk {
  symbol: string
  side: 'LONG' | 'SHORT' | 'SPOT'
  quantity: number
  entryPrice: number
  /** Last (mid) price, the one used for P&L, orders and liquidation. */
  price: number | null
  priceStatus: PriceStatus
  priceTime: string | null
  /** Hyperliquid mark price from the last ticker response: information only. */
  markPrice: number | null
  markPriceTime: string | null
  leverage: number
  /** quantity * price */
  notional: number | null
  /** quantity * entryPrice / leverage, as posted at open */
  margin: number
  unrealizedPnl: number | null
  unrealizedPnlPctOfMargin: number | null
  /** Fees of the fills since this position was opened. */
  feesPaid: number | null
  /** Interest already charged since it was opened (adds, partial closes). */
  interestCharged: number | null
  /** Interest accrued since the last charge, charged at close. */
  interestAccrued: number
  openedAt: string | null
  durationMinutes: number | null
  /** Subject to the margin monitor (leverage > 1). */
  liquidatable: boolean
  liquidation: {
    /** Price at which the monitor rule triggers; null when not computable. */
    price: number | null
    /** True when it assumes the other positions' prices stay unchanged. */
    conditional: boolean
    note: string
  }
  issues: string[]
}

export interface AccountRiskSnapshot {
  accountId: number
  generatedAt: string
  /** All prices ok and accounting checks consistent. */
  reliable: boolean
  /** Amounts already booked in the database. */
  booked: {
    initialCapital: number
    cash: number
    /** account.marginUsed: margin of leveraged positions, used by the monitor */
    marginUsed: number
    feesPaid: number
    interestCharged: number
    /** Derived: cash + posted margin - initial capital + fees + interest. */
    realizedPnl: number
  }
  /** Accrued, not yet booked. */
  accrued: { interest: number }
  /** Mark-to-market at current prices; null when a price is missing. */
  estimated: {
    equity: number | null
    unrealizedPnl: number | null
    postedMargin: number
    notionalExposure: number | null
    returnUsdc: number | null
    returnPct: number | null
    /** Return if accrued interest were charged now. */
    returnAfterAccruedUsdc: number | null
    equityToMarginRatio: number | null
  }
  /** What the margin monitor computes right now (unpriced P&L counted as 0). */
  monitor: {
    equity: number
    marginLevel: number | null
    maintenanceMarginRatio: number
    /** equity - ratio * marginUsed: loss that would trigger liquidation. */
    bufferUsdc: number | null
    wouldLiquidate: boolean
  }
  openPositions: number
  prices: { status: PriceStatus; oldestAgeSeconds: number | null }
  positions: PositionRisk[]
  issues: string[]
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

interface PositionHistory {
  openedAtMs: number | null
  feesPaid: number | null
  interestCharged: number | null
  issue: string | null
}

/**
 * Replays the fills of a symbol to find when the open position started and
 * what it has paid since. Not reconstructable when the replayed quantity does
 * not match the position (fills outside the leveraged engine, manual edits).
 */
function positionHistory(accountId: number, pos: Position): PositionHistory {
  const fills = db
    .select()
    .from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.symbol, pos.symbol)))
    .orderBy(asc(trades.id))
    .all()
  let quantity = 0
  let start = -1
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i]!
    const opening = f.side === 'LONG' || f.side === 'SHORT' || (f.side === 'BUY' && pos.leverage <= 1 && !pos.side)
    if (quantity === 0 && opening) start = i
    quantity = Number((quantity + (opening ? f.quantity : -f.quantity)).toFixed(6))
  }
  if (start < 0 || Math.abs(quantity - pos.quantity) > EPS) {
    return {
      openedAtMs: null, feesPaid: null, interestCharged: null,
      issue: 'fills do not rebuild this position: opening time and costs unknown',
    }
  }
  const own = fills.slice(start)
  return {
    openedAtMs: parseDbDate(own[0]!.tradeTime)?.getTime() ?? null,
    feesPaid: own.reduce((s, f) => s + f.commission, 0),
    interestCharged: own.reduce((s, f) => s + f.interestCharged, 0),
    issue: null,
  }
}

async function priceOf(symbol: string, market: string) {
  try {
    const price = await getLastPrice(symbol, market)
    const age = getCachedPriceAge(symbol, market)
    const status: PriceStatus = age === null || age > PRICE_MAX_AGE_SECONDS ? 'stale' : 'ok'
    return { price, age, status, issue: age === null ? 'price age unknown' : null }
  } catch (err) {
    return { price: null, age: null, status: 'missing' as const, issue: `no price: ${err}` }
  }
}

/** Snapshot of one account; never throws for missing prices. */
export async function getAccountRiskSnapshot(
  accountId: number,
  options: { maxPriceAgeSeconds?: number } = {},
): Promise<AccountRiskSnapshot> {
  const maxAge = options.maxPriceAgeSeconds ?? PRICE_MAX_AGE_SECONDS
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!account) throw new Error(`Account ${accountId} not found`)
  const open = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()
    .filter((p) => p.quantity > 0)
  const issues: string[] = []
  const now = Date.now()

  // Prices first (cached path), then the same equity the monitor uses
  const priced = await Promise.all(open.map((p) => priceOf(p.symbol, p.market)))
  priced.forEach((p) => {
    if (p.status === 'ok' && p.age !== null && p.age > maxAge) p.status = 'stale'
  })
  const equity = await calcAccountEquity(account)

  const allTrades = db.select().from(trades).where(eq(trades.accountId, accountId)).all()
  const feesPaid = allTrades.reduce((s, t) => s + t.commission, 0)
  const interestCharged = allTrades.reduce((s, t) => s + t.interestCharged, 0)

  const allPriced = priced.every((p) => p.price !== null)
  const pricesOk = priced.every((p) => p.status === 'ok')
  const m = account.maintenanceMarginRatio
  const marginUsed = account.marginUsed
  const monitorBuffer = marginUsed > 0 ? equity.equity - m * marginUsed : null
  const leveraged = open.filter((p) => p.leverage > 1)

  const rows: PositionRisk[] = open.map((pos, i) => {
    const { price, age, status, issue } = priced[i]!
    const posIssues = issue ? [issue] : []
    const leverage = pos.leverage > 1 ? pos.leverage : 1
    const side = pos.side === 'SHORT' ? 'SHORT' : pos.side === 'LONG' ? 'LONG' : 'SPOT'
    const sign = side === 'SHORT' ? -1 : 1
    const margin = (pos.quantity * pos.avgCost) / leverage
    const pnl = price === null ? null : sign * pos.quantity * (price - pos.avgCost)
    const history = positionHistory(accountId, pos)
    if (history.issue) posIssues.push(history.issue)
    const ctx = getAssetContext(pos.symbol)
    const mark = ctx ? Number(ctx.info.markPx) : NaN

    let liquidation: PositionRisk['liquidation']
    const conditional = open.length > 1
    if (leverage <= 1) {
      liquidation = { price: null, conditional: false, note: '1x positions are not liquidated by the margin monitor' }
    } else if (marginUsed <= 0) {
      liquidation = { price: null, conditional: false, note: 'account marginUsed is 0: the monitor skips this account' }
    } else if (!allPriced || price === null) {
      liquidation = { price: null, conditional, note: 'not computable: a price is missing' }
    } else if (monitorBuffer! <= 0) {
      liquidation = { price, conditional, note: 'already below the threshold: liquidation at the next monitor check (every 5 s)' }
    } else {
      // equity is linear in this price: the rule triggers after a move of buffer / quantity
      const p = price - sign * (monitorBuffer! / pos.quantity)
      const others = conditional ? '; assumes the other positions\' prices stay unchanged' : ''
      liquidation = p > 0
        ? { price: p, conditional, note: `equity / marginUsed < ${m} at this price${others}; accrued interest not included, as in the monitor` }
        : { price: null, conditional, note: `not reachable at a positive price${others}` }
    }

    return {
      symbol: pos.symbol,
      side,
      quantity: pos.quantity,
      entryPrice: pos.avgCost,
      price,
      priceStatus: status,
      priceTime: age === null ? null : iso(now - age * 1000),
      markPrice: Number.isFinite(mark) && mark > 0 ? mark : null,
      markPriceTime: ctx ? iso(ctx.receivedAt) : null,
      leverage,
      notional: price === null ? null : pos.quantity * price,
      margin,
      unrealizedPnl: pnl,
      unrealizedPnlPctOfMargin: pnl === null || margin <= 0 ? null : (pnl / margin) * 100,
      feesPaid: history.feesPaid,
      interestCharged: history.interestCharged,
      interestAccrued: calculatePositionInterest(pos),
      openedAt: iso(history.openedAtMs),
      durationMinutes: history.openedAtMs === null ? null : (now - history.openedAtMs) / 60_000,
      liquidatable: leverage > 1,
      liquidation,
      issues: posIssues,
    }
  })

  // Consistency checks against the booked figures
  const leveragedMargin = leveraged.reduce((s, p) => s + (p.quantity * p.avgCost) / p.leverage, 0)
  if (Math.abs(leveragedMargin - marginUsed) > EPS) {
    issues.push(`account marginUsed ${marginUsed} differs from the leveraged positions' margin ${leveragedMargin}`)
  }
  const positionsPnl = rows.reduce((s, r) => s + (r.unrealizedPnl ?? 0), 0)
  if (Math.abs(positionsPnl - equity.unrealizedPnl) > EPS) {
    issues.push('a price changed during the snapshot: per-position and account P&L differ')
  }
  if (!allPriced) issues.push('some prices are missing: equity and P&L are unknown (the monitor counts their P&L as 0)')
  else if (!pricesOk) issues.push('some prices are stale: values are not reliable')
  if (equity.equity <= 0) issues.push('equity is zero or negative')

  const accruedInterest = rows.reduce((s, r) => s + r.interestAccrued, 0)
  const knownEquity = allPriced ? equity.equity : null
  const ages = priced.map((p) => p.age).filter((a): a is number => a !== null)
  const worst: PriceStatus = priced.some((p) => p.status === 'missing') ? 'missing'
    : priced.some((p) => p.status === 'stale') ? 'stale' : 'ok'

  return {
    accountId,
    generatedAt: iso(now)!,
    reliable: worst === 'ok' && issues.length === 0,
    booked: {
      initialCapital: account.initialCapital,
      cash: account.currentCash,
      marginUsed,
      feesPaid,
      interestCharged,
      realizedPnl: account.currentCash + equity.postedMargin - account.initialCapital + feesPaid + interestCharged,
    },
    accrued: { interest: accruedInterest },
    estimated: {
      equity: knownEquity,
      unrealizedPnl: allPriced ? equity.unrealizedPnl : null,
      postedMargin: equity.postedMargin,
      notionalExposure: allPriced ? equity.exposure : null,
      returnUsdc: knownEquity === null ? null : knownEquity - account.initialCapital,
      returnPct: knownEquity === null || account.initialCapital <= 0
        ? null : ((knownEquity - account.initialCapital) / account.initialCapital) * 100,
      returnAfterAccruedUsdc: knownEquity === null ? null : knownEquity - accruedInterest - account.initialCapital,
      equityToMarginRatio: knownEquity === null || marginUsed <= 0 ? null : knownEquity / marginUsed,
    },
    monitor: {
      equity: equity.equity,
      marginLevel: marginUsed > 0 ? equity.equity / marginUsed : null,
      maintenanceMarginRatio: m,
      bufferUsdc: monitorBuffer,
      wouldLiquidate: leveraged.length > 0 && marginUsed > 0 && equity.equity / marginUsed < m,
    },
    openPositions: open.length,
    prices: { status: worst, oldestAgeSeconds: ages.length ? Math.max(...ages) : null },
    positions: rows,
    issues,
  }
}

/** Same snapshot, but failures are returned instead of thrown. */
export async function safeAccountRiskSnapshot(
  accountId: number,
): Promise<AccountRiskSnapshot | { accountId: number; error: string }> {
  try {
    return await getAccountRiskSnapshot(accountId)
  } catch (err) {
    return { accountId, error: String(err) }
  }
}
