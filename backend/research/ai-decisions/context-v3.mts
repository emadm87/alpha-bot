// ALPHA BOT 007E — PROPOSED market context for a future prompt ("v3"), built offline from recorded candles.
// Research only: not wired into the app, the active prompt is unchanged. It shows what Gemini WOULD be given and how
// large it is; it does not and cannot tell what Gemini would decide with it (that needs a real test).
//
//   npx tsx research/ai-decisions/context-v3.mts --at 2026-10-28T18:37:00Z [--json]
//   npx tsx research/ai-decisions/context-v3.mts --export <diag.json>        (the brief at every cycle of a run: sizes)
//
// Every value uses only bars that had closed at the given time. Labels (e.g. "higher highs") describe the numbers next
// to them; there is no rule and no signal: the model is asked to weigh the whole picture.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { atr as atrSeries, ema, macd, relativeVolume, rsi } from '../../src/indicators/technical.ts'
import { COINS, DATA_DIR, halfSpreads, loadFunding, verifiedManifest } from '../exit-rules/lib.mts'

export interface HourBar { openTime: number; endTime: number; open: number; high: number; low: number; close: number; volume: number }
const FEE = 0.00045
const HOUR = 3_600_000

/** 15 m candles with volume, by coin (the exit-rule loader has no volume). Bars still forming at the fetch are dropped. */
export function loadBarsWithVolume(file: string, fetchedAt: number): Record<string, HourBar[]> {
  const rows = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  const out: Record<string, HourBar[]> = {}
  for (const [c, t, o, h, l, cl, v] of rows) {
    const openTime = Number(t)
    if (openTime + 900_000 > fetchedAt) continue
    ;(out[c!] ??= []).push({ openTime, endTime: openTime + 900_000, open: +o!, high: +h!, low: +l!, close: +cl!, volume: +v! })
  }
  return out
}

/** Bars of `size` ms from aligned smaller bars (an incomplete group is left out). */
export function aggregate(bars: HourBar[], size: number): HourBar[] {
  const groups = new Map<number, HourBar[]>()
  for (const b of bars) (groups.get(Math.floor(b.openTime / size) * size) ?? groups.set(Math.floor(b.openTime / size) * size, []).get(Math.floor(b.openTime / size) * size)!).push(b)
  const n = size / (bars[1] ? bars[1].openTime - bars[0]!.openTime : size)
  return [...groups].filter(([, g]) => g.length === n).sort((a, b) => a[0] - b[0]).map(([t, g]) => ({
    openTime: t, endTime: t + size, open: g[0]!.open, close: g.at(-1)!.close, volume: g.reduce((s, b) => s + b.volume, 0),
    high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)),
  }))
}

/** Swing points: a high (low) higher (lower) than the `k` bars on each side; only bars with k closed bars after them. */
export function swings(bars: HourBar[], k = 2) {
  const highs: { t: number; price: number }[] = [], lows: { t: number; price: number }[] = []
  for (let i = k; i < bars.length - k; i++) {
    const w = bars.slice(i - k, i + k + 1)
    if (bars[i]!.high === Math.max(...w.map((b) => b.high))) highs.push({ t: bars[i]!.endTime, price: bars[i]!.high })
    if (bars[i]!.low === Math.min(...w.map((b) => b.low))) lows.push({ t: bars[i]!.endTime, price: bars[i]!.low })
  }
  return { highs, lows }
}

const r = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(d + 2)))
const pct = (x: number) => Math.round(x * 1e4) / 100

