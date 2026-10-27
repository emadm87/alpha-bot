/**
 * Scheduled task scheduler service.
 * Manages WebSocket snapshot updates and other periodic tasks.
 * Port of `services/scheduler.py` (APScheduler -> setInterval).
 *
 * APScheduler's `max_instances=1` + `coalesce=True` semantics are reproduced
 * with a per-job in-flight flag: if the previous run has not finished, the
 * tick is skipped rather than piling up concurrent executions.
 */
import { and, eq, gt, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  cryptoPrices,
  liquidationEvents,
  positions as positionsTable,
  type Account,
  type Position,
} from '../db/schema.js'
import { getLogger } from '../utils/logger.js'
import { utcDateStr } from '../utils/datetime.js'

const logger = getLogger('services.scheduler')

interface Job {
  id: string
  intervalSeconds: number
  timer: NodeJS.Timeout
  fn: () => void | Promise<void>
  inFlight: boolean
  funcName: string
  nextRunTime: number
}

/** Accounts whose Hyperliquid margin check is running: never two at once. */
const hyperliquidChecks = new Set<number>()
/** Last reason an account could not be evaluated, to log each change once. */
const hyperliquidSkips = new Map<number, string>()

/** Unified task scheduler. */
export class TaskScheduler {
  private jobs = new Map<string, Job>()
  private started = false

  start(): void {
    if (!this.started) {
      this.started = true
      logger.info('Scheduler started')
    }
  }

  shutdown(): void {
    if (!this.started) return
    for (const job of this.jobs.values()) clearInterval(job.timer)
    this.jobs.clear()
    this.started = false
    logger.info('Scheduler shutdown')
  }

