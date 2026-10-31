/**
 * The exit rules on a path of bars (Task 007C): ordering inside a bar, gaps,
 * partials, time exits, costs and funding.
 *
 * Run: npx tsx --test src/services/exitPathSim.test.ts
 *
 * Plan: entry 100, ATR 1 -> stop 98 (LONG) / 102 (SHORT), R = 2, chandelier 3.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlan, DEFAULT_EXIT_CONFIG, type Bar, type ExitMode, type Side } from './exitRules.js'
import { simulatePath, type PathCosts } from './exitPathSim.js'

const Q = 900_000
const T0 = Date.UTC(2026, 9, 1, 12)
const noCost: PathCosts = { entryFeeFraction: 0, exitFeeRate: 0, halfSpread: 0, stopSlippage: 0, fundingRate: () => 0 }
const bars = (rows: [number, number, number, number][]): Bar[] =>
  rows.map(([o, h, l, c], i) => ({ openTime: T0 + i * Q, endTime: T0 + (i + 1) * Q, open: o, high: h, low: l, close: c }))
const plan = (mode: ExitMode, side: Side = 'LONG') => createPlan(mode, side, 100, 1, T0, { ...DEFAULT_EXIT_CONFIG, mode })
const near = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)

test('1. stop first when one bar touches the stop and the target; flagged ambiguous', () => {
  const r = simulatePath(plan('C3'), bars([[100, 104.5, 97.5, 100]]), T0, noCost)
  assert.equal(r.legs[0]!.kind, 'exit_stop')
  assert.equal(r.legs[0]!.price, 98)
  assert.equal(r.ambiguous, true)
  near(r.grossR, -1, 'one R lost')
})

test('2. gaps fill at the open: through the stop (worse) and through the target (better)', () => {
  const s = simulatePath(plan('C1'), bars([[100, 101, 99, 100], [97, 97.5, 96, 97]]), T0, noCost)
  assert.equal(s.legs[0]!.price, 97)
  near(s.grossR, -1.5, 'gap loss')
  const t = simulatePath(plan('C3'), bars([[100, 101, 99, 100], [105, 106, 104.5, 105]]), T0, noCost)
  assert.equal(t.legs[0]!.kind, 'exit_take_profit')
  assert.equal(t.legs[0]!.price, 105)
})

test('3. C1 trailing from the best price of the bars before; time exit at the last close', () => {
  // bar 0 high 105 -> from bar 1 the chandelier is 102; bar 1 low 101.9 -> exit at 102
  const r = simulatePath(plan('C1'), bars([[100, 105, 99.5, 104], [104, 104.5, 101.9, 102]]), T0, noCost)
  assert.equal(r.legs[0]!.kind, 'exit_trailing')
  assert.equal(r.legs[0]!.price, 102)
  near(r.grossR, 1, '+2 on a 2 risk')
  near(r.mfeR, 2.5, 'best excursion')
  const time = simulatePath(plan('C1'), bars([[100, 100.5, 99.5, 100.2], [100.2, 100.6, 99.9, 100.4]]), T0, noCost)
  assert.equal(time.legs[0]!.kind, 'time_exit')
  assert.equal(time.legs[0]!.price, 100.4)
})

test('4. C2: 25% at +1.5R (103), the break-even and the chandelier start from the next bar', () => {
  // bar 0 high 103 -> best 103, chandelier 100 = break-even (a tie keeps the break-even)
  const r = simulatePath(plan('C2'), bars([[100, 103, 99.5, 103], [103, 103.4, 99.9, 100]]), T0, noCost)
  assert.deepEqual(r.legs.map((l) => [l.kind, l.fraction, l.price]), [['partial_take_profit', 0.25, 103], ['exit_breakeven', 0.75, 100]])
  near(r.grossR, 0.25 * 1.5, 'partial only: the rest at break-even')
  // a higher high in the bar of the partial lifts the chandelier above the break-even
  const t = simulatePath(plan('C2'), bars([[100, 103.2, 99.5, 103], [103, 103.4, 99.9, 100]]), T0, noCost)
  assert.deepEqual(t.legs.map((l) => [l.kind, l.price]), [['partial_take_profit', 103], ['exit_trailing', 100.2]])
  // same bar: no break-even inside the bar of the partial (low 99.9 in bar 0 does not close the rest)
  const same = simulatePath(plan('C2'), bars([[100, 103.2, 99.9, 101], [101, 101.5, 100.5, 101]]), T0, noCost)
  assert.equal(same.legs.at(-1)!.kind, 'time_exit')
})

test('5. SHORT mirrors LONG', () => {
  const r = simulatePath(plan('C3', 'SHORT'), bars([[100, 101, 95.5, 96]]), T0, noCost)
  assert.equal(r.legs[0]!.kind, 'exit_take_profit')
  assert.equal(r.legs[0]!.price, 96)
  near(r.grossR, 2, '+2R')
  const s = simulatePath(plan('C1', 'SHORT'), bars([[100, 102.5, 99.5, 102]]), T0, noCost)
  assert.equal(s.legs[0]!.kind, 'exit_stop')
  assert.equal(s.legs[0]!.price, 102)
})

test('6. costs: fees on each leg, exit half spread, slippage only on stop-type exits, funding sign', () => {
  const c: PathCosts = { entryFeeFraction: 0.00045, exitFeeRate: 0.00045, halfSpread: 0.0001, stopSlippage: 0.0002, fundingRate: () => 0.0001 }
  // stop at 98 after 4 bars (one hour boundary crossed): fee 4.5 bp + exit (98/100) x (4.5 + 1) bp + slippage 2 bp + funding 1 bp (LONG pays)
  const path = bars([[100, 100.5, 99.5, 100], [100, 100.5, 99.5, 100], [100, 100.5, 99.5, 100], [100, 100.5, 99.5, 100], [100, 100, 97.9, 98]])
  const r = simulatePath(plan('C1'), path, T0 + 1, c)
  const expected = 0.00045 + 0.98 * (0.00045 + 0.0001) + 0.0002 + 0.0001
  near(r.costBps, expected * 1e4, 'cost bps', 1e-6)
  near(r.netBps, (-0.02 - expected) * 1e4, 'net bps', 1e-6)
  // a SHORT receives the same positive rate
  const short = simulatePath(plan('C1', 'SHORT'), path.map((b) => ({ ...b, high: 200 - b.low, low: 200 - b.high, open: 200 - b.open, close: 200 - b.close })).map((b) => ({ ...b, open: b.open - 100, high: b.high - 100, low: b.low - 100, close: b.close - 100 })), T0 + 1, c)
  assert.ok(short.costBps < r.costBps, 'funding received by the SHORT')
  // a take profit has no stop slippage
  const tp = simulatePath(plan('C3'), bars([[100, 104.2, 99.9, 104]]), T0 + 1, { ...c, fundingRate: () => 0 })
  near(tp.costBps, (0.00045 + 1.04 * (0.00045 + 0.0001)) * 1e4, 'take profit costs', 1e-6)
})

test('7. premature stop: the stop was hit and the price later reached +1R', () => {
  const r = simulatePath(plan('C1'), bars([[100, 100.5, 97.9, 98], [98, 102.1, 98, 102]]), T0, noCost)
  assert.equal(r.premature, true)
  assert.equal(simulatePath(plan('C1'), bars([[100, 100.5, 97.9, 98], [98, 101.5, 98, 101]]), T0, noCost).premature, false)
})

test('8. deterministic', () => {
  const p = bars([[100, 103.2, 99.5, 103], [103, 104, 101, 102], [102, 102.5, 100.5, 101]])
  assert.deepEqual(simulatePath(plan('C2'), p, T0, noCost), simulatePath(plan('C2'), p, T0, noCost))
})
