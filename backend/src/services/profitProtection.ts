/**
 * Profit protection and dynamic risk management (Task 007A, experimental).
 *
 * Pure rules, no database, no clock, no network: the same code runs live
 * (positionProtection.ts) and in the chronological replay
 * (protectionReplay.ts), and a decision depends only on the position, the
 * mark price and the state kept up to that moment.
 *
 * Gemini stays responsible for every trading decision. This module only
 * intervenes to close (all or part of) a position that is already open, in
 * two explainable cases:
 *
 *   risk exit              the net result fell to the position's loss limit,
 *                          which no profit had yet lifted;
 *   profit protection exit the net result fell back to a floor that the
 *                          position's own profit had raised.
 *
 * Unit: R, the loss the position is allowed, in USDC:
 *   R = min(maxLossPctOfEquity * account value at open,
 *           maxLossFractionOfMargin * margin posted)
 * Everything below is a multiple of R, so no price level, coin or leverage
 * is hard-coded. Net result = unrealized P&L at the mark + realized P&L of
 * earlier partial closes - fees paid - estimated exit fee + settled funding.
 * Spread and book depth of the exit are NOT in it (the real exit fills
 * against the l2Book and can be worse).
 *
 *   stage 0   floor = -R                        (risk exit)
 *   stage 1   floor = 0, once peak >= breakEvenArmR * R
 *                                                (profit protection exit)
 *   stage 2   floor = peak * (1 - giveBackFraction), once peak >= trailArmR * R
 *                                                (profit protection exit)
 *
 * The stage never goes back down; the peak (high-water mark of the net
 * result) never goes down except after a partial exit, which restarts it
 * from the current net result so the floor does not fire again at once.
 *
 * The default numbers are conventional a-priori values (a 1-2% account risk
 * per position, break-even at +1R, trailing from +2R giving back half). They
 * were NOT fitted to any recorded trade: they are hypotheses the experiment
 * has to confirm or reject, and every one can be changed with
 * ALPHA_PROTECTION_CONFIG (JSON) without touching the code.
 */

export interface ProtectionConfig {
  /** Master switch (ALPHA_PROTECTION=on). */
  enabled: boolean
  /** Loss allowed per position as a fraction of the account value at open. */
  maxLossPctOfEquity: number
  /** ... and as a fraction of the margin posted: R is the smaller of the two. */
  maxLossFractionOfMargin: number
  /** Peak net result (in R) that lifts the floor to break-even. */
  breakEvenArmR: number
  /** Peak net result (in R) from which the floor trails the peak. */
  trailArmR: number
  /** Fraction of the peak profit that may be given back once trailing. */
  giveBackFraction: number
  /**
   * Fraction of the remaining quantity closed when the trailing floor (stage
   * 2) is hit and the net result is still positive; 1 = close all. The risk
   * and break-even exits always close everything: a partial close would
   * leave the rest below the same floor.
   */
  trailExitFraction: number
  /** Minimum time between two exit attempts of the same position (ms). */
  retryAfterMs: number
}

export const DEFAULT_PROTECTION_CONFIG: ProtectionConfig = {
  enabled: false,
  maxLossPctOfEquity: 0.02,
  maxLossFractionOfMargin: 0.5,
  breakEvenArmR: 1,
  trailArmR: 2,
  giveBackFraction: 0.5,
  trailExitFraction: 1,
  retryAfterMs: 15_000,
}

const RANGES: Record<Exclude<keyof ProtectionConfig, 'enabled'>, [number, number]> = {
  maxLossPctOfEquity: [0.001, 0.5],
  maxLossFractionOfMargin: [0.05, 1],
  breakEvenArmR: [0.1, 20],
  trailArmR: [0.1, 50],
  giveBackFraction: [0.05, 0.95],
  trailExitFraction: [0.05, 1],
  retryAfterMs: [1_000, 3_600_000],
}

/**
 * Configuration from the environment: ALPHA_PROTECTION=on|off (default off)
 * and ALPHA_PROTECTION_CONFIG, a JSON object with any of the numeric fields.
 * Unknown fields, non-numbers and values out of range are refused (throws),
 * so a typo can never silently run a different experiment.
 */
