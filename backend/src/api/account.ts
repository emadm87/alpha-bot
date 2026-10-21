/** Account and Asset Curve API Routes. Port of `api/account_routes.py`. */
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { and, asc, eq, gt } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  orders,
  positions as positionsTable,
  trades as tradesTable,
  users,
  type Account,
} from '../db/schema.js'
import {
  calcAccountEquity,
  calcPositionsMarketValue,
} from '../services/assetCalculator.js'
import { getKlineData, type Kline } from '../services/marketData.js'
import { resetAutoTradingJob } from '../services/scheduler.js'
import { getLogger } from '../utils/logger.js'
import { dbDateMs } from '../utils/datetime.js'

const logger = getLogger('api.account')

export const accountRoutes = new Hono()

function accountPayload(account: Account, username: string) {
  return {
    id: account.id,
    user_id: account.userId,
    username,
    name: account.name,
    account_type: account.accountType,
    initial_capital: account.initialCapital,
    current_cash: account.currentCash,
    frozen_cash: account.frozenCash,
    model: account.model,
    base_url: account.baseUrl,
    api_key: account.apiKey,
    is_active: account.isActive === 'true',
  }
}

/** Get all active accounts (for paper trading demo). */
accountRoutes.get('/list', (c) => {
  try {
    const rows = db
      .select()
      .from(accounts)
      .where(eq(accounts.isActive, 'true'))
      .all()

    return c.json(
      rows.map((account) => {
        const user = db
          .select()
          .from(users)
          .where(eq(users.id, account.userId))
          .get()
        return accountPayload(account, user?.username ?? 'unknown')
      }),
    )
  } catch (e) {
    logger.error(`Failed to list accounts: ${e}`)
    throw new HTTPException(500, { message: `Failed to list accounts: ${e}` })
  }
})

