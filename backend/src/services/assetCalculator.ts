/** Port of `services/asset_calculator.py`. */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, positions, type Account, type Position } from '../db/schema.js'
import { getLastPrice } from './marketData.js'
import { marksFromAssetContexts } from './hyperliquidMarginData.js'
import { TICKER_MAX_AGE_MS } from './quantData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.assetCalculator')

/**
 * Equity held in an account's positions: posted margin + unrealized P&L,
 * i.e. calcAccountEquity's positionsEquity (kept for its callers).
 */
export async function calcPositionsMarketValue(
  accountId: number,
): Promise<number> {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  return account ? (await calcAccountEquity(account)).positionsEquity : 0
}

/**
 * Margin posted for a position's open quantity. The engine records it since
 * Task 006G-4; older rows (and spot rows) have none, and then it is rebuilt
 * as quantity * avgCost / leverage, which is exact only if every fill of the
 * position used the same leverage.
 */
export function positionMargin(p: Pick<Position, 'quantity' | 'avgCost' | 'leverage' | 'margin'>): number {
  if (p.margin !== null && p.margin !== undefined) return p.margin
  return (p.quantity * p.avgCost) / (p.leverage > 1 ? p.leverage : 1)
}

export interface AccountEquity {
  /** Account value: cash + posted margin + unrealized P&L. */
  equity: number
  /** Posted margin + unrealized P&L of open positions (equity - cash). */
  positionsEquity: number
  /** Margin posted for open positions (full entry notional at 1x). */
  postedMargin: number
  unrealizedPnl: number
  /** Real exposure: sum(quantity * price). */
  exposure: number
  /**
   * Price of the unrealized P&L: 'mid' (the price path, original model) or
   * 'mark' (Hyperliquid's mark price, hyperliquid model); 'mixed' when some
   * hyperliquid positions had no valid, fresh mark and used the mid.
   */
  priceBasis: 'mid' | 'mark' | 'mixed'
  /** Why a mark price could not be used, per symbol. */
  priceIssues: string[]
}

/**
 * Account equity (account value) = cash + posted margin + unrealized P&L.
 *
 * placeAndExecuteCrypto takes each position's entry margin (the full entry
 * notional at 1x) and the opening fee out of cash, and gives the same margin
 * back on close, so the margin of every open position (positionMargin) is
 * added back here. It is computed per
 * position rather than read from account.marginUsed, which does not cover
 * 1x positions and is not released by liquidations run through
 * orderMatching.
 * Unrealized P&L is side-aware: LONG quantity * (price - avgCost),
 * SHORT quantity * (avgCost - price). Fees already charged stay out of
 * equity because they left cash for good.
 *
 * When a price cannot be fetched, the position's margin is still counted
 * and its unrealized P&L is taken as 0.
 */
export async function calcAccountEquity(
  account: Account,
): Promise<AccountEquity> {
  const rows = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, account.id))
    .all()

  let postedMargin = 0
  let unrealizedPnl = 0
  let exposure = 0
  // 'hyperliquid' model: unrealized P&L at Hyperliquid's mark price (docs:
  // robust price indices); the mid is used only when the mark is missing or
  // stale, and that is reported in priceIssues
  const atMark = account.costModel === 'hyperliquid'
  let marks = 0
  let mids = 0
  const priceIssues: string[] = []

  for (const p of rows) {
    if (p.quantity <= 0) continue
    postedMargin += positionMargin(p)

    try {
      let price = await getLastPrice(p.symbol, p.market)
      if (atMark) {
        const quote = marksFromAssetContexts([p.symbol])[p.symbol]!
        const age = quote.receivedAt === null ? Infinity : Date.now() - quote.receivedAt
        if (quote.markPrice !== null && age <= TICKER_MAX_AGE_MS) {
          price = quote.markPrice
          marks++
        } else {
          mids++
          priceIssues.push(`${p.symbol}: ${quote.issue ?? `mark price ${Math.round(age / 1000)} s old`}, mid used`)
        }
      }
      exposure += p.quantity * price
      unrealizedPnl +=
        p.side === 'SHORT'
          ? p.quantity * (p.avgCost - price)
          : p.quantity * (price - p.avgCost)
    } catch (e) {
      logger.warning(
        `Cannot get price for ${p.symbol}.${p.market}, counting margin without unrealized P&L: ${e}`,
      )
    }
  }

  const positionsEquity = postedMargin + unrealizedPnl
  return {
    equity: account.currentCash + positionsEquity,
    positionsEquity,
    postedMargin,
    unrealizedPnl,
    exposure,
    priceBasis: !atMark ? 'mid' : mids === 0 ? 'mark' : marks === 0 ? 'mid' : 'mixed',
    priceIssues,
  }
}

/**
 * Total NOTIONAL value of all positions: sum(quantity * price * leverage).
 *
 * WARNING: this is exposure, not equity. For account assets/profit use
 * {@link calcPositionsMarketValue} instead.
 */
export async function calcPositionsValue(accountId: number): Promise<number> {
  const rows = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()

  let total = 0

  for (const p of rows) {
    try {
      const price = await getLastPrice(p.symbol, p.market)
      total += price * p.quantity * p.leverage
    } catch (e) {
      logger.warning(
        `Cannot get price for ${p.symbol}.${p.market}, skipping position value calculation: ${e}`,
      )
    }
  }

  return total
}
