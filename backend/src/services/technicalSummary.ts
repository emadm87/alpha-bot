/**
 * Task 009F: compact technical summary of the six coins for the AI prompt,
 * from Hyperliquid 1 h candles only. Read only: nothing here changes orders,
 * sizing, leverage, fees, C1 or the scheduler.
 *
 * - Candles come through the cache of quantData.ts (006E): per coin, one
 *   candleSnapshot request per closed hour (the entry is kept until the next
 *   1 h close + 5 s), concurrent loads share one request, and after an error
 *   no new request for 60 s (120 s after a rate limit); the last cached
 *   series stays usable and is reported stale when it is behind.
 * - Only bars closed at the time of the fetch are used (indicatorSnapshot
 *   drops the bar still forming), so nothing later than the decision is used.
 * - A value that cannot be computed (missing, invalid, too few contiguous
 *   bars, stale series) is null and the reason is given in `issue`; nothing
 *   is filled in or invented.
 * - The whole load is bounded by `deadlineMs`: a slow exchange never holds
 *   the AI cycle; the coins without data are reported unavailable.
 */
import {
  closedCandles,
  emaWarmupBars,
  indicatorSnapshot,
  wilderWarmupBars,
  type Candle,
} from '../indicators/technical.js'
import { CLOSE_GRACE_MS, loadCandles, QUANT_TIMEFRAMES } from './quantData.js'

export const TECH_SUMMARY = {
  symbols: ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'],
  /** Longest wait for the candles of a cycle; the cycle continues without them after it. */
  deadlineMs: 8_000,
} as const

const H = QUANT_TIMEFRAMES['1h']

export type Trend = 'up' | 'down' | 'mixed'

export interface CoinTechnical {
  /** Price of Current Market Prices (the price orders fill at), fetched at the start of the cycle. */
  price: number | null
  /** Close time of the last closed 1 h bar used. */
  last_closed_1h: string | null
  close_1h: number | null
  change_1h_pct: number | null
  change_24h_pct: number | null
  ema20_1h: number | null
  ema50_1h: number | null
  atr14_1h: number | null
  rel_volume_1h: number | null
  trend_1h: Trend | null
  issue?: string
}

/** Explanation of the fields, shown once in the prompt. */
export const TECH_LEGEND =
  'Values on the last closed 1h bar (last_closed_1h = its close time, UTC); the bar still forming is never used. ' +
  'change_1h_pct / change_24h_pct = (close_1h / close of the bar that closed 1 h / 24 h earlier - 1) x 100; ' +
  'ema20_1h / ema50_1h = EMA of 1h closes (alpha = 2/(n+1), SMA seed); atr14_1h = Wilder ATR(14) of 1h bars, in price units; ' +
  'rel_volume_1h = volume of that bar / mean volume of the 20 bars before it; ' +
  'trend_1h = "up" if close_1h > ema20_1h > ema50_1h, "down" if close_1h < ema20_1h < ema50_1h, else "mixed" (a description of these numbers, not a signal). ' +
  'Prices and levels rounded to 5 significant digits, ATR to 3. price = Current Market Prices value (fetched at the start of this cycle, price cache at most 30 s old). null = not available, the reason is in issue.'

const sig = (x: number | null | undefined, digits = 5) =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(digits))
const r2 = (x: number) => Math.round(x * 100) / 100
const isoMin = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z'
class DeadlineError extends Error {}

function empty(price: number | null): CoinTechnical {
  return {
    price: price !== null && price > 0 ? price : null,
    last_closed_1h: null, close_1h: null, change_1h_pct: null, change_24h_pct: null,
    ema20_1h: null, ema50_1h: null, atr14_1h: null, rel_volume_1h: null, trend_1h: null,
  }
}

/**
 * Summary of one coin from its cached 1 h candles (pure). `fetchedAt` is when
 * the candles were received: a bar is used only if it had closed (plus the
 * grace) at that time and at `now`. A series whose last closed bar is older
 * than the last hour closed at `now` is stale: its values are not given.
 */
