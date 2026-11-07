/**
 * Task 009G: hard cap on the notional of every new AI open (LONG or SHORT):
 * notional (quantity x fill price) <= 25% of the account's current equity,
 * whatever the leverage. Closes, C1 exits and liquidations are not concerned.
 *
 * Equity = cash + posted margin + unrealized P&L, with the same formula as
 * calcAccountEquity (assetCalculator.ts), but read from the account row at
 * the time of the check and without its fallback: when the price of an open
 * position cannot be obtained, calcAccountEquity counts its P&L as 0, which
 * could authorize an order on an equity that is not real; here the equity is
 * then "not verifiable" and the open is refused.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, positions } from '../db/schema.js'
import { positionMargin } from './assetCalculator.js'
import { getLastPrice } from './marketData.js'

export const OPEN_NOTIONAL_CAP = 0.25

export interface VerifiedEquity {
  equity: number
  cash: number
  postedMargin: number
  unrealizedPnl: number
}

/** Current equity of the account, or why it cannot be verified (never a guessed value). */
export async function verifiedEquity(accountId: number): Promise<VerifiedEquity | { error: string }> {
  const acc = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!acc) return { error: 'account not found' }
  if (!Number.isFinite(acc.currentCash)) return { error: `cash not finite (${acc.currentCash})` }
  let postedMargin = 0
  let unrealizedPnl = 0
  for (const p of db.select().from(positions).where(eq(positions.accountId, accountId)).all()) {
    if (!(p.quantity > 0)) continue
    let price: number
    try {
      price = await getLastPrice(p.symbol, p.market)
    } catch (e) {
      return { error: `no price for open position ${p.symbol}: ${String(e).slice(0, 120)}` }
    }
    if (!Number.isFinite(price) || !(price > 0)) return { error: `invalid price for open position ${p.symbol}: ${price}` }
    postedMargin += positionMargin(p)
    unrealizedPnl += p.side === 'SHORT' ? p.quantity * (p.avgCost - price) : p.quantity * (price - p.avgCost)
  }
  const equity = acc.currentCash + postedMargin + unrealizedPnl
  if (!Number.isFinite(equity)) return { error: `equity not finite (${equity})` }
  if (!(equity > 0)) return { error: `equity not positive (${equity})` }
  return { equity, cash: acc.currentCash, postedMargin, unrealizedPnl }
}

/**
 * Largest quantity in 6 decimals (the engine's order step) whose notional at
 * `price` does not exceed `maxNotional`; rounded down, never above the cap.
 */
export function maxQuantityWithin(maxNotional: number, price: number): number {
  if (!Number.isFinite(maxNotional) || !(maxNotional > 0) || !Number.isFinite(price) || !(price > 0)) return 0
  let units = Math.floor((maxNotional / price) * 1e6)
  while (units > 0 && (units / 1e6) * price > maxNotional) units-- // floating point: never above
  return units / 1e6
}
