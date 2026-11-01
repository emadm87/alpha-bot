/**
 * Market context of the v3 decision prompt (Task 007F): per coin, from the
 * local 1 h history (closed bars only) and the live Hyperliquid asset
 * context already received by the price path. Pure: the caller passes the
 * bars and the live data.
 *
 * Nothing is invented: a value that cannot be computed from the data
 * available at `now` is null and listed in data_quality.missing with the
 * reason; stale data is used but marked (status 'stale', with its age).
 * Labels ("higher high", "above") only describe the numbers next to them:
 * there is no rule and no signal here.
 */
import { atr as atrSeries, ema, macd, relativeVolume, rsi, wilderWarmupBars } from '../indicators/technical.js'
import type { HourBar } from './marketHistory.js'

const HOUR = 3_600_000
/** Closed 1 h bars needed before anything is computed: the warm-up of ATR(14). */
export const MIN_BARS_1H = wilderWarmupBars(14)

export interface LiveContext {
  markPx: number | null
  midPx: number | null
  /** Hourly funding rate (fraction), as published in the asset context. */
  funding: number | null
  premium: number | null
  openInterest: number | null
  /** 24 h notional volume, USD. */
  dayNtlVlm: number | null
  /** Impact prices [bid, ask] for a sizeable order, from the asset context. */
  impactPxs: [number, number] | null
  receivedAt: number | null
}

export interface BriefOptions {
  /** Taker fee rate of the account's cost model, each side. */
  feeRate: number
  /** Account value without unrealized P&L, for the risk budget. */
  equityBase: number
  /** Live data older than this is not used for the price. */
  liveMaxAgeMs?: number
}

/** 4 h bars from aligned 1 h bars (an incomplete group is left out). */
export function aggregate4h(h1: readonly HourBar[]): HourBar[] {
  const size = 4 * HOUR
  const groups = new Map<number, HourBar[]>()
  for (const b of h1) {
    const k = Math.floor(b.openTime / size) * size
    ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(b)
  }
  return [...groups].filter(([, g]) => g.length === 4).sort((a, b) => a[0] - b[0]).map(([t, g]) => ({
    openTime: t, endTime: t + size, open: g[0]!.open, close: g[3]!.close, volume: g.reduce((s, b) => s + b.volume, 0),
    high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)),
  }))
}

/** Swing points: a high (low) above (below) the `k` bars on each side; only bars with k closed bars after them. */
export function swings(bars: readonly HourBar[], k = 2) {
  const highs: { endTime: number; price: number }[] = [], lows: { endTime: number; price: number }[] = []
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1)
    if (bars[i]!.high === Math.max(...w.map((b) => b.high))) highs.push({ endTime: bars[i]!.endTime, price: bars[i]!.high })
    if (bars[i]!.low === Math.min(...w.map((b) => b.low))) lows.push({ endTime: bars[i]!.endTime, price: bars[i]!.low })
  }
  return { highs, lows }
}

/** Rounds to `sig` significant digits; null stays null. */
export function sig(x: number | null | undefined, digits = 6): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null
  if (x === 0) return 0
  return Number(x.toPrecision(digits))
}
const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100)

export type BriefStatus = 'ok' | 'stale' | 'insufficient'

/**
 * The brief of one coin at `now`. Needs MIN_BARS_1H closed 1 h bars (else
 * status 'insufficient' with what is known); 4 h EMAs and the 30-day ATR
 * percentile need their own history and are null with a reason until then.
 */
