// ALPHA BOT 008 — offline comparison of the v3 and v4 prompts on the SAME historical data (committed Hyperliquid 1 h
// candles and funding, SHA-256 verified). No AI call and no decision: what the model would answer to v4 cannot be
// measured without calling it. This compares what each prompt GIVES: structure, completeness, sign conventions,
// LONG/SHORT symmetry and size.
//
//   npx tsx research/ai-decisions/compare-v3-v4.mts [--out <new folder>]
//
// Account flat, no memory, no news, exit module C3 (the 2 Nov pilot setting). Live context offline: price = last
// 1 h close, funding = last committed hourly rate, impact prices and 24 h volume not in the data (null, listed as
// missing in both versions alike).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { briefSnapshot, coinBrief, type CoinBrief } from '../../src/services/marketContext.ts'
import { coinBriefV4 } from '../../src/services/marketContextV4.ts'
import { loadExitConfig } from '../../src/services/exitRules.ts'
import { selectNews } from '../../src/services/newsFeed.ts'
import { buildMessagesV3, estimateTokens } from '../../src/services/promptV3.ts'
import { buildMessagesV4 } from '../../src/services/promptV4.ts'
import type { V3Context } from '../../src/services/v3Context.ts'
import { COINS, DATA_DIR, verifiedManifest } from '../exit-rules/lib.mts'

const HOUR = 3_600_000
const args = process.argv.slice(2)
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : null
if (out && fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`${out} is not empty: nothing written`); process.exit(73) }
verifiedManifest()
const csv = (f: string) => zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, f))).toString('utf8').trim().split('\n').slice(1).map((l) => l.split(','))
const bars: Record<string, { openTime: number; endTime: number; open: number; high: number; low: number; close: number; volume: number }[]> = {}
for (const [c, t, o, h, l, cl, v] of csv('oos-candles-1h.csv.gz')) (bars[c!] ??= []).push({ openTime: +t!, endTime: +t! + HOUR, open: +o!, high: +h!, low: +l!, close: +cl!, volume: +v! })
const funding: Record<string, [number, number][]> = {}
for (const [c, t, r] of csv('oos-funding-1h.csv.gz')) (funding[c!] ??= []).push([+t!, +r!])
const exitModule = loadExitConfig({ ALPHA_PROTECTION: 'C3' })

function context(at: number): V3Context {
  const markets: Record<string, any> = {}, snapshots: Record<string, any> = {}, prices: Record<string, number | null> = {}
  for (const c of COINS) {
    const h1 = bars[c]!.filter((b) => b.endTime <= at && b.openTime >= at - 45 * 24 * HOUR)
    const p = h1.at(-1)!.close
    const f = funding[c]!.filter(([t]) => t <= at).at(-1)?.[1] ?? null
    const b = coinBrief(h1, { markPx: p, midPx: p, funding: f, premium: null, openInterest: null, dayNtlVlm: null, impactPxs: null, receivedAt: at }, at, { feeRate: 0.00045, equityBase: 1000 })
    markets[c] = { ...b, mid_price: p }; snapshots[c] = briefSnapshot(b); prices[c] = b.price
  }
  return {
    now: at, account: { cash_usdc: 1000, frozen_cash_usdc: 0, total_assets_usdc: 1000, cost_model: 'hyperliquid', taker_fee_pct_each_side: 0.045, open_positions: 0 },
    positions: [], cooldowns: [], exitModule, memory: [], markets, news: selectNews([], at, new Map(), 'offline comparison: no news'), snapshots, prices, history: {},
  }
}

// every numeric field whose name says it is a signed distance, with the convention its NAME or the HEADER implies
function distanceFields(o: unknown, prefix = ''): { key: string; value: number }[] {
  if (!o || typeof o !== 'object') return []
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number' && /_atr$|_pct$/.test(k) && /distance|price_vs|price_minus/.test(k)) return [{ key, value: v }]
    return Array.isArray(v) ? v.flatMap((x, i) => distanceFields(x, `${key}[${i}]`)) : distanceFields(v, key)
  })
}

