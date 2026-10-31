/**
 * Chronological replay of the profit protection rules (Task 007A).
 *
 * Run: npx tsx --test src/services/protectionReplay.test.ts
 *
 * Pure inputs (fills, funding rows, price samples), hand-computed values:
 * 1 BTC bought at 100 with margin 100 (leverage 1) and 1000 USDC of capital,
 * so R = min(2% x account value, 50% x 100) = 20 USDC; fee rate 0.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROTECTION_CONFIG, type ProtectionConfig } from './profitProtection.js'
import { replayProtection, type ReplayFill, type ReplayFunding, type ReplayInput } from './protectionReplay.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)
const cfg = (over: Partial<ProtectionConfig> = {}): ProtectionConfig => ({ ...DEFAULT_PROTECTION_CONFIG, enabled: true, ...over })
const fill = (side: string, price: number, quantity: number, min: number, over: Partial<ReplayFill> = {}): ReplayFill =>
  ({ symbol: 'BTC', side, price, quantity, commission: 0, interest: 0, ms: T0 + min * MIN, leverage: 1, ...over })
const series = (prices: number[], startMin = 5, step = 5) =>
  prices.map((p, i) => ({ ms: T0 + (startMin + i * step) * MIN, prices: { BTC: p } }))
const input = (over: Partial<ReplayInput> = {}): ReplayInput => ({
  costModel: 'hyperliquid', initialCapital: 1000, feeRate: 0, fills: [fill('LONG', 100, 1, 0)], funding: [],
  samples: series([100, 110, 125, 140, 160, 150, 135, 128, 120]), config: cfg(), ...over,
})
const near = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)

test('1. a winner that gives it back: the hypothetical exit is the first sample at or under the trailing floor, labelled hypothetical', () => {
  const r = replayProtection(input())
  assert.equal(r.positions.length, 1)
  const p = r.positions[0]!
  assert.equal(p.symbol, 'BTC')
  assert.equal(p.side, 'LONG')
  near(p.riskUsdc, 20, 'R')
  // peak 60 at price 160 -> floor 30 -> exit at the first sample with net <= 30: price 128 (net 28), not 135 (net 35)
  assert.equal(p.hypothetical.exits.length, 1)
  const x = p.hypothetical.exits[0]!
  assert.equal(x.kind, 'profit_protection')
  assert.equal(x.price, 128)
  assert.equal(x.ms, T0 + 40 * MIN)
  near(x.netAtExit, 28, 'net at exit')
  assert.equal(p.maxStage, 2)
  near(p.peakNet, 60, 'peak')
  // recorded: still open at the end of the data (price 120): an estimate, not a realized result
  assert.equal(p.recorded.status, 'open_at_end')
  near(p.recorded.net, 20, 'estimate at the last price')
  assert.match(p.recorded.basis, /NOT realized/)
  near(p.hypothetical.net, 28, 'hypothetical net')
  near(p.hypothetical.deltaVsRecorded, 8, 'delta')
  assert.equal(p.hypothetical.closedByRules, true)
  assert.match(p.hypothetical.note, /^HYPOTHETICAL/)
  assert.ok(r.limits.some((l) => /order book at the hypothetical exit is not recorded/.test(l)))
  assert.ok(r.limits.some((l) => /not an account result and not a profit that was made/.test(l)))
  assert.ok(r.limits.some((l) => /sample spacing: median 5\.0 min/.test(l)))
})

test('2. no look-ahead: samples after the exit, or later fills, change nothing about the exit', () => {
  const full = replayProtection(input())
  const exitMs = full.positions[0]!.hypothetical.exits[0]!.ms
  const cut = replayProtection(input({ samples: input().samples.filter((s) => s.ms <= exitMs) }))
  assert.deepEqual(cut.positions[0]!.hypothetical.exits, full.positions[0]!.hypothetical.exits)
  assert.deepEqual(cut.positions[0]!.steps, full.positions[0]!.steps)
  // an extreme price after the exit is not used
  const later = replayProtection(input({ samples: [...input().samples, { ms: T0 + 200 * MIN, prices: { BTC: 1 } }] }))
  assert.deepEqual(later.positions[0]!.hypothetical.exits, full.positions[0]!.hypothetical.exits)
  // the recorded closing fill after the exit does not change the hypothetical exit either
  const closed = replayProtection(input({ fills: [fill('LONG', 100, 1, 0), fill('SELL', 90, 1, 70)] }))
  assert.deepEqual(closed.positions[0]!.hypothetical.exits, full.positions[0]!.hypothetical.exits)
  assert.equal(closed.positions[0]!.recorded.status, 'closed')
  near(closed.positions[0]!.recorded.net, -10, 'realized')
  near(closed.positions[0]!.hypothetical.deltaVsRecorded, 38, 'hypothetical 28 vs realized -10')
})

test('3. SHORT risk exit; fees and the hypothetical exit fee are counted', () => {
  const r = replayProtection(input({
    feeRate: 0.001,
    fills: [fill('SHORT', 100, 1, 0, { commission: 0.1 })],
    samples: series([100, 105, 112, 118, 122]),
  }))
  const p = r.positions[0]!
  assert.equal(p.side, 'SHORT')
  const x = p.hypothetical.exits[0]!
  assert.equal(x.kind, 'risk')
  // R: account value at the first sample 1000 - 0.1 = 999.9 -> min(19.998, 50) = 19.998; net at 118 = -18 - 0.1 - 0.118 = -18.218; at 122 = -22.2 - ...
  assert.equal(x.price, 122)
  near(x.netAtExit, -22 - 0.1 - 0.122, 'net after fees', 1e-9)
  near(p.riskUsdc, 19.998, 'R from the account value after the opening fee')
  // closed by the rules: entry fee 0.1 + exit fee 0.122 are in the hypothetical net
  near(p.hypothetical.net, -22 - 0.1 - 0.122, 'hypothetical net')
})

test('4. funding enters only from the time it was recorded', () => {
  const funding: ReplayFunding[] = [{ symbol: 'BTC', fundingTime: T0 + 5 * MIN, recordedAt: T0 + 22 * MIN, amount: -19, status: 'settled' }]
  const flat = series([100, 100, 100, 100, 100, 100])
  const r = replayProtection(input({ funding, samples: flat }))
  // the funding row was written at minute 22: the sample at minute 20 does not know it, the one at minute 25 does (net -19 > -20: still held)
  const steps = r.positions[0]!.steps
  near(steps[3]!.net, 0, 'minute 20: funding not recorded yet')
  near(steps[4]!.net, -19, 'minute 25: funding known')
  assert.equal(r.positions[0]!.hypothetical.exits.length, 0, '-19 is above the -20 limit')
  // a larger funding crosses the limit at the first sample that can know it
  const big = replayProtection(input({ funding: [{ ...funding[0]!, amount: -21 }], samples: flat }))
  assert.equal(big.positions[0]!.hypothetical.exits[0]!.ms, T0 + 25 * MIN)
  // not settled funding is never counted
  const missing = replayProtection(input({ funding: [{ ...funding[0]!, status: 'missing_oracle', amount: 0 }], samples: flat }))
  assert.ok(missing.limits.some((l) => /1 funding hour\(s\) were not settled/.test(l)))
})

test('5. partial exits continue with the quantity left; recorded fills after the first exit are ignored', () => {
  const r = replayProtection(input({ config: cfg({ trailExitFraction: 0.5 }), samples: series([100, 110, 125, 140, 160, 128, 150, 190, 150]) }))
  const p = r.positions[0]!
  assert.ok(p.hypothetical.exits.length >= 1)
  // peak 60 at 160 -> floor 30 -> first sample at or under it is 128 (net 28): half closed, realized 0.5 x 28 = 14
  assert.equal(p.hypothetical.exits.length, 1, 'no second exit: the peak restarted from the net result')
  const first = p.hypothetical.exits[0]!
  assert.equal(first.fraction, 0.5)
  near(first.quantity, 0.5, 'half of the position')
  assert.equal(first.price, 128)
  assert.equal(p.hypothetical.closedByRules, false)
  // end of the data at 150: realized 14 + the other half 0.5 x 50 = 39 (the recorded estimate is 50 on the whole position)
  near(p.hypothetical.net, 39, 'net with half closed at 128 and half still open at 150')
  near(p.recorded.net, 50, 'recorded estimate')
  near(p.hypothetical.deltaVsRecorded, -11, 'taking half profit at 128 instead of holding to 150 would have cost 11 here')
})

test('6. not replayable without data, and said so; a position closed before any sample is not replayed', () => {
  const none = replayProtection(input({ samples: [] }))
  assert.equal(none.verifiable, false)
  assert.equal(none.positions.length, 0)
  assert.ok(none.limits.some((l) => /not replayable/.test(l)))
  const one = replayProtection(input({ samples: series([100]) }))
  assert.equal(one.verifiable, false, 'a single price is not a chronology')
  // data for another coin only
  const other = replayProtection(input({ samples: [{ ms: T0 + 5 * MIN, prices: { ETH: 1 } }, { ms: T0 + 10 * MIN, prices: { ETH: 1 } }] }))
  assert.equal(other.verifiable, false)
  const fast = replayProtection(input({ fills: [fill('LONG', 100, 1, 0), fill('SELL', 100, 1, 1)], samples: series([100, 100]) }))
  assert.equal(fast.positions.length, 0)
})

test('7. the rules never fired: same as recorded, said so', () => {
  const r = replayProtection(input({ samples: series([100, 102, 99, 101, 100]), fills: [fill('LONG', 100, 1, 0), fill('SELL', 101, 1, 25)] }))
  const p = r.positions[0]!
  assert.equal(p.hypothetical.exits.length, 0)
  assert.equal(p.hypothetical.deltaVsRecorded, 0)
  assert.equal(p.hypothetical.note, 'the rules never fired: same as recorded')
  assert.equal(p.recorded.status, 'closed')
  near(p.recorded.net, 1, 'realized')
})

test('8. several positions, one coin reopened: each is its own replay with its own R and peak', () => {
  const r = replayProtection(input({
    fills: [fill('LONG', 100, 1, 0), fill('SELL', 130, 1, 12), fill('SHORT', 130, 1, 14)],
    samples: series([100, 120, 130, 125, 110, 100]),
  }))
  assert.equal(r.positions.length, 2)
  assert.deepEqual(r.positions.map((p) => p.side), ['LONG', 'SHORT'])
  assert.equal(r.positions[0]!.recorded.status, 'closed')
  assert.equal(r.positions[1]!.recorded.status, 'open_at_end')
  assert.ok(r.positions[1]!.openedAt > r.positions[0]!.openedAt)
})

test('9. deterministic: the same input gives the same result', () => {
  assert.deepEqual(replayProtection(input()), replayProtection(input()))
})
