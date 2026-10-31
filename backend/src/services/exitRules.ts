/**
 * Exit management rules C1 / C2 / C3 (Task 007C, experimental). Pure: no
 * database, clock or network. The same functions run in the live monitor
 * (positionProtection.ts), in the chronological replay (exitReplay.ts) and in
 * the research simulation (research/exit-rules), so what is validated is the
 * code that runs.
 *
 * Gemini keeps every entry decision, its size and its leverage. The rules only
 * close (all or part of) a position already open:
 *
 *   all   initial stop at 2 x ATR(14, 1 h) from the entry price; R = that distance
 *   C1    trailing stop (chandelier) at best price - 3 x ATR, never below the stop; no take profit
 *   C2    25% realized at +1.5 R; then the rest: break-even (entry price) and the
 *         chandelier 3 x ATR, never below the stop
 *   C3    whole position closed at +2 R (take profit); otherwise the stop
 *
 * ATR comes only from 1 h bars closed before the position's first fill and is
 * frozen for the life of the position: the plan never uses later information.
 * Levels are prices; they are checked against the mark price (live) or the
 * bar's high/low (simulation, stop first when both are touched in one bar).
 *
 * A separate account emergency control closes everything when the open
 * positions together lose emergencyLossPctOfEquity of the account value; it
 * is not a stop on the price and does not depend on the plan.
 *
 * The parameters were chosen a priori in Task 007B (exit-rule sensitivity on
 * 9 Sep - 27 Oct 2026 candles), not fitted to any recorded trade.
 */

export type ExitMode = 'C1' | 'C2' | 'C3'
export type Side = 'LONG' | 'SHORT'

export interface ExitConfig {
  /** off = module disabled (original behaviour). */
  mode: 'off' | ExitMode
  atrPeriod: number
  /** Initial stop distance, in ATR. */
  stopAtr: number
  /** Chandelier distance from the best price, in ATR (C1, C2 after the partial). */
  trailAtr: number
  /** C2: profit (in R) at which part of the position is realized. */
  partialAtR: number
  /** C2: fraction of the position realized there. */
  partialFraction: number
  /** C3: take profit, in R. */
  takeProfitR: number
  /** Same coin and direction cannot be reopened by the AI for this long after a full exit of the module. */
  cooldownMs: number
  /** Account emergency: open positions together losing this fraction of the account value. */
  emergencyLossPctOfEquity: number
  /** Risk per trade used as the evaluation reference (1%); NOT a stop. */
  referenceRiskPct: number
  /** Estimated slippage of a stop exit beyond the level (bps), in the risk estimate. */
  stopSlippageBps: number
  /** First retry delay after a failed exit; doubles up to retryMaxMs. */
  retryBaseMs: number
  retryMaxMs: number
}

export const RISK_PROFILES = [0.005, 0.01, 0.02] as const
/** Hyperliquid minimum order value (MinTradeNtl). */
export const MIN_ORDER_NOTIONAL = 10

export const DEFAULT_EXIT_CONFIG: ExitConfig = {
  mode: 'off',
  atrPeriod: 14,
  stopAtr: 2,
  trailAtr: 3,
  partialAtR: 1.5,
  partialFraction: 0.25,
  takeProfitR: 2,
  cooldownMs: 2 * 3_600_000,
  emergencyLossPctOfEquity: 0.03,
  referenceRiskPct: 0.01,
  stopSlippageBps: 2,
  retryBaseMs: 15_000,
  retryMaxMs: 15 * 60_000,
}

const RANGES: Record<Exclude<keyof ExitConfig, 'mode'>, [number, number]> = {
  atrPeriod: [5, 50],
  stopAtr: [0.5, 10],
  trailAtr: [0.5, 15],
  partialAtR: [0.25, 10],
  partialFraction: [0.05, 0.95],
  takeProfitR: [0.25, 20],
  cooldownMs: [0, 48 * 3_600_000],
  emergencyLossPctOfEquity: [0.005, 0.5],
  referenceRiskPct: [0.001, 0.1],
  stopSlippageBps: [0, 100],
  retryBaseMs: [1_000, 3_600_000],
  retryMaxMs: [1_000, 24 * 3_600_000],
}