  isRunning(): boolean {
    return this.started
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId)
  }

  /** Registers a repeating job, replacing any existing job with the same id. */
  private schedule(
    jobId: string,
    intervalSeconds: number,
    fn: () => void | Promise<void>,
    funcName: string,
  ): void {
    if (!this.isRunning()) this.start()

    const existing = this.jobs.get(jobId)
    if (existing) clearInterval(existing.timer)

    const job: Job = {
      id: jobId,
      intervalSeconds,
      fn,
      inFlight: false,
      funcName,
      nextRunTime: Date.now() + intervalSeconds * 1000,
      timer: setInterval(() => {
        const j = this.jobs.get(jobId)
        if (!j) return
        j.nextRunTime = Date.now() + intervalSeconds * 1000
        // max_instances=1 / coalesce=True
        if (j.inFlight) {
          logger.debug(`Job ${jobId} still running, skipping this tick`)
          return
        }
        j.inFlight = true
        void Promise.resolve()
          .then(() => j.fn())
          .catch((e) => logger.error(`Job ${jobId} failed: ${e}`))
          .finally(() => {
            j.inFlight = false
          })
      }, intervalSeconds * 1000),
    }
    job.timer.unref?.()
    this.jobs.set(jobId, job)
  }

  /** Add snapshot update task for an account (default every 10 seconds). */
  addAccountSnapshotTask(accountId: number, intervalSeconds = 10): void {
    if (!this.isRunning()) this.start()

    const jobId = `snapshot_account_${accountId}`
    if (this.jobs.has(jobId)) {
      logger.debug(`Snapshot task for account ${accountId} already exists`)
      return
    }

    this.schedule(
      jobId,
      intervalSeconds,
      () => this.executeAccountSnapshot(accountId),
      'executeAccountSnapshot',
    )
    logger.info(
      `Added snapshot task for account ${accountId}, interval ${intervalSeconds} seconds`,
    )
  }

  /**
   * Add margin monitoring task to watch for liquidation conditions.
   * Checks all leveraged positions and force closes if margin is insufficient.
   */
  addMarginMonitorTask(intervalSeconds = 5): void {
    if (!this.isRunning()) this.start()

    const jobId = 'margin_monitor'
    if (this.jobs.has(jobId)) {
      logger.debug('Margin monitor task already exists')
      return
    }

    this.schedule(
      jobId,
      intervalSeconds,
      () => this.checkMarginLevels(),
      'checkMarginLevels',
    )
    logger.info(
      `Added margin monitor task, checking every ${intervalSeconds} seconds`,
    )
  }

  removeAccountSnapshotTask(accountId: number): void {
    const jobId = `snapshot_account_${accountId}`
    if (this.jobs.has(jobId)) {
      this.removeTask(jobId)
      logger.info(`Removed snapshot task for account ${accountId}`)
    } else {
      logger.debug(`Failed to remove snapshot task for account ${accountId}`)
    }
  }

  /** Add an interval execution task. */
  addIntervalTask(
    taskFunc: () => void | Promise<void>,
    intervalSeconds: number,
    taskId: string,
  ): void {
    this.schedule(taskId, intervalSeconds, taskFunc, taskFunc.name || taskId)
    logger.info(
      `Added interval task ${taskId}: Execute every ${intervalSeconds} seconds`,
    )
  }

  removeTask(taskId: string): void {
    const job = this.jobs.get(taskId)
    if (!job) {
      logger.debug(`Failed to remove task ${taskId}: not found`)
      return
    }
    clearInterval(job.timer)
    this.jobs.delete(taskId)
    logger.info(`Removed task: ${taskId}`)
  }

  /** Get all task information. */
  getJobInfo(): { id: string; next_run_time: string; func_name: string }[] {
    return [...this.jobs.values()].map((j) => ({
      id: j.id,
      next_run_time: new Date(j.nextRunTime).toISOString(),
      func_name: j.funcName,
    }))
  }

  /** Internal method to execute an account snapshot update. */
  private async executeAccountSnapshot(accountId: number): Promise<void> {
    const startTime = Date.now()
    try {
      // Dynamic import to avoid circular dependency
      const { manager } = await import('../api/ws.js')

      // Account disconnected -> drop the task
      if (!manager.hasConnections(accountId)) {
        this.removeAccountSnapshotTask(accountId)
        return
      }

      // Save latest prices for the account's positions (less frequently)
      if (new Date(startTime).getSeconds() % 30 === 0) {
        await this.savePositionPrices(accountId)
      }
    } catch (e) {
      logger.error(`Account ${accountId} snapshot update failed: ${e}`)
    } finally {
      const executionTime = (Date.now() - startTime) / 1000
      if (executionTime > 5) {
        logger.warning(
          `Slow snapshot execution for account ${accountId}: ${executionTime.toFixed(2)}s`,
        )
      }
    }
  }

  /** Save latest prices for an account's positions on the current date. */
  private async savePositionPrices(accountId: number): Promise<void> {
    const { getLastPrice } = await import('./marketData.js')

    try {
      const positions = db
        .select()
        .from(positionsTable)
        .where(
          and(
            eq(positionsTable.accountId, accountId),
            gt(positionsTable.quantity, 0),
          ),
        )
        .all()

      if (positions.length === 0) {
        logger.debug(`Account ${accountId} has no positions, skip price saving`)
        return
      }

      const today = utcDateStr()

      for (const position of positions) {
        try {
          const existingPrice = db
            .select()
            .from(cryptoPrices)
            .where(
              and(
                eq(cryptoPrices.symbol, position.symbol),
                eq(cryptoPrices.market, position.market),
                eq(cryptoPrices.priceDate, today),
              ),
            )
            .get()

          if (existingPrice) {
            logger.debug(
              `crypto ${position.symbol} price already exists for today, skip`,
            )
            continue
          }

          const currentPrice = await getLastPrice(
            position.symbol,
            position.market,
          )

          db.insert(cryptoPrices)
            .values({
              symbol: position.symbol,
              market: position.market,
              price: currentPrice,
              priceDate: today,
            })
            .run()

          logger.info(
            `Saved crypto price: ${position.symbol} ${today} ${currentPrice}`,
          )
        } catch (e) {
          logger.error(`Failed to save crypto ${position.symbol} price: ${e}`)
        }
      }
    } catch (e) {
      logger.error(`Failed to save account ${accountId} position prices: ${e}`)
    }
  }

  /**
   * Check margin levels for all accounts with leveraged positions and force
   * close positions if margin falls below the maintenance level: the
   * author's rule for 'original' accounts, Hyperliquid's cross margin rule
   * for 'hyperliquid' accounts (checkHyperliquidMargin).
   */
  private async checkMarginLevels(): Promise<void> {
    try {
      const leveragedAccountIds = db
        .selectDistinct({ accountId: positionsTable.accountId })
        .from(positionsTable)
        .where(
          and(gt(positionsTable.quantity, 0), gt(positionsTable.leverage, 1)),
        )
        .all()
        .map((r) => r.accountId)

      const accountsWithPositions = leveragedAccountIds.length === 0 ? [] : db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, leveragedAccountIds))
        .all()

      for (const account of accountsWithPositions) {
        if (account.costModel === 'hyperliquid') continue // cross margin rule below
        try {
          await this.checkAccountMargin(account)
        } catch (e) {
          logger.error(
            `Error checking margin for account ${account.name} (ID: ${account.id}): ${e}`,
          )
        }
      }
    } catch (e) {
      logger.error(`Error in margin monitoring: ${e}`)
    }

    try {
      // every open perpetual of a hyperliquid account, 1x included
      const ids = db
        .selectDistinct({ accountId: positionsTable.accountId })
        .from(positionsTable)
        .innerJoin(accounts, eq(accounts.id, positionsTable.accountId))
        .where(and(gt(positionsTable.quantity, 0), eq(accounts.costModel, 'hyperliquid')))
        .all()
        .map((r) => r.accountId)
      for (const accountId of ids) {
        try {
          await this.checkHyperliquidMargin(accountId)
        } catch (e) {
          logger.error(`Error checking Hyperliquid margin for account ${accountId}: ${e}`)
        }
      }
    } catch (e) {
      logger.error(`Error in Hyperliquid margin monitoring: ${e}`)
    }
  }


  /**
   * Hyperliquid cross margin (docs: trading/liquidations, margining,
   * margin-tiers): account value = collateral (cash + posted margin, so after
   * every fee and settled funding) + unrealized P&L at mark price; the account
   * is liquidated when it falls below the sum of the positions' maintenance
   * margins from the official tiers. Without a valid, fresh mark price or
   * margin table for every position nothing is decided.
   */
  private async checkHyperliquidMargin(accountId: number): Promise<void> {
    if (hyperliquidChecks.has(accountId)) return
    hyperliquidChecks.add(accountId)
    try {
      const { getLastPrice } = await import('./marketData.js')
      const { loadMarginTables } = await import('./hyperliquidMarket.js')
      const { marksFromAssetContexts } = await import('./hyperliquidMarginData.js')
      const { crossInputFromAccount } = await import('./hyperliquidCrossAdapter.js')

      const openRows = () =>
        db.select().from(positionsTable)
          .where(and(eq(positionsTable.accountId, accountId), gt(positionsTable.quantity, 0))).all()
      const symbols = [...new Set(openRows().map((p) => p.symbol))]
      // refreshes the asset contexts (mark prices) when the price cache expired
      for (const symbol of symbols) await getLastPrice(symbol, 'CRYPTO').catch(() => null)
      const tables = await loadMarginTables()

      // decided on the rows as they are now, after the awaits above
      const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
      const rows = openRows()
      if (!account || rows.length === 0) return
      const skip = (reason: string) => {
        if (hyperliquidSkips.get(accountId) !== reason) {
          hyperliquidSkips.set(accountId, reason)
          logger.warning(`Hyperliquid margin of account ${account.name} not evaluated, no liquidation: ${reason}`)
        }
      }
      if (!tables) return skip('margin tables unavailable')
      const result = crossInputFromAccount({
        account, positions: rows, marks: marksFromAssetContexts(rows.map((r) => r.symbol)), tables, now: Date.now(),
        accruedInterest: {}, // the hyperliquid model charges no interest
      })
      if (result.status !== 'ready') return skip([...result.anomalies, ...result.reasons].join('; '))
      hyperliquidSkips.delete(accountId)
      const state = result.state
      if (!state.liquidatable) return

      logger.warning(
        `⚠️ HYPERLIQUID LIQUIDATION: account ${account.name} value ${state.accountValue!.toFixed(4)} < ` +
          `maintenance margin ${state.maintenanceMargin!.toFixed(4)} at mark` +
          (state.belowBackstop ? ' (below the 2/3 backstop level)' : ''),
      )
      const perps = rows.filter((r) => r.side)
      const orderNos = await this.liquidatePositions(
        account, perps,
        `Hyperliquid cross margin: account value ${state.accountValue} < maintenance ${state.maintenanceMargin}`,
      )
      if (orderNos.length === 0) return // nothing could be closed: no event
      db.insert(liquidationEvents).values({
        accountId,
        triggeredAt: Date.now(),
        collateral: result.collateral.total,
        accountValue: state.accountValue!,
        maintenanceMargin: state.maintenanceMargin!,
        belowBackstop: state.belowBackstop ? 1 : 0,
        marks: JSON.stringify(result.input.markPrices),
        positions: JSON.stringify(state.positions.map((p) => ({
          coin: p.coin, side: p.side, size: p.size, mark: p.markPrice, notional: p.notional,
          unrealizedPnl: p.unrealizedPnl, mmr: p.mmr, maintenanceMargin: p.maintenanceMargin,
        }))),
        orders: JSON.stringify(orderNos),
        execution: 'every perpetual closed in full by a market order of the engine at the price path (mid), with the ' +
          'taker fee of the cost model; no order book, bid/ask or slippage yet (006I-5); partial liquidation applies ' +
          'only above 100k USDC; the backstop (liquidator vault) is not reproduced',
      }).run()
    } finally {
      hyperliquidChecks.delete(accountId)
    }
  }

  /** Check margin level for a specific account and liquidate if necessary. */
  private async checkAccountMargin(account: Account): Promise<void> {
    const { calcAccountEquity } = await import('./assetCalculator.js')

    const positions = db
      .select()
      .from(positionsTable)
      .where(
        and(
          eq(positionsTable.accountId, account.id),
          gt(positionsTable.quantity, 0),
          gt(positionsTable.leverage, 1),
        ),
      )
      .all()

    if (positions.length === 0) return

    // Equity: cash + posted margin + unrealised PnL. Opening a position
    // takes its margin out of cash, so the margin is added back.
    const { equity } = await calcAccountEquity(account)
    const marginUsed = account.marginUsed

    if (marginUsed <= 0) return // No margin used, nothing to check

    const marginLevel = equity / marginUsed
    const maintenanceMarginRatio = account.maintenanceMarginRatio

    logger.debug(
      `Account ${account.name}: equity=$${equity.toFixed(2)}, margin_used=$${marginUsed.toFixed(2)}, ` +
        `margin_level=${(marginLevel * 100).toFixed(2)}%, maintenance_required=${(maintenanceMarginRatio * 100).toFixed(2)}%`,
    )

    if (marginLevel < maintenanceMarginRatio) {
      logger.warning(
        `⚠️ MARGIN CALL! Account ${account.name} margin level ${(marginLevel * 100).toFixed(2)}% ` +
          `below maintenance ${(maintenanceMarginRatio * 100).toFixed(2)}%. Liquidating positions...`,
      )
      await this.liquidatePositions(account, positions, 'Insufficient margin')
    }
  }

  /** Force close (liquidate) all given positions for an account. */
  private async liquidatePositions(
    account: Account,
    positions: Position[],
    reason: string,
  ): Promise<string[]> {
    const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
    const { randomUUID } = await import('node:crypto')
    const filled: string[] = []

    for (const position of positions) {
      const orderNo = `LIQ-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`
      try {
        // Re-read both: an earlier close in this loop changed cash and margin
        const current = db
          .select()
          .from(positionsTable)
          .where(eq(positionsTable.id, position.id))
          .get()
        const latestAccount = db
          .select()
          .from(accounts)
          .where(eq(accounts.id, account.id))
          .get()
        if (!current || current.quantity <= 0 || !latestAccount) continue

        // SELL closes LONG, BUY closes SHORT
        const closeSide = current.side === 'LONG' ? 'SELL' : 'BUY'

        // The perpetual engine records the order, the fill, the margin
        // release and the position reset in one transaction, so a failed
        // close leaves nothing behind.
        await placeAndExecuteCrypto({
          account: latestAccount,
          symbol: current.symbol,
          name: current.name,
          side: closeSide,
          orderType: 'MARKET',
          price: null,
          quantity: current.quantity,
          leverage: current.leverage,
          orderNo,
        })

        filled.push(orderNo)
        logger.warning(
          `🔴 LIQUIDATED: ${account.name} ${closeSide} ${current.quantity} ${current.symbol} ` +
            `at market price. Reason: ${reason}`,
        )
      } catch (e) {
        logger.error(
          `Failed to execute liquidation order ${orderNo} for ${position.symbol}: ${e}`,
        )
      }
    }
    return filled
  }
}

