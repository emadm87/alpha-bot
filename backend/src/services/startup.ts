/** Application startup initialization service. Port of `services/startup.py`. */
import {
  getAutoTradingStatus,
  resetAutoTradingJob,
  setupMarketTasks,
  startMarginMonitor,
  startScheduler,
  stopScheduler,
  taskScheduler,
} from './scheduler.js'
import {
  AI_TRADE_JOB_ID,
  AUTO_TRADE_JOB_ID,
  placeAIDrivenCryptoOrder,
  placeRandomCryptoOrder,
} from './tradingCommands.js'
import { clearExpiredPrices } from './priceCache.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.startup')

/** Initialize all services. */
export async function initializeServices(): Promise<void> {
  try {
    startScheduler()
    logger.info('Scheduler service started')

    setupMarketTasks()
    logger.info('Market scheduled tasks have been set up')

    // Start automatic crypto trading via reset, which also verifies market
    // data readiness and uses the correct job ID. If prices are not ready it
    // retries on its own (bounded, see resetAutoTradingJob); the original
    // fallback to random spot orders is never used for the AI accounts.
    try {
      await resetAutoTradingJob()
      logger.info(
        `Automatic cryptocurrency trading: ${JSON.stringify(getAutoTradingStatus())}. ` +
          `Jobs: ${JSON.stringify(taskScheduler.getJobInfo())}`,
      )
    } catch (e) {
      logger.error(`Failed to schedule AI auto trading task: ${e}`)
    }

    // Price cache cleanup task (every 2 minutes)
    taskScheduler.addIntervalTask(
      () => clearExpiredPrices(),
      120,
      'price_cache_cleanup',
    )
    logger.info('Price cache cleanup task started (2-minute interval)')

    // Margin monitoring for leveraged positions (every 5 seconds)
    startMarginMonitor(5)
    logger.info('Margin monitor started (5-second interval)')

    // Hourly funding of the 'hyperliquid' cost model: captures the oracle
    // price right after each hour and settles due hours (every 10 seconds;
    // nothing to do, and no request, without a hyperliquid account)
    const { runFundingTasks } = await import('./fundingSettlement.js')
    taskScheduler.addIntervalTask(() => runFundingTasks(), 10, 'funding_settlement')
    logger.info('Funding settlement task started (10-second interval, hyperliquid cost model only)')

    logger.info('All services initialized successfully')
  } catch (e) {
    logger.error(`Service initialization failed: ${e}`)
    throw e
  }
}

/** Shut down all services. */
export function shutdownServices(): void {
  try {
    stopScheduler()
    logger.info('All services have been shut down')
  } catch (e) {
    logger.error(`Failed to shut down services: ${e}`)
  }
}

/**
 * Schedule automatic trading tasks.
 *
 * @param useAi true -> AI-driven trading, false -> random trading
 */
export function scheduleAutoTrading(options?: {
  intervalSeconds?: number
  maxRatio?: number
  useAi?: boolean
}): void {
  const {
    intervalSeconds = 300,
    maxRatio = 0.2,
    useAi = true,
  } = options ?? {}

  const taskFunc = useAi
    ? () => placeAIDrivenCryptoOrder()
    : () => placeRandomCryptoOrder(maxRatio)
  const jobId = useAi ? AI_TRADE_JOB_ID : AUTO_TRADE_JOB_ID

  logger.info(
    useAi
      ? 'Scheduling AI-driven crypto trading'
      : 'Scheduling random crypto trading',
  )

  taskScheduler.addIntervalTask(taskFunc, intervalSeconds, jobId)

  // Execute the first trade immediately without blocking startup
  void (async () => {
    try {
      await taskFunc()
      logger.info('Initial auto-trading execution completed')
    } catch (e) {
      logger.error(`Error during initial auto-trading execution: ${e}`)
    }
  })()
}