/**
 * From the environment: ALPHA_PROTECTION = off | C1 | C2 | C3 (default off)
 * and ALPHA_PROTECTION_CONFIG, a JSON object of numeric fields. Anything else
 * is refused (throws), so a typo never runs a different experiment.
 */
export function loadExitConfig(env: Record<string, string | undefined> = process.env): ExitConfig {
  const config: ExitConfig = { ...DEFAULT_EXIT_CONFIG }
  const raw = (env.ALPHA_PROTECTION ?? 'off').trim()
  const mode = raw.toLowerCase() === 'off' ? 'off' : raw.toUpperCase()
  if (mode !== 'off' && mode !== 'C1' && mode !== 'C2' && mode !== 'C3') {
    throw new Error(`ALPHA_PROTECTION must be off, C1, C2 or C3, got ${raw}` + (raw === 'on' ? ' (the 007A mode "on" was replaced by C1/C2/C3)' : ''))
  }
  config.mode = mode
  const json = env.ALPHA_PROTECTION_CONFIG?.trim()
  if (json) {
    let given: unknown
    try {
      given = JSON.parse(json)
    } catch (e) {
      throw new Error(`ALPHA_PROTECTION_CONFIG is not valid JSON: ${e}`)
    }
    if (!given || typeof given !== 'object' || Array.isArray(given)) throw new Error('ALPHA_PROTECTION_CONFIG must be a JSON object')
    for (const [key, value] of Object.entries(given)) {
      const range = RANGES[key as keyof typeof RANGES]
      if (!range) throw new Error(`ALPHA_PROTECTION_CONFIG: unknown field ${key}`)
      if (typeof value !== 'number' || !Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new Error(`ALPHA_PROTECTION_CONFIG: ${key} must be a number in [${range[0]}, ${range[1]}], got ${JSON.stringify(value)}`)
      }
      ;(config as unknown as Record<string, number>)[key] = value
    }
  }
  if (!Number.isInteger(config.atrPeriod)) throw new Error('ALPHA_PROTECTION_CONFIG: atrPeriod must be an integer')
  if (config.retryMaxMs < config.retryBaseMs) throw new Error('ALPHA_PROTECTION_CONFIG: retryMaxMs must be >= retryBaseMs')
  return config
}

/** 'v2' sends the corrected position information to the AI (ALPHA_POSITION_INFO=v2); default 'v1' = original. */
export function positionInfoVersion(env: Record<string, string | undefined> = process.env): 'v1' | 'v2' {
  const v = (env.ALPHA_POSITION_INFO ?? 'v1').trim().toLowerCase()
  if (v !== 'v1' && v !== 'v2') throw new Error(`ALPHA_POSITION_INFO must be v1 or v2, got ${v}`)
  return v
}

// ---------------------------------------------------------------- ATR from 15 m bars

export interface Bar {
  openTime: number
  /** End time (exclusive) of the bar: openTime + its length. */
  endTime: number
  open: number
  high: number
  low: number
  close: number
}

export interface Bar15 {
  openTime: number
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

const HOUR = 3_600_000
const QUARTER = 900_000

/** 1 h bars from four aligned 15 m bars; an hour with a missing or invalid quarter is left out. */
export function hourBars(bars15: readonly Bar15[]): Bar[] {
  const byOpen = new Map(bars15.map((b) => [b.openTime, b]))
  const hours = [...new Set(bars15.map((b) => Math.floor(b.openTime / HOUR) * HOUR))].sort((a, b) => a - b)
  const out: Bar[] = []
  for (const h of hours) {
    const q = [0, 1, 2, 3].map((k) => byOpen.get(h + k * QUARTER))
    if (q.some((b) => !b || [b.open, b.high, b.low, b.close].some((x) => x === null || !Number.isFinite(x) || x <= 0))) continue
    out.push({
      openTime: h, endTime: h + HOUR, open: q[0]!.open!, close: q[3]!.close!,
      high: Math.max(...q.map((b) => b!.high!)), low: Math.min(...q.map((b) => b!.low!)),
    })
  }
  return out
}

export type AtrResult = { atr: number; asOf: number; bars: number } | { error: string }

/**
 * Wilder ATR(period) of the 1 h bars that ENDED at or before `asOfMs`
 * (information available at that moment), over the last contiguous run of
 * hours; at least period + 1 bars are needed.
 */
export function atrAt(bars15: readonly Bar15[], asOfMs: number, period = 14): AtrResult {
  return atrFromHourBars(hourBars(bars15), asOfMs, period)
}

/** Same, from 1 h bars directly. */
export function atrFromHourBars(hourly: readonly Bar[], asOfMs: number, period = 14): AtrResult {
  const hours = hourly.filter((b) => b.endTime <= asOfMs)
  // last contiguous run (a missing hour restarts the average)
  let start = hours.length - 1
  while (start > 0 && hours[start - 1]!.endTime === hours[start]!.openTime) start--
  const run = hours.slice(Math.max(0, start))
  if (run.length < period + 1) return { error: `${run.length} contiguous closed 1 h bars before ${new Date(asOfMs).toISOString()}, ${period + 1} needed` }
  const tr = run.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - run[i - 1]!.close), Math.abs(b.low - run[i - 1]!.close))))
  let atr = tr.slice(0, period).reduce((s, x) => s + x, 0) / period
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]!) / period
  return { atr, asOf: run.at(-1)!.endTime, bars: run.length }
}