/** The proposed brief of one coin at time t (only closed bars), with the costs and the risk budget of a 1000 USDC account. */
export function coinBrief(b15: HourBar[], t: number, opts: { halfSpread: number; funding: Map<number, number>; equity: number }) {
  const closed15 = b15.filter((b) => b.endTime <= t)
  const h1 = aggregate(closed15, HOUR).slice(-24 * 30)
  const h4 = aggregate(closed15, 4 * HOUR)
  if (h1.length < 60 || h4.length < 30) return { error: `not enough closed bars before ${new Date(t).toISOString()} (${h1.length} hours)` }
  const last = closed15.at(-1)!
  const c1 = h1.map((b) => b.close), c4 = h4.map((b) => b.close)
  const at = (s: (number | null)[]) => s.at(-1) ?? null
  const ema20h = ema(c1, 20), ema50h = ema(c1, 50), ema20d = ema(c4, 20), ema50d = ema(c4, 50)
  const atr1 = atrSeries(h1.map((b) => b.high), h1.map((b) => b.low), c1, 14)
  const a = at(atr1)!
  const atrHistory = atr1.filter((x): x is number => x !== null)
  const atrPercentile = atrHistory.filter((x) => x <= a).length / atrHistory.length
  const sw = swings(h1.slice(-72))
  const lastHighs = sw.highs.slice(-2), lastLows = sw.lows.slice(-2)
  const structure = lastHighs.length === 2 && lastLows.length === 2
    ? `${lastHighs[1]!.price > lastHighs[0]!.price ? 'higher' : 'lower'} high, ${lastLows[1]!.price > lastLows[0]!.price ? 'higher' : 'lower'} low (last two 1 h swings)`
    : 'not enough swings in 72 h'
  const window = (hours: number) => h1.slice(-hours)
  const hi = (hours: number) => Math.max(...window(hours).map((b) => b.high)), lo = (hours: number) => Math.min(...window(hours).map((b) => b.low))
  const ret = (hours: number) => { const p = h1.at(-1 - hours)?.close; return p ? last.close / p - 1 : null }
  const m = macd(c1)
  const fundingHours = [...opts.funding].filter(([h]) => h <= t).sort((x, y) => x[0] - y[0])
  const fLast = fundingHours.at(-1)?.[1] ?? null
  const f24 = fundingHours.slice(-24).map(([, v]) => v)
  const stopPct = (2 * a) / last.close
  const lossPerUnitPct = stopPct + 2 * FEE + 2 * opts.halfSpread + 0.0002
  const inAtr = (x: number) => r((x - last.close) / a, 2)
  return {
    as_of: new Date(last.endTime).toISOString(), price: last.close,
    trend: {
      '1h': { ema20: r(at(ema20h)), ema50: r(at(ema50h)), price_vs_ema20_atr: r((last.close - at(ema20h)!) / a, 2),
        ema20_slope_4h_atr: r((at(ema20h)! - (ema20h.at(-5) ?? at(ema20h)!)) / a, 2) },
      '4h': { ema20: r(at(ema20d)), ema50: r(at(ema50d)), ema20_above_ema50: (at(ema20d) ?? 0) > (at(ema50d) ?? 0) },
    },
    structure: {
      summary: structure,
      swing_highs_1h: lastHighs.map((s) => ({ price: r(s.price), hours_ago: Math.round((t - s.t) / HOUR), distance_atr: inAtr(s.price) })),
      swing_lows_1h: lastLows.map((s) => ({ price: r(s.price), hours_ago: Math.round((t - s.t) / HOUR), distance_atr: inAtr(s.price) })),
      range_24h: { high: r(hi(24)), low: r(lo(24)), high_distance_atr: inAtr(hi(24)), low_distance_atr: inAtr(lo(24)) },
      range_7d: { high: r(hi(168)), low: r(lo(168)), high_distance_atr: inAtr(hi(168)), low_distance_atr: inAtr(lo(168)) },
    },
    momentum: {
      rsi14_1h: r(at(rsi(c1, 14)), 2), macd_histogram_1h_atr: r((at(m.histogram) ?? 0) / a, 2),
      return_4h_pct: ret(4) === null ? null : pct(ret(4)!), return_24h_pct: ret(24) === null ? null : pct(ret(24)!),
      move_4h_atr: ret(4) === null ? null : r((ret(4)! * last.close) / a, 2),
    },
    volume: { relative_volume_1h_vs_20h: r(at(relativeVolume(h1.map((b) => b.volume), 20)), 2) },
    volatility: { atr14_1h: r(a), atr14_1h_pct: pct(a / last.close), atr_percentile_30d: Math.round(atrPercentile * 100) },
    costs: {
      taker_fee_pct_each_side: FEE * 100, half_spread_bps: Math.round(opts.halfSpread * 1e5) / 10,
      funding_last_hour_pct: fLast === null ? null : Math.round(fLast * 1e6) / 1e4, funding_24h_avg_apr_pct: f24.length ? Math.round(f24.reduce((s, x) => s + x, 0) / f24.length * 24 * 365 * 1e4) / 100 : null,
      funding_note: 'positive: LONG pays SHORT every hour',
      round_trip_cost_pct: Math.round((2 * FEE + 2 * opts.halfSpread) * 1e5) / 1e3,
    },
    risk_budget: {
      stop_2atr_pct: pct(stopPct), loss_at_stop_per_100_usdc_notional: Math.round(lossPerUnitPct * 100 * 100) / 100,
      max_notional_usdc: Object.fromEntries([0.005, 0.01, 0.02].map((p) => [`${p * 100}%`, Math.round((p * opts.equity) / lossPerUnitPct)])),
      leverage_note: 'notional = cash x portion; leverage only changes the margin, not the P&L per price move',
    },
  }
}

