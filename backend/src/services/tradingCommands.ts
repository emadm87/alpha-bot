/**
 * Trading Commands Service — order execution and trading logic.
 * Port of `services/trading_commands.py`.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, positions as positionsTable, type Account } from '../db/schema.js'
import { calcPositionsValue } from './assetCalculator.js'
import { getLastPrice } from './marketData.js'
import { checkAndExecuteOrder, createOrder } from './orderMatching.js'
import { placeAndExecuteCrypto } from './orderExecutorLeverage.js'
import {
  callAIForDecision,
  getActiveAIAccounts,
  getPortfolioData,
  saveAIDecision,
  SUPPORTED_SYMBOLS,
} from './aiDecision.js'
import { newCycleId, recordAICycle } from './aiDiagnostics.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.tradingCommands')

export const AI_TRADING_SYMBOLS: string[] = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
]

export const AUTO_TRADE_JOB_ID = 'auto_crypto_trade'
export const AI_TRADE_JOB_ID = 'ai_crypto_trade'

/** Get latest prices for the given symbols. */
async function getMarketPrices(
  symbols: string[],
): Promise<Record<string, number>> {
  const prices: Record<string, number> = {}
  for (const symbol of symbols) {
    try {
      const price = await getLastPrice(symbol, 'CRYPTO')
      if (price > 0) prices[symbol] = price
    } catch (err) {
      logger.warning(`Failed to get price for ${symbol}: ${err}`)
    }
  }
  return prices
}

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

/** Select a random trading side and quantity for legacy random trading. */
async function selectSide(
  account: Account,
  symbol: string,
  maxValue: number,
): Promise<[string, number] | null> {
  const market = 'CRYPTO'
  let price: number
  try {
    price = await getLastPrice(symbol, market)
  } catch (err) {
    logger.warning(`Cannot get price for ${symbol}: ${err}`)
    return null
  }

  if (price <= 0) {
    logger.debug(`${symbol} returned non-positive price ${price}`)
    return null
  }

  const maxQuantityByValue = Math.floor(maxValue / price)

  const position = db
    .select()
    .from(positionsTable)
    .where(
      and(
        eq(positionsTable.accountId, account.id),
        eq(positionsTable.symbol, symbol),
        eq(positionsTable.market, market),
      ),
    )
    .get()

  const availableQuantity = position
    ? Math.trunc(position.availableQuantity)
    : 0

  const choices: [string, number][] = []

  if (account.currentCash >= price && maxQuantityByValue >= 1) {
    choices.push(['BUY', maxQuantityByValue])
  }

  if (availableQuantity > 0) {
    const maxSellQuantity = Math.min(
      availableQuantity,
      maxQuantityByValue >= 1 ? maxQuantityByValue : availableQuantity,
    )
    if (maxSellQuantity >= 1) choices.push(['SELL', maxSellQuantity])
  }

  if (choices.length === 0) return null

  const [side, maxQty] = randomChoice(choices)
  // random.randint(1, maxQty) is inclusive on both ends
  const quantity = Math.floor(Math.random() * maxQty) + 1
  return [side, quantity]
}

/** Round to 6 decimal places, matching Python's `round(x, 6)` for crypto. */
function round6(value: number): number {
  return Number(value.toFixed(6))
}