// ---------------------------------------------------------------- plan and decisions

export interface ExitPlan {
  mode: ExitMode
  side: Side
  /** Average entry price the plan was built on. */
  entry: number
  atr: number
  /** End of the last 1 h bar used for the ATR. */
  atrAsOf: number
  stopPrice: number
  /** R in price: distance entry -> stop. */
  riskPrice: number
  trailDistance: number
  takeProfitPrice: number | null
  partialPrice: number | null
  partialFraction: number
}

export type PartialState = 'pending' | 'done' | 'skipped' | 'n/a'

export interface ExitState {
  /** Best price seen since the plan started (highest for LONG, lowest for SHORT). */
  best: number
  partial: PartialState
}

export function createPlan(mode: ExitMode, side: Side, entry: number, atr: number, atrAsOf: number, config: ExitConfig): ExitPlan {
  const s = side === 'LONG' ? 1 : -1
  const riskPrice = config.stopAtr * atr
  return {
    mode, side, entry, atr, atrAsOf,
    stopPrice: entry - s * riskPrice,
    riskPrice,
    trailDistance: config.trailAtr * atr,
    takeProfitPrice: mode === 'C3' ? entry + s * config.takeProfitR * riskPrice : null,
    partialPrice: mode === 'C2' ? entry + s * config.partialAtR * riskPrice : null,
    partialFraction: mode === 'C2' ? config.partialFraction : 0,
  }
}

export function initialExitState(plan: ExitPlan): ExitState {
  return { best: plan.entry, partial: plan.mode === 'C2' ? 'pending' : 'n/a' }
}

export type LevelKind = 'stop' | 'breakeven' | 'trailing'

/** The exit level in force, from the best price known so far. */
export function activeLevel(plan: ExitPlan, state: ExitState): { price: number; kind: LevelKind } {
  const s = plan.side === 'LONG' ? 1 : -1
  const candidates: { price: number; kind: LevelKind }[] = [{ price: plan.stopPrice, kind: 'stop' }]
  const trailing = state.best - s * plan.trailDistance
  if (plan.mode === 'C1') candidates.push({ price: trailing, kind: 'trailing' })
  if (plan.mode === 'C2' && (state.partial === 'done' || state.partial === 'skipped')) {
    candidates.push({ price: plan.entry, kind: 'breakeven' }, { price: trailing, kind: 'trailing' })
  }
  // the most protective level: highest for a LONG, lowest for a SHORT (ties keep the first: stop, break-even, trailing)
  return candidates.reduce((a, b) => (s * b.price > s * a.price ? b : a))
}

export type ExitKind = 'exit_stop' | 'exit_breakeven' | 'exit_trailing' | 'exit_take_profit' | 'partial_take_profit'

export interface ExitDecision {
  action: 'hold' | 'exit' | 'partial'
  kind?: ExitKind
  /** Price level that triggered (or would trigger). */
  level: number
  levelKind: LevelKind
  /** Fraction of the open quantity to close: 1 for an exit, partialFraction for a partial. */
  fraction: number
  reason: string
}

const px = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toFixed(6))

/**
 * Decision at one price (the mark), with the best price known BEFORE it; the
 * caller then calls updateBest. Exits are checked before targets.
 */
