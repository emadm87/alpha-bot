// ALPHA BOT 007C — paired comparison of the exit configurations C1 / C2 / C3 and BASE (no exit rules) on recorded
// Hyperliquid candles, with the SAME rule code the app runs (src/services/exitRules.ts, exitPathSim.ts).
//
//   npx tsx research/exit-rules/simulate.mts            (from backend/; ~1 min; no network)
// Writes research/exit-rules/results/results.json and results/summary.md. Deterministic (fixed bootstrap seed).
//
// Entries are generated (every 4 h, LONG and SHORT, every market): they stand for "any entry", because entries
// are Gemini's decision. This measures how each exit rule behaves on the price path and what it costs; it is NOT
// a backtest of a strategy and no result here is a profit that was made.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atrFromHourBars, createPlan, DEFAULT_EXIT_CONFIG, hourBars, RISK_PROFILES, type Bar, type ExitConfig, type ExitMode, type Side } from '../../src/services/exitRules.ts'
import { simulatePath, type PathResult } from '../../src/services/exitPathSim.ts'
import { asBar15, COINS, DATA_DIR, halfSpreads, loadBars, loadFunding, rng, verifiedManifest } from './lib.mts'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results')
const FEE = 0.00045 // Hyperliquid perpetual taker fee, base tier, each side
const SLIPPAGES = [0.0002, 0.0005] // extra slippage of stop-type exits beyond the level: 2 bps (main) and 5 bps (sensitivity)
const BOOT = 2000
const HOLDOUT = Date.UTC(2026, 9, 28) // 30 Oct pilot day and after: never used for calibration
const OOS_END = Date.UTC(2026, 8, 9, 18, 45) // first 15 m bar: the 007B calibration started here
const CONFIGS = ['BASE', 'C1', 'C2', 'C3'] as const
type Cfg = (typeof CONFIGS)[number]

const manifest = verifiedManifest()
const f15 = Date.parse(manifest.files['candles-15m.csv.gz']!.fetched_at)
const f1h = Date.parse(manifest.files['oos-candles-1h.csv.gz']!.fetched_at)
const bars15 = loadBars(path.join(DATA_DIR, 'candles-15m.csv.gz'), 900_000, f15)
const bars1h = loadBars(path.join(DATA_DIR, 'oos-candles-1h.csv.gz'), 3_600_000, f1h)
const funding15 = loadFunding(path.join(DATA_DIR, 'funding-1h.csv.gz'))
const funding1h = loadFunding(path.join(DATA_DIR, 'oos-funding-1h.csv.gz'))
const HS = halfSpreads()
const config: ExitConfig = { ...DEFAULT_EXIT_CONFIG }

interface SetDef {
  name: string; description: string; bars: Record<string, Bar[]>; hourly: Record<string, Bar[]>; funding: Record<string, Map<number, number>>
  horizon: number; step: number; firstIndex: number; accept: (entryTime: number, endTime: number) => boolean
}
const hourly15 = Object.fromEntries(COINS.map((c) => [c, hourBars(asBar15(bars15[c]!))]))
const SETS: SetDef[] = [
  { name: 'in_sample_15m', description: '15 m bars, entries 2026-09-11 to 2026-10-25 (windows end before 2026-10-28): the window Task 007B used to choose C1/C2/C3',
    bars: bars15, hourly: hourly15, funding: funding15, horizon: 96, step: 16, firstIndex: 200, accept: (_t, end) => end + 96 * 900_000 < HOLDOUT },
  { name: 'out_of_sample_1h', description: '1 h bars, entries 2026-04-09 to 2026-09-07 (before any data Task 007B used); the path is coarser (1 h bars)',
    bars: bars1h, hourly: bars1h, funding: funding1h, horizon: 24, step: 4, firstIndex: 60, accept: (_t, end) => end <= OOS_END },
  { name: 'holdout_15m', description: '15 m bars, entries from 2026-10-28 (includes the 30 Oct pilot day); 3.5 days, too short for conclusions',
    bars: bars15, hourly: hourly15, funding: funding15, horizon: 96, step: 16, firstIndex: 0, accept: (t) => t >= HOLDOUT },
]