/** Get overview for the default account (for paper trading demo). */
accountRoutes.get('/overview', async (c) => {
  try {
    const account = db
      .select()
      .from(accounts)
      .where(eq(accounts.isActive, 'true'))
      .get()

    if (!account) {
      throw new HTTPException(404, { message: 'No active account found' })
    }

    const positionsValue = (await calcAccountEquity(account)).positionsEquity
    const positionsCount = db
      .select()
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.accountId, account.id),
          gt(positionsTable.quantity, 0),
        ),
      )
      .all().length

    const pendingOrders = db
      .select()
      .from(orders)
      .where(
        and(eq(orders.accountId, account.id), eq(orders.status, 'PENDING')),
      )
      .all().length

    return c.json({
      account: {
        id: account.id,
        name: account.name,
        account_type: account.accountType,
        current_cash: account.currentCash,
        frozen_cash: account.frozenCash,
      },
      portfolio: {
        total_assets: positionsValue + account.currentCash,
        positions_value: positionsValue,
        positions_count: positionsCount,
        pending_orders: pendingOrders,
      },
    })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to get overview: ${e}`)
    throw new HTTPException(500, { message: `Failed to get overview: ${e}` })
  }
})

/**
 * Get asset curve data for all accounts within a specified timeframe
 * (20 data points).
 *
 * Registered before `/:accountId/overview` so the literal path wins.
 */
accountRoutes.get('/asset-curve/timeframe', async (c) => {
  try {
    const timeframe = c.req.query('timeframe') ?? '1d'

    const validTimeframes = ['5m', '1h', '1d']
    if (!validTimeframes.includes(timeframe)) {
      throw new HTTPException(400, {
        message: `Invalid timeframe. Must be one of: ${validTimeframes.join(', ')}`,
      })
    }
    const period = timeframe

    const activeAccounts = db
      .select()
      .from(accounts)
      .where(eq(accounts.isActive, 'true'))
      .all()

    if (activeAccounts.length === 0) return c.json([])

    const symbolRows = db
      .selectDistinct({
        symbol: tradesTable.symbol,
        market: tradesTable.market,
      })
      .from(tradesTable)
      .all()

    if (symbolRows.length === 0) {
      // No trades yet, return initial capital for all accounts
      const now = new Date()
      return c.json(
        activeAccounts.map((account) => ({
          timestamp: Math.trunc(now.getTime() / 1000),
          datetime_str: now.toISOString(),
          user_id: account.userId,
          username: account.name,
          total_assets: account.initialCapital,
          initial_capital: account.initialCapital,
          profit: 0.0,
          profit_percentage: 0.0,
          cash: account.currentCash,
          positions_value: 0.0,
        })),
      )
    }

    // Fetch kline data for all symbols (20 points)
    const symbolKlines = new Map<string, Kline[]>()
    for (const { symbol, market } of symbolRows) {
      try {
        const klines = await getKlineData(symbol, market, period, 20)
        if (klines.length > 0) {
          symbolKlines.set(`${symbol} ${market}`, klines)
          logger.info(`Fetched ${klines.length} klines for ${symbol}.${market}`)
        }
      } catch (e) {
        logger.warning(`Failed to fetch klines for ${symbol}.${market}: ${e}`)
      }
    }

    if (symbolKlines.size === 0) {
      throw new HTTPException(500, { message: 'Failed to fetch market data' })
    }

    const firstKlines = symbolKlines.values().next().value as Kline[]
    const timestamps = firstKlines.map((k) => k.timestamp)

    const result: Record<string, unknown>[] = []

    for (const account of activeAccounts) {
      const accountTrades = db
        .select()
        .from(tradesTable)
        .where(eq(tradesTable.accountId, account.id))
        .orderBy(asc(tradesTable.tradeTime))
        .all()

      if (accountTrades.length === 0) {
        // No trades, return initial capital at all timestamps
        timestamps.forEach((ts, i) => {
          result.push({
            timestamp: ts,
            datetime_str: firstKlines[i]?.datetime_str ?? '',
            user_id: account.userId,
            username: account.name,
            total_assets: account.initialCapital,
            initial_capital: account.initialCapital,
            profit: 0.0,
            profit_percentage: 0.0,
            cash: account.initialCapital,
            positions_value: 0.0,
          })
        })
        continue
      }

      for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i]!
        const tsMs = ts * 1000
        const isLastTimestamp = i === timestamps.length - 1

        let cashChange = 0.0
        const positionQuantities = new Map<string, number>()

        for (const trade of accountTrades) {
          if (dbDateMs(trade.tradeTime) > tsMs) continue

          const tradeAmount =
            trade.price * trade.quantity +
            trade.commission +
            trade.interestCharged
          const isOpen = trade.side === 'BUY' || trade.side === 'LONG'
          cashChange += isOpen ? -tradeAmount : tradeAmount

          const key = `${trade.symbol} ${trade.market}`
          const prev = positionQuantities.get(key) ?? 0.0
          positionQuantities.set(
            key,
            isOpen ? prev + trade.quantity : prev - trade.quantity,
          )
        }

        const currentCash = isLastTimestamp
          ? account.currentCash
          : account.initialCapital + cashChange

        let positionsValue = 0.0
        if (isLastTimestamp) {
          positionsValue = await calcPositionsMarketValue(account.id)
        } else {
          for (const [key, quantity] of positionQuantities) {
            if (quantity <= 0) continue
            const klines = symbolKlines.get(key)
            if (!klines || i >= klines.length) continue
            const price = klines[i]?.close
            if (price) positionsValue += price * quantity
          }
        }

        const totalAssets = currentCash + positionsValue
        const initialCapital = account.initialCapital
        const profit = totalAssets - initialCapital
        const profitPercentage =
          initialCapital > 0 ? (profit / initialCapital) * 100 : 0.0

        result.push({
          timestamp: ts,
          datetime_str: firstKlines[i]?.datetime_str ?? '',
          user_id: account.userId,
          username: account.name,
          total_assets: totalAssets,
          initial_capital: initialCapital,
          profit,
          profit_percentage: profitPercentage,
          cash: currentCash,
          positions_value: positionsValue,
        })
      }
    }

    return c.json(result)
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to get asset curve for timeframe: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get asset curve for timeframe: ${e}`,
    })
  }
})

