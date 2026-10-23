/**
 * Order matching service.
 * Implements conditional execution logic for limit orders.
 * Port of `services/order_matching.py`.
 *
 * The Python original used `Decimal` throughout; better-sqlite3 stores these
 * columns as SQLite REAL and every Python read went through `float()`, so
 * plain numbers are used here.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, eq, TransactionRollbackError } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  orders,
  positions,
  trades,
  CRYPTO_COMMISSION_RATE,
  CRYPTO_MIN_COMMISSION,
  type Account,
  type Order,
} from '../db/schema.js'
import { getLastPrice } from './marketData.js'
import { getLogger } from '../utils/logger.js'
import { utcNow } from '../utils/datetime.js'

const logger = getLogger('services.orderMatching')

/** Calculate commission. */
function calcCommission(notional: number): number {
  return Math.max(notional * CRYPTO_COMMISSION_RATE, CRYPTO_MIN_COMMISSION)
}

/**
 * Manual orders share the positions row with the perpetual engine
 * (placeAndExecuteCrypto), which marks its positions LONG/SHORT. Filling a
 * manual order into an open perpetual would mix the two, so such an order is
 * refused when created and not filled while the perpetual is open.
 */
function perpetualConflict(position: { side: string | null; quantity: number } | undefined): string | null {
  return position && position.side && position.quantity > 0
    ? `an open ${position.side} perpetual position`
    : null
}

/** Pending orders already reported as blocked, to log each one once. */
const blockedOrders = new Set<number>()

/**
 * Create limit order.
 *
 * @throws Error when validation fails or funds/positions are insufficient.
 */
export async function createOrder(params: {
  account: Account
  symbol: string
  name: string
  side: string
  orderType: string
  price: number | null | undefined
  quantity: number
  leverage?: number
}): Promise<Order> {
  const {
    account,
    symbol,
    name,
    side,
    orderType,
    price,
    quantity,
    leverage = 1,
  } = params

  // Basic parameter validation (crypto-only).
  // Fractional quantities are supported, so there is no lot-size check.
  if (quantity <= 0) {
    throw new Error('Order quantity must be > 0')
  }

  if (orderType === 'LIMIT' && (price == null || price <= 0)) {
    throw new Error('Limit order must specify valid order price')
  }

  // Price used for fund validation.
  let checkPrice: number
  if (orderType === 'MARKET') {
    try {
      checkPrice = await getLastPrice(symbol)
    } catch (err) {
      throw new Error(`Unable to get market price for market order: ${err}`)
    }
  } else {
    checkPrice = price!
  }

  const current = db
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
  const conflict = perpetualConflict(current)
  if (conflict) {
    throw new Error(
      `${symbol} has ${conflict}: manual orders are not allowed until it is closed`,
    )
  }

  // Pre-check funds and positions
  if (side === 'BUY') {
    const notional = checkPrice * quantity
    const commission = calcCommission(notional)
    const cashNeeded =
      leverage > 1 ? notional / leverage + commission : notional + commission

    if (account.currentCash < cashNeeded) {
      throw new Error(
        `Insufficient cash. Need $${cashNeeded.toFixed(2)}, current cash $${account.currentCash.toFixed(2)}`,
      )
    }
  } else {
    // SELL: check if sufficient positions available
    const position = db
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

    if (!position || position.availableQuantity < quantity) {
      const availableQty = position ? position.availableQuantity : 0
      throw new Error(
        `Insufficient positions. Need ${quantity} ${symbol}, available ${availableQty} ${symbol}`,
      )
    }
  }

  const order = db
    .insert(orders)
    .values({
      version: 'v1',
      accountId: account.id,
      orderNo: randomUUID().replace(/-/g, '').slice(0, 16),
      symbol,
      name,
      market: 'CRYPTO',
      side,
      orderType,
      price: price ?? null,
      quantity,
      leverage,
      filledQuantity: 0,
      status: 'PENDING',
      orderTime: utcNow(),
    })
    .returning()
    .get()

  logger.info(
    `Created limit order: ${order.orderNo}, ${side} ${quantity} ${symbol} @ ${price ?? 'MARKET'}`,
  )

  return order
}

/**
 * Check and execute a limit order.
 *
 * Execution conditions:
 *  - Buy: order price >= current market price and sufficient funds
 *  - Sell: order price <= current market price and sufficient positions
 *
 * @returns whether the order was executed
 */