interface Row { coin: string; side: Side; entryTime: number; day: number; res: Record<Cfg, PathResult>; atrPct: number; stopPct: number
  /** Best favorable excursion over the whole window (fraction of the entry), the same for every config. */
  mfePct: number }

function meanRate(m: Map<number, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return m.size ? s / m.size : 0
}

function runSet(set: SetDef, slip: number): Row[] {
  const rows: Row[] = []
  for (const coin of COINS) {
    const bars = set.bars[coin]!
    const fmap = set.funding[coin] ?? new Map<number, number>()
    const fmean = meanRate(fmap)
    const fundingRate = (h: number) => fmap.get(h) ?? fmean
    for (let i = set.firstIndex; i + set.horizon < bars.length; i += set.step) {
      const entryTime = bars[i]!.endTime
      const end = bars[i + set.horizon]!.endTime
      if (!set.accept(entryTime, end)) continue
      const atr = atrFromHourBars(set.hourly[coin]!, entryTime, config.atrPeriod)
      if ('error' in atr) continue
      const path = bars.slice(i + 1, i + 1 + set.horizon)
      for (const side of ['LONG', 'SHORT'] as Side[]) {
        const s = side === 'LONG' ? 1 : -1
        const entry = bars[i]!.close * (1 + s * HS[coin]!)
        const costs = { entryFeeFraction: FEE, exitFeeRate: FEE, halfSpread: HS[coin]!, stopSlippage: slip, fundingRate }
        const res = {} as Record<Cfg, PathResult>
        for (const c of CONFIGS) {
          // BASE: no exit rule, the position is held to the end of the window (as the original leaves it to Gemini)
          const plan = c === 'BASE' ? createPlan('C1', side, entry, entry * 1e3, atr.asOf, config) : createPlan(c as ExitMode, side, entry, atr.atr, atr.asOf, { ...config, mode: c as ExitMode })
          res[c] = simulatePath(plan, path, entryTime, costs)
        }
        const mfePct = Math.max(0, ...path.map((b) => (s * ((s > 0 ? b.high : b.low) - entry)) / entry))
        rows.push({ coin, side, entryTime, day: Math.floor(entryTime / 86_400_000), res, atrPct: atr.atr / entry, stopPct: (config.stopAtr * atr.atr) / entry, mfePct })
      }
    }
  }
  return rows
}

/** Mean and 95% interval by a block bootstrap over calendar days (all entries of a day stay together). */
function boot(rows: Row[], value: (r: Row) => number, seed: number) {
  const byDay = new Map<number, number[]>()
  for (const r of rows) (byDay.get(r.day) ?? byDay.set(r.day, []).get(r.day)!).push(value(r))
  const days = [...byDay.values()]
  const all = days.flat()
  const mean = all.reduce((s, x) => s + x, 0) / all.length
  const rand = rng(seed)
  const means: number[] = []
  for (let b = 0; b < BOOT; b++) {
    let sum = 0, n = 0
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rand() * days.length)]!
      for (const x of d) sum += x
      n += d.length
    }
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const sd = Math.sqrt(means.reduce((s, x) => s + (x - mean) ** 2, 0) / (means.length - 1))
  return { mean, se: sd, ci95: [means[Math.floor(0.025 * BOOT)]!, means[Math.floor(0.975 * BOOT)]!] as [number, number] }
}

const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

