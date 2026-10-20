/**
 * Leveraged CRYPTO order execution.
 * Port of `services/order_executor_leverage.py`.
 */
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  orders,
  positions,
  trades,
  CRYPTO_INTEREST_RATE_HOURLY,
  CRYPTO_MAX_LEVERAGE,
  CRYPTO_MIN_ORDER_QUANTITY,
  CRYPTO_TAKER_FEE_RATE,
  type Account,
  type Order,
  type Position,
} from '../db/schema.js'
import { getLastPrice } from './marketData.js'
import { dbDateMs, utcNow } from '../utils/datetime.js'

/** Calculate taker fee for CRYPTO market. */
function calcCryptoFee(notional: number): number {
  return notional * CRYPTO_TAKER_FEE_RATE
}

/** Calculate accumulated interest since the last calculation. */
function calculatePositionInterest(position: Position): number {
  if (!position.lastInterestTime || position.leverage <= 1) return 0

  const hoursElapsed =
    (Date.now() - dbDateMs(position.lastInterestTime)) / 3_600_000

  // Interest only applies to the borrowed (leveraged) portion.
  const borrowedNotional =
    (position.quantity * position.avgCost * (position.leverage - 1)) /
    position.leverage

  return borrowedNotional * CRYPTO_INTEREST_RATE_HOURLY * hoursElapsed
}

/**
 * Place and execute a CRYPTO order with leverage support.
 *
 * @param side 'LONG' (open long) / 'SHORT' (open short) /
 *             'BUY' (close short) / 'SELL' (close long)
 * @param leverage Leverage multiplier (1 = spot, 2-50 = leveraged)
 * @param quantity Amount in base currency (e.g. BTC amount for BTC/USDT)
 * @param orderNo Optional order number (e.g. 'LIQ-…' for liquidations);
 *                a random one is generated when omitted
 */
