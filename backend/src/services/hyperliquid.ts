/**
 * Hyperliquid market data service using CCXT.
 * Port of `services/hyperliquid_market_data.py`.
 *
 * ccxt's JavaScript API is promise-based (the Python one was synchronous), so
 * every accessor here is async and that asynchrony propagates up through
 * marketData -> priceCache consumers.
 */
import ccxt from 'ccxt'
import type { hyperliquid as HyperliquidExchange } from 'ccxt'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.hyperliquid')

export interface Kline {
  timestamp: number
  datetime_str: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  amount: number | null
  change: number
  percent: number
}

export interface MarketStatus {
  market_status: string
  is_trading: boolean
  symbol?: string
  exchange?: string
  market_type?: string
  base_currency?: string
  quote_currency?: string
  active?: boolean
  error?: string
}

const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '1d': '1d',
}

export const MAINSTREAM_CRYPTOS = ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB', 'XRP']

/**
 * Raw Hyperliquid asset context (midPx, markPx, funding, openInterest...)
 * of a symbol, as received by the last successful getLastPrices call.
 */
export interface AssetContext {
  info: Record<string, unknown>
  /** Local time the response was received, ms since epoch. */
  receivedAt: number
}

const assetContexts = new Map<string, AssetContext>()

/** Context kept from the last getLastPrices call; no request is made. */
export function getAssetContext(symbol: string): AssetContext | null {
  return assetContexts.get(symbol) ?? null
}

class HyperliquidClient {
  private exchange: HyperliquidExchange | null = null

  constructor() {
    this.initializeExchange()
  }

  private initializeExchange(): void {
    try {
      this.exchange = new ccxt.hyperliquid({
        sandbox: false, // Set to true for testnet
        enableRateLimit: true,
      })
      logger.info('Hyperliquid exchange initialized successfully')
    } catch (e) {
      logger.error(`Failed to initialize Hyperliquid exchange: ${e}`)
      throw e
    }
  }

  private getExchange(): HyperliquidExchange {
    if (!this.exchange) this.initializeExchange()
    return this.exchange!
  }

  /** Format symbol for CCXT (e.g., 'BTC' -> 'BTC/USDC:USDC') */
  formatSymbol(symbol: string): string {
    if (symbol.includes('/') && symbol.includes(':')) return symbol
    if (symbol.includes('/')) {
      // If it's BTC/USDC, convert to BTC/USDC:USDC for Hyperliquid
      return `${symbol}:USDC`
    }

    const upper = symbol.toUpperCase()
    return MAINSTREAM_CRYPTOS.includes(upper)
      ? `${upper}/USDC:USDC` // perpetual swap format for mainstream cryptos
      : `${upper}/USDC` // spot format for other cryptos
  }

  async getLastPrice(symbol: string): Promise<number | null> {
    try {
      const formatted = this.formatSymbol(symbol)
      const ticker = await this.getExchange().fetchTicker(formatted)
      const price = ticker.last
      logger.info(`Got price for ${formatted}: ${price}`)
      return price ? Number(price) : null
    } catch (e) {
      logger.error(`Error fetching price for ${symbol}: ${e}`)
      return null
    }
  }

  /**
   * Last prices of several symbols from one fetchTickers call. A symbol
   * without a price maps to null; on error every symbol maps to null, or the
   * error is thrown with `rethrow` (the caller tells a rate limit apart).
   *
   * When every symbol is a perpetual the call asks for perpetuals only
   * ({ type: 'swap' }: one `metaAndAssetCtxs` request, weight 20). Without a
   * type ccxt reloads every market kind: spot, perpetuals, the perp dex list
   * and the HIP-3 dexes, 12 requests (weight 240) for the same six tickers,
   * which is what exhausted the 1200/minute limit in the 006J-1 pilot.
   */
  async getLastPrices(
    symbols: string[],
    options: { rethrow?: boolean } = {},
  ): Promise<Record<string, number | null>> {
    const result: Record<string, number | null> = {}
    for (const symbol of symbols) result[symbol] = null
    try {
      const formatted = symbols.map((s) => this.formatSymbol(s))
      const perpsOnly = formatted.every((s) => s.endsWith(':USDC'))
      const tickers = await this.getExchange().fetchTickers(formatted, perpsOnly ? { type: 'swap' } : {})
      const receivedAt = Date.now()
      symbols.forEach((symbol, i) => {
        const ticker = tickers[formatted[i]!]
        const price = ticker?.last
        result[symbol] = price ? Number(price) : null
        // The same response carries funding, open interest, mark price...:
        // keep it for the quantitative snapshot instead of asking again.
        const info = ticker?.info
        if (info && typeof info === 'object') {
          assetContexts.set(symbol, { info: info as Record<string, unknown>, receivedAt })
        } else {
          assetContexts.delete(symbol) // never show an older answer as this one
        }
      })
      logger.info(`Got prices for ${formatted.join(', ')}`)
    } catch (e) {
      logger.error(`Error fetching prices for ${symbols.join(', ')}: ${e}`)
      if (options.rethrow) throw e
    }
    return result
  }

