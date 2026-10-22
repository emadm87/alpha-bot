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
    // The six mainstream perps come from one request (it costs the same as a
    // single ticker) and are cached together; other symbols keep their own.
    const mainstream = MAINSTREAM_CRYPTOS.includes(symbol)
    const prices = mainstream
      ? await sharedRequest('mainstream', () =>
          getLastPricesFromHyperliquid(MAINSTREAM_CRYPTOS),
        )
      : await sharedRequest(symbol, async () => ({
          [symbol]: await getLastPriceFromHyperliquid(symbol),
        }))
    if (mainstream) {
      for (const [other, otherPrice] of Object.entries(prices)) {
        if (other !== symbol && otherPrice && otherPrice > 0) {
          cachePrice(other, market, otherPrice)
        }
      }
    }

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