export async function checkAndExecuteOrder(order: Order): Promise<boolean> {
  if (order.status !== 'PENDING') return false

  try {
    const currentPrice = await getLastPrice(order.symbol, order.market)

    const account = db
      .select()
      .from(accounts)
      .where(eq(accounts.id, order.accountId))
      .get()

    if (!account) {
      logger.error(
        `Account corresponding to order ${order.orderNo} does not exist`,
      )
      return false
    }

    let shouldExecute = false
    const executionPrice = currentPrice

    if (order.orderType === 'MARKET') {
      // Market order executes immediately
      shouldExecute = true
    } else if (order.orderType === 'LIMIT') {
      const limitPrice = order.price!
      if (order.side === 'BUY') {
        // Buy: order price >= current market price
        if (limitPrice >= currentPrice) shouldExecute = true
      } else {
        // Sell: order price <= current market price
        if (limitPrice <= currentPrice) shouldExecute = true
      }
    }

    if (!shouldExecute) {
      logger.debug(
        `Order ${order.orderNo} does not meet execution condition: ${order.side} ${order.price} vs market ${currentPrice}`,
      )
      return false
    }

    return executeOrder(order, account, executionPrice)
  } catch (e) {
    logger.error(`Error checking order ${order.orderNo}: ${e}`)
    return false
  }
}

/**
 * Execute order fill.
 *
 * Runs inside a single SQLite transaction so a mid-way failure leaves no
 * partial position/cash mutation — the equivalent of the Python
 * commit/rollback pair. Insufficient funds/position abort via `tx.rollback()`,
 * which Drizzle signals by throwing `TransactionRollbackError`; that is an
 * expected outcome (already logged as a warning), not an error.
 */
function executeOrder(
  order: Order,
  account: Account,
  executionPrice: number,
): boolean {
  try {
    return db.transaction((tx) => {
      const quantity = order.quantity
      const notional = executionPrice * quantity
      let commission = calcCommission(notional)
      const leverage = order.leverage

      // Checked again inside the transaction: the perpetual may have been
      // opened after this order was created. The order stays PENDING.
      const current = tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.accountId, account.id),
            eq(positions.symbol, order.symbol),
            eq(positions.market, order.market),
          ),
        )
        .get()
      const conflict = perpetualConflict(current)
      if (conflict) {
        if (!blockedOrders.has(order.id)) {
          blockedOrders.add(order.id)
          logger.warning(
            `Order ${order.orderNo} kept pending: ${order.symbol} has ${conflict}`,
          )
        }
        tx.rollback()
        return false
      }
      blockedOrders.delete(order.id)

      let newCash: number

      if (order.side === 'BUY') {
        const cashNeeded =
          leverage > 1
            ? notional / leverage + commission
            : notional + commission

        // Re-check funds (prevent concurrency issues)
        if (account.currentCash < cashNeeded) {
          logger.warning(
            `Insufficient cash when executing order ${order.orderNo}`,
          )
          tx.rollback()
          return false
        }

        newCash = account.currentCash - cashNeeded

        let position = tx
          .select()
          .from(positions)
          .where(
            and(
              eq(positions.accountId, account.id),
              eq(positions.symbol, order.symbol),
              eq(positions.market, order.market),
            ),
          )
          .get()

        if (!position) {
          position = tx
            .insert(positions)
            .values({
              version: 'v1',
              accountId: account.id,
              symbol: order.symbol,
              name: order.name,
              market: order.market,
              quantity: 0,
              availableQuantity: 0,
              avgCost: 0,
              leverage: 1,
              accumulatedInterest: 0,
              updateTime: utcNow(),
            })
            .returning()
            .get()
        }

        // Calculate new average cost and leverage
        const oldQty = position.quantity
        const oldCost = position.avgCost
        const oldLeverage = position.leverage
        const newQty = oldQty + quantity

        let newAvgCost: number
        let newLeverage: number
        if (oldQty === 0) {
          newAvgCost = executionPrice
          newLeverage = leverage
        } else {
          const oldNotional = oldCost * oldQty
          const newNotional = notional + oldNotional
          newAvgCost = newNotional / newQty
          // Update leverage (weighted average)
          newLeverage =
            (oldNotional * oldLeverage + notional * leverage) / newNotional
        }

        tx.update(positions)
          .set({
            quantity: newQty,
            availableQuantity: position.availableQuantity + quantity,
            avgCost: newAvgCost,
            leverage: Math.trunc(newLeverage),
            // A buy reopening an empty row is a spot holding: clear the side
            // a closed perpetual may have left on it
            ...(oldQty === 0 ? { side: null } : {}),
          })
          .where(eq(positions.id, position.id))
          .run()
      } else {
        // SELL
        const position = tx
          .select()
          .from(positions)
          .where(
            and(
              eq(positions.accountId, account.id),
              eq(positions.symbol, order.symbol),
              eq(positions.market, order.market),
            ),
          )
          .get()

        if (!position || position.availableQuantity < quantity) {
          logger.warning(
            `Insufficient position when executing order ${order.orderNo}`,
          )
          tx.rollback()
          return false
        }

        tx.update(positions)
          .set({
            quantity: position.quantity - quantity,
            availableQuantity: position.availableQuantity - quantity,
          })
          .where(eq(positions.id, position.id))
          .run()

        // PnL and cash gain calculation for leveraged positions
        const sellNotional = notional
        commission = calcCommission(sellNotional)
        const positionLeverage = position.leverage

        let cashGain: number
        if (positionLeverage > 1) {
          // Leveraged close — realise PnL and release margin
          const entryPrice = position.avgCost
          const pnl = (executionPrice - entryPrice) * quantity
          const initialMarginPart = (entryPrice * quantity) / positionLeverage
          cashGain = initialMarginPart + pnl - commission
        } else {
          // Spot sell
          cashGain = sellNotional - commission
        }

        newCash = account.currentCash + cashGain
      }

      // Create trade record
      tx.insert(trades)
        .values({
          orderId: order.id,
          accountId: account.id,
          symbol: order.symbol,
          name: order.name,
          market: order.market,
          side: order.side,
          price: executionPrice,
          quantity,
          commission,
          takerFee: 0,
          interestCharged: 0,
        })
        .run()

      // Release frozen cash on fill (BUY only). The estimate may differ from
      // the actual fill, so release based on the executed amount.
      let newFrozen = account.frozenCash
      if (order.side === 'BUY') {
        const frozenToRelease = executionPrice * order.quantity + commission
        newFrozen = Math.max(account.frozenCash - frozenToRelease, 0)
      }

      tx.update(accounts)
        .set({ currentCash: newCash, frozenCash: newFrozen })
        .where(eq(accounts.id, account.id))
        .run()

      tx.update(orders)
        .set({ filledQuantity: quantity, status: 'FILLED' })
        .where(eq(orders.id, order.id))
        .run()

      logger.info(
        `Order ${order.orderNo} executed: ${order.side} ${quantity} ${order.symbol} @ $${executionPrice}`,
      )
      return true
    })
  } catch (e) {
    if (e instanceof TransactionRollbackError) return false
    logger.error(`Error executing order ${order.orderNo}: ${e}`)
    return false
  }
}

