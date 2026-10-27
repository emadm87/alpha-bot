/** WebSocket endpoint and connection manager. Port of `api/ws.py`. */
import type { WSContext } from 'hono/ws'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  aiDecisionLogs,
  trades as tradesTable,
  type Account,
} from '../db/schema.js'
import { getAccount, getOrCreateDefaultAccount } from '../repositories/account.js'
import { getOrCreateUser, getUser } from '../repositories/user.js'
import { listOrders } from '../repositories/order.js'
import { listPositions } from '../repositories/position.js'
import {
  calcAccountEquity,
  calcPositionsValue,
} from '../services/assetCalculator.js'
import { getLastPrice } from '../services/marketData.js'
import {
  addAccountSnapshotJob,
  removeAccountSnapshotJob,
} from '../services/scheduler.js'
import { getAllAssetCurvesDataNew } from '../services/assetCurveCalculator.js'
import { createOrder } from '../services/orderMatching.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('api.ws')

/** WebSocket readyState for an open socket. */
const OPEN = 1

export class ConnectionManager {
  private activeConnections = new Map<number, Set<WSContext>>()

  register(accountId: number, ws: WSContext): void {
    let set = this.activeConnections.get(accountId)
    if (!set) {
      set = new Set()
      this.activeConnections.set(accountId, set)
    }
    set.add(ws)
    // Add scheduled snapshot task for new account
    addAccountSnapshotJob(accountId, 10)
  }

  unregister(accountId: number, ws: WSContext): void {
    const set = this.activeConnections.get(accountId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) {
      this.activeConnections.delete(accountId)
      removeAccountSnapshotJob(accountId)
    }
  }

  hasConnections(accountId: number): boolean {
    return this.activeConnections.has(accountId)
  }

  sendToAccount(accountId: number, message: unknown): void {
    const set = this.activeConnections.get(accountId)
    if (!set) return

    const payload = JSON.stringify(message)
    for (const ws of [...set]) {
      try {
        if (ws.readyState !== OPEN) {
          set.delete(ws)
          continue
        }
        ws.send(payload)
      } catch (e) {
        logger.warning(`Failed to send message to WebSocket: ${e}`)
        set.delete(ws)
      }
    }
  }

  /** Broadcast a message to all connected clients. */
  broadcastToAll(message: unknown): void {
    const payload = JSON.stringify(message)
    for (const [, sockets] of [...this.activeConnections]) {
      for (const ws of [...sockets]) {
        try {
          if (ws.readyState !== OPEN) {
            sockets.delete(ws)
            continue
          }
          ws.send(payload)
        } catch (e) {
          logger.warning(`Failed to broadcast message to WebSocket: ${e}`)
          sockets.delete(ws)
        }
      }
    }
  }
}

export const manager = new ConnectionManager()

/**
 * Get timeframe-based asset curve data for all accounts — WebSocket version.
 * Uses the algorithm that draws curves by account and creates all-time lists.
 */
export function getAllAssetCurvesData(timeframe = '1h') {
  return getAllAssetCurvesDataNew(timeframe)
}

/** Broadcast asset curve updates to all connected clients. */
export async function broadcastAssetCurveUpdate(timeframe = '1h'): Promise<void> {
  try {
    const assetCurves = await getAllAssetCurvesData(timeframe)
    manager.broadcastToAll({
      type: 'asset_curve_update',
      timeframe,
      data: assetCurves,
    })
  } catch (e) {
    logger.error(`Failed to broadcast asset curve update: ${e}`)
  }
}

function buildOverview(
  account: Account,
  positionsMarketValue: number,
  positionsNotionalValue: number,
) {
  // Total assets = cash + posted margin + unrealized P&L (calcAccountEquity),
  // the same account value as /overview and the AI prompt
  const totalAssets = positionsMarketValue + account.currentCash
  const initialCapital = account.initialCapital
  const returnRate =
    initialCapital > 0 ? totalAssets / initialCapital - 1 : 0.0

  return {
    account: {
      id: account.id,
      user_id: account.userId,
      name: account.name,
      account_type: account.accountType,
      initial_capital: account.initialCapital,
      current_cash: account.currentCash,
      frozen_cash: account.frozenCash,
    },
    return_rate: returnRate,
    total_assets: totalAssets,
    positions_market_value: positionsMarketValue,
    /** DEPRECATED: kept for compatibility, mirrors total_assets. */
    total_notional_value: totalAssets,
    /** DEPRECATED: still available for risk exposure. */
    positions_notional_value: positionsNotionalValue,
  }
}

/**
 * Builds the snapshot payload shared by the full and optimized variants.
 * @param limit how many orders / trades / decisions to include
 */