export function coinTechnical(
  candles: readonly Candle[],
  fetchedAt: number,
  now: number,
  price: number | null,
): CoinTechnical {
  const out = empty(price)
  const issues: string[] = []
  if (out.price === null) issues.push('no current price')
  const done = () => (issues.length ? { ...out, issue: issues.join('; ') } : out)

  const cut = Math.min(now, fetchedAt) - CLOSE_GRACE_MS
  const snap = indicatorSnapshot(candles, H, cut)
  const detail = snap.issues.filter((s) => !/not closed yet excluded|still warming up/.test(s))
  if (snap.asOf === null || snap.close === null) {
    issues.push(`no valid closed 1h bar${detail.length ? ` (${detail.join('; ')})` : ''}`)
    return done()
  }
  out.last_closed_1h = isoMin(snap.asOf + 1)
  const expectedClose = Math.floor((now - CLOSE_GRACE_MS) / H) * H - 1
  const lag = Math.round((expectedClose - snap.asOf) / H)
  if (lag > 0) {
    issues.push(`stale: last closed 1h bar received ended ${Math.round((now - snap.asOf - 1) / 60_000)} min ago, ${lag} newer bar(s) not received; values not given`)
    return done()
  }

  const close = snap.close
  out.close_1h = sig(close)
  const closeAt = new Map(closedCandles(candles, cut).map((c) => [c.closeTime, c.close]))
  const change = (hours: number) => {
    const p = closeAt.get(snap.asOf! - hours * H)
    if (p === null || p === undefined || !(p > 0)) {
      issues.push(`change_${hours}h_pct: no valid bar closed ${hours} h before`)
      return null
    }
    return r2((close / p - 1) * 100)
  }
  out.change_1h_pct = change(1)
  out.change_24h_pct = change(24)

  const warm = (name: string, needed: number) =>
    issues.push(`${name}: ${snap.bars} contiguous closed bars, ${needed} needed`)
  out.ema20_1h = sig(snap.ema20)
  if (out.ema20_1h === null) warm('ema20_1h', emaWarmupBars(20))
  out.ema50_1h = sig(snap.ema50)
  if (out.ema50_1h === null) warm('ema50_1h', emaWarmupBars(50))
  out.atr14_1h = sig(snap.atr14, 3)
  if (out.atr14_1h === null) warm('atr14_1h', wilderWarmupBars(14))
  out.rel_volume_1h = snap.relativeVolume20 === null ? null : r2(snap.relativeVolume20)
  if (out.rel_volume_1h === null) {
    issues.push(snap.bars > 20 ? 'rel_volume_1h: mean volume of the 20 previous bars is 0' : `rel_volume_1h: ${snap.bars} contiguous closed bars, 21 needed`)
  }
  if (snap.bars < emaWarmupBars(50) && detail.length) issues.push(detail.join('; '))

  if (snap.ema20 !== null && snap.ema50 !== null) {
    out.trend_1h = close > snap.ema20 && snap.ema20 > snap.ema50 ? 'up'
      : close < snap.ema20 && snap.ema20 < snap.ema50 ? 'down' : 'mixed'
  }
  return done()
}

/** Rejects after `ms` (the request itself goes on and fills the cache for the next cycle). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

/** Summary of the six coins; each coin fails on its own; never throws. */
export async function technicalSummary(
  prices: Record<string, number>,
  now = Date.now(),
  deadlineMs: number = TECH_SUMMARY.deadlineMs,
): Promise<Record<string, CoinTechnical>> {
  const rows = await Promise.all(TECH_SUMMARY.symbols.map(async (symbol) => {
    const price = prices[symbol] ?? null
    try {
      const entry = await withDeadline(loadCandles(symbol, '1h', now), deadlineMs)
      return [symbol, coinTechnical(entry.candles, entry.fetchedAt, now, price)] as const
    } catch (e) {
      // the error itself is logged by quantData; the prompt gets a stable reason
      const row = empty(price)
      const why = e instanceof DeadlineError
        ? `1h candles: no answer from Hyperliquid within ${deadlineMs / 1000} s`
        : '1h candles unavailable from Hyperliquid (request failed, none cached; retried after a pause)'
      return [symbol, { ...row, issue: `${row.price === null ? 'no current price; ' : ''}${why}` }] as const
    }
  }))
  return Object.fromEntries(rows)
}

/**
 * The prompt section: the legend, then one compact line per coin. No wall
 * clock in it (the time reference is last_closed_1h), so the same data give
 * the same text. Never throws.
 */
export async function technicalSection(prices: Record<string, number>, now = Date.now()): Promise<string> {
  try {
    const s = await technicalSummary(prices, now)
    const lines = TECH_SUMMARY.symbols.map((c) => `  "${c}": ${JSON.stringify(s[c])}`)
    return `${TECH_LEGEND}\n{\n${lines.join(',\n')}\n}`
  } catch {
    return 'Not available this cycle; decide on the other data.'
  }
}
