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
   * close positions if margin falls below the maintenance level.
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

      if (leveragedAccountIds.length === 0) return

      const accountsWithPositions = db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, leveragedAccountIds))
        .all()

      for (const account of accountsWithPositions) {
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
  ): Promise<void> {
    const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
    const { randomUUID } = await import('node:crypto')

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
  }
}

/** Global scheduler instance */
export const taskScheduler = new TaskScheduler()

// ---------------------------------------------------------------- convenience

export const startScheduler = () => taskScheduler.start()
export const stopScheduler = () => taskScheduler.shutdown()

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
    const err = new Error(
      `Market data not ready for symbols: ${unique.join(', ')}`,
    )
    logger.error(`Market data readiness check failed: ${err.message}`)
    throw err
  }
}

/** Reset the auto trading job after account configuration changes. */
export async function resetAutoTradingJob(): Promise<void> {
  try {
    const { AI_TRADE_JOB_ID, placeAIDrivenCryptoOrder } = await import(
      './tradingCommands.js'
    )

    const AI_TRADE_INTERVAL_SECONDS = 300 // 5 minutes

    // Ensure market data is ready before scheduling trading tasks
    await ensureMarketDataReady()

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
  }
}