async function buildSnapshot(accountId: number, limit: number) {
  const account = getAccount(accountId)
  if (!account) return null

  const positions = listPositions(accountId)
  const orders = listOrders(accountId)
  const trades = db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.accountId, accountId))
    .orderBy(desc(tradesTable.tradeTime))
    .limit(limit)
    .all()

  const aiDecisions = db
    .select()
    .from(aiDecisionLogs)
    .where(eq(aiDecisionLogs.accountId, accountId))
    .orderBy(desc(aiDecisionLogs.decisionTime))
    .limit(limit)
    .all()

  const positionsMarketValue = (await calcAccountEquity(account)).positionsEquity
  const positionsNotionalValue = await calcPositionsValue(accountId)

  // Batch price fetching: one lookup per unique (symbol, market)
  const priceCache = new Map<string, number | null>()
  let priceErrorMessage: string | null = null

  for (const p of positions) {
    const key = `${p.symbol} ${p.market}`
    if (priceCache.has(key)) continue
    try {
      priceCache.set(key, await getLastPrice(p.symbol, p.market))
    } catch (e) {
      priceCache.set(key, null)
      const errorMsg = String(e)
      if (errorMsg.toLowerCase().includes('cookie') && priceErrorMessage === null) {
        priceErrorMessage = errorMsg
      }
    }
  }

  const enrichedPositions = positions.map((p) => {
    const price = priceCache.get(`${p.symbol} ${p.market}`) ?? null
    return {
      id: p.id,
      account_id: p.accountId,
      symbol: p.symbol,
      name: p.name,
      market: p.market,
      quantity: p.quantity,
      available_quantity: p.availableQuantity,
      avg_cost: p.avgCost,
      leverage: p.leverage,
      last_price: price,
      market_value: price !== null ? price * p.quantity : null,
      notional_value: price !== null ? price * p.quantity * p.leverage : null,
    }
  })

  return {
    overview: buildOverview(
      account,
      positionsMarketValue,
      positionsNotionalValue,
    ),
    positions: enrichedPositions,
    orders: orders.slice(0, limit).map((o) => ({
      id: o.id,
      order_no: o.orderNo,
      user_id: o.accountId,
      symbol: o.symbol,
      name: o.name,
      market: o.market,
      side: o.side,
      order_type: o.orderType,
      price: o.price,
      quantity: o.quantity,
      leverage: o.leverage,
      filled_quantity: o.filledQuantity,
      status: o.status,
    })),
    trades: trades.map((t) => ({
      id: t.id,
      order_id: t.orderId,
      user_id: t.accountId,
      symbol: t.symbol,
      name: t.name,
      market: t.market,
      side: t.side,
      price: t.price,
      quantity: t.quantity,
      commission: t.commission,
      trade_time: String(t.tradeTime),
    })),
    ai_decisions: aiDecisions.map((d) => ({
      id: d.id,
      decision_time: String(d.decisionTime),
      reason: d.reason,
      operation: d.operation,
      symbol: d.symbol,
      prev_portion: d.prevPortion,
      target_portion: d.targetPortion,
      total_balance: d.totalBalance,
      executed: d.executed ? String(d.executed).toLowerCase() : 'false',
      order_id: d.orderId,
      leverage: d.leverage ?? 1,
    })),
    warning: priceErrorMessage
      ? { type: 'market_data_error', message: priceErrorMessage }
      : null,
  }
}

/** Optimized snapshot that reduces expensive operations. */
export async function sendSnapshotOptimized(accountId: number): Promise<void> {
  const snapshot = await buildSnapshot(accountId, 10)
  if (!snapshot) return

  const { warning, ...rest } = snapshot
  const responseData: Record<string, unknown> = {
    type: 'snapshot_fast',
    ...rest,
    timestamp: Date.now() / 1000,
  }

  // Only include expensive asset curve data in the first 10 seconds of a minute
  const currentSecond = Math.trunc(Date.now() / 1000) % 60
  if (currentSecond < 10) {
    try {
      responseData.all_asset_curves = await getAllAssetCurvesData('1h')
      responseData.type = 'snapshot_full'
    } catch (e) {
      logger.error(`Failed to get asset curves: ${e}`)
    }
  }

  if (warning) responseData.warning = warning

  manager.sendToAccount(accountId, responseData)
}

export async function sendSnapshot(accountId: number): Promise<void> {
  const snapshot = await buildSnapshot(accountId, 20)
  if (!snapshot) return

  const { warning, ...rest } = snapshot
  const responseData: Record<string, unknown> = {
    type: 'snapshot',
    ...rest,
    all_asset_curves: await getAllAssetCurvesData('1h'),
  }

  if (warning) responseData.warning = warning

  manager.sendToAccount(accountId, responseData)
}

/** Per-connection state for the WebSocket message loop. */
interface WsState {
  accountId: number | null
  userId: number | null
}

const send = (ws: WSContext, message: unknown) => {
  try {
    ws.send(JSON.stringify(message))
  } catch (e) {
    logger.warning(`Failed to send WebSocket message: ${e}`)
  }
}

export function createWsState(): WsState {
  return { accountId: null, userId: null }
}

export function handleWsClose(state: WsState, ws: WSContext): void {
  if (state.accountId !== null) manager.unregister(state.accountId, ws)
  if (state.userId !== null) manager.unregister(state.userId, ws)
}