export function coinBrief(h1All: readonly HourBar[], live: LiveContext, now: number, opts: BriefOptions) {
  const h1 = h1All.filter((b) => b.endTime <= now) // closed bars only (also guards a caller passing more)
  const missing: string[] = []
  const liveFresh = live.receivedAt !== null && now - live.receivedAt <= (opts.liveMaxAgeMs ?? 60_000)
  const last = h1.at(-1)
  const price = liveFresh && live.markPx ? live.markPx : last?.close ?? null
  const priceSource = liveFresh && live.markPx ? 'mark (live)' : last ? 'last 1 h close (no fresh live price)' : null
  const lastAgeMin = last ? Math.round((now - last.endTime) / 60_000) : null
  let gaps = 0
  for (let i = 1; i < h1.length; i++) gaps += Math.max(0, (h1[i]!.openTime - h1[i - 1]!.openTime) / HOUR - 1)
  const base = {
    price: sig(price), price_source: priceSource,
    data_quality: {
      status: 'insufficient' as BriefStatus, bars_1h: h1.length, last_bar_close: last ? new Date(last.endTime).toISOString() : null,
      last_bar_age_min: lastAgeMin, gaps_1h: gaps, live_context_age_s: live.receivedAt === null ? null : Math.round((now - live.receivedAt) / 1000), missing,
    },
  }
  if (!last || price === null || h1.length < MIN_BARS_1H) {
    missing.push(`indicators: ${h1.length} closed 1 h bars, ${MIN_BARS_1H} needed (ATR(14) warm-up)`)
    return base
  }
  const c1 = h1.map((b) => b.close)
  const at = (s: (number | null)[]) => s.at(-1) ?? null
  const atr1 = atrSeries(h1.map((b) => b.high), h1.map((b) => b.low), c1, 14)
  const a = at(atr1)
  if (a === null || !(a > 0)) {
    missing.push('ATR(14, 1h): not enough contiguous bars')
    return base
  }
  const inAtr = (level: number | null) => (level === null ? null : r2((level - price) / a))
  const e20 = ema(c1, 20), e50 = ema(c1, 50)
  const h4 = aggregate4h(h1)
  const c4 = h4.map((b) => b.close)
  const e20d = at(ema(c4, 20)), e50d = at(ema(c4, 50)), rsi4 = at(rsi(c4, 14))
  if (e20d === null) missing.push('4h EMA20: not enough 4 h bars yet')
  if (e50d === null) missing.push(`4h EMA50: ${h4.length} 4 h bars, warm-up not reached`)
  const atrHist = atr1.slice(-720).filter((x): x is number => x !== null)
  const atrPct = atrHist.length >= 24 * 20 ? Math.round((atrHist.filter((x) => x <= a).length / atrHist.length) * 100) : null
  if (atrPct === null) missing.push(`ATR percentile: ${atrHist.length} hourly ATR values, 480 needed (20 days)`)
  const window = (hours: number) => h1.filter((b) => b.endTime > last.endTime - hours * HOUR)
  const range = (hours: number) => {
    const w = window(hours)
    if (w.length < hours * 0.9) { missing.push(`${hours} h range: ${w.length} of ${hours} hours`); return null }
    const hi = Math.max(...w.map((b) => b.high)), lo = Math.min(...w.map((b) => b.low))
    return { high: sig(hi), low: sig(lo), high_distance_atr: inAtr(hi), low_distance_atr: inAtr(lo) }
  }
  const sw = swings(h1.slice(-72))
  const lastHighs = sw.highs.slice(-2), lastLows = sw.lows.slice(-2)
  const structure = lastHighs.length === 2 && lastLows.length === 2
    ? `${lastHighs[1]!.price > lastHighs[0]!.price ? 'higher' : 'lower'} high, ${lastLows[1]!.price > lastLows[0]!.price ? 'higher' : 'lower'} low (last two 1 h swings)`
    : null
  if (!structure) missing.push('structure: fewer than two 1 h swing highs and lows in 72 h')
  // nearest levels above and below among swing points and the 24 h / 7 d extremes
  const candidates = [...sw.highs, ...sw.lows].map((s) => s.price)
  const r24 = range(24), r7d = range(168)
  for (const r of [r24, r7d]) if (r) candidates.push(r.high!, r.low!)
  const above = candidates.filter((p) => p > price).sort((x, y) => x - y)[0] ?? null
  const below = candidates.filter((p) => p < price).sort((x, y) => y - x)[0] ?? null
  // return over `hours`: the close of the bar that ended exactly `hours` before the last one (null across a gap)
  const closeAt = new Map(h1.map((b) => [b.endTime, b.close]))
  const ret = (hours: number) => { const p = closeAt.get(last.endTime - hours * HOUR); return p ? last.close / p - 1 : null }
  const m = macd(c1)
  const impact = live.impactPxs && live.impactPxs[0] > 0 && live.impactPxs[1] > 0
    ? (live.impactPxs[1] - live.impactPxs[0]) / ((live.impactPxs[1] + live.impactPxs[0]) / 2) : null
  if (impact === null) missing.push('impact spread: no impact prices in the live context')
  if (live.funding === null) missing.push('funding: not in the live context')
  const stop = (2 * a) / price
  const lossPerUnit = stop + 2 * opts.feeRate + (impact ?? 0) + 0.0002
  const status: BriefStatus = lastAgeMin! > 120 || !liveFresh ? 'stale' : 'ok'
  return {
    ...base,
    data_quality: { ...base.data_quality, status },
    trend: {
      '1h': {
        ema20: sig(at(e20)), ema50: sig(at(e50)),
        price_vs_ema20_atr: at(e20) === null ? null : r2((price - at(e20)!) / a), price_vs_ema50_atr: at(e50) === null ? null : r2((price - at(e50)!) / a),
        ema20_slope_4h_atr: at(e20) !== null && e20.at(-5) != null ? r2((at(e20)! - e20.at(-5)!) / a) : null,
        ema20_vs_ema50: at(e20) !== null && at(e50) !== null ? (at(e20)! > at(e50)! ? 'above' : 'below') : null,
      },
      '4h': {
        ema20: sig(e20d), ema50: sig(e50d), ema20_vs_ema50: e20d !== null && e50d !== null ? (e20d > e50d ? 'above' : 'below') : null,
        price_vs_ema50_atr: e50d === null ? null : r2((price - e50d) / a), rsi14: r2(rsi4),
      },
    },
    structure: {
      summary: structure,
      swing_highs_1h: lastHighs.map((s) => ({ price: sig(s.price), hours_ago: Math.round((now - s.endTime) / HOUR), distance_atr: inAtr(s.price) })),
      swing_lows_1h: lastLows.map((s) => ({ price: sig(s.price), hours_ago: Math.round((now - s.endTime) / HOUR), distance_atr: inAtr(s.price) })),
      range_24h: r24, range_7d: r7d,
      nearest_level_above: above === null ? null : { price: sig(above), distance_atr: inAtr(above), distance_pct: r2((above / price - 1) * 100) },
      nearest_level_below: below === null ? null : { price: sig(below), distance_atr: inAtr(below), distance_pct: r2((below / price - 1) * 100) },
    },
    momentum: {
      rsi14_1h: r2(at(rsi(c1, 14))), macd_histogram_1h_atr: at(m.histogram) === null ? null : r2(at(m.histogram)! / a),
      return_4h_pct: ret(4) === null ? null : r2(ret(4)! * 100), return_24h_pct: ret(24) === null ? null : r2(ret(24)! * 100),
      move_4h_atr: ret(4) === null ? null : r2((ret(4)! * last.close) / a),
    },
    volume: {
      relative_volume_1h_vs_20h: r2(at(relativeVolume(h1.map((b) => b.volume), 20))),
      notional_24h_usd: live.dayNtlVlm === null ? null : Math.round(live.dayNtlVlm),
    },
    volatility: { atr14_1h: sig(a), atr14_1h_pct: r2((a / price) * 100), atr_percentile_30d: atrPct },
    costs: {
      taker_fee_pct_each_side: Math.round(opts.feeRate * 1e5) / 1e3,
      impact_spread_bps: impact === null ? null : r2(impact * 1e4),
      funding_hourly_pct: live.funding === null ? null : Math.round(live.funding * 1e8) / 1e6,
    },
    risk_budget: {
      stop_2atr_pct: r2(stop * 100), loss_at_stop_per_100_usdc_notional: r2(lossPerUnit * 100),
      max_notional_usdc: Object.fromEntries([0.005, 0.01, 0.02].map((p) => [`${p * 100}%`, Math.round((p * opts.equityBase) / lossPerUnit)])),
    },
  }
}