const start = Date.parse('2026-10-01T00:00:30Z'), end = Date.parse('2026-10-31T12:00:30Z')
const times: number[] = []
for (let t = start; t <= end; t += 12 * HOUR) times.push(t)
const agg = {
  points: times.length, coin_points: 0,
  v3: { tokens_est: [] as number[], distance_fields: 0, fields_against_header: 0, missing: 0, keys: 0 },
  v4: { tokens_est: [] as number[], distance_fields: 0, fields_against_convention: 0, missing: 0, keys: 0 },
  context: { trend4h_ema20_below_ema50: 0, price_above_1h_ema20: 0, price_below_4h_ema50: 0 },
  symmetry: { long_levels: 0, short_levels: 0, costs_in_R: [] as number[], funding_long_pays: 0, funding_short_pays: 0 },
}
const countKeys = (o: unknown): number => (o && typeof o === 'object' ? Object.values(o).reduce((s: number, v) => s + 1 + countKeys(v), 0) : 0)
const countNull = (o: unknown): number => (o === null ? 1 : o && typeof o === 'object' ? Object.values(o).reduce((s: number, v) => s + countNull(v), 0) : 0)
let sample: { at: string; v3: { role: string; content: string }[]; v4: { role: string; content: string }[] } | null = null
for (const at of times) {
  const ctx = context(at)
  const m3 = buildMessagesV3(ctx), m4 = buildMessagesV4(ctx, { recent: [], last_decision_minutes_ago: null, since_last_decision: null })
  agg.v3.tokens_est.push(m3.reduce((s, m) => s + estimateTokens(m.content), 0))
  agg.v4.tokens_est.push(m4.reduce((s, m) => s + estimateTokens(m.content), 0))
  if (at === Date.parse('2026-10-28T12:00:30Z')) sample = { at: new Date(at).toISOString(), v3: m3, v4: m4 }
  for (const c of COINS) {
    const b3 = ctx.markets[c] as CoinBrief & { mid_price: number | null }
    if (!('trend' in b3)) continue
    agg.coin_points++
    const b4 = coinBriefV4(b3, b3.mid_price, exitModule) as any
    const price = b3.price!, atr = b3.volatility.atr14_1h!
    // v3: the header says "level minus price"; a field follows it when its sign is that of (level - price)
    for (const f of distanceFields(b3)) {
      agg.v3.distance_fields++
      if (/price_vs/.test(f.key) && f.value !== 0) agg.v3.fields_against_header++ // computed as price minus EMA
    }
    // v4: every field is price minus x; checked against the level it names
    for (const f of distanceFields(b4)) {
      agg.v4.distance_fields++
      const holder = f.key.split('.').slice(0, -1).reduce((o: any, k) => { const m = /^(.*)\[(\d+)\]$/.exec(k); return m ? o[m[1]!][+m[2]!] : o[k] }, b4)
      const leaf = f.key.split('.').at(-1)!
      const x = leaf === 'price_minus_level_atr' || leaf === 'price_minus_level_pct' ? holder.price
        : leaf === 'price_minus_high_atr' ? holder.high : leaf === 'price_minus_low_atr' ? holder.low
          : leaf === 'price_minus_ema20_atr' ? holder.ema20 : leaf === 'price_minus_ema50_atr' ? holder.ema50 : null
      if (x !== null && f.value !== 0 && Math.sign(f.value) !== Math.sign(price - x)) agg.v4.fields_against_convention++
    }
    agg.v3.missing += countNull(b3); agg.v4.missing += countNull(b4)
    agg.v3.keys += countKeys(b3); agg.v4.keys += countKeys(b4)
    if (b3.trend['4h'].ema20_vs_ema50 === 'below') agg.context.trend4h_ema20_below_ema50++
    if (b3.trend['1h'].ema20 !== null && price > b3.trend['1h'].ema20) agg.context.price_above_1h_ema20++
    if (b3.trend['4h'].ema50 !== null && price < b3.trend['4h'].ema50) agg.context.price_below_4h_ema50++
    const L = b4.if_opened_now.long, Sh = b4.if_opened_now.short
    agg.symmetry.long_levels += L.levels_in_the_way.length; agg.symmetry.short_levels += Sh.levels_in_the_way.length
    agg.symmetry.costs_in_R.push(b4.costs.round_trip_costs_in_R)
    if (L.funding_8h_pct < 0) agg.symmetry.funding_long_pays++
    if (Sh.funding_8h_pct < 0) agg.symmetry.funding_short_pays++
    void atr
  }
}
const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)]!
const result = {
  data: 'committed oos-candles-1h + oos-funding-1h (verified), 2026-10-01 .. 2026-10-31 every 12 h, C3, flat account, no memory, no news',
  points: agg.points, coin_points: agg.coin_points,
  size_estimate_tokens: { v3_median: med(agg.v3.tokens_est), v4_median: med(agg.v4.tokens_est), note: 'estimateTokens (digits + others / 2.9); exact counts of the sample: examples/v4/tokens.json' },
  sign_convention: {
    v3: { distance_fields: agg.v3.distance_fields, fields_whose_sign_contradicts_the_header: agg.v3.fields_against_header, header: 'level minus price', note: 'price_vs_ema20_atr, price_vs_ema50_atr (1h) and price_vs_ema50_atr (4h) are price minus EMA' },
    v4: { distance_fields: agg.v4.distance_fields, fields_whose_sign_contradicts_the_convention: agg.v4.fields_against_convention, convention: 'price minus x' },
  },
  completeness: { v3_numeric_and_label_keys_per_coin: Math.round(agg.v3.keys / agg.coin_points), v4_keys_per_coin: Math.round(agg.v4.keys / agg.coin_points),
    v3_null_values: agg.v3.missing, v4_null_values: agg.v4.missing, note: 'v4 keeps every v3 value (re-signed), adds 4h price-EMA20 distance, EMA20-EMA50 gaps, position in range, round-trip cost and the LONG/SHORT references; nulls are the same missing data in both (impact prices, 24 h volume: not in the offline data)' },
  market_context_share_of_coin_points: {
    four_h_ema20_below_ema50: +(agg.context.trend4h_ema20_below_ema50 / agg.coin_points).toFixed(3),
    price_above_1h_ema20: +(agg.context.price_above_1h_ema20 / agg.coin_points).toFixed(3),
    price_below_4h_ema50: +(agg.context.price_below_4h_ema50 / agg.coin_points).toFixed(3),
    note: 'descriptive only: how often the data showed a bearish 4 h EMA structure in October; not a decision',
  },
  long_short_symmetry_v4: {
    levels_in_the_way: { long: agg.symmetry.long_levels, short: agg.symmetry.short_levels },
    round_trip_costs_in_R_median: med(agg.symmetry.costs_in_R), costs_note: 'one value per coin, the same for both sides; offline without the spread (no impact prices in the data)',
    funding_paid_by: { long: agg.symmetry.funding_long_pays, short: agg.symmetry.funding_short_pays },
    note: 'same rules for both sides (test 4 of src/services/aiV4.test.ts mirrors prices); the counts differ only with the market',
  },
  not_measurable_offline: 'what Gemini decides with v4, how often it trades, P&L: only a real paper test can show it',
}
console.log(JSON.stringify(result, null, 2))
if (out && sample) {
  fs.mkdirSync(out, { recursive: true })
  fs.writeFileSync(path.join(out, 'compare.json'), JSON.stringify(result, null, 2) + '\n')
  for (const v of ['v3', 'v4'] as const) {
    fs.writeFileSync(path.join(out, `${v}.system.txt`), sample[v][0]!.content)
    fs.writeFileSync(path.join(out, `${v}.user.txt`), sample[v][1]!.content)
  }
  fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify({ at: sample.at, sha256: Object.fromEntries((['v3', 'v4'] as const).flatMap((v) => [0, 1].map((i) => [`${v}.${i ? 'user' : 'system'}`, crypto.createHash('sha256').update(sample![v][i]!.content).digest('hex')]))) }, null, 2) + '\n')
}
