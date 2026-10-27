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
import { positionMargin } from './assetCalculator.js'
import { getLastPrice } from './marketData.js'
import { dbDateMs, utcNow } from '../utils/datetime.js'

/** Calculate taker fee for CRYPTO market. */
function calcCryptoFee(notional: number): number {
  return notional * CRYPTO_TAKER_FEE_RATE
}

/**
 * Round a quantity to the 6 decimals order quantities already use
 * (tradingCommands round6, Python `round(x, 6)`), so that subtracting a close
 * leaves no floating-point residue such as 0.000059000000000000025.
 */
function roundQuantity(value: number): number {
  return Number(value.toFixed(6))
}

/** Absolute tolerance between account.marginUsed and the rows' margin. */
const MARGIN_EPS = 1e-6

/**
 * Why the margin of a perpetual row written before 006G-4 (margin NULL)
 * cannot be trusted, or null when it can. Such a row rebuilds its margin as
 * quantity * avgCost / leverage, which is wrong when its fills used
 * different leverages. It is trusted only when the account's perpetual rows
 * above 1x rebuild account.marginUsed; the missing margin is never guessed.
 */
export function legacyMarginIssue(
  marginUsed: number,
  rows: Pick<Position, 'symbol' | 'quantity' | 'avgCost' | 'leverage' | 'side' | 'margin'>[],
): string | null {
  const perps = rows.filter((r) => r.side && r.quantity > 0)
  const legacy = perps.filter((r) => r.margin === null)
  if (legacy.length === 0) return null
  const rebuilt = perps
    .filter((r) => r.leverage > 1)
    .reduce((sum, r) => sum + positionMargin(r), 0)
  if (Math.abs(rebuilt - marginUsed) <= MARGIN_EPS) return null
  return (
    `margin not recorded for ${legacy.map((r) => r.symbol).join(', ')} (rows written before 006G-4) ` +
    `and not reconcilable: the perpetual rows give ${rebuilt}, account marginUsed is ${marginUsed}`
  )
}

/** Calculate accumulated interest since the last calculation. */
export function calculatePositionInterest(position: Position): number {
  if (!position.lastInterestTime || position.leverage <= 1) return 0

  const hoursElapsed =
    (Date.now() - dbDateMs(position.lastInterestTime)) / 3_600_000

  // Interest only applies to the borrowed (leveraged) portion: the entry
  // notional not covered by posted margin. With a single leverage this is
  // quantity * avgCost * (leverage - 1) / leverage.
  const borrowedNotional = Math.max(
    position.quantity * position.avgCost - positionMargin(position),
    0,
  )

  return borrowedNotional * CRYPTO_INTEREST_RATE_HOURLY * hoursElapsed
}