/** Global scheduler instance */
export const taskScheduler = new TaskScheduler()

// ---------------------------------------------------------------- convenience

export const startScheduler = () => taskScheduler.start()
export const stopScheduler = () => {
  cancelAutoTradingRetry()
  taskScheduler.shutdown()
}

export const addAccountSnapshotJob = (accountId: number, intervalSeconds = 10) =>
  taskScheduler.addAccountSnapshotTask(accountId, intervalSeconds)

export const removeAccountSnapshotJob = (accountId: number) =>
  taskScheduler.removeAccountSnapshotTask(accountId)

export function startMarginMonitor(intervalSeconds = 5): void {
  taskScheduler.addMarginMonitorTask(intervalSeconds)
  logger.info(`Margin monitor started - checking every ${intervalSeconds} seconds`)
}

/** Set up crypto market-related scheduled tasks. */
export function setupMarketTasks(): void {
  // Crypto markets run 24/7, no specific market open/close times needed
  logger.info('Crypto markets run 24/7 - no market hours tasks needed')
}

/** Symbols the readiness check could not price. */
class MarketDataNotReadyError extends Error {
  constructor(
    readonly missing: string[],
    readonly total: number,
  ) {
    super(`Market data not ready for symbols: ${missing.join(', ')}`)
  }
}

