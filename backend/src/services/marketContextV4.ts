/**
 * Market view of the v4 prompt (Task 008, ALPHA_PROMPT=v4 only). Pure: built
 * from the v3 brief (marketContext.coinBrief, unchanged), so v3 is untouched.
 *
 * What changes for v4:
 * - ONE sign convention for every distance: `price_minus_<x>_atr` =
 *   (price - x) / ATR(14, 1h). Positive: the price is ABOVE x; negative:
 *   BELOW. (In v3 the header said "level minus price" while the EMA fields were
 *   price minus EMA: two opposite conventions under one header.)
 * - LONG and SHORT are described symmetrically: for each side, what a position
 *   opened now would face with the exit module in force (stop, take profit or
 *   partial, the levels in the way, the costs in R, the funding paid or
 *   received). Reference only, no signal: the same rules for both sides.
 */
import type { ExitConfig } from './exitRules.js'
import { sig, type CoinBrief } from './marketContext.js'

const r2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100)

type Full = Extract<CoinBrief, { trend: unknown }>
const isFull = (b: CoinBrief): b is Full => 'trend' in b

/** A level in the way: its kind (the same names as in `levels` and `trend`, where its price is) and its distance. */
export interface V4Level { kind: string; price_minus_level_atr: number }

export interface V4Side {
  stop: number | null
  /** Only with C3 (the module's take profit). */
  take_profit?: number | null
  /** Only with C2 (the module's partial exit). */
  partial_exit?: number | null
  /** Levels between the entry and the take profit (or 2 R when there is none), nearest first, at most 3. */
  levels_in_the_way: V4Level[]
  /** Funding over 8 h for this side at the current rate, % of notional: negative = paid, positive = received. */
  funding_8h_pct: number | null
}

/** Round-trip fee and spread as a share of the risk at the module's stop (the same for both sides). */
export function costsInR(b: Full, cfg: ExitConfig): number | null {
  const fee = b.costs.taker_fee_pct_each_side / 100, spread = (b.costs.impact_spread_bps ?? 0) / 1e4
  return r2(((2 * fee + spread) * b.price!) / (cfg.stopAtr * b.volatility.atr14_1h!))
}

/** Every price level of the brief with its kind (swings, ranges, EMAs). */
export function briefLevels(b: Full): { kind: string; price: number }[] {
  const out: { kind: string; price: number }[] = []
  const add = (kind: string, p: number | null | undefined) => { if (p !== null && p !== undefined && Number.isFinite(p)) out.push({ kind, price: p }) }
  for (const s of b.structure.swing_highs_1h) add(`1h swing high ${s.hours_ago}h ago`, s.price)
  for (const s of b.structure.swing_lows_1h) add(`1h swing low ${s.hours_ago}h ago`, s.price)
  add('24 h high', b.structure.range_24h?.high); add('24 h low', b.structure.range_24h?.low)
  add('7 d high', b.structure.range_7d?.high); add('7 d low', b.structure.range_7d?.low)
  add('1h EMA20', b.trend['1h'].ema20); add('1h EMA50', b.trend['1h'].ema50)
  add('4h EMA20', b.trend['4h'].ema20); add('4h EMA50', b.trend['4h'].ema50)
  return out
}

/** What a LONG or a SHORT opened at `price` now would face with the exit module `cfg` (reference, same rules both sides). */
export function sideReference(b: Full, side: 'long' | 'short', cfg: ExitConfig): V4Side {
  const price = b.price!, atr = b.volatility.atr14_1h!
  const dir = side === 'long' ? 1 : -1
  const risk = cfg.stopAtr * atr
  const stop = price - dir * risk
  const tp = cfg.mode === 'C3' ? price + dir * cfg.takeProfitR * risk : null
  const partial = cfg.mode === 'C2' ? price + dir * cfg.partialAtR * risk : null
  const horizon = tp ?? price + dir * 2 * risk
  const between = briefLevels(b)
    .filter((l) => (dir > 0 ? l.price > price && l.price < horizon : l.price < price && l.price > horizon))
    .sort((x, y) => dir * (x.price - y.price))
  const seen = new Set<number>()
  const levels = between.filter((l) => (seen.has(l.price) ? false : (seen.add(l.price), true))).slice(0, 3)
    .map((l) => ({ kind: l.kind, price_minus_level_atr: r2((price - l.price) / atr)! }))
  const fundingH = b.costs.funding_hourly_pct
  return {
    stop: sig(stop),
    ...(cfg.mode === 'C3' ? { take_profit: sig(tp) } : {}),
    ...(cfg.mode === 'C2' ? { partial_exit: sig(partial) } : {}),
    levels_in_the_way: levels,
    // positive funding: LONG pays SHORT
    funding_8h_pct: fundingH === null ? null : Math.round(-dir * fundingH * 8 * 1e5) / 1e5,
  }
}

