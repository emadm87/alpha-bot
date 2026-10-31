/**
 * The exit rules of exitRules.ts applied to a price path of bars (Task 007C):
 * used by the research simulation and by the chronological replay. Pure.
 *
 * In each bar the level in force comes from the best price of the bars
 * BEFORE it. The adverse extreme is checked first (if the stop and a target
 * are both touched in one bar, the stop is assumed first: conservative); a
 * gap through a level fills at the bar's open. A partial in a bar starts the
 * break-even and the trailing stop from the next bar. Without an exit the
 * position closes at the last bar's close (time exit).
 *
 * Costs, as fractions of the notional: the entry fee (given by the caller,
 * because the replay knows the real one), the taker fee of every exit, the
 * half spread of every exit, a slippage beyond the level on stop, break-even
 * and trailing exits, and the hourly funding while the position is open
 * (LONG pays a positive rate, SHORT receives it).
 */
import { activeLevel, initialExitState, updateBest, type Bar, type ExitPlan, type ExitState, type LevelKind } from './exitRules.js'

export interface PathCosts {
  /** Entry fee as a fraction of the entry notional. */
  entryFeeFraction: number
  exitFeeRate: number
  /** Half spread paid on each exit, fraction of the price. */
  halfSpread: number
  /** Extra slippage on stop-type exits, fraction of the price. */
  stopSlippage: number
  /** Hourly funding rate for the funding hour starting at `hourMs`. */
  fundingRate: (hourMs: number) => number
}

export interface PathLeg {
  fraction: number
  price: number
  kind: 'exit_stop' | 'exit_breakeven' | 'exit_trailing' | 'exit_take_profit' | 'partial_take_profit' | 'time_exit'
  bar: number
  time: number
}

export interface PathResult {
  legs: PathLeg[]
  /** Price result in R, before costs. */
  grossR: number
  costR: number
  netR: number
  /** Net result in basis points of the entry notional. */
  netBps: number
  costBps: number
  exitTime: number
  /** Best excursion seen, in R. */
  mfeR: number
  /** A bar touched both the exit level and a target: the stop was assumed first. */
  ambiguous: boolean
  /** Initial stop hit, and the price later reached +1 R inside the path (premature stop). */
  premature: boolean
  barsHeld: number
}

const LEVEL_KIND: Record<LevelKind, PathLeg['kind']> = { stop: 'exit_stop', breakeven: 'exit_breakeven', trailing: 'exit_trailing' }

export function simulatePath(plan: ExitPlan, bars: readonly Bar[], entryTime: number, costs: PathCosts): PathResult {
  const s = plan.side === 'LONG' ? 1 : -1
  let state: ExitState = initialExitState(plan)
  let remaining = 1
  const legs: PathLeg[] = []
  let ambiguous = false
  let mfe = 0
  let lastBar = bars.length - 1
  for (let j = 0; j < bars.length && remaining > 1e-12; j++) {
    const b = bars[j]!
    const adverse = s > 0 ? b.low : b.high
    const favorable = s > 0 ? b.high : b.low
    const lvl = activeLevel(plan, state)
    const tpHit = plan.takeProfitPrice !== null && s * (favorable - plan.takeProfitPrice) >= 0
    const partialHit = plan.partialPrice !== null && state.partial === 'pending' && s * (favorable - plan.partialPrice) >= 0
    if (s * (adverse - lvl.price) <= 0) {
      if (tpHit || partialHit) ambiguous = true
      const price = s * (b.open - lvl.price) <= 0 ? b.open : lvl.price
      legs.push({ fraction: remaining, price, kind: LEVEL_KIND[lvl.kind], bar: j, time: b.endTime })
      remaining = 0
      lastBar = j
      break
    }
    if (tpHit) {
      const price = s * (b.open - plan.takeProfitPrice!) >= 0 ? b.open : plan.takeProfitPrice!
      legs.push({ fraction: remaining, price, kind: 'exit_take_profit', bar: j, time: b.endTime })
      remaining = 0
      lastBar = j
      break
    }
    if (partialHit) {
      const price = s * (b.open - plan.partialPrice!) >= 0 ? b.open : plan.partialPrice!
      const fraction = Math.min(remaining, plan.partialFraction)
      legs.push({ fraction, price, kind: 'partial_take_profit', bar: j, time: b.endTime })
      remaining -= fraction
      state = { ...state, partial: 'done' }
    }
    mfe = Math.max(mfe, (s * (favorable - plan.entry)) / plan.riskPrice)
    state = updateBest(plan, state, favorable)
  }
  if (remaining > 1e-12 && bars.length) {
    const last = bars[bars.length - 1]!
    legs.push({ fraction: remaining, price: last.close, kind: 'time_exit', bar: bars.length - 1, time: last.endTime })
    lastBar = bars.length - 1
  }
  const exitTime = legs.length ? Math.max(...legs.map((l) => l.time)) : entryTime
  const grossFrac = legs.reduce((sum, l) => sum + l.fraction * s * (l.price - plan.entry), 0) / plan.entry
  // costs as a fraction of the entry notional
  let cost = costs.entryFeeFraction
  for (const l of legs) {
    cost += l.fraction * (l.price / plan.entry) * (costs.exitFeeRate + costs.halfSpread)
    if (l.kind === 'exit_stop' || l.kind === 'exit_breakeven' || l.kind === 'exit_trailing') cost += l.fraction * costs.stopSlippage
  }
  // funding at every hour boundary crossed while (part of) the position was open
  for (let h = Math.floor(entryTime / 3_600_000) * 3_600_000 + 3_600_000; h <= exitTime; h += 3_600_000) {
    const open = legs.filter((l) => l.time > h).reduce((sum, l) => sum + l.fraction, 0)
    cost += s * costs.fundingRate(h) * open
  }
  const toR = plan.entry / plan.riskPrice
  const premature = legs.length === 1 && legs[0]!.kind === 'exit_stop' &&
    bars.slice(legs[0]!.bar + 1).some((b) => s * ((s > 0 ? b.high : b.low) - plan.entry) >= plan.riskPrice)
  return {
    legs, grossR: grossFrac * toR, costR: cost * toR, netR: (grossFrac - cost) * toR,
    netBps: (grossFrac - cost) * 1e4, costBps: cost * 1e4, exitTime, mfeR: mfe, ambiguous, premature, barsHeld: lastBar + 1,
  }
}