const results: Record<string, unknown> = {
  generated_by: 'research/exit-rules/simulate.mts', engine: 'src/services/exitRules.ts + exitPathSim.ts (the code the app runs)',
  data: Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, v.sha256])),
  assumptions: {
    fee_each_side: FEE, half_spread_by_coin: Object.fromEntries(Object.entries(HS).map(([k, v]) => [k, r3(v * 1e4) + ' bps'])),
    stop_slippage_bps: SLIPPAGES.map((s) => s * 1e4), funding: 'hourly rates of the period where recorded, otherwise the mean of the file',
    entries: 'every 4 h, LONG and SHORT, all six markets; held at most 24 h; BASE = no exit rule, closed at 24 h',
    intrabar: 'stop first when a bar touches both a stop and a target; gaps fill at the open', config: { ...config, mode: 'C1|C2|C3' },
  },
  sets: {} as Record<string, unknown>,
}

for (const set of SETS) {
  const main = runSet(set, SLIPPAGES[0]!)
  const slip5 = runSet(set, SLIPPAGES[1]!)
  if (!main.length) continue
  const days = new Set(main.map((r) => r.day)).size
  const coinDays = new Set(main.map((r) => `${r.coin}:${r.day}`)).size
  const per: Record<string, unknown> = {}
  CONFIGS.forEach((c, ci) => {
    const n = main.length
    const kinds: Record<string, number> = {}
    for (const r of main) { const k = r.res[c].legs.at(-1)!.kind; kinds[k] = (kinds[k] ?? 0) + 1 }
    const big = main.filter((r) => r.mfePct >= 3 * r.stopPct) // same entries for every config: moves of at least 3 R (R = 2 ATR) inside the window
    per[c] = {
      net_bps: (({ mean, se, ci95 }) => ({ mean: r2(mean), se: r2(se), ci95: ci95.map(r2) }))(boot(main, (r) => r.res[c].netBps, 11 + ci)),
      net_bps_slippage_5bps: r2(slip5.reduce((s, r) => s + r.res[c].netBps, 0) / slip5.length),
      cost_bps: r2(main.reduce((s, r) => s + r.res[c].costBps, 0) / n),
      // the loss tail per entry: 5th percentile, mean of the worst 5% (expected shortfall) and the worst entry
      tail_bps: (() => {
        const v = main.map((r) => r.res[c].netBps).sort((a, b) => a - b)
        const k = Math.max(1, Math.floor(v.length * 0.05))
        return { p05: r2(v[k - 1]!), expected_shortfall_5pct: r2(v.slice(0, k).reduce((s, x) => s + x, 0) / k), worst: r2(v[0]!) }
      })(),
      win_rate: r3(main.filter((r) => r.res[c].netBps > 0).length / n),
      exit_kinds: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, r3(v / n)])),
      premature_stop_share: c === 'BASE' ? null : r3(main.filter((r) => r.res[c].premature).length / n),
      // share of the best excursion kept (gross), on the entries whose window moved at least 3 R in their favour
      capture_of_3R_moves: r3(big.reduce((s, r) => s + (r.res[c].netBps + r.res[c].costBps) / 1e4 / r.mfePct, 0) / Math.max(1, big.length)),
      moves_3R: big.length,
      mean_hold_h: r2(main.reduce((s, r) => s + r.res[c].barsHeld, 0) / n * (set.horizon === 96 ? 0.25 : 1)),
      ambiguous_bars: main.filter((r) => r.res[c].ambiguous).length,
    }
  })
  const pairs: [Cfg, Cfg][] = [['C1', 'BASE'], ['C2', 'BASE'], ['C3', 'BASE'], ['C1', 'C3'], ['C2', 'C3'], ['C1', 'C2']]
  const paired = Object.fromEntries(pairs.map(([a, b], k) => {
    const x = boot(main, (r) => r.res[a].netBps - r.res[b].netBps, 101 + k)
    return [`${a}-${b}`, { mean_bps: r2(x.mean), se: r2(x.se), ci95: x.ci95.map(r2), share_better: r3(main.filter((r) => r.res[a].netBps > r.res[b].netBps).length / main.length) }]
  }))
  const stop = (c: string) => { const v = main.filter((r) => r.coin === c).map((r) => r.stopPct).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]! }
  ;(results.sets as Record<string, unknown>)[set.name] = {
    description: set.description,
    observations: {
      simulated_entries: main.length, entry_times: main.length / 2,
      independent_calendar_days: days, coin_days: coinDays,
      note: 'LONG and SHORT of the same entry are mirror images and windows overlap (24 h held, one entry every 4 h): the bootstrap resamples whole calendar days, so the intervals reflect about the number of days, not the number of entries',
    },
    configs: per, paired_differences_bps: paired,
    risk_profiles: Object.fromEntries(COINS.map((c) => {
      const sp = stop(c)
      return [c, {
        stop_2atr_pct_median: r3(sp * 100),
        max_notional_usdc_for_risk: Object.fromEntries(RISK_PROFILES.map((p) => [`${p * 100}%`, Math.round((p * 1000) / (sp + 2 * FEE + SLIPPAGES[0]!))])),
      }]
    })),
  }
}

