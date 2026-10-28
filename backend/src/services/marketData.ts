/** Port of `services/market_data.py`. */
import { getLogger } from '../utils/logger.js'
import {
  getAllSymbolsFromHyperliquid,
  getKlineDataFromHyperliquid,
  getLastPriceFromHyperliquid,
  getLastPricesFromHyperliquid,
  getMarketStatusFromHyperliquid,
  MAINSTREAM_CRYPTOS,
  type Kline,
  type MarketStatus,
} from './hyperliquid.js'
import { cachePrice, getCachedPrice } from './priceCache.js'

const logger = getLogger('services.marketData')

/** Price requests in flight, shared by callers that ask at the same time. */
const inFlight = new Map<string, Promise<Record<string, number | null>>>()

function sharedRequest(
  key: string,
  load: () => Promise<Record<string, number | null>>,
): Promise<Record<string, number | null>> {
  let request = inFlight.get(key)
  if (!request) {
    request = load().finally(() => inFlight.delete(key))
    inFlight.set(key, request)
  }
  return request
}

// --- mainstream price refresh: one shared request, backoff after errors (Task 006J-2) ---

/**
 * Pause before the next mainstream refresh after consecutive HTTP 429
 * answers: 5, 10, 20 s, then 30 s at most. A pause never outlasts 30 s, so
 * marks can be fresh again within the monitor's 60 s limit once Hyperliquid
 * answers; there is no timer, only a time check at the next call.
 */
export const RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000]
const refreshState = { pausedUntil: 0, rateLimitStreak: 0 }
/** Counters for the pilot report and tests. */
export const refreshStats = { requests: 0, failures: 0, rateLimited: 0, skippedWhilePaused: 0 }

/** Clears the backoff and the counters (tests). */
export function resetPriceRefreshState(): void {
  refreshState.pausedUntil = 0
  refreshState.rateLimitStreak = 0
  Object.assign(refreshStats, { requests: 0, failures: 0, rateLimited: 0, skippedWhilePaused: 0 })
}

const isRateLimit = (e: unknown) => {
  const err = e as { name?: string; constructor?: { name?: string } } | null
  const name = `${err?.name ?? ''} ${err?.constructor?.name ?? ''}`
  return /RateLimitExceeded|DDoSProtection/.test(name) || /\b429\b|Too Many Requests/.test(String(e))
}

/**
 * Prices (and asset contexts: mark, oracle, funding) of the six mainstream
 * perpetuals from one request shared by every caller asking at the same time,
 * cached for the price cache's lifetime. After an HTTP 429 further callers get
 * an error without a request until the pause ends; nothing is invented.
 */
export async function refreshMainstreamPrices(market = 'CRYPTO'): Promise<Record<string, number | null>> {
  const wait = refreshState.pausedUntil - Date.now()
  if (wait > 0) {
    refreshStats.skippedWhilePaused++
    throw new Error(`price refresh paused for ${Math.ceil(wait / 1000)} s after a failed request (no request sent)`)
  }
  return sharedRequest('mainstream', async () => {
    refreshStats.requests++
    try {
      const prices = await getLastPricesFromHyperliquid(MAINSTREAM_CRYPTOS, { rethrow: true })
      if (!Object.values(prices).some((p) => p && p > 0)) throw new Error('no valid price in the answer')
      refreshState.rateLimitStreak = 0
      refreshState.pausedUntil = 0
      for (const [symbol, price] of Object.entries(prices)) if (price && price > 0) cachePrice(symbol, market, price)
      return prices
    } catch (e) {
      refreshStats.failures++
      if (isRateLimit(e)) {
        refreshStats.rateLimited++
        const pause = RATE_LIMIT_BACKOFF_MS[Math.min(refreshState.rateLimitStreak, RATE_LIMIT_BACKOFF_MS.length - 1)]!
        refreshState.rateLimitStreak++
        refreshState.pausedUntil = Date.now() + pause
        logger.warning(`Hyperliquid rate limit (HTTP 429): next price refresh in ${pause / 1000} s`)
      }
      // any other error (network, empty answer) pauses nothing: the next
      // caller retries, as before; concurrent callers still share one request
      throw e
    }
  })
}

export async function getLastPrice(
  symbol: string,
  market = 'CRYPTO',
): Promise<number> {
  const key = `${symbol}.${market}`

  // Check cache first
  const cached = getCachedPrice(symbol, market)
  if (cached !== null) {
    logger.debug(`Using cached price for ${key}: ${cached}`)
    return cached
  }

  logger.info(`Getting real-time price for ${key} from API...`)

  try {
    // The six mainstream perps come from one shared request and are cached
    // together (refreshMainstreamPrices); other symbols keep their own.
    const mainstream = MAINSTREAM_CRYPTOS.includes(symbol)
    const prices = mainstream
      ? await refreshMainstreamPrices(market)
      : await sharedRequest(symbol, async () => ({
          [symbol]: await getLastPriceFromHyperliquid(symbol),
        }))

    const price = prices[symbol]
    if (price && price > 0) {
      logger.info(`Got real-time price for ${key} from Hyperliquid: ${price}`)
      cachePrice(symbol, market, price)
      return price
    }
    throw new Error(`Hyperliquid returned invalid price: ${price}`)
  } catch (hlErr) {
    logger.error(`Failed to get price from Hyperliquid: ${hlErr}`)
    throw new Error(`Unable to get real-time price for ${key}: ${hlErr}`)
  }
}

export async function getKlineData(
  symbol: string,
  market = 'CRYPTO',
  period = '1d',
  count = 100,
): Promise<Kline[]> {
  const key = `${symbol}.${market}`

  try {
    const data = await getKlineDataFromHyperliquid(symbol, period, count)
    if (data.length > 0) {
      logger.info(
        `Got K-line data for ${key} from Hyperliquid, total ${data.length} items`,
      )
      return data
    }
    throw new Error('Hyperliquid returned empty K-line data')
  } catch (hlErr) {
    logger.error(`Failed to get K-line data from Hyperliquid: ${hlErr}`)
    throw new Error(`Unable to get K-line data for ${key}: ${hlErr}`)
  }
}

export async function getMarketStatus(
  symbol: string,
  market = 'CRYPTO',
): Promise<MarketStatus> {
  const key = `${symbol}.${market}`

  try {
    const status = await getMarketStatusFromHyperliquid(symbol)
    logger.info(
      `Retrieved market status for ${key} from Hyperliquid: ${status.market_status}`,
    )
    return status
  } catch (hlErr) {
    logger.error(`Failed to get market status: ${hlErr}`)
    throw new Error(`Unable to get market status for ${key}: ${hlErr}`)
  }
}

/** Get all available trading pairs. */
export async function getAllSymbols(): Promise<string[]> {
  try {
    const symbols = await getAllSymbolsFromHyperliquid()
    logger.info(`Got ${symbols.length} trading pairs from Hyperliquid`)
    return symbols
  } catch (hlErr) {
    logger.error(`Failed to get trading pairs list: ${hlErr}`)
    return ['BTC/USD', 'ETH/USD', 'SOL/USD'] // default trading pairs
  }
}

export type { Kline, MarketStatus }
