/**
 * Quantitative market snapshot for the six mainstream perps: ticker context
 * (mid, mark, 24h change, volume, open interest, funding) and 15m / 4h
 * indicators from the technical module.
 *
 * Not used by the bot yet: importing it makes no request. When called:
 * - ticker data comes from the getLastPrices response already used for prices
 *   (005I); getLastPrice is called once so that response is at most as old as
 *   the 30 s price cache, which costs nothing when the price is cached;
 * - candles are cached per symbol and timeframe until the next bar closes,
 *   concurrent loads share one request, and a failure blocks new requests for
 *   that key for 60 s (120 s after a rate limit) instead of retrying.
 * Stale or missing data is reported as such, never as current.
 */
import ccxt from 'ccxt'
import {
  closedCandles,
  indicatorSnapshot,
  type Candle,
  type IndicatorSnapshot,
} from '../indicators/technical.js'
import {
  getAssetContext,
  getCandleSnapshotFromHyperliquid,
  MAINSTREAM_CRYPTOS,
} from './hyperliquid.js'
import { getLastPrice } from './marketData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.quantData')

export const QUANT_TIMEFRAMES = { '15m': 900_000, '4h': 14_400_000 } as const
export type Timeframe = keyof typeof QUANT_TIMEFRAMES

/** Closed bars requested per timeframe (EMA50 needs 166, MACD signal 115). */
export const BARS = 250
/** A bar counts as closed only if the data was fetched this long after. */
export const CLOSE_GRACE_MS = 5_000
/** Ticker context older than this is reported as stale. */
export const TICKER_MAX_AGE_MS = 60_000
export const ERROR_BACKOFF_MS = 60_000
export const RATE_LIMIT_BACKOFF_MS = 120_000
const LAST_CLOSES = 8

export type Status = 'ok' | 'stale' | 'insufficient' | 'error'

export interface TickerSnapshot {
  status: 'ok' | 'stale' | 'missing'
  receivedAt: string | null
  ageSeconds: number | null
  mid: number | null
  mark: number | null
  /** (mid - prevDayPx) / prevDayPx * 100 */
  change24hPct: number | null
  /** 24h notional volume, USDC. */
  dayNotionalVolume: number | null
  /** Open interest, in coins. */
  openInterest: number | null
  /** Current hourly funding rate (fraction, e.g. 0.0000125 = 0.00125%/h). */
  fundingHourly: number | null
  issues: string[]
}

export interface TimeframeSnapshot {
  status: Status
  /** Close time of the last closed bar used. */
  asOf: string | null
  /** Closed bars missing after asOf (0 = up to date). */
  lagBars: number | null
  /** Consecutive valid closed bars the indicators were computed on. */
  bars: number
  fetchedAt: string | null
  indicators: IndicatorSnapshot | null
  /** Last closes, oldest first (15m only). */
  lastCloses?: { closeTime: string; close: number }[]
  issues: string[]
}

export interface QuantSnapshot {
  symbol: string
  generatedAt: string
  /** True only when the ticker and both timeframes are ok. */
  valid: boolean
  ticker: TickerSnapshot
  tf15m: TimeframeSnapshot
  tf4h: TimeframeSnapshot
}

interface CandleEntry {
  candles: Candle[]
  issues: string[]
  fetchedAt: number
  /** Next bar close (+ grace): no new request before this. */
  refreshAfter: number
}

const candleCache = new Map<string, CandleEntry>()
const blockedUntil = new Map<string, { until: number; error: string }>()
const inFlight = new Map<string, Promise<CandleEntry>>()