/** Prefetch required market data before enabling trading tasks. */
async function ensureMarketDataReady(): Promise<void> {
  const { AI_TRADING_SYMBOLS } = await import('./tradingCommands.js')
  const { getLastPrice } = await import('./marketData.js')

  const missingSymbols: string[] = []

  for (const symbol of AI_TRADING_SYMBOLS) {
    try {
      const price = await getLastPrice(symbol, 'CRYPTO')
      if (price == null || price <= 0) {
        missingSymbols.push(symbol)
        logger.warning(`Prefetch returned invalid price for ${symbol}: ${price}`)
      } else {
        logger.debug(`Prefetched market data for ${symbol}: ${price}`)
      }
    } catch (fetchErr) {
      missingSymbols.push(symbol)
      logger.warning(`Failed to prefetch price for ${symbol}: ${fetchErr}`)
    }
  }

  if (missingSymbols.length > 0) {
    const unique = [...new Set(missingSymbols)].sort()
    const err = new MarketDataNotReadyError(unique, AI_TRADING_SYMBOLS.length)
    logger.error(`Market data readiness check failed: ${err.message}`)
    throw err
  }
}

/**
 * When the readiness check fails and no AI job exists yet (at startup), the
 * job is not scheduled with incomplete prices: the start is retried after
 * these delays (seconds; the last one repeats), at most
 * AI_START_MAX_ATTEMPTS times. Every symbol missing looks like an outage and
 * is retried up to that limit; the same symbols missing while the others are
 * priced looks permanent and stops after AI_START_MAX_PARTIAL attempts.
 * Giving up is logged as an error; the next account save or a restart starts
 * a new series. stopScheduler cancels a pending retry.
 */