if (process.argv[1] && process.argv[1].endsWith('context-v3.mts')) {
  const args = process.argv.slice(2)
  const m = verifiedManifest()
  const bars = loadBarsWithVolume(path.join(DATA_DIR, 'candles-15m.csv.gz'), Date.parse(m.files['candles-15m.csv.gz']!.fetched_at))
  const funding = loadFunding(path.join(DATA_DIR, 'funding-1h.csv.gz'))
  const hs = halfSpreads()
  const brief = (t: number) => Object.fromEntries(COINS.map((c) => [c, coinBrief(bars[c]!, t, { halfSpread: hs[c]!, funding: funding[c] ?? new Map(), equity: 1000 })]))
  if (args.includes('--export')) {
    const e = JSON.parse(fs.readFileSync(args[args.indexOf('--export') + 1]!, 'utf8')) as { source: { run: string }; cycles: { ts: string; prompt_chars: number; response: { prompt_tokens: number | null } | null }[] }
    const sizes = e.cycles.map((c) => ({ ts: c.ts, v1_prompt_tokens: c.response?.prompt_tokens ?? null, v3_market_brief_chars: JSON.stringify(brief(Date.parse(c.ts))).length }))
    console.log(JSON.stringify({ run: e.source.run, cycles: sizes.length, v1_prompt_tokens_median: sizes.map((s) => s.v1_prompt_tokens).sort()[Math.floor(sizes.length / 2)],
      v3_brief_chars_median: sizes.map((s) => s.v3_market_brief_chars).sort((a, b) => a - b)[Math.floor(sizes.length / 2)],
      v3_brief_tokens_estimate: Math.round(sizes.map((s) => s.v3_market_brief_chars).sort((a, b) => a - b)[Math.floor(sizes.length / 2)]! / 3.5), note: 'tokens estimated as characters / 3.5 for compact JSON' }, null, 2))
  } else {
    const at = Date.parse(args[args.indexOf('--at') + 1] ?? '')
    if (!Number.isFinite(at)) { console.error('usage: npx tsx research/ai-decisions/context-v3.mts --at <ISO> | --export <diag.json>'); process.exit(64) }
    const b = brief(at)
    const text = JSON.stringify(b)
    console.log(args.includes('--json') ? JSON.stringify(b, null, 2) : JSON.stringify({ at: new Date(at).toISOString(), chars: text.length, tokens_estimate: Math.round(text.length / 3.5), BTC: b.BTC }, null, 2))
  }
}