  /**
   * Raw candleSnapshot rows (t, T, o, h, l, c, v...) of a perpetual, oldest
   * first; the last row may be a bar still forming. Errors are thrown so the
   * caller can tell a rate limit from an empty answer.
   */
  async getCandleSnapshot(
    coin: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<unknown> {
    return this.getExchange().publicPostInfo({
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime },
    })
  }

  /**
   * Raw `meta` response (universe with maxLeverage and marginTableId, and
   * marginTables, which ccxt's own parsing drops). Errors are thrown.
   */
  async getMeta(): Promise<unknown> {
    return this.getExchange().publicPostInfo({ type: 'meta' })
  }

  /**
   * Raw `l2Book` snapshot of a perpetual: { coin, time, levels: [bids, asks] },
   * each level { px, sz, n } as strings, best first, at most 20 per side
   * (Task 006I-5). Errors are thrown.
   */
  async getL2Book(coin: string): Promise<unknown> {
    return this.getExchange().publicPostInfo({ type: 'l2Book', coin })
  }

  /**
   * Realised hourly funding of a perpetual: rows { coin, fundingRate,
   * premium, time } from the public fundingHistory request, oldest first.
   * Errors are thrown so the caller can retry later.
   */
  async getFundingHistory(coin: string, startTime: number, endTime: number): Promise<unknown> {
    return this.getExchange().publicPostInfo({ type: 'fundingHistory', coin, startTime, endTime })
  }

  async getKlineData(
    symbol: string,
    period = '1d',
    count = 100,
  ): Promise<Kline[]> {
    try {
      const formatted = this.formatSymbol(symbol)
      const timeframe = TIMEFRAME_MAP[period] ?? '1d'

      const ohlcv = await this.getExchange().fetchOHLCV(
        formatted,
        timeframe,
        undefined,
        count,
      )

      const klines: Kline[] = []
      for (const candle of ohlcv) {
        const [timestampMs, openPrice, highPrice, lowPrice, closePrice, volume] =
          candle as (number | undefined)[]
        if (timestampMs == null) continue

        const change =
          openPrice && closePrice != null ? closePrice - openPrice : 0
        const percent = openPrice ? (change / openPrice) * 100 : 0

        klines.push({
          timestamp: Math.trunc(timestampMs / 1000), // Convert to seconds
          datetime_str: new Date(timestampMs).toISOString(),
          open: openPrice ? Number(openPrice) : null,
          high: highPrice ? Number(highPrice) : null,
          low: lowPrice ? Number(lowPrice) : null,
          close: closePrice ? Number(closePrice) : null,
          volume: volume ? Number(volume) : null,
          amount: volume && closePrice ? Number(volume * closePrice) : null,
          change: Number(change),
          percent: Number(percent),
        })
      }

      logger.info(`Got ${klines.length} klines for ${formatted}`)
      return klines
    } catch (e) {
      logger.error(`Error fetching klines for ${symbol}: ${e}`)
      return []
    }
  }

  async getMarketStatus(symbol: string): Promise<MarketStatus> {
    try {
      const formatted = this.formatSymbol(symbol)

      // Hyperliquid is 24/7, but we can check if the market exists
      const markets = await this.getExchange().loadMarkets()
      const marketExists = formatted in markets

      const status: MarketStatus = {
        market_status: marketExists ? 'OPEN' : 'CLOSED',
        is_trading: marketExists,
        symbol: formatted,
        exchange: 'Hyperliquid',
        market_type: 'crypto',
      }

      if (marketExists) {
        const info = markets[formatted]
        status.base_currency = info?.base
        status.quote_currency = info?.quote
        status.active = info?.active ?? true
      }

      logger.info(`Market status for ${formatted}: ${status.market_status}`)
      return status
    } catch (e) {
      logger.error(`Error getting market status for ${symbol}: ${e}`)
      return {
        market_status: 'ERROR',
        is_trading: false,
        error: String(e),
      }
    }
  }

