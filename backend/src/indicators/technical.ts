/**
 * Technical indicators on OHLCV series: EMA, RSI (Wilder), MACD, ATR (Wilder)
 * and relative volume. Pure functions: no I/O, inputs are never modified.
 *
 * Conventions
 * - Series are ordered oldest -> newest and contain CLOSED bars only;
 *   `indicatorSnapshot` drops the bar still forming before computing.
 * - Outputs are arrays aligned with the input. `null` means "not available":
 *   not enough history, not warmed up yet, or an invalid input. A missing
 *   value is never turned into 0.
 * - An invalid value (null, NaN, +-Infinity, price <= 0, volume < 0, high <
 *   low...) breaks the series: recursions restart from scratch after it, as if
 *   the series began on the next valid bar.
 * - Seeds follow TA-Lib's defaults: EMA starts from the simple mean of its
 *   first `period` values; RSI and ATR start from the simple mean of the first
 *   `period` gains/losses or true ranges, then use Wilder smoothing (1/period).
 *
 * Warm-up
 *   A seeded recursion keeps (1 - alpha)^k of its seed error after k more
 *   bars. Values are reported only once that residual is <= 1%
 *   (SEED_RESIDUAL), i.e. after period + ceil(ln 0.01 / ln(1 - alpha)) bars:
 *   EMA20 67, EMA50 166, RSI14 78, ATR14 78, MACD 12/26/9 signal 115.
 *   Every function accepts { warmup } to override (minimum: the bars needed
 *   for the first raw value), which the tests use to check raw values.
 */

export type Series = readonly (number | null | undefined)[]
export type Output = (number | null)[]