export function decide(plan: ExitPlan, state: ExitState, price: number): ExitDecision {
  const s = plan.side === 'LONG' ? 1 : -1
  const lvl = activeLevel(plan, state)
  if (s * (price - lvl.price) <= 0) {
    const kind: ExitKind = lvl.kind === 'stop' ? 'exit_stop' : lvl.kind === 'breakeven' ? 'exit_breakeven' : 'exit_trailing'
    const what = lvl.kind === 'stop' ? `initial stop ${px(plan.stopPrice)} (entry ${px(plan.entry)} ${s > 0 ? '-' : '+'} ${plan.riskPrice / plan.atr} ATR)`
      : lvl.kind === 'breakeven' ? `break-even ${px(plan.entry)} after the partial`
        : `chandelier ${px(lvl.price)} = best ${px(state.best)} ${s > 0 ? '-' : '+'} ${plan.trailDistance / plan.atr} ATR`
    return { action: 'exit', kind, level: lvl.price, levelKind: lvl.kind, fraction: 1, reason: `${plan.mode} ${kind}: price ${px(price)} reached the ${what}` }
  }
  if (plan.takeProfitPrice !== null && s * (price - plan.takeProfitPrice) >= 0) {
    return { action: 'exit', kind: 'exit_take_profit', level: plan.takeProfitPrice, levelKind: lvl.kind, fraction: 1,
      reason: `${plan.mode} exit_take_profit: price ${px(price)} reached the take profit ${px(plan.takeProfitPrice)} (+${(s * (plan.takeProfitPrice - plan.entry) / plan.riskPrice).toFixed(2)} R)` }
  }
  if (plan.partialPrice !== null && state.partial === 'pending' && s * (price - plan.partialPrice) >= 0) {
    return { action: 'partial', kind: 'partial_take_profit', level: plan.partialPrice, levelKind: lvl.kind, fraction: plan.partialFraction,
      reason: `${plan.mode} partial_take_profit: price ${px(price)} reached +${(s * (plan.partialPrice - plan.entry) / plan.riskPrice).toFixed(2)} R (${px(plan.partialPrice)}): realizing ${plan.partialFraction * 100}%` }
  }
  return { action: 'hold', level: lvl.price, levelKind: lvl.kind, fraction: 0, reason: `${plan.mode} hold: price ${px(price)}, ${lvl.kind} level ${px(lvl.price)}` }
}

export function updateBest(plan: ExitPlan, state: ExitState, price: number): ExitState {
  const best = plan.side === 'LONG' ? Math.max(state.best, price) : Math.min(state.best, price)
  return best === state.best ? state : { ...state, best }
}

// ---------------------------------------------------------------- risk on the capital

export interface RiskAssessment {
  /** Loss if the initial stop is hit: price move + fees + estimated slippage beyond the stop, USDC. */
  riskUsdc: number
  /** riskUsdc / account value without unrealized P&L. */
  riskPct: number
  /** Whether the position fits each profile (0.5%, 1%, 2%). */
  fits: Record<string, boolean>
  /** Above the reference risk (1%): the size chosen by the AI is larger than the reference allows. */
  oversized: boolean
  /** Largest notional at this stop distance that the reference risk allows. */
  referenceNotional: number
  notional: number
  note: string
}

export function assessRisk(input: {
  plan: ExitPlan; quantity: number; feesPaid: number; exitFeeRate: number; equityBase: number; config: ExitConfig
}): RiskAssessment {
  const { plan, quantity, feesPaid, exitFeeRate, equityBase, config } = input
  const slip = config.stopSlippageBps / 1e4
  const stopFill = plan.side === 'LONG' ? plan.stopPrice * (1 - slip) : plan.stopPrice * (1 + slip)
  const move = quantity * Math.abs(plan.entry - stopFill)
  const riskUsdc = move + feesPaid + quantity * stopFill * exitFeeRate
  const riskPct = equityBase > 0 ? riskUsdc / equityBase : Number.POSITIVE_INFINITY
  const perUnit = Math.abs(plan.entry - stopFill) + plan.entry * exitFeeRate * 2
  const referenceNotional = perUnit > 0 ? ((config.referenceRiskPct * equityBase) / perUnit) * plan.entry : 0
  const fits = Object.fromEntries(RISK_PROFILES.map((p) => [`${p * 100}%`, riskPct <= p]))
  const oversized = riskPct > config.referenceRiskPct
  return {
    riskUsdc, riskPct, fits, oversized, referenceNotional, notional: quantity * plan.entry,
    note: oversized
      ? `oversized: ${(riskPct * 100).toFixed(2)}% of the account at the stop, above the ${config.referenceRiskPct * 100}% reference; ` +
        `the reference allows about ${referenceNotional.toFixed(0)} USDC of notional, the AI chose ${(quantity * plan.entry).toFixed(0)}. ` +
        'Sizing is unchanged in this experiment: the stop stays at the ATR distance, the account emergency control stays separate'
      : `${(riskPct * 100).toFixed(2)}% of the account at the stop, within the ${config.referenceRiskPct * 100}% reference`,
  }
}