export async function placeAndExecuteCrypto(params: {
  account: Account
  symbol: string
  name: string
  side: string
  orderType: string
  price: number | null
  quantity: number
  leverage?: number
  orderNo?: string
}): Promise<Order> {
  const {
    account,
    symbol,
    name,
    orderType,
    price,
    quantity,
    leverage = 1,
    orderNo = randomUUID().replace(/-/g, '').slice(0, 16),
  } = params
  const side = params.side.toUpperCase()

  if (leverage < 1 || leverage > CRYPTO_MAX_LEVERAGE) {
    throw new Error(`Leverage must be between 1 and ${CRYPTO_MAX_LEVERAGE}`)
  }

  if (quantity < CRYPTO_MIN_ORDER_QUANTITY) {
    throw new Error(`Quantity must be >= ${CRYPTO_MIN_ORDER_QUANTITY}`)
  }

  // Get execution price (await outside the transaction — no I/O inside it)
  const execPrice =
    orderType === 'LIMIT' && price
      ? price
      : await getLastPrice(symbol, 'CRYPTO')

  const notional = execPrice * quantity
  const takerFee = calcCryptoFee(notional)

  return db.transaction((tx) => {
    const order = tx
      .insert(orders)
      .values({
        version: 'v1',
        accountId: account.id,
        orderNo,
        symbol,
        name,
        market: 'CRYPTO',
        side,
        orderType,
        price: execPrice,
        quantity,
        leverage,
        filledQuantity: 0,
        status: 'PENDING',
        orderTime: utcNow(),
      })
      .returning()
      .get()

    let pos = tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.accountId, account.id),
          eq(positions.symbol, symbol),
          eq(positions.market, 'CRYPTO'),
        ),
      )
      .get()

    let currentCash = account.currentCash
    let marginUsed = account.marginUsed
    let interestCharged = 0

    if (side === 'LONG' || side === 'SHORT') {
      // Opening a leveraged position
      const initialMargin = notional / leverage
      const totalCost = initialMargin + takerFee

      if (currentCash < totalCost) {
        throw new Error(
          `Insufficient cash. Need ${totalCost}, have ${currentCash}`,
        )
      }

      currentCash -= totalCost

      // Only track margin for leveraged positions
      if (leverage > 1) marginUsed += initialMargin

      if (pos && pos.leverage > 1 && pos.side) {
        // Existing leveraged position — settle interest before modifying
        interestCharged = calculatePositionInterest(pos)
        if (interestCharged > 0) {
          if (currentCash < interestCharged) {
            throw new Error(
              `Insufficient cash for interest payment: ${interestCharged}`,
            )
          }
          currentCash -= interestCharged
        }

        if (pos.side !== side) {
          throw new Error(
            `Cannot open ${side} position while holding ${pos.side} position. Close existing position first.`,
          )
        }

        // Adding to existing position — weighted averages
        const oldNotional = pos.quantity * pos.avgCost
        const newQty = pos.quantity + quantity
        const newCost = (oldNotional + notional) / newQty

        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: newQty,
            avgCost: newCost,
            leverage: Math.trunc(
              (oldNotional * pos.leverage + notional * leverage) /
                (oldNotional + notional),
            ),
            lastInterestTime: utcNow(),
            updateTime: utcNow(),
          })
          .where(eq(positions.id, pos.id))
          .returning()
          .get()
      } else {
        // Create new position or convert spot to leveraged
        if (!pos) {
          pos = tx
            .insert(positions)
            .values({
              version: 'v1',
              accountId: account.id,
              symbol,
              name,
              market: 'CRYPTO',
              quantity: 0,
              availableQuantity: 0,
              avgCost: 0,
              leverage: 1,
              accumulatedInterest: 0,
            })
            .returning()
            .get()
        }

        pos = tx
          .update(positions)
          .set({
            quantity,
            availableQuantity: quantity,
            avgCost: execPrice,
            leverage,
            side,
            lastInterestTime: utcNow(),
            updateTime: utcNow(),
          })
          .where(eq(positions.id, pos.id))
          .returning()
          .get()
      }
    } else if (side === 'BUY' || side === 'SELL') {
      // Closing a position (partial or full)
      if (!pos || pos.quantity === 0) {
        throw new Error('No position to close')
      }

      interestCharged = calculatePositionInterest(pos)
      if (interestCharged > 0) {
        if (currentCash < interestCharged) {
          throw new Error(
            `Insufficient cash for interest payment: ${interestCharged}`,
          )
        }
        currentCash -= interestCharged
      }

      if (pos.leverage > 1 || pos.side === 'SHORT') {
        // Closing a perpetual position (leveraged, or a 1x SHORT):
        // BUY closes SHORT, SELL closes LONG
        if (
          (side === 'SELL' && pos.side !== 'LONG') ||
          (side === 'BUY' && pos.side !== 'SHORT')
        ) {
          throw new Error(`Cannot ${side} to close a ${pos.side} position`)
        }

        if (quantity > pos.quantity) {
          throw new Error(
            `Cannot close more than position size. Position: ${pos.quantity}, Trying to close: ${quantity}`,
          )
        }

        const entryNotional = pos.avgCost * quantity
        const exitNotional = notional
        const pnl =
          pos.side === 'LONG'
            ? exitNotional - entryNotional
            : entryNotional - exitNotional

        // Release margin proportionally
        const marginReleased = entryNotional / pos.leverage

        // Net cash change = PnL + margin released - closing fee
        currentCash += pnl + marginReleased - takerFee
        // Margin is only tracked for leveraged positions (see open branch)
        if (pos.leverage > 1) marginUsed -= marginReleased

        const newQty = pos.quantity - quantity
        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: newQty,
            availableQuantity: pos.availableQuantity - quantity,
            ...(newQty === 0
              ? { side: null, leverage: 1, lastInterestTime: null }
              : { lastInterestTime: utcNow() }),
            updateTime: utcNow(),
          })
          .where(eq(positions.id, pos.id))
          .returning()
          .get()
      } else {
        // Closing spot position (simple sell)
        if (side !== 'SELL') {
          throw new Error('Can only SELL spot positions')
        }
        if (quantity > pos.availableQuantity) {
          throw new Error(
            `Insufficient position. Have: ${pos.availableQuantity}, Trying to sell: ${quantity}`,
          )
        }

        currentCash += notional - takerFee

        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: pos.quantity - quantity,
            availableQuantity: pos.availableQuantity - quantity,
            updateTime: utcNow(),
          })
          .where(eq(positions.id, pos.id))
          .returning()
          .get()
      }
    } else {
      throw new Error(
        `Invalid side: ${side}. Must be LONG/SHORT (open) or BUY/SELL (close)`,
      )
    }

    tx.update(accounts)
      .set({ currentCash, marginUsed })
      .where(eq(accounts.id, account.id))
      .run()

    tx.insert(trades)
      .values({
        orderId: order.id,
        accountId: account.id,
        symbol,
        name,
        market: 'CRYPTO',
        side,
        price: execPrice,
        quantity,
        commission: takerFee,
        takerFee,
        interestCharged,
      })
      .run()

    return tx
      .update(orders)
      .set({ filledQuantity: quantity, status: 'FILLED' })
      .where(eq(orders.id, order.id))
      .returning()
      .get()
  })
}
