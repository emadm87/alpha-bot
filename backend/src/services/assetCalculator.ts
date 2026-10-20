/** Port of `services/asset_calculator.py`. */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { positions } from '../db/schema.js'
import { getLastPrice } from './marketData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.assetCalculator')

/**
 * Calculate total equity in positions: margin posted at entry + unrealized P&L.
 *
 * Account cash already had the entry margin deducted on open, so each
 * position contributes what closing it would return (before fees/interest):
 *
 *   Equity = Entry Margin + Unrealized P&L
 *   Entry Margin = avg_cost * quantity / leverage
 *   P&L (LONG)   = quantity * (current_price - avg_cost)
 *   P&L (SHORT)  = quantity * (avg_cost - current_price)
 *
 * At leverage 1 a LONG reduces to quantity * current_price (spot market
 * value). Positions without a side are treated as LONG.
 *
 * @returns Total equity in positions; positions whose price cannot be
 *          obtained are skipped.
 */
export async function calcPositionsMarketValue(
  accountId: number,
): Promise<number> {
  const rows = db
    .select()
    .from(positions)
    .where(eq(positions.accountId, accountId))
    .all()

  let total = 0

  for (const p of rows) {
    try {
      const price = await getLastPrice(p.symbol, p.market)
      const quantity = p.quantity
      const avgCost = p.avgCost
      const leverage = p.leverage && p.leverage > 0 ? p.leverage : 1

      const entryMargin = (quantity * avgCost) / leverage
      const unrealizedPnl =
        p.side === 'SHORT'
          ? quantity * (avgCost - price)
          : quantity * (price - avgCost)

      total += entryMargin + unrealizedPnl
    } catch (e) {
      logger.warning(
        `Cannot get price for ${p.symbol}.${p.market}, skipping position value calculation: ${e}`,
      )
    }
  }

  return total
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