export type CoinBrief = ReturnType<typeof coinBrief>

/** Compact snapshot of a brief, kept with a decision to describe later what changed since. */
export function briefSnapshot(b: CoinBrief) {
  const t = 'trend' in b ? b.trend : null
  const s = 'structure' in b ? b.structure : null
  return {
    price: b.price, status: b.data_quality.status,
    ema20_vs_ema50_1h: t?.['1h'].ema20_vs_ema50 ?? null, ema20_vs_ema50_4h: t?.['4h'].ema20_vs_ema50 ?? null,
    structure: s?.summary ?? null, atr14_1h: 'volatility' in b ? b.volatility.atr14_1h : null,
    range_24h_high: s?.range_24h?.high ?? null, range_24h_low: s?.range_24h?.low ?? null,
  }
}
export type BriefSnapshot = ReturnType<typeof briefSnapshot>

/** What changed between the snapshot of an earlier decision and now, in words with the numbers. */
export function changesSince(then: BriefSnapshot, now: BriefSnapshot): string[] {
  const out: string[] = []
  if (then.ema20_vs_ema50_1h && now.ema20_vs_ema50_1h && then.ema20_vs_ema50_1h !== now.ema20_vs_ema50_1h) out.push(`1h EMA20 moved ${now.ema20_vs_ema50_1h} EMA50`)
  if (then.ema20_vs_ema50_4h && now.ema20_vs_ema50_4h && then.ema20_vs_ema50_4h !== now.ema20_vs_ema50_4h) out.push(`4h EMA20 moved ${now.ema20_vs_ema50_4h} EMA50`)
  if (then.structure && now.structure && then.structure !== now.structure) out.push(`structure was "${then.structure}", now "${now.structure}"`)
  if (then.price && now.price && then.atr14_1h) out.push(`price ${then.price} -> ${now.price} (${r2((now.price - then.price) / then.atr14_1h)} ATR of that time)`)
  if (then.atr14_1h && now.atr14_1h) out.push(`ATR(14, 1h) ${then.atr14_1h} -> ${now.atr14_1h} (${r2((now.atr14_1h / then.atr14_1h - 1) * 100)}%)`)
  if (then.range_24h_low && now.price && now.price < then.range_24h_low) out.push(`price below the 24 h low of that time (${then.range_24h_low})`)
  if (then.range_24h_high && now.price && now.price > then.range_24h_high) out.push(`price above the 24 h high of that time (${then.range_24h_high})`)
  return out
}
