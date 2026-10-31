/**
 * Pure rules of the profit protection module (Task 007A).
 *
 * Run: npx tsx --test src/services/profitProtection.test.ts
 *
 * No database, no clock, no network. Expected values are computed by hand
 * from the rules in profitProtection.ts: R = min(2% of the account value,
 * 50% of the margin); net result = unrealized + realized - fees - exit fee +
 * funding; floor -R (stage 0), 0 (stage 1, peak >= 1R), peak x 0.5 (stage 2,
 * peak >= 2R).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterPartialExit,
  DEFAULT_PROTECTION_CONFIG,
  evaluate,
  floorOf,
  initialState,
  loadProtectionConfig,
  netResult,
  positionInfoVersion,
  riskUnit,
  type ProtectionConfig,
  type ProtectionInput,
  type ProtectionState,
} from './profitProtection.js'

const cfg = (over: Partial<ProtectionConfig> = {}): ProtectionConfig => ({ ...DEFAULT_PROTECTION_CONFIG, enabled: true, ...over })
// 1000 USDC account, 100 USDC margin: R = min(0.02 * 1000, 0.5 * 100) = 20
const base = (over: Partial<ProtectionInput> = {}): ProtectionInput => ({
  side: 'LONG', quantity: 1, avgCost: 100, price: 100, margin: 100, equityBase: 1000,
  realizedGross: 0, feesPaid: 0, fundingNet: 0, exitFeeRate: 0, ...over,
})
const near = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
/** Runs the rules over a list of prices, feeding the state forward as the runtime does. */
function run(prices: number[], over: Partial<ProtectionInput> = {}, config = cfg()) {
  let state: ProtectionState = initialState(base({ ...over, price: prices[0]! }), config)
  return prices.map((price) => {
    const r = evaluate(state, base({ ...over, price }), config)
    state = r.state
    return r.decision
  })
}

test('1. configuration: off by default; ALPHA_PROTECTION and the JSON override; invalid values are refused', () => {
  assert.equal(loadProtectionConfig({}).enabled, false)
  assert.deepEqual({ ...loadProtectionConfig({}), enabled: true }, { ...DEFAULT_PROTECTION_CONFIG, enabled: true })
  const on = loadProtectionConfig({ ALPHA_PROTECTION: 'ON', ALPHA_PROTECTION_CONFIG: '{"giveBackFraction":0.3,"trailExitFraction":0.5}' })
  assert.equal(on.enabled, true)
  assert.equal(on.giveBackFraction, 0.3)
  assert.equal(on.trailExitFraction, 0.5)
  assert.equal(on.breakEvenArmR, 1, 'unlisted fields keep the default')
  for (const bad of [
    { ALPHA_PROTECTION: 'yes' },
    { ALPHA_PROTECTION_CONFIG: '{oops' },
    { ALPHA_PROTECTION_CONFIG: '[1]' },
    { ALPHA_PROTECTION_CONFIG: '{"typo":1}' },
    { ALPHA_PROTECTION_CONFIG: '{"giveBackFraction":"0.5"}' },
    { ALPHA_PROTECTION_CONFIG: '{"giveBackFraction":0.99}' },
    { ALPHA_PROTECTION_CONFIG: '{"maxLossPctOfEquity":0}' },
    { ALPHA_PROTECTION_CONFIG: '{"breakEvenArmR":3,"trailArmR":2}' },
  ]) assert.throws(() => loadProtectionConfig(bad), /ALPHA_PROTECTION/, JSON.stringify(bad))
  assert.equal(positionInfoVersion({}), 'v1')
  assert.equal(positionInfoVersion({ ALPHA_POSITION_INFO: 'V2' }), 'v2')
  assert.throws(() => positionInfoVersion({ ALPHA_POSITION_INFO: 'v3' }))
})

test('2. net result: unrealized, realized partials, fees, exit fee and funding, LONG and SHORT', () => {
  const long = netResult(base({ price: 110, realizedGross: 3, feesPaid: 0.5, fundingNet: -0.2, exitFeeRate: 0.00045 }))
  near(long.unrealized, 10, 'LONG unrealized')
  near(long.exitFee, 110 * 0.00045, 'exit fee')
  near(long.net, 10 + 3 - 0.5 - 110 * 0.00045 - 0.2, 'LONG net')
  const short = netResult(base({ side: 'SHORT', price: 90, exitFeeRate: 0 }))
  near(short.unrealized, 10, 'SHORT unrealized')
  near(netResult(base({ side: 'SHORT', price: 110 })).unrealized, -10, 'SHORT loses when the price rises')
  near(netResult(base({ quantity: 0.5, price: 120 })).unrealized, 10, 'quantity still open')
})