/** Clears caches and backoffs (tests). */
export function resetQuantData(): void {
  candleCache.clear()
  blockedUntil.clear()
  inFlight.clear()
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Parses candleSnapshot rows into ascending bars. Rows of another coin or
 * interval are dropped; bars with bad timestamps or prices are kept with null
 * prices so the indicators restart after them; identical duplicates are
 * merged, conflicting duplicates become one invalid bar.
 */
export function parseCandles(
  raw: unknown,
  coin: string,
  timeframe: Timeframe,
): { candles: Candle[]; issues: string[] } {
  if (!Array.isArray(raw)) throw new Error('incomplete candleSnapshot response (not an array)')
  const intervalMs = QUANT_TIMEFRAMES[timeframe]
  const issues: string[] = []
  const byOpen = new Map<number, Candle>()
  let unordered = false
  let previous = -Infinity

  for (const row of raw as Record<string, unknown>[]) {
    const openTime = num(row?.t)
    const closeTime = num(row?.T)
    if (openTime === null || closeTime === null) {
      issues.push('row without timestamps dropped')
      continue
    }
    if (row.s !== undefined && row.s !== coin) {
      issues.push(`row of ${String(row.s)} dropped`)
      continue
    }
    if (row.i !== undefined && row.i !== timeframe) {
      issues.push(`row with interval ${String(row.i)} dropped`)
      continue
    }
    if (openTime < previous) unordered = true
    previous = openTime

    const aligned = openTime % intervalMs === 0 && closeTime === openTime + intervalMs - 1
    const bar: Candle = {
      openTime,
      closeTime,
      open: aligned ? num(row.o) : null,
      high: aligned ? num(row.h) : null,
      low: aligned ? num(row.l) : null,
      close: aligned ? num(row.c) : null,
      volume: aligned ? num(row.v) : null,
    }
    if (!aligned) issues.push(`misaligned bar at ${iso(openTime)} marked invalid`)

    const existing = byOpen.get(openTime)
    if (!existing) {
      byOpen.set(openTime, bar)
    } else if (JSON.stringify(existing) !== JSON.stringify(bar)) {
      issues.push(`conflicting duplicate bar at ${iso(openTime)} marked invalid`)
      byOpen.set(openTime, { ...bar, open: null, high: null, low: null, close: null, volume: null })
    } else {
      issues.push(`duplicate bar at ${iso(openTime)} merged`)
    }
  }
  if (unordered) issues.push('bars received out of order, sorted')
  const candles = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime)
  return { candles, issues }
}

function backoffFor(err: unknown): number {
  return err instanceof ccxt.RateLimitExceeded || err instanceof ccxt.DDoSProtection
    ? RATE_LIMIT_BACKOFF_MS
    : ERROR_BACKOFF_MS
}

/**
 * Cached candles of one symbol and timeframe. Returns the cached entry
 * (possibly stale) while blocked by a recent failure; throws only when there
 * is nothing cached.
 */