/** Test LLM connection with provided credentials. */
accountRoutes.post('/test-llm', async (c) => {
  try {
    const payload = (await c.req.json()) as Record<string, unknown>

    const model = (payload.model as string) ?? 'gpt-3.5-turbo'
    let baseUrl = (payload.base_url as string) ?? 'https://api.openai.com/v1'
    const apiKey = (payload.api_key as string) ?? ''

    if (!apiKey) return c.json({ success: false, message: 'API key is required' })
    if (!baseUrl) return c.json({ success: false, message: 'Base URL is required' })

    baseUrl = baseUrl.replace(/\/+$/, '')

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            {
              role: 'user',
              content:
                "Say 'Connection test successful' if you can read this.",
            },
          ],
          max_tokens: 50,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(10_000),
      })

      if (response.status === 200) {
        const result = (await response.json()) as Record<string, any>
        const choices = result.choices
        if (Array.isArray(choices) && choices.length > 0) {
          const content = choices[0]?.message?.content ?? ''
          if (content) {
            logger.info(`LLM test successful for model ${model} at ${baseUrl}`)
            return c.json({
              success: true,
              message: `Connection successful! Model ${model} responded correctly.`,
              response: content,
            })
          }
          return c.json({
            success: false,
            message: 'LLM responded but with empty content',
          })
        }
        return c.json({
          success: false,
          message: 'Unexpected response format from LLM',
        })
      }

      const statusMessages: Record<number, string> = {
        401: 'Authentication failed. Please check your API key.',
        403: 'Permission denied. Your API key may not have access to this model.',
        429: 'Rate limit exceeded. Please try again later.',
        404: `Model '${model}' not found or endpoint not available.`,
      }
      const message =
        statusMessages[response.status] ??
        `API returned status ${response.status}: ${await response.text()}`
      return c.json({ success: false, message })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return c.json({
          success: false,
          message: 'Request timed out. The LLM service may be unavailable.',
        })
      }
      logger.error(`LLM test request failed: ${err}`)
      return c.json({
        success: false,
        message: `Failed to connect to ${baseUrl}. Please check the base URL. (${err.message})`,
      })
    }
  } catch (e) {
    logger.error(`Failed to test LLM connection: ${e}`)
    return c.json({
      success: false,
      message: `Failed to test LLM connection: ${e}`,
    })
  }
})

/** Create a new account for the default user (for paper trading demo). */
accountRoutes.post('/', async (c) => {
  try {
    const payload = (await c.req.json()) as Record<string, any>

    const user =
      db.select().from(users).where(eq(users.username, 'default')).get() ??
      db.select().from(users).get()

    if (!user) throw new HTTPException(404, { message: 'No user found' })

    if (!payload.name) {
      throw new HTTPException(400, { message: 'Account name is required' })
    }

    const initialCapital = Number(payload.initial_capital ?? 10000.0)

    const newAccount = db
      .insert(accounts)
      .values({
        userId: user.id,
        version: 'v1',
        name: payload.name,
        accountType: payload.account_type ?? 'AI',
        model: payload.model ?? 'gpt-4-turbo',
        baseUrl: payload.base_url ?? 'https://api.openai.com/v1',
        apiKey: payload.api_key ?? '',
        initialCapital,
        currentCash: initialCapital,
        frozenCash: 0.0,
        isActive: 'true',
      })
      .returning()
      .get()

    // Reset auto trading job after creating a new account
    try {
      await resetAutoTradingJob()
      logger.info('Auto trading job reset successfully after account creation')
    } catch (e) {
      logger.warning(`Failed to reset auto trading job: ${e}`)
    }

    return c.json(accountPayload(newAccount, user.username))
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to create account: ${e}`)
    throw new HTTPException(500, { message: `Failed to create account: ${e}` })
  }
})

/** Get overview for a specific account. */
accountRoutes.get('/:accountId/overview', async (c) => {
  const accountId = Number(c.req.param('accountId'))
  try {
    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.isActive, 'true')))
      .get()

    if (!account) throw new HTTPException(404, { message: 'Account not found' })

    const positionsValue = (await calcAccountEquity(account)).positionsEquity

    const positionsCount = db
      .select()
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.accountId, account.id),
          gt(positionsTable.quantity, 0),
        ),
      )
      .all().length

    const pendingOrders = db
      .select()
      .from(orders)
      .where(
        and(eq(orders.accountId, account.id), eq(orders.status, 'PENDING')),
      )
      .all().length

    return c.json({
      account: {
        id: account.id,
        name: account.name,
        account_type: account.accountType,
        current_cash: account.currentCash,
        frozen_cash: account.frozenCash,
      },
      total_assets: positionsValue + account.currentCash,
      positions_value: positionsValue,
      positions_count: positionsCount,
      pending_orders: pendingOrders,
    })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to get account ${accountId} overview: ${e}`)
    throw new HTTPException(500, {
      message: `Failed to get account overview: ${e}`,
    })
  }
})