test('3. R: the smaller of the account limit and the margin limit; never from a price', () => {
  near(riskUnit({ equityBase: 1000, margin: 100 }, cfg()), 20, 'account limit')
  near(riskUnit({ equityBase: 1000, margin: 10 }, cfg()), 5, 'margin limit')
  near(riskUnit({ equityBase: 5000, margin: 100 }, cfg()), 50, 'margin limit when the account is large')
  near(riskUnit({ equityBase: 1000, margin: 100 }, cfg({ maxLossPctOfEquity: 0.05 })), 50, 'configured')
})

test('4. stage 0: hold above -R, risk exit at -R (LONG and SHORT symmetric)', () => {
  for (const side of ['LONG', 'SHORT'] as const) {
    const sign = side === 'LONG' ? 1 : -1
    const at = (pnl: number) => 100 + sign * pnl // price giving that unrealized P&L at quantity 1
    const d = run([at(0), at(-10), at(-19.9), at(-20)], { side })
    assert.deepEqual(d.map((x) => x.action), ['hold', 'hold', 'hold', 'exit'], side)
    const exit = d[3]!
    assert.equal(exit.kind, 'risk')
    assert.equal(exit.fraction, 1)
    assert.equal(exit.stage, 0)
    near(exit.floor, -20, 'floor')
    near(exit.rMultiple, -1, 'R multiple')
    assert.match(exit.reason, /^risk exit: net result -20\.0000 USDC <= loss limit -20\.0000 \(R=20\.0000\)/)
  }
})

test('5. stage 1: after a +1R peak the floor is break-even; falling back is a profit protection exit, not a risk exit', () => {
  const d = run([100, 110, 120, 105, 99.9])
  assert.deepEqual(d.map((x) => x.stage), [0, 0, 1, 1, 1])
  assert.deepEqual(d.map((x) => x.action), ['hold', 'hold', 'hold', 'hold', 'exit'])
  assert.deepEqual(d[2]!.transitions, ['breakeven_armed'])
  const exit = d[4]!
  assert.equal(exit.kind, 'profit_protection')
  assert.equal(exit.fraction, 1)
  near(exit.floor, 0, 'break-even floor')
  assert.match(exit.reason, /^profit protection exit: .* break-even floor 0 after a peak of 20\.0000 \(1\.0000R >= 1R\)/)
  // a position that never reached +1R is stopped at -R, not at break-even
  assert.equal(run([100, 119, 100, 80]).at(-1)!.kind, 'risk')
})