  async getAllSymbols(): Promise<string[]> {
    try {
      const markets = await this.getExchange().loadMarkets()
      const symbols = Object.keys(markets)

      // Filter for USDC pairs (both spot and perpetual)
      const usdcSymbols = symbols.filter((s) => s.includes('/USDC'))

      // Prioritize mainstream cryptos (perpetual swaps) and popular spot pairs
      const prefixes = MAINSTREAM_CRYPTOS.map((c) => `${c}/`)
      const mainstreamPerps = usdcSymbols.filter((s) =>
        prefixes.some((p) => s.includes(p)),
      )
      const otherSymbols = usdcSymbols.filter(
        (s) => !mainstreamPerps.includes(s),
      )

      const result = [...mainstreamPerps, ...otherSymbols.slice(0, 50)]
      logger.info(
        `Found ${usdcSymbols.length} USDC trading pairs, returning ${result.length}`,
      )
      return result
    } catch (e) {
      logger.error(`Error getting symbols: ${e}`)
      return ['BTC/USD', 'ETH/USD', 'SOL/USD'] // Fallback popular pairs
    }
  }
}

/** Global client instance */
export const hyperliquidClient = new HyperliquidClient()

export const getLastPriceFromHyperliquid = (symbol: string) =>
  hyperliquidClient.getLastPrice(symbol)

export const getLastPricesFromHyperliquid = (symbols: string[], options: { rethrow?: boolean } = {}) =>
  hyperliquidClient.getLastPrices(symbols, options)

export const getCandleSnapshotFromHyperliquid = (
  coin: string,
  interval: string,
  startTime: number,
  endTime: number,
) => hyperliquidClient.getCandleSnapshot(coin, interval, startTime, endTime)

export const getMetaFromHyperliquid = () => hyperliquidClient.getMeta()

export const getL2BookFromHyperliquid = (coin: string) => hyperliquidClient.getL2Book(coin)

export const getFundingHistoryFromHyperliquid = (coin: string, startTime: number, endTime: number) =>
  hyperliquidClient.getFundingHistory(coin, startTime, endTime)

export const getKlineDataFromHyperliquid = (
  symbol: string,
  period = '1d',
  count = 100,
) => hyperliquidClient.getKlineData(symbol, period, count)

export const getMarketStatusFromHyperliquid = (symbol: string) =>
  hyperliquidClient.getMarketStatus(symbol)

export const getAllSymbolsFromHyperliquid = () =>
  hyperliquidClient.getAllSymbols()

export interface TradeCost {
  side: string
  initial_margin: number
  maintenance_margin: number
  open_fee: number
  close_fee: number
  interest_cost: number
  total_trade_cost: number
  liquidation_price: number
  liquidation_fee: number
  liquidation_interest: number
  total_liquidation_cost: number
}

/**
 * Calculate fees, interest, liquidation price, etc. for Hyperliquid
 * leveraged positions.
 */
export function hyperliquidTradeCost(params: {
  side: string
  entryPrice: number
  positionSize: number
  leverage: number
  takerFeeRate?: number
  interestRateHourly?: number
  holdingHours?: number
}): TradeCost {
  const {
    entryPrice,
    positionSize,
    leverage,
    takerFeeRate = 0.0007, // Default 0.07%
    interestRateHourly = 0.0000125, // Default 0.00125%/hour
    holdingHours = 8.0,
  } = params

  const side = params.side.toLowerCase()
  if (side !== 'long' && side !== 'short') {
    throw new Error("side must be 'long' or 'short'")
  }

  // === Margin ===
  const initialMargin = positionSize / leverage
  // Typically liquidation line is half of initial margin
  const maintenanceMargin = initialMargin / 2

  // === Fees ===
  const openFee = positionSize * takerFeeRate
  const closeFee = positionSize * takerFeeRate
  const totalFee = openFee + closeFee

  // === Interest ===
  const interestCost = positionSize * interestRateHourly * holdingHours

  // === Total trade cost ===
  const totalTradeCost = initialMargin + totalFee + interestCost

  // === Liquidation price ===
  const ratio = (maintenanceMargin / initialMargin) * leverage
  const liquidationPrice =
    side === 'long'
      ? (entryPrice * leverage) / (leverage + 1 - ratio)
      : (entryPrice * leverage) / (leverage - 1 + ratio)

  // === Liquidation cost ===
  const liquidationFee = positionSize * takerFeeRate
  const liquidationInterest = positionSize * interestRateHourly * holdingHours

  return {
    side,
    initial_margin: initialMargin,
    maintenance_margin: maintenanceMargin,
    open_fee: openFee,
    close_fee: closeFee,
    interest_cost: interestCost,
    total_trade_cost: totalTradeCost,
    liquidation_price: liquidationPrice,
    liquidation_fee: liquidationFee,
    liquidation_interest: liquidationInterest,
    total_liquidation_cost: liquidationFee + liquidationInterest,
  }
}