/** Handles one inbound WebSocket text frame. */
export async function handleWsMessage(
  state: WsState,
  ws: WSContext,
  data: string,
): Promise<void> {
  let msg: Record<string, any>
  try {
    msg = JSON.parse(data)
  } catch (e) {
    logger.error(`Invalid JSON received: ${e}`)
    send(ws, { type: 'error', message: 'Invalid JSON format' })
    return
  }

  const kind = msg.type

  switch (kind) {
    case 'bootstrap': {
      const username = msg.username ?? 'default'
      const user = getOrCreateUser(username)

      const account = getOrCreateDefaultAccount({
        userId: user.id,
        accountName: `${username} AI Trader`,
        initialCapital: Number(msg.initial_capital ?? 100000),
      })
      state.accountId = account.id
      manager.register(account.id, ws)

      manager.sendToAccount(account.id, {
        type: 'bootstrap_ok',
        user: { id: user.id, username: user.username },
        account: { id: account.id, name: account.name, user_id: account.userId },
      })
      await sendSnapshot(account.id)
      break
    }

    case 'subscribe': {
      const uid = Number(msg.user_id)
      if (!getUser(uid)) {
        send(ws, { type: 'error', message: 'user not found' })
        return
      }
      state.userId = uid
      manager.register(uid, ws)
      await sendSnapshot(uid)
      break
    }

    case 'switch_user': {
      const targetUsername = msg.username
      if (!targetUsername) {
        send(ws, { type: 'error', message: 'username required' })
        return
      }

      if (state.userId !== null) manager.unregister(state.userId, ws)

      const targetUser = getOrCreateUser(targetUsername)
      state.userId = targetUser.id
      manager.register(targetUser.id, ws)

      manager.sendToAccount(targetUser.id, {
        type: 'user_switched',
        user: { id: targetUser.id, username: targetUser.username },
      })
      await sendSnapshot(targetUser.id)
      break
    }

    case 'switch_account': {
      const targetAccountId = msg.account_id
      if (!targetAccountId) {
        send(ws, { type: 'error', message: 'account_id required' })
        return
      }

      if (state.accountId !== null) manager.unregister(state.accountId, ws)

      const targetAccount = getAccount(Number(targetAccountId))
      if (!targetAccount) {
        send(ws, { type: 'error', message: 'account not found' })
        return
      }

      state.accountId = targetAccount.id
      manager.register(targetAccount.id, ws)

      manager.sendToAccount(targetAccount.id, {
        type: 'account_switched',
        account: {
          id: targetAccount.id,
          user_id: targetAccount.userId,
          name: targetAccount.name,
        },
      })
      await sendSnapshot(targetAccount.id)
      break
    }

    case 'get_snapshot': {
      if (state.accountId !== null) await sendSnapshot(state.accountId)
      break
    }

    case 'get_asset_curve': {
      const timeframe = msg.timeframe ?? '1h'
      if (!['5m', '1h', '1d'].includes(timeframe)) {
        send(ws, {
          type: 'error',
          message: 'Invalid timeframe. Must be 5m, 1h, or 1d',
        })
        return
      }
      send(ws, {
        type: 'asset_curve_data',
        timeframe,
        data: await getAllAssetCurvesData(timeframe),
      })
      break
    }

    case 'place_order': {
      if (state.accountId === null) {
        send(ws, { type: 'error', message: 'not authenticated' })
        return
      }

      try {
        const account = getAccount(state.accountId)
        if (!account) {
          send(ws, { type: 'error', message: 'account not found' })
          return
        }
        if (!getUser(account.userId)) {
          send(ws, { type: 'error', message: 'user not found' })
          return
        }

        const symbol = msg.symbol
        const name = msg.name ?? symbol
        const side = msg.side
        const orderType = msg.order_type
        const price = msg.price
        let quantity = msg.quantity
        let leverage = msg.leverage ?? 1

        if (!symbol || !side || !orderType || !quantity) {
          send(ws, { type: 'error', message: 'missing required parameters' })
          return
        }

        quantity = Number(quantity)
        if (!Number.isFinite(quantity)) {
          send(ws, { type: 'error', message: 'invalid quantity' })
          return
        }

        leverage = Number(leverage)
        if (!Number.isInteger(leverage)) {
          send(ws, { type: 'error', message: 'invalid leverage' })
          return
        }
        if (leverage < 1 || leverage > 50) {
          send(ws, {
            type: 'error',
            message: 'leverage must be between 1 and 50',
          })
          return
        }

        const order = await createOrder({
          account,
          symbol,
          name,
          side,
          orderType,
          price,
          quantity,
          leverage,
        })

        manager.sendToAccount(state.accountId, {
          type: 'order_pending',
          order_id: order.id,
        })
        await sendSnapshot(state.accountId)
      } catch (e) {
        // Business logic errors (insufficient funds, etc.)
        send(ws, { type: 'error', message: String((e as Error).message ?? e) })
      }
      break
    }

    case 'ping': {
      send(ws, { type: 'pong' })
      break
    }

    default:
      send(ws, { type: 'error', message: 'unknown message' })
  }
}