// a position Gemini actually chose (006J-1: BTC LONG 0.00615 at 81168, 3x): its risk at a 2 ATR stop in each set
for (const [name, s] of Object.entries(results.sets as Record<string, any>)) {
  const sp = s.risk_profiles.BTC.stop_2atr_pct_median / 100
  const notional = 0.00615 * 81168
  s.example_gemini_position = { position: 'BTC LONG 0.00615 x 81168 (499 USDC), 3x, from the 006J-1 pilot', risk_at_stop_usdc: r2(notional * (sp + 2 * FEE + SLIPPAGES[0]!)),
    risk_pct_of_1000: r3(notional * (sp + 2 * FEE + SLIPPAGES[0]!) / 10), set: name }
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2) + '\n')

// summary table
const lines = ['# Exit rules C1 / C2 / C3 vs BASE — results (HYPOTHETICAL: simulated exits on recorded prices, not realized profits)', '',
  'Generated by `npx tsx research/exit-rules/simulate.mts` from the data in `data/` (checksums in `data/MANIFEST.json`).', '']
for (const [name, s] of Object.entries(results.sets as Record<string, any>)) {
  lines.push(`## ${name}`, '', s.description, '', `Simulated entries ${s.observations.simulated_entries} (${s.observations.entry_times} entry times x LONG/SHORT); independent calendar days ${s.observations.independent_calendar_days}; coin-days ${s.observations.coin_days}.`, '')
  lines.push('| Config | Net bps (95% CI) | 5 bps slip | Cost bps | Win | Worst 5% (ES) / worst | Premature stops | Capture of 3R moves | Hold h | Exit kinds |', '|---|---|---|---|---|---|---|---|---|---|')
  for (const c of CONFIGS) {
    const v = s.configs[c]
    lines.push(`| ${c} | ${v.net_bps.mean} (${v.net_bps.ci95[0]} to ${v.net_bps.ci95[1]}) | ${v.net_bps_slippage_5bps} | ${v.cost_bps} | ${(v.win_rate * 100).toFixed(0)}% | ${v.tail_bps.expected_shortfall_5pct} / ${v.tail_bps.worst} | ${v.premature_stop_share === null ? '-' : (v.premature_stop_share * 100).toFixed(1) + '%'} | ${v.capture_of_3R_moves ?? '-'} | ${v.mean_hold_h} | ${Object.entries(v.exit_kinds).map(([k, x]) => `${k.replace('exit_', '')} ${((x as number) * 100).toFixed(0)}%`).join(', ')} |`)
  }
  lines.push('', '| Paired difference | Mean bps (95% CI) | Share of entries better |', '|---|---|---|')
  for (const [k, v] of Object.entries(s.paired_differences_bps as Record<string, any>)) lines.push(`| ${k} | ${v.mean_bps} (${v.ci95[0]} to ${v.ci95[1]}) | ${(v.share_better * 100).toFixed(0)}% |`)
  lines.push('')
}
fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