/**
 * Get pending orders.
 * @param accountId when omitted, returns pending orders across all accounts.
 */
export function getPendingOrders(accountId?: number): Order[] {
  const where =
    accountId !== undefined
      ? and(eq(orders.status, 'PENDING'), eq(orders.accountId, accountId))
      : eq(orders.status, 'PENDING')

  return db
    .select()
    .from(orders)
    .where(where)
    .orderBy(asc(orders.createdAt))
    .all()
}

/** Cancel an order, releasing any frozen cash (BUY only). */
export function cancelOrder(order: Order, reason = 'User cancelled'): boolean {
  if (order.status !== 'PENDING') return false

  try {
    db.transaction((tx) => {
      tx.update(orders)
        .set({ status: 'CANCELLED' })
        .where(eq(orders.id, order.id))
        .run()

      const account = tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, order.accountId))
        .get()

      if (account && order.side === 'BUY') {
        // Conservative release: estimate the frozen amount from the order
        // price so no market-data call is needed.
        let refPrice = order.price ?? 0.0
        if (refPrice <= 0) {
          logger.warning(
            `Order ${order.orderNo} has no order price, unable to accurately release frozen funds`,
          )
          refPrice = 100.0 // Use default value
        }

        const notional = refPrice * order.quantity
        const releaseAmt = notional + calcCommission(notional)
        tx.update(accounts)
          .set({
            frozenCash: Math.max(account.frozenCash - releaseAmt, 0),
          })
          .where(eq(accounts.id, account.id))
          .run()
      }
    })

    logger.info(`Order ${order.orderNo} cancelled: ${reason}`)
    return true
  } catch (e) {
    logger.error(`Error cancelling order ${order.orderNo}: ${e}`)
    return false
  }
}

/**
 * Process all pending orders.
 * @returns [executed orders count, total checked orders]
 */
export async function processAllPendingOrders(): Promise<[number, number]> {
  const pendingOrders = getPendingOrders()
  let executedCount = 0

  for (const order of pendingOrders) {
    if (await checkAndExecuteOrder(order)) executedCount += 1
  }

  logger.info(
    `Processing pending orders: checked ${pendingOrders.length} orders, executed ${executedCount} orders`,
  )
  return [executedCount, pendingOrders.length]
}