/** Place crypto orders based on AI model decisions for all active accounts. */
export async function placeAIDrivenCryptoOrder(): Promise<void> {
  try {
    const activeAccounts = getActiveAIAccounts()
    if (activeAccounts.length === 0) {
      logger.debug('No available accounts, skipping AI trading')
      return
    }

    // Get latest market prices once for all accounts
    const prices = await getMarketPrices(AI_TRADING_SYMBOLS)
    if (Object.keys(prices).length === 0) {
      logger.warning('Failed to fetch market prices, skipping AI trading')
      return
    }

    for (const account of activeAccounts) {
      try {
        logger.info(`Processing AI trading for account: ${account.name}`)

        const portfolio = await getPortfolioData(account)
        if (portfolio.total_assets <= 0) {
          logger.debug(
            `Account ${account.name} has non-positive total assets, skipping`,
          )
          continue
        }

        const cycleId = newCycleId()
        const outcome = (status: string, detail: string, orderId?: number | null) =>
          recordAICycle(cycleId, 'outcome', {
            account_id: account.id,
            status,
            detail,
            order_id: orderId ?? null,
          })

        const decision = await callAIForDecision(
          account,
          portfolio,
          prices,
          cycleId,
        )
        if (!decision) {
          logger.warning(
            `Failed to get AI decision for ${account.name}, skipping`,
          )
          outcome('no_decision', 'No usable AI decision; nothing executed')
          continue
        }

        const operation = decision.operation
          ? String(decision.operation).toLowerCase()
          : ''
        const symbol = decision.symbol
          ? String(decision.symbol).toUpperCase()
          : ''
        const direction = decision.direction
          ? String(decision.direction).toLowerCase()
          : 'long'
        const targetPortion =
          decision.target_portion_of_balance != null
            ? Number(decision.target_portion_of_balance)
            : 0
        const reason = decision.reason ?? 'No reason provided'

        logger.info(
          `AI decision for ${account.name}: ${operation} ${symbol} ${direction} (portion: ${(targetPortion * 100).toFixed(2)}%) - ${reason}`,
        )

        if (!['open', 'close', 'hold'].includes(operation)) {
          logger.warning(
            `Invalid operation '${operation}' from AI for ${account.name}, skipping`,
          )
          outcome('rejected', `Invalid operation '${operation}' from AI for ${account.name}, skipping`)
          saveAIDecision(account, decision, portfolio, false)
          continue
        }

        if (operation === 'hold') {
          logger.info(`AI decided to HOLD for ${account.name}`)
          outcome('hold', 'No order placed')
          saveAIDecision(account, decision, portfolio, true)
          continue
        }

        if (!(symbol in SUPPORTED_SYMBOLS)) {
          logger.warning(
            `Invalid symbol '${symbol}' from AI for ${account.name}, skipping`,
          )
          outcome('rejected', `Invalid symbol '${symbol}' from AI for ${account.name}, skipping`)
          saveAIDecision(account, decision, portfolio, false)
          continue
        }

        if (!['long', 'short'].includes(direction)) {
          logger.warning(
            `Invalid direction '${direction}' from AI for ${account.name}, skipping`,
          )
          outcome('rejected', `Invalid direction '${direction}' from AI for ${account.name}, skipping`)
          saveAIDecision(account, decision, portfolio, false)
          continue
        }

        if (targetPortion <= 0 || targetPortion > 1) {
          logger.warning(
            `Invalid target_portion ${targetPortion} from AI for ${account.name}, skipping`,
          )
          outcome('rejected', `Invalid target_portion ${targetPortion} from AI for ${account.name}, skipping`)
          saveAIDecision(account, decision, portfolio, false)
          continue
        }

        const price = prices[symbol]
        if (!price || price <= 0) {
          logger.warning(
            `Invalid price for ${symbol} for ${account.name}, skipping`,
          )
          outcome('rejected', `Invalid price for ${symbol} for ${account.name}, skipping`)
          saveAIDecision(account, decision, portfolio, false)
          continue
        }

        let quantity: number
        let side: string

        if (operation === 'open') {
          // ONE position per coin rule
          const existingPosition = db
            .select()
            .from(positionsTable)
            .where(
              and(
                eq(positionsTable.accountId, account.id),
                eq(positionsTable.symbol, symbol),
                eq(positionsTable.market, 'CRYPTO'),
              ),
            )
            .get()

          if (existingPosition && existingPosition.quantity > 0) {
            logger.warning(
              `Cannot open ${direction} position on ${symbol} - already have a ${existingPosition.side} position. Only ONE position per coin allowed. Close existing position first.`,
            )
            outcome('rejected', `Cannot open ${direction} position on ${symbol} - already have a ${existingPosition.side} position. Only ONE position per coin allowed. Close existing position first.`)
            saveAIDecision(account, decision, portfolio, false)
            continue
          }

          const orderValue = account.currentCash * targetPortion
          quantity = round6(orderValue / price)

          if (quantity <= 0) {
            logger.info(
              `Calculated ${direction.toUpperCase()} quantity <= 0 for ${symbol} for ${account.name}, skipping`,
            )
            outcome('rejected', `Calculated ${direction.toUpperCase()} quantity <= 0 for ${symbol} for ${account.name}, skipping`)
            saveAIDecision(account, decision, portfolio, false)
            continue
          }

          side = direction === 'long' ? 'LONG' : 'SHORT'
        } else {
          // close
          const position = db
            .select()
            .from(positionsTable)
            .where(
              and(
                eq(positionsTable.accountId, account.id),
                eq(positionsTable.symbol, symbol),
                eq(positionsTable.market, 'CRYPTO'),
              ),
            )
            .get()

          if (!position || position.quantity <= 0) {
            logger.warning(
              `No position available to close for ${symbol} for ${account.name}, skipping`,
            )
            outcome('rejected', `No position available to close for ${symbol} for ${account.name}, skipping`)
            saveAIDecision(account, decision, portfolio, false)
            continue
          }

          const positionSide = (position.side ?? 'LONG').toLowerCase()
          if (positionSide !== direction) {
            logger.warning(
              `Cannot close ${direction} position on ${symbol} - current position is ${positionSide.toUpperCase()}. Direction mismatch!`,
            )
            outcome('rejected', `Cannot close ${direction} position on ${symbol} - current position is ${positionSide.toUpperCase()}. Direction mismatch!`)
            saveAIDecision(account, decision, portfolio, false)
            continue
          }

          // Leveraged positions close against total quantity, spot against available
          const positionQuantity =
            position.leverage > 1 ? position.quantity : position.availableQuantity

          quantity = round6(positionQuantity * targetPortion)
          if (quantity > positionQuantity) quantity = positionQuantity

          if (quantity <= 0) {
            logger.info(
              `Calculated close quantity <= 0 for ${symbol} for ${account.name}, skipping`,
            )
            outcome('rejected', `Calculated close quantity <= 0 for ${symbol} for ${account.name}, skipping`)
            saveAIDecision(account, decision, portfolio, false)
            continue
          }

          // SELL closes LONG, BUY closes SHORT
          side = direction === 'long' ? 'SELL' : 'BUY'
        }

        const leverage = Number(decision.leverage) || 1
        const name = SUPPORTED_SYMBOLS[symbol]!

        let orderId: number | null = null
        let executed = false
        try {
          const order = await placeAndExecuteCrypto({
            account,
            symbol,
            name,
            side,
            orderType: 'MARKET',
            price: null,
            quantity,
            leverage,
          })
          orderId = order.id
          executed = true
          logger.info(
            `✅ AI order executed: account=${account.name} ${operation.toUpperCase()} ${direction.toUpperCase()} ${side} ${symbol} ${order.orderNo} quantity=${quantity} leverage=${leverage}x reason='${reason}'`,
          )
        } catch (e) {
          logger.error(`Failed to execute order for ${account.name}: ${e}`)
          executed = false
          outcome('execution_failed', `${side} ${symbol} quantity=${quantity} leverage=${leverage}x: ${e}`)
        }
        if (executed) {
          outcome('executed', `${side} ${symbol} quantity=${quantity} leverage=${leverage}x`, orderId)
        }

        saveAIDecision(account, decision, portfolio, executed, orderId)
      } catch (accountErr) {
        logger.error(
          `AI-driven order placement failed for account ${account.name}: ${accountErr}`,
        )
        // Continue with next account even if one fails
      }
    }
  } catch (err) {
    logger.error(`AI-driven order placement failed: ${err}`)
  }
}