/** Update account settings (for paper trading demo). */
accountRoutes.put('/:accountId', async (c) => {
  const accountId = Number(c.req.param('accountId'))
  try {
    const payload = (await c.req.json()) as Record<string, any>
    logger.info(
      `Updating account ${accountId} with payload keys: ${Object.keys(payload).join(', ')}`,
    )

    const account = db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.isActive, 'true')))
      .get()

    if (!account) throw new HTTPException(404, { message: 'Account not found' })

    // Update fields if provided (empty strings are allowed for api_key/base_url)
    const values: Partial<typeof accounts.$inferInsert> = {}

    if ('name' in payload) {
      if (!payload.name) {
        throw new HTTPException(400, {
          message: 'Account name cannot be empty',
        })
      }
      values.name = payload.name
    }
    if ('model' in payload) values.model = payload.model ? payload.model : null
    if ('base_url' in payload) values.baseUrl = payload.base_url
    if ('api_key' in payload) values.apiKey = payload.api_key

    const updated =
      Object.keys(values).length > 0
        ? db
            .update(accounts)
            .set(values)
            .where(eq(accounts.id, accountId))
            .returning()
            .get()
        : account

    logger.info(`Account ${accountId} updated successfully`)

    try {
      await resetAutoTradingJob()
      logger.info('Auto trading job reset successfully after account update')
    } catch (e) {
      logger.warning(`Failed to reset auto trading job: ${e}`)
    }

    const user = db
      .select()
      .from(users)
      .where(eq(users.id, updated.userId))
      .get()

    return c.json(accountPayload(updated, user?.username ?? 'unknown'))
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to update account: ${e}`)
    throw new HTTPException(500, { message: `Failed to update account: ${e}` })
  }
})

/** Verify auth session token. */
accountRoutes.post('/auth/verify', async (c) => {
  try {
    const payload = (await c.req.json()) as { session_token?: string }
    const token = payload.session_token
    if (!token) return c.json({ valid: false, message: 'Token required' })

    const { verifyAuthSession } = await import('../repositories/user.js')
    const userId = verifyAuthSession(token)

    if (userId !== null) {
      return c.json({ valid: true, user_id: userId })
    }
    return c.json({ valid: false, message: 'Invalid or expired session' })
  } catch (e) {
    return c.json({ valid: false, message: String(e) })
  }
})

/** Soft delete / deactivate an account. */
accountRoutes.delete('/:accountId', async (c) => {
  const accountId = Number(c.req.param('accountId'))
  try {
    const { deactivateAccount } = await import('../repositories/account.js')
    const deactivated = deactivateAccount(accountId)

    if (!deactivated) {
      throw new HTTPException(404, { message: 'Account not found' })
    }

    try {
      await resetAutoTradingJob()
    } catch (e) {
      logger.warning(`Failed to reset auto trading job after deletion: ${e}`)
    }

    return c.json({ success: true, message: 'Account deactivated successfully' })
  } catch (e) {
    if (e instanceof HTTPException) throw e
    logger.error(`Failed to delete account ${accountId}: ${e}`)
    throw new HTTPException(500, { message: `Failed to delete account: ${e}` })
  }
})