export const AI_START_RETRY_DELAYS = [15, 30, 60, 120, 300]
export const AI_START_MAX_ATTEMPTS = 12
export const AI_START_MAX_PARTIAL = 3

export interface AutoTradingStatus {
  state: 'idle' | 'scheduled' | 'retrying' | 'failed'
  /** Attempts of the current series. */
  attempts: number
  lastError: string | null
  nextRetryAt: string | null
}

let autoTradingStatus: AutoTradingStatus = { state: 'idle', attempts: 0, lastError: null, nextRetryAt: null }
let startRetryTimer: NodeJS.Timeout | null = null
/** Bumped by every reset and stop: an attempt of an older series is dropped. */
let startSeries = 0
let partialMissing = { symbols: '', count: 0 }

export function getAutoTradingStatus(): AutoTradingStatus {
  return { ...autoTradingStatus }
}

/** Cancels a pending start retry and drops any attempt still running. */
function cancelAutoTradingRetry(): void {
  startSeries++
  if (startRetryTimer) clearTimeout(startRetryTimer)
  startRetryTimer = null
  if (autoTradingStatus.state === 'retrying') {
    autoTradingStatus = { ...autoTradingStatus, state: 'idle', nextRetryAt: null }
  }
}

/** Reset the auto trading job after account configuration changes. */
export async function resetAutoTradingJob(): Promise<void> {
  cancelAutoTradingRetry()
  autoTradingStatus = { state: 'idle', attempts: 0, lastError: null, nextRetryAt: null }
  partialMissing = { symbols: '', count: 0 }
  await startAutoTradingJob(startSeries)
}