test('6. stage 2: trailing floor = peak x (1 - give back); the floor rises with the peak and never falls', () => {
  const d = run([100, 120, 140, 160, 150, 135, 129.9])
  assert.deepEqual(d.map((x) => x.stage), [0, 1, 2, 2, 2, 2, 2])
  assert.deepEqual(d[2]!.transitions, ['trailing_armed'])
  assert.deepEqual(d.map((x) => x.peakNet), [0, 20, 40, 60, 60, 60, 60])
  assert.deepEqual(d.slice(2).map((x) => x.floor), [20, 30, 30, 30, 30])
  assert.deepEqual(d.map((x) => x.action), ['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'exit'])
  const exit = d[6]!
  assert.equal(exit.kind, 'profit_protection')
  near(exit.net, 29.9, 'net at the exit')
  assert.match(exit.reason, /trailing floor 30\.0000 = peak 60\.0000 x \(1 - 0\.5\) \(peak 3\.0000R >= 2R\)/)
  // exactly at the floor exits too
  assert.equal(run([100, 120, 140, 160, 130]).at(-1)!.action, 'exit')
  // SHORT mirrors it
  const s = run([100, 80, 60, 40, 50, 70.1], { side: 'SHORT' })
  assert.equal(s.at(-1)!.action, 'exit')
  assert.equal(s.at(-2)!.action, 'hold')
})

test('7. the stage and the peak never go down by themselves; the decision depends only on the past (no look-ahead)', () => {
  const prices = [100, 112, 125, 141, 133, 150, 138, 120, 118, 140, 160, 90]
  const full = run(prices)
  for (let i = 1; i < full.length; i++) {
    assert.ok(full[i]!.stage >= full[i - 1]!.stage, `stage ${i}`)
    assert.ok(full[i]!.peakNet >= full[i - 1]!.peakNet, `peak ${i}`)
  }
  // feeding only the first k prices gives the same decisions as the full run: nothing later is used
  for (let k = 1; k <= prices.length; k++) assert.deepEqual(run(prices.slice(0, k)), full.slice(0, k), `prefix ${k}`)
  // deterministic: the same run twice is identical
  assert.deepEqual(run(prices), full)
  // the first exit is the first time net <= floor; hold decisions before it
  const first = full.findIndex((x) => x.action === 'exit')
  assert.ok(first > 0)
  assert.ok(full.slice(0, first).every((x) => x.action === 'hold'))
})

test('8. costs count: fees, exit fee and funding move the floor crossings', () => {
  // without costs a +20 move sits exactly at the break-even arming; with 2 USDC of fees it is 18 and does not arm
  assert.equal(run([100, 120]).at(-1)!.stage, 1)
  assert.equal(run([100, 120], { feesPaid: 2 }).at(-1)!.stage, 0)
  // funding paid pushes a flat position towards the loss limit
  const d = run([100, 100], { fundingNet: -19.9 })
  assert.equal(d.at(-1)!.action, 'hold')
  assert.equal(run([100, 100], { fundingNet: -20 }).at(-1)!.action, 'exit')
  // the estimated exit fee is deducted: net at price 100 with 1% exit fee is -1
  near(run([100], { exitFeeRate: 0.01 })[0]!.net, -1, 'exit fee')
})

test('9. partial exits: only the trailing floor, only while net > 0; the peak restarts so it does not fire again at once', () => {
  const half = cfg({ trailExitFraction: 0.5 })
  const d = run([100, 120, 140, 160, 129], {}, half)
  const exit = d.at(-1)!
  assert.equal(exit.action, 'exit')
  assert.equal(exit.fraction, 0.5)
  // risk exit and break-even exit are always complete
  assert.equal(run([100, 70], {}, half).at(-1)!.fraction, 1)
  assert.equal(run([100, 125, 99], {}, half).at(-1)!.fraction, 1)
  // after the partial exit (net 29 now, half the quantity left) the rules go on from the new peak
  let state = initialState(base({ price: 100 }), half)
  for (const p of [120, 140, 160]) state = evaluate(state, base({ price: p }), half).state
  const before = evaluate(state, base({ price: 129 }), half)
  assert.equal(before.decision.action, 'exit')
  const rebased = afterPartialExit(before.state, before.decision.net)
  assert.equal(rebased.partialExits, 1)
  near(rebased.peakNet, 29, 'peak restarts at the net result')
  assert.equal(rebased.stage, 2)
  const next = evaluate(rebased, base({ quantity: 0.5, price: 129, realizedGross: 14.5 }), half)
  assert.equal(next.decision.action, 'hold', 'not the same exit again')
  near(floorOf(rebased, half), 14.5, 'new floor = new peak x 0.5')
  // a trailing exit with a net result <= 0 (gap) closes everything
  const gap = run([100, 120, 140, 160, 70], {}, half).at(-1)!
  assert.equal(gap.action, 'exit')
  assert.equal(gap.fraction, 1)
})

test('10. adding to a position raises R (never lowers it); no usable R means no decision, with the reason', () => {
  let state = initialState(base(), cfg())
  near(state.riskUsdc, 20, 'R at open')
  const bigger = evaluate(state, base({ margin: 400 }), cfg())
  near(bigger.state.riskUsdc, 20, 'account limit still 20 (2% of 1000)')
  const smallMargin = evaluate(state, base({ margin: 10 }), cfg())
  near(smallMargin.state.riskUsdc, 20, 'a smaller margin does not lower R')
  state = initialState(base({ equityBase: 5000, margin: 100 }), cfg())
  near(state.riskUsdc, 50, 'R follows the margin limit')
  const none = evaluate({ stage: 0, riskUsdc: 0, peakNet: 0, partialExits: 0 }, base({ equityBase: 0, margin: 0 }), cfg())
  assert.equal(none.decision.action, 'hold')
  assert.match(none.decision.reason, /no decision: risk unit R=0/)
})

test('11. the parameters are not tied to any price or coin: scaling the position scales R and the outcome', () => {
  const a = run([100, 125, 150, 160, 130], { quantity: 1, margin: 100 })
  const b = run([1, 1.25, 1.5, 1.6, 1.3], { quantity: 100, avgCost: 1, margin: 100 })
  assert.deepEqual(a.map((x) => x.action), b.map((x) => x.action))
  assert.deepEqual(a.map((x) => x.stage), b.map((x) => x.stage))
})