const neg = (x: number | null | undefined) => (x === null || x === undefined ? null : r2(-x))

/** The v4 view of one coin: v3 values, one sign convention, LONG/SHORT references. Missing data stays missing. */
export function coinBriefV4(b: CoinBrief, mid: number | null, cfg: ExitConfig) {
  if (!isFull(b)) return { price: b.price, price_source: b.price_source, data_quality: b.data_quality, mid_price: mid }
  const atr = b.volatility.atr14_1h!, price = b.price!
  const pm = (x: number | null) => (x === null ? null : r2((price - x) / atr))
  const t1 = b.trend['1h'], t4 = b.trend['4h']
  const range = (r: Full['structure']['range_24h']) => r && {
    high: r.high, low: r.low, price_minus_high_atr: neg(r.high_distance_atr), price_minus_low_atr: neg(r.low_distance_atr),
    position_in_range_pct: r.high !== null && r.low !== null && r.high > r.low ? Math.round(((price - r.low) / (r.high - r.low)) * 100) : null,
  }
  const lvl = (l: Full['structure']['nearest_level_above']) => l && { price: l.price, price_minus_level_atr: neg(l.distance_atr), price_minus_level_pct: neg(l.distance_pct) }
  const swing = (s: { price: number | null; hours_ago: number; distance_atr: number | null }) => ({ price: s.price, hours_ago: s.hours_ago, price_minus_level_atr: neg(s.distance_atr) })
  return {
    price, price_source: b.price_source, mid_price: mid, data_quality: b.data_quality,
    trend: {
      '1h': { ema20: t1.ema20, ema50: t1.ema50, price_minus_ema20_atr: t1.price_vs_ema20_atr, price_minus_ema50_atr: t1.price_vs_ema50_atr,
        ema20_minus_ema50_atr: t1.ema20 !== null && t1.ema50 !== null ? r2((t1.ema20 - t1.ema50) / atr) : null, ema20_slope_4h_atr: t1.ema20_slope_4h_atr },
      '4h': { ema20: t4.ema20, ema50: t4.ema50, price_minus_ema20_atr: pm(t4.ema20), price_minus_ema50_atr: t4.price_vs_ema50_atr,
        ema20_minus_ema50_atr: t4.ema20 !== null && t4.ema50 !== null ? r2((t4.ema20 - t4.ema50) / atr) : null, rsi14: t4.rsi14 },
    },
    levels: {
      structure_1h: b.structure.summary,
      swing_highs_1h: b.structure.swing_highs_1h.map(swing), swing_lows_1h: b.structure.swing_lows_1h.map(swing),
      range_24h: range(b.structure.range_24h), range_7d: range(b.structure.range_7d),
      nearest_above: lvl(b.structure.nearest_level_above), nearest_below: lvl(b.structure.nearest_level_below),
    },
    momentum: b.momentum, volume: b.volume, volatility: b.volatility,
    costs: { ...b.costs, round_trip_cost_pct: r2(2 * b.costs.taker_fee_pct_each_side + (b.costs.impact_spread_bps ?? 0) / 100), round_trip_costs_in_R: costsInR(b, cfg) },
    risk_budget: b.risk_budget,
    if_opened_now: { long: sideReference(b, 'long', cfg), short: sideReference(b, 'short', cfg) },
  }
}
export type CoinBriefV4 = ReturnType<typeof coinBriefV4>