async function loadCandles(symbol: string, timeframe: Timeframe, now: number): Promise<CandleEntry> {
  const key = `${symbol}:${timeframe}`
  const cached = candleCache.get(key)
  if (cached && now < cached.refreshAfter) return cached

  const blocked = blockedUntil.get(key)
  if (blocked && now < blocked.until) {
    if (cached) return cached
    throw new Error(`${blocked.error} (no new request before ${iso(blocked.until)})`)
  }

  let request = inFlight.get(key)
  if (!request) {
    const intervalMs = QUANT_TIMEFRAMES[timeframe]
    const currentOpen = Math.floor(now / intervalMs) * intervalMs
    request = getCandleSnapshotFromHyperliquid(symbol, timeframe, currentOpen - BARS * intervalMs, now)
      .then((raw) => {
        const { candles, issues } = parseCandles(raw, symbol, timeframe)
        // Fetched within the grace period of a close: that bar is not used
        // yet, so fetch again once the grace period is over
        const nextClose = now < currentOpen + CLOSE_GRACE_MS ? currentOpen : currentOpen + intervalMs
        const entry: CandleEntry = {
          candles,
          issues,
          fetchedAt: now,
          refreshAfter: nextClose + CLOSE_GRACE_MS,
        }
        candleCache.set(key, entry)
        blockedUntil.delete(key)
        return entry
      })
      .catch((err) => {
        const until = now + backoffFor(err)
        blockedUntil.set(key, { until, error: String(err) })
        logger.warning(`Candles ${key} failed, next attempt after ${iso(until)}: ${err}`)
        if (cached) return cached
        throw err
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, request)
  }
  return request
}

const REQUIRED: (keyof IndicatorSnapshot)[] = [
  'ema20', 'ema50', 'rsi14', 'macd', 'macdSignal', 'macdHistogram', 'atr14', 'relativeVolume20',
]

function timeframeSnapshot(entry: CandleEntry, timeframe: Timeframe, now: number): TimeframeSnapshot {
  const intervalMs = QUANT_TIMEFRAMES[timeframe]
  // A bar is used only if it had closed (with grace) when the data was fetched
  const cut = Math.min(now, entry.fetchedAt) - CLOSE_GRACE_MS
  const indicators = indicatorSnapshot(entry.candles, intervalMs, cut)
  const issues = [...entry.issues, ...indicators.issues]

  const expectedClose = Math.floor((now - CLOSE_GRACE_MS) / intervalMs) * intervalMs - 1
  const lagBars = indicators.asOf === null ? null : Math.round((expectedClose - indicators.asOf) / intervalMs)
  if (lagBars !== null && lagBars > 0) issues.push(`last closed bar is ${lagBars} bar(s) old`)

  const missing = REQUIRED.filter((k) => indicators[k] === null)
  if (missing.length > 0) issues.push(`not available: ${missing.join(', ')}`)

  const status: Status =
    indicators.asOf === null ? 'error' : lagBars! > 0 ? 'stale' : missing.length > 0 ? 'insufficient' : 'ok'

  const snapshot: TimeframeSnapshot = {
    status,
    asOf: iso(indicators.asOf),
    lagBars,
    bars: indicators.bars,
    fetchedAt: iso(entry.fetchedAt),
    indicators,
    issues,
  }
  if (timeframe === '15m') {
    const closed = closedCandles(entry.candles, cut)
    snapshot.lastCloses = closed
      .slice(closed.length - Math.min(LAST_CLOSES, indicators.bars))
      .map((c) => ({ closeTime: iso(c.closeTime)!, close: c.close! }))
  }
  return snapshot
}

function errorSnapshot(err: unknown): TimeframeSnapshot {
  return {
    status: 'error', asOf: null, lagBars: null, bars: 0, fetchedAt: null,
    indicators: null, issues: [String(err)],
  }
}

/** Ticker fields of the last price response, validated; never fetched here. */
export function tickerSnapshot(symbol: string, now: number): TickerSnapshot {
  const ctx = getAssetContext(symbol)
  if (!ctx) {
    return {
      status: 'missing', receivedAt: null, ageSeconds: null, mid: null, mark: null,
      change24hPct: null, dayNotionalVolume: null, openInterest: null, fundingHourly: null,
      issues: ['no ticker context received yet'],
    }
  }
  const issues: string[] = []
  const field = (name: string, valid: (v: number) => boolean) => {
    const v = num(ctx.info[name])
    if (v === null || !valid(v)) {
      issues.push(`${name} missing or invalid`)
      return null
    }
    return v
  }
  const positive = (v: number) => v > 0
  const nonNegative = (v: number) => v >= 0
  const mid = field('midPx', positive)
  const mark = field('markPx', positive)
  const prevDay = field('prevDayPx', positive)
  const ageMs = now - ctx.receivedAt
  if (ageMs > TICKER_MAX_AGE_MS) issues.push(`ticker context is ${Math.round(ageMs / 1000)} s old`)
  return {
    status: ageMs > TICKER_MAX_AGE_MS ? 'stale' : 'ok',
    receivedAt: iso(ctx.receivedAt),
    ageSeconds: Math.round(ageMs / 1000),
    mid,
    mark,
    change24hPct: mid !== null && prevDay !== null ? ((mid - prevDay) / prevDay) * 100 : null,
    dayNotionalVolume: field('dayNtlVlm', nonNegative),
    openInterest: field('openInterest', nonNegative),
    fundingHourly: field('funding', () => true),
    issues,
  }
}

/**
 * Snapshots of the requested symbols (default: the six mainstream perps).
 * Each symbol and timeframe fails on its own.
 */
export async function getQuantSnapshots(
  options: { symbols?: string[]; now?: number } = {},
): Promise<Record<string, QuantSnapshot>> {
  const symbols = options.symbols ?? MAINSTREAM_CRYPTOS

  // Refreshes the shared ticker response only if the 30 s price cache expired
  try {
    await getLastPrice(symbols[0]!, 'CRYPTO')
  } catch (err) {
    logger.warning(`Ticker refresh failed, contexts may be stale: ${err}`)
  }
  // Taken after the ticker refresh, which can take seconds
  const now = options.now ?? Date.now()

  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      const [tf15m, tf4h] = await Promise.all(
        (['15m', '4h'] as const).map((tf) =>
          loadCandles(symbol, tf, now).then(
            (entry) => timeframeSnapshot(entry, tf, now),
            (err) => errorSnapshot(err),
          ),
        ),
      )
      const ticker = tickerSnapshot(symbol, Date.now())
      const snapshot: QuantSnapshot = {
        symbol,
        generatedAt: iso(now)!,
        valid: ticker.status === 'ok' && ticker.issues.length === 0 &&
          tf15m!.status === 'ok' && tf4h!.status === 'ok',
        ticker,
        tf15m: tf15m!,
        tf4h: tf4h!,
      }
      return [symbol, snapshot] as const
    }),
  )
  return Object.fromEntries(entries)
}