async function startAutoTradingJob(series: number): Promise<void> {
  const attempts = autoTradingStatus.attempts + 1
  autoTradingStatus = { ...autoTradingStatus, attempts, nextRetryAt: null }
  try {
    const { AI_TRADE_JOB_ID, placeAIDrivenCryptoOrder } = await import(
      './tradingCommands.js'
    )

    const AI_TRADE_INTERVAL_SECONDS = 300 // 5 minutes

    // Ensure market data is ready before scheduling trading tasks
    try {
      await ensureMarketDataReady()
    } catch (e) {
      if (series !== startSeries) return // reset or stopped meanwhile
      if (!(e instanceof MarketDataNotReadyError)) throw e
      if (taskScheduler.getJob(AI_TRADE_JOB_ID)) {
        // A job already runs (account saved later on): keep it, as before
        logger.warning(`Auto trading job kept unchanged: ${e.message}`)
        autoTradingStatus = { ...autoTradingStatus, state: 'scheduled', lastError: e.message }
        return
      }
      planStartRetry(series, attempts, e)
      return
    }
    if (series !== startSeries) return

    if (!taskScheduler.isRunning()) {
      taskScheduler.start()
      logger.info('Started scheduler for auto trading job reset')
    }

    if (taskScheduler.getJob(AI_TRADE_JOB_ID)) {
      taskScheduler.removeTask(AI_TRADE_JOB_ID)
      logger.info(`Removed existing auto trading job: ${AI_TRADE_JOB_ID}`)
    }

    taskScheduler.addIntervalTask(
      () => placeAIDrivenCryptoOrder(),
      AI_TRADE_INTERVAL_SECONDS,
      AI_TRADE_JOB_ID,
    )
    autoTradingStatus = { state: 'scheduled', attempts, lastError: null, nextRetryAt: null }

    // Trigger one immediate execution in the background so API calls don't block
    void (async () => {
      try {
        logger.info('Triggering immediate AI trade after account save/update')
        await placeAIDrivenCryptoOrder()
      } catch (runErr) {
        logger.error(`Immediate AI trade failed: ${runErr}`)
      }
    })()

    logger.info(
      `Auto trading job reset successfully - interval: ${AI_TRADE_INTERVAL_SECONDS}s; ` +
        `Jobs: ${JSON.stringify(taskScheduler.getJobInfo())}`,
    )
  } catch (e) {
    logger.error(`Failed to reset auto trading job: ${e}`)
    autoTradingStatus = { ...autoTradingStatus, state: 'failed', lastError: String(e) }
  }
}

function planStartRetry(series: number, attempts: number, e: MarketDataNotReadyError): void {
  const partial = e.missing.length < e.total
  const symbols = e.missing.join(',')
  partialMissing = partial
    ? { symbols, count: partialMissing.symbols === symbols ? partialMissing.count + 1 : 1 }
    : { symbols: '', count: 0 }

  if (attempts >= AI_START_MAX_ATTEMPTS || partialMissing.count >= AI_START_MAX_PARTIAL) {
    const why = partialMissing.count >= AI_START_MAX_PARTIAL
      ? `the same symbols had no price ${partialMissing.count} times in a row`
      : `${attempts} attempts`
    logger.error(
      `Failed to reset auto trading job: AI trading NOT scheduled after ${why} (${e.message}). ` +
        'No retry left: save an account or restart the app to try again.',
    )
    autoTradingStatus = { state: 'failed', attempts, lastError: e.message, nextRetryAt: null }
    return
  }

  const delay = AI_START_RETRY_DELAYS[Math.min(attempts - 1, AI_START_RETRY_DELAYS.length - 1)]!
  logger.warning(
    `AI trading job not scheduled yet: ${e.message}. Retry ${attempts + 1}/${AI_START_MAX_ATTEMPTS} in ${delay}s`,
  )
  autoTradingStatus = {
    state: 'retrying', attempts, lastError: e.message,
    nextRetryAt: new Date(Date.now() + delay * 1000).toISOString(),
  }
  startRetryTimer = setTimeout(() => {
    startRetryTimer = null
    void startAutoTradingJob(series)
  }, delay * 1000)
  startRetryTimer.unref?.()
}