/**
 * Place and execute a CRYPTO order with leverage support.
 *
 * @param side 'LONG' (open long) / 'SHORT' (open short) /
 *             'BUY' (close short) / 'SELL' (close long)
 * @param leverage Leverage multiplier (1 = spot, 2-50 = leveraged)
 * @param quantity Amount in base currency (e.g. BTC amount for BTC/USDT)
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
  /** Order number to record; a random one when omitted. */
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

  // A close below the minimum is checked against the position inside the
  // transaction: only closing all of a smaller position is allowed.
  const isClose = side === 'BUY' || side === 'SELL'
  if (quantity <= 0 || (!isClose && quantity < CRYPTO_MIN_ORDER_QUANTITY)) {
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

    // Cash and margin are read here, inside the transaction, rather than
    // taken from the caller's account: that row may have been read before an
    // await (an AI call, a price fetch) during which another fill or a
    // liquidation changed it, and writing it back would create or destroy cash.
    const booked = tx.select().from(accounts).where(eq(accounts.id, account.id)).get()
    if (!booked) throw new Error(`Account ${account.id} not found`)

    // A perpetual would overwrite a spot holding (side null, from
    // orderMatching) on the same row: refused until the holding is closed.
    if ((side === 'LONG' || side === 'SHORT') && pos && !pos.side && pos.quantity > 0) {
      throw new Error(
        `Cannot open ${side} on ${symbol}: it holds a spot position of ${pos.quantity} on the same row. Close the spot position first.`,
      )
    }

    // An older perpetual whose margin cannot be rebuilt would close or grow
    // with a wrong margin, creating or destroying cash: refused.
    if (pos && pos.side && pos.quantity > 0 && pos.margin === null) {
      const issue = legacyMarginIssue(
        booked.marginUsed,
        tx.select().from(positions).where(eq(positions.accountId, account.id)).all(),
      )
      if (issue) throw new Error(`Cannot ${side} ${symbol}: ${issue}`)
    }

    let currentCash = booked.currentCash
    let marginUsed = booked.marginUsed
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

      if (pos && pos.side && pos.quantity > 0) {
        // Existing perpetual position (any leverage) — settle interest before modifying
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

        // Adding to existing position — weighted average cost, and the margin
        // actually posted is summed rather than rebuilt from an average leverage
        const oldNotional = pos.quantity * pos.avgCost
        const newQty = pos.quantity + quantity
        const newCost = (oldNotional + notional) / newQty
        const oldMargin = positionMargin(pos)
        const newMargin = oldMargin + initialMargin
        // Effective leverage rounded up, so a position with any borrowed part
        // stays above 1x (monitor, interest and the perpetual close path)
        const newLeverage = Math.max(1, Math.ceil((oldNotional + notional) / newMargin - 1e-9))

        // marginUsed covers the margin of positions above 1x
        if (pos.leverage > 1) marginUsed -= oldMargin
        if (newLeverage > 1) marginUsed += newMargin

        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: newQty,
            availableQuantity: newQty,
            avgCost: newCost,
            leverage: newLeverage,
            margin: newMargin,
            lastInterestTime: utcNow(),
            updateTime: utcNow(),
          })
          .where(eq(positions.id, pos.id))
          .returning()
          .get()
      } else {
        // Only track margin for leveraged positions
        if (leverage > 1) marginUsed += initialMargin

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
            margin: initialMargin,
            side,
            // a reopened row starts a new position: interest charged on the
            // previous one stays in its trades
            accumulatedInterest: 0,
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

      // Below the minimum, only a close of the whole position goes through;
      // closing more than the position is rejected further down.
      if (quantity < CRYPTO_MIN_ORDER_QUANTITY && quantity < pos.quantity) {
        throw new Error(`Quantity must be >= ${CRYPTO_MIN_ORDER_QUANTITY}`)
      }

      // Settled within the same update as the released margin and P&L below,
      // so a close is never refused because free cash alone is short of it
      interestCharged = calculatePositionInterest(pos)
      currentCash -= interestCharged

      // A SHORT closes here at any leverage: the spot branch below only sells
      if (pos.leverage > 1 || pos.side === 'SHORT') {
        // Closing leveraged position: BUY closes SHORT, SELL closes LONG
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

        // Release the posted margin in proportion to the quantity closed
        const newQty = roundQuantity(pos.quantity - quantity)
        const posted = positionMargin(pos)
        const marginReleased = newQty === 0 ? posted : (posted * quantity) / pos.quantity

        // Net cash change = PnL + margin released - closing fee
        currentCash += pnl + marginReleased - takerFee
        // Opening adds to marginUsed only above 1x
        if (pos.leverage > 1) marginUsed -= marginReleased

        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: newQty,
            availableQuantity: roundQuantity(pos.availableQuantity - quantity),
            margin: newQty === 0 ? null : posted - marginReleased,
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

        const newQty = roundQuantity(pos.quantity - quantity)
        pos = tx
          .update(positions)
          .set({
            accumulatedInterest: pos.accumulatedInterest + interestCharged,
            quantity: newQty,
            availableQuantity: roundQuantity(pos.availableQuantity - quantity),
            // a 1x long of the engine keeps its margin (= entry notional)
            // in step with the quantity; spot rows have none
            margin:
              pos.margin === null || newQty === 0
                ? null
                : (pos.margin * newQty) / pos.quantity,
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