/** Delay before the next attempt after `failures` consecutive failed exits. */
export function retryDelay(failures: number, config: ExitConfig): number {
  return Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.max(0, failures - 1))
}

// ---------------------------------------------------------------- position lifecycle from fills

export interface Lifecycle {
  /** ms since epoch of the first fill of the position now open; null when flat. */
  openedAt: number | null
  /** Fees paid on this position: opens, additions, partial closes. */
  feesPaid: number
  /** Realized P&L (gross) of its partial closes. */
  realizedGross: number
  quantity: number
  side: Side | null
  /** Average entry price of the quantity still open. */
  avgCost: number
  /** Margin posted for the quantity still open; NaN when a fill carries no leverage. */
  margin: number
  /** Quantity added after the first fill (opens on an already open position). */
  additions: number
}

export interface FillRow {
  side: string
  price: number
  quantity: number
  commission: number
  ms: number
  /** Leverage of an opening fill (from its order); needed only for `margin`. */
  leverage?: number
}

/**
 * Folds the fills of one coin, oldest first, into the position now open.
 * A close that brings the quantity to zero starts over, so a reopened row is
 * a new position (as in the engine, which resets side and margin).
 */
export function foldLifecycle(fills: FillRow[]): Lifecycle {
  let qty = 0, avg = 0, fees = 0, realized = 0, margin = 0, additions = 0
  let openedAt: number | null = null
  let side: Side | null = null
  for (const t of fills) {
    if (t.side === 'LONG' || t.side === 'SHORT') {
      if (qty <= 1e-9) {
        qty = 0; avg = 0; openedAt = t.ms; fees = 0; realized = 0; margin = 0; additions = 0
      } else {
        additions++
      }
      avg = (avg * qty + t.price * t.quantity) / (qty + t.quantity)
      qty = Number((qty + t.quantity).toFixed(6))
      fees += t.commission
      side = t.side
      margin += t.leverage && t.leverage > 0 ? (t.price * t.quantity) / t.leverage : Number.NaN
    } else if ((t.side === 'SELL' || t.side === 'BUY') && qty > 1e-9) {
      // SELL closes a LONG, BUY a SHORT
      realized += (t.side === 'SELL' ? t.price - avg : avg - t.price) * t.quantity
      fees += t.commission
      const before = qty
      qty = Number((qty - t.quantity).toFixed(6))
      margin *= qty > 1e-9 ? qty / before : 0 // released pro rata, as the engine does
      if (qty <= 1e-9) { qty = 0; avg = 0; openedAt = null; fees = 0; realized = 0; side = null; margin = 0; additions = 0 }
    }
  }
  const open = qty > 1e-9
  return {
    openedAt: open ? openedAt : null, feesPaid: fees, realizedGross: realized, quantity: qty,
    side: open ? side : null, avgCost: open ? avg : 0, margin: open ? margin : 0, additions: open ? additions : 0,
  }
}

export interface NetInput {
  side: Side
  quantity: number
  avgCost: number
  price: number
  realizedGross: number
  feesPaid: number
  fundingNet: number
  exitFeeRate: number
}

/** Net result of a position if closed at `price`: unrealized + realized partials - fees - exit fee + funding (spread not included). */
export function netResult(input: NetInput): { unrealized: number; exitFee: number; net: number } {
  const unrealized = input.side === 'LONG'
    ? input.quantity * (input.price - input.avgCost)
    : input.quantity * (input.avgCost - input.price)
  const exitFee = input.quantity * input.price * input.exitFeeRate
  return { unrealized, exitFee, net: unrealized + input.realizedGross - input.feesPaid - exitFee + input.fundingNet }
}