export function loadProtectionConfig(env: Record<string, string | undefined> = process.env): ProtectionConfig {
  const config: ProtectionConfig = { ...DEFAULT_PROTECTION_CONFIG }
  const mode = (env.ALPHA_PROTECTION ?? 'off').trim().toLowerCase()
  if (mode !== 'on' && mode !== 'off') throw new Error(`ALPHA_PROTECTION must be on or off, got ${mode}`)
  config.enabled = mode === 'on'
  const raw = env.ALPHA_PROTECTION_CONFIG?.trim()
  if (raw) {
    let given: unknown
    try {
      given = JSON.parse(raw)
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
  if (config.trailArmR < config.breakEvenArmR) throw new Error('ALPHA_PROTECTION_CONFIG: trailArmR must be >= breakEvenArmR')
  return config
}

/** 'v2' sends the corrected position information to the AI (ALPHA_POSITION_INFO=v2); default 'v1' = original. */
export function positionInfoVersion(env: Record<string, string | undefined> = process.env): 'v1' | 'v2' {
  const v = (env.ALPHA_POSITION_INFO ?? 'v1').trim().toLowerCase()
  if (v !== 'v1' && v !== 'v2') throw new Error(`ALPHA_POSITION_INFO must be v1 or v2, got ${v}`)
  return v
}

export type Side = 'LONG' | 'SHORT'

/** What the rules need to know about an open position at one moment. */
export interface ProtectionInput {
  side: Side
  /** Quantity still open. */
  quantity: number
  avgCost: number
  /** Valid, fresh price of the position's valuation (the mark price). */
  price: number
  /** Margin posted for the quantity still open. */
  margin: number
  /** Account value without unrealized P&L (cash + posted margin): the base of the risk limit. */
  equityBase: number
  /** Realized P&L (gross) of earlier partial closes of this position. */
  realizedGross: number
  /** Fees paid so far on this position (open, additions, partial closes). */
  feesPaid: number
  /** Funding settled on this position so far (+ received, - paid). */
  fundingNet: number
  /** Taker fee rate of the account's cost model, for the estimated exit. */
  exitFeeRate: number
}

export interface ProtectionState {
  /** 0 initial, 1 break-even lock, 2 trailing. */
  stage: 0 | 1 | 2
  /** R: loss allowed, USDC. */
  riskUsdc: number
  /** High-water mark of the net result, USDC. */
  peakNet: number
  /** Partial exits done so far. */
  partialExits: number
}

export interface NetResult {
  unrealized: number
  exitFee: number
  net: number
}

export function netResult(input: ProtectionInput): NetResult {
  const unrealized =
    input.side === 'LONG'
      ? input.quantity * (input.price - input.avgCost)
      : input.quantity * (input.avgCost - input.price)
  const exitFee = input.quantity * input.price * input.exitFeeRate
  return {
    unrealized,
    exitFee,
    net: unrealized + input.realizedGross - input.feesPaid - exitFee + input.fundingNet,
  }
}

/** R of a position: the smaller of the account-risk limit and the margin-based limit. */
export function riskUnit(input: Pick<ProtectionInput, 'equityBase' | 'margin'>, config: ProtectionConfig): number {
  return Math.min(config.maxLossPctOfEquity * input.equityBase, config.maxLossFractionOfMargin * input.margin)
}

export function initialState(input: ProtectionInput, config: ProtectionConfig): ProtectionState {
  const net = netResult(input).net
  return {
    stage: 0,
    riskUsdc: riskUnit(input, config),
    peakNet: Math.max(0, net),
    partialExits: 0,
  }
}

export function floorOf(state: ProtectionState, config: ProtectionConfig): number {
  if (state.stage === 2) return state.peakNet * (1 - config.giveBackFraction)
  if (state.stage === 1) return 0
  return -state.riskUsdc
}

export interface ProtectionDecision {
  action: 'hold' | 'exit'
  /** Set when action is 'exit'. */
  kind?: 'risk' | 'profit_protection'
  /** Fraction of the remaining quantity to close (1 = all). */
  fraction?: number
  /** Why, in words, with the numbers used. */
  reason: string
  net: number
  floor: number
  peakNet: number
  stage: 0 | 1 | 2
  riskUsdc: number
  /** net / R, 0 when R is not positive. */
  rMultiple: number
  /** Stage changes made by this evaluation. */
  transitions: ('breakeven_armed' | 'trailing_armed')[]
}

const f = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(4))

/**
 * One evaluation. Returns the new state and the decision; the caller stores
 * the state and, on 'exit', executes the close and calls `afterExit`.
 * A position whose R is not positive (no equity, no margin) is never acted on
 * and is reported as such.
 */
export function evaluate(
  prev: ProtectionState,
  input: ProtectionInput,
  config: ProtectionConfig,
): { state: ProtectionState; decision: ProtectionDecision } {
  const { net } = netResult(input)
  const state: ProtectionState = { ...prev, riskUsdc: Math.max(prev.riskUsdc, riskUnit(input, config)) }
  const R = state.riskUsdc
  const transitions: ProtectionDecision['transitions'] = []

  const base = (): Omit<ProtectionDecision, 'action' | 'reason'> => ({
    net, floor: floorOf(state, config), peakNet: state.peakNet, stage: state.stage,
    riskUsdc: R, rMultiple: R > 0 ? net / R : 0, transitions,
  })

  if (!(R > 0) || !Number.isFinite(net)) {
    return { state, decision: { ...base(), action: 'hold', reason: `no decision: risk unit R=${f(R)} or net result ${net} not usable` } }
  }

  if (net > state.peakNet) state.peakNet = net
  if (state.stage < 1 && state.peakNet >= config.breakEvenArmR * R) {
    state.stage = 1
    transitions.push('breakeven_armed')
  }
  if (state.stage < 2 && state.peakNet >= config.trailArmR * R) {
    state.stage = 2
    transitions.push('trailing_armed')
  }
  const floor = floorOf(state, config)
  const common = { net, floor, peakNet: state.peakNet, stage: state.stage, riskUsdc: R, rMultiple: net / R, transitions }

  if (net <= floor) {
    const risk = state.stage === 0
    const fraction = state.stage === 2 && net > 0 ? config.trailExitFraction : 1
    const reason = risk
      ? `risk exit: net result ${f(net)} USDC <= loss limit ${f(floor)} (R=${f(R)}); no profit had lifted the floor (peak ${f(state.peakNet)})`
      : state.stage === 1
        ? `profit protection exit: net result ${f(net)} USDC <= break-even floor 0 after a peak of ${f(state.peakNet)} (${f(state.peakNet / R)}R >= ${config.breakEvenArmR}R)`
        : `profit protection exit: net result ${f(net)} USDC <= trailing floor ${f(floor)} = peak ${f(state.peakNet)} x (1 - ${config.giveBackFraction}) (peak ${f(state.peakNet / R)}R >= ${config.trailArmR}R)`
    return { state, decision: { ...common, action: 'exit', kind: risk ? 'risk' : 'profit_protection', fraction, reason: reason + (fraction < 1 ? `; closing ${fraction * 100}% of the open quantity` : '') } }
  }
  return {
    state,
    decision: {
      ...common, action: 'hold',
      reason: `hold: net result ${f(net)} USDC (${f(net / R)}R) above floor ${f(floor)}; stage ${state.stage}, peak ${f(state.peakNet)}, R=${f(R)}`,
    },
  }
}

/**
 * State after a partial exit executed at `netNow` (> 0, a partial exit is only
 * made while the net result is positive): the peak restarts from there (the
 * stage stays 2), so the trailing floor, now below the net result, does not
 * fire again at once.
 */
export function afterPartialExit(state: ProtectionState, netNow: number): ProtectionState {
  return { ...state, peakNet: Math.max(0, netNow), partialExits: state.partialExits + 1 }
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
  let qty = 0
  let avg = 0
  let openedAt: number | null = null
  let fees = 0
  let realized = 0
  let side: Side | null = null
  let margin = 0
  for (const t of fills) {
    if (t.side === 'LONG' || t.side === 'SHORT') {
      if (qty <= 1e-9) {
        qty = 0; avg = 0; openedAt = t.ms; fees = 0; realized = 0; margin = 0
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
      if (qty <= 1e-9) { qty = 0; avg = 0; openedAt = null; fees = 0; realized = 0; side = null; margin = 0 }
    }
  }
  const open = qty > 1e-9
  return { openedAt: open ? openedAt : null, feesPaid: fees, realizedGross: realized, quantity: qty, side: open ? side : null, avgCost: open ? avg : 0, margin: open ? margin : 0 }
}