export interface Candle {
  /** Bar open time, ms since epoch. */
  openTime: number
  /** Bar close time, ms since epoch (Hyperliquid `T`, end inclusive). */
  closeTime: number
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

export interface WarmupOption {
  /** Bars from the start of a valid run before a value is reported. */
  warmup?: number
}

/** Seed error still tolerated when a value is first reported. */
export const SEED_RESIDUAL = 0.01

const isPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0
const isVolume = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Bars after the seed until (1 - alpha)^k <= SEED_RESIDUAL. */
function decayBars(alpha: number): number {
  return Math.ceil(Math.log(SEED_RESIDUAL) / Math.log(1 - alpha))
}

export const emaWarmupBars = (period: number) =>
  period + decayBars(2 / (period + 1))
export const wilderWarmupBars = (period: number) =>
  period + 1 + decayBars(1 / period)
export const macdWarmupBars = (slow = 26, signal = 9) =>
  emaWarmupBars(slow) + emaWarmupBars(signal) - 1

function checkPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${period}`)
  }
}

function resolveWarmup(opts: WarmupOption | undefined, min: number, fallback: number): number {
  const warmup = opts?.warmup ?? fallback
  if (!Number.isInteger(warmup) || warmup < min) {
    throw new RangeError(`warmup must be an integer >= ${min}, got ${warmup}`)
  }
  return warmup
}

/**
 * Calls `fn(start, end)` for each maximal run [start, end) of valid indexes.
 */
function forEachRun(valid: boolean[], fn: (start: number, end: number) => void): void {
  let start = -1
  for (let i = 0; i <= valid.length; i++) {
    if (i < valid.length && valid[i]) {
      if (start < 0) start = i
    } else if (start >= 0) {
      fn(start, i)
      start = -1
    }
  }
}

/** EMA of a clean run; NaN before the seed (index period - 1). */
function emaRun(x: readonly number[], period: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  if (x.length < period) return out
  const alpha = 2 / (period + 1)
  let value = 0
  for (let i = 0; i < period; i++) value += x[i]!
  value /= period
  out[period - 1] = value
  for (let i = period; i < x.length; i++) {
    value = alpha * x[i]! + (1 - alpha) * value
    out[i] = value
  }
  return out
}

/** Copies run values into `out`, from `warmup - 1` bars after the run start. */
function place(out: Output, start: number, run: readonly number[], warmup: number): void {
  for (let j = warmup - 1; j < run.length; j++) {
    const v = run[j]!
    out[start + j] = Number.isFinite(v) ? v : null
  }
}

/** Exponential moving average, alpha = 2 / (period + 1), SMA seed. */
export function ema(values: Series, period: number, opts?: WarmupOption): Output {
  checkPeriod(period)
  const warmup = resolveWarmup(opts, period, emaWarmupBars(period))
  const out: Output = new Array(values.length).fill(null)
  forEachRun(values.map(isPrice), (start, end) => {
    const run = values.slice(start, end) as number[]
    place(out, start, emaRun(run, period), warmup)
  })
  return out
}

/**
 * Relative Strength Index, Wilder's method: the first average gain/loss is
 * the mean of the first `period` changes, then avg = (avg * (period - 1) +
 * current) / period. RSI = 100 - 100 / (1 + avgGain / avgLoss); 100 when
 * avgLoss = 0, and 50 when both averages are 0 (flat series).
 * First raw value needs period + 1 closes.
 */
export function rsi(closes: Series, period = 14, opts?: WarmupOption): Output {
  checkPeriod(period)
  const warmup = resolveWarmup(opts, period + 1, wilderWarmupBars(period))
  const out: Output = new Array(closes.length).fill(null)
  forEachRun(closes.map(isPrice), (start, end) => {
    const c = closes.slice(start, end) as number[]
    if (c.length < period + 1) return
    const run = new Array<number>(c.length).fill(Number.NaN)
    let gain = 0
    let loss = 0
    for (let i = 1; i <= period; i++) {
      const d = c[i]! - c[i - 1]!
      if (d > 0) gain += d
      else loss -= d
    }
    gain /= period
    loss /= period
    run[period] = rsiValue(gain, loss)
    for (let i = period + 1; i < c.length; i++) {
      const d = c[i]! - c[i - 1]!
      gain = (gain * (period - 1) + Math.max(d, 0)) / period
      loss = (loss * (period - 1) + Math.max(-d, 0)) / period
      run[i] = rsiValue(gain, loss)
    }
    place(out, start, run, warmup)
  })
  return out
}

function rsiValue(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100
  return 100 - 100 / (1 + gain / loss)
}

export interface MacdOutput {
  macd: Output
  signal: Output
  histogram: Output
}

/**
 * MACD: line = EMA(fast) - EMA(slow), both SMA-seeded on the same run;
 * signal = EMA(signal) of the line, seeded with the mean of its first
 * `signal` values; histogram = line - signal. With the default warm-up the
 * line is reported once EMA(slow) is warmed up, and signal/histogram once
 * the signal EMA is warmed up on top of that (115 bars for 12/26/9).
 */
export function macd(
  closes: Series,
  fast = 12,
  slow = 26,
  signal = 9,
  opts?: WarmupOption,
): MacdOutput {
  checkPeriod(fast, 'fast')
  checkPeriod(slow, 'slow')
  checkPeriod(signal, 'signal')
  if (fast >= slow) throw new RangeError('fast must be shorter than slow')
  const lineWarmup = resolveWarmup(opts, slow, emaWarmupBars(slow))
  const signalWarmup = opts?.warmup !== undefined
    ? Math.max(lineWarmup, slow + signal - 1)
    : lineWarmup + emaWarmupBars(signal) - 1

  const n = closes.length
  const result: MacdOutput = {
    macd: new Array(n).fill(null),
    signal: new Array(n).fill(null),
    histogram: new Array(n).fill(null),
  }
  forEachRun(closes.map(isPrice), (start, end) => {
    const c = closes.slice(start, end) as number[]
    const fastEma = emaRun(c, fast)
    const slowEma = emaRun(c, slow)
    const line = c.map((_, i) => fastEma[i]! - slowEma[i]!) // NaN before slow - 1
    const sig = new Array<number>(c.length).fill(Number.NaN)
    const tail = emaRun(line.slice(slow - 1), signal)
    tail.forEach((v, j) => (sig[slow - 1 + j] = v))
    place(result.macd, start, line, lineWarmup)
    place(result.signal, start, sig, signalWarmup)
    place(result.histogram, start, line.map((v, i) => v - sig[i]!), signalWarmup)
  })
  return result
}

/**
 * Average True Range, Wilder's method. TR = max(high - low, |high -
 * prevClose|, |low - prevClose|), defined from the second bar of a run. The
 * first ATR is the mean of the first `period` TRs (bar index `period`), then
 * ATR = (ATR * (period - 1) + TR) / period. A bar is valid when all three
 * prices are > 0 and low <= close <= high.
 */
export function atr(
  highs: Series,
  lows: Series,
  closes: Series,
  period = 14,
  opts?: WarmupOption,
): Output {
  checkPeriod(period)
  if (highs.length !== lows.length || lows.length !== closes.length) {
    throw new RangeError('high, low and close must have the same length')
  }
  const warmup = resolveWarmup(opts, period + 1, wilderWarmupBars(period))
  const valid = closes.map((c, i) => {
    const h = highs[i]
    const l = lows[i]
    return isPrice(h) && isPrice(l) && isPrice(c) && l <= c && c <= h
  })
  const out: Output = new Array(closes.length).fill(null)
  forEachRun(valid, (start, end) => {
    const len = end - start
    if (len < period + 1) return
    const h = (i: number) => highs[start + i] as number
    const l = (i: number) => lows[start + i] as number
    const c = (i: number) => closes[start + i] as number
    const tr = (i: number) =>
      Math.max(h(i) - l(i), Math.abs(h(i) - c(i - 1)), Math.abs(l(i) - c(i - 1)))
    const run = new Array<number>(len).fill(Number.NaN)
    let value = 0
    for (let i = 1; i <= period; i++) value += tr(i)
    value /= period
    run[period] = value
    for (let i = period + 1; i < len; i++) {
      value = (value * (period - 1) + tr(i)) / period
      run[i] = value
    }
    place(out, start, run, warmup)
  })
  return out
}

/**
 * Volume of each bar divided by the mean volume of the `lookback` bars
 * before it (the current bar is excluded). Null when fewer than `lookback`
 * valid bars precede it in the same run, or when that mean is 0.
 */
export function relativeVolume(volumes: Series, lookback = 20): Output {
  checkPeriod(lookback, 'lookback')
  const out: Output = new Array(volumes.length).fill(null)
  forEachRun(volumes.map(isVolume), (start, end) => {
    for (let i = start + lookback; i < end; i++) {
      let sum = 0
      for (let j = i - lookback; j < i; j++) sum += volumes[j] as number
      const mean = sum / lookback
      if (mean > 0) out[i] = (volumes[i] as number) / mean
    }
  })
  return out
}

/** Bars fully closed at `asOfMs` (closeTime is end inclusive). */
export function closedCandles(candles: readonly Candle[], asOfMs: number): Candle[] {
  return candles.filter((c) => c.closeTime < asOfMs)
}

export interface IndicatorSnapshot {
  /** Close time of the last closed, valid bar used; null if none. */
  asOf: number | null
  /** Contiguous valid closed bars the values were computed on. */
  bars: number
  close: number | null
  ema20: number | null
  ema50: number | null
  rsi14: number | null
  macd: number | null
  macdSignal: number | null
  macdHistogram: number | null
  atr14: number | null
  /** ATR14 as a percentage of the last close. */
  atr14Pct: number | null
  relativeVolume20: number | null
  /** Why some values are null or fewer bars were used. */
  issues: string[]
}

const NO_VALUES = {
  close: null, ema20: null, ema50: null, rsi14: null, macd: null,
  macdSignal: null, macdHistogram: null, atr14: null, atr14Pct: null,
  relativeVolume20: null,
}

/**
 * Latest indicator values for one symbol and interval. Bars still forming at
 * `asOfMs` are dropped; values come from the most recent run of consecutive
 * valid bars (spaced exactly `intervalMs`), so a gap or an invalid bar
 * restarts every indicator.
 */
export function indicatorSnapshot(
  candles: readonly Candle[],
  intervalMs: number,
  asOfMs: number,
): IndicatorSnapshot {
  const issues: string[] = []
  for (let i = 1; i < candles.length; i++) {
    if (!(candles[i]!.openTime > candles[i - 1]!.openTime)) {
      return { asOf: null, bars: 0, ...NO_VALUES, issues: ['candles not in strictly ascending order'] }
    }
  }

  const closed = closedCandles(candles, asOfMs)
  if (closed.length < candles.length) {
    issues.push(`${candles.length - closed.length} bar(s) not closed yet excluded`)
  }

  const validBar = (c: Candle) =>
    isPrice(c.open) && isPrice(c.high) && isPrice(c.low) && isPrice(c.close) &&
    isVolume(c.volume) && c.low <= Math.min(c.open, c.close) &&
    c.high >= Math.max(c.open, c.close)
  let start = closed.length
  while (start > 0) {
    const bar = closed[start - 1]!
    if (!validBar(bar)) {
      issues.push(`invalid bar at ${new Date(bar.openTime).toISOString()}`)
      break
    }
    const next = closed[start]
    if (next && next.openTime - bar.openTime !== intervalMs) {
      issues.push(`gap before ${new Date(next.openTime).toISOString()}`)
      break
    }
    start--
  }
  const run = closed.slice(start)
  if (run.length === 0) return { asOf: null, bars: 0, ...NO_VALUES, issues }

  const close = run.map((c) => c.close)
  const last = <T>(xs: T[]) => xs[xs.length - 1]!
  const m = macd(close)
  const atr14 = last(atr(run.map((c) => c.high), run.map((c) => c.low), close))
  const lastClose = last(close) as number
  const snapshot: IndicatorSnapshot = {
    asOf: last(run).closeTime,
    bars: run.length,
    close: lastClose,
    ema20: last(ema(close, 20)),
    ema50: last(ema(close, 50)),
    rsi14: last(rsi(close, 14)),
    macd: last(m.macd),
    macdSignal: last(m.signal),
    macdHistogram: last(m.histogram),
    atr14,
    atr14Pct: atr14 === null ? null : (atr14 / lastClose) * 100,
    relativeVolume20: last(relativeVolume(run.map((c) => c.volume), 20)),
    issues,
  }
  if (snapshot.ema50 === null || snapshot.macdSignal === null) {
    issues.push(`${run.length} bars: some indicators still warming up`)
  }
  return snapshot
}