/** Legacy random order placement (kept for backward compatibility). */
export async function placeRandomCryptoOrder(maxRatio = 0.2): Promise<void> {
  try {
    const activeAccounts = getActiveAIAccounts()
    if (activeAccounts.length === 0) {
      logger.debug('No available accounts, skipping auto order placement')
      return
    }

    const account = randomChoice(activeAccounts)

    const positionsValue = await calcPositionsValue(account.id)
    const totalAssets = positionsValue + account.currentCash

    if (totalAssets <= 0) {
      logger.debug(
        `Account ${account.name} total assets non-positive, skipping auto order placement`,
      )
      return
    }

    const maxOrderValue = totalAssets * maxRatio
    if (maxOrderValue <= 0) {
      logger.debug(`Account ${account.name} maximum order amount is 0, skipping`)
      return
    }

    const symbol = randomChoice(Object.keys(SUPPORTED_SYMBOLS))
    const sideInfo = await selectSide(account, symbol, maxOrderValue)
    if (!sideInfo) {
      logger.debug(
        `Account ${account.name} has no executable direction for ${symbol}, skipping`,
      )
      return
    }

    const [side, quantity] = sideInfo
    const name = SUPPORTED_SYMBOLS[symbol]!

    const order = await createOrder({
      account,
      symbol,
      name,
      side,
      orderType: 'MARKET',
      price: null,
      quantity,
    })

    const executed = await checkAndExecuteOrder(order)
    if (executed) {
      logger.info(
        `Auto order executed: account=${account.name} ${side} ${symbol} ${order.orderNo} quantity=${quantity}`,
      )
    } else {
      logger.info(
        `Auto order created: account=${account.name} ${side} ${symbol} quantity=${quantity} order_id=${order.orderNo}`,
      )
    }
  } catch (err) {
    logger.error(`Auto order placement failed: ${err}`)
  }
}

/** Re-exported for parity with the old `services/auto_trader.py` shim. */
export { getActiveAIAccounts, SUPPORTED_SYMBOLS }
export { accounts as accountsTable }
