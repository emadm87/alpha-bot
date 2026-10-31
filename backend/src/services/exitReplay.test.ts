/**
 * Chronological replay of C1 / C2 / C3 on a recorded run (Task 007C).
 *
 * Run: npx tsx --test src/services/exitReplay.test.ts
 *
 * Synthetic run: 20 flat hours (true range 2 each hour: ATR 2) before a
 * SHORT of 1 unit at 100 opened at T; R = 4, stop 104, C3 take profit 92,
 * C2 partial at 94, chandelier 6. Fee rate 0, no spread, no slippage unless
 * stated, so the values can be checked by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_EXIT_CONFIG, type Bar } from './exitRules.js'
import { replayExits, type ReplayFill, type ReplayInput } from './exitReplay.js'

const Q = 900_000
const T = Date.UTC(2026, 9, 30, 12, 0, 0)
const near = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
/** 20 hours before T of quarters with range 2 in each hour, then the given quarters after T. */
function bars(after: [number, number, number, number][]): Bar[] {
  const out: Bar[] = []
  for (let k = 80; k > 0; k--) {
    const t = T - k * Q
    const q = (t / Q) % 4
    out.push({ openTime: t, endTime: t + Q, open: 100, close: 100, high: q === 1 ? 101 : 100, low: q === 2 ? 99 : 100 })
  }
  after.forEach(([o, h, l, c], i) => out.push({ openTime: T + i * Q, endTime: T + (i + 1) * Q, open: o, high: h, low: l, close: c }))
  return out
}
const fill = (side: string, price: number, ms: number, commission = 0): ReplayFill => ({ symbol: 'XRP', side, price, quantity: 1, commission, ms, leverage: 3 })
const input = (over: Partial<ReplayInput> = {}): ReplayInput => ({
  feeRate: 0, fills: [fill('SHORT', 100, T - 60_000)], funding: [],
  bars15: { XRP: bars([[100, 100.5, 97, 97], [97, 97.5, 93.5, 94], [94, 101, 93.8, 100.5], [100.5, 100.8, 100, 100.4]]) },
  runEnd: T + 4 * Q, samples: [], modes: ['C1', 'C2', 'C3'], config: { ...DEFAULT_EXIT_CONFIG }, halfSpread: {}, stopSlippage: 0, ...over,
})

test('1. ATR only from 1 h bars ended before the first fill; plan on the real entry', () => {
  const r = replayExits(input())
  const p = r.positions[0]!
  assert.ok(!('error' in p.atr))
  near((p.atr as any).value, 2, 'ATR of the flat hours')
  assert.equal((p.atr as any).asOf, new Date(T - 3_600_000).toISOString(), 'the hour that ended before the fill at T - 1 min')
  assert.deepEqual([p.modes.C1!.plan.stop, p.modes.C3!.plan.takeProfit, p.modes.C2!.plan.partialAt], [104, 92, 94])
})

test('2. C1/C2/C3 on the same recorded SHORT: chandelier, partial + break-even, stop; open at the end = estimate, labelled', () => {
  const r = replayExits(input())
  const p = r.positions[0]!
  assert.equal(p.recorded.status, 'open_at_end')
  near(p.recorded.netUsdc, -0.4, 'estimate at the last close 100.4')
  assert.match(p.recorded.basis, /NOT realized/)
  // C1: best 93.5 after bar 1 -> chandelier 99.5; bar 2 high 101 -> exit at 99.5: +0.5
  assert.deepEqual(p.modes.C1!.legs.map((l) => [l.kind, l.price]), [['exit_trailing', 99.5]])
  near(p.modes.C1!.netUsdc, 0.5, 'C1')
  near(p.modes.C1!.deltaVsRecordedUsdc, 0.9, 'C1 vs record')
  // C2: 25% at 94 in bar 1; bar 2: break-even 100 vs chandelier 99.5 -> 99.5 (more protective for a SHORT)
  assert.deepEqual(p.modes.C2!.legs.map((l) => [l.kind, l.fraction, l.price]), [['partial_take_profit', 0.25, 94], ['exit_trailing', 0.75, 99.5]])
  near(p.modes.C2!.netUsdc, 0.25 * 6 + 0.75 * 0.5, 'C2')
  // C3: take profit 92 never reached, stop 104 never reached: follows the record
  assert.deepEqual(p.modes.C3!.legs.map((l) => l.kind), ['time_exit'])
  near(p.modes.C3!.netUsdc, p.recorded.netUsdc, 'C3 = recorded')
  assert.equal(p.modes.C3!.note, 'the rules would not have acted: same as recorded')
  assert.match(p.modes.C1!.note, /^HYPOTHETICAL/)
  assert.ok(r.limits.some((l) => /never a realized profit/.test(l)))
  assert.ok(r.limits.some((l) => /not the mark price/.test(l)))
})

test('3. a position closed in the record: realized result; what the rules did not close follows the recorded close', () => {
  const closed = input({ fills: [fill('SHORT', 100, T - 60_000, 0.05), fill('BUY', 100.3, T + 4 * Q - 1, 0.05)] })
  const p = replayExits(closed).positions[0]!
  assert.equal(p.recorded.status, 'closed')
  near(p.recorded.netUsdc, -0.3 - 0.1, 'realized - fees')
  // C3 did nothing: the recorded close
  near(p.modes.C3!.netUsdc, p.recorded.netUsdc, 'C3')
  // C2: partial at 94 then 75% at 99.5 by the rules
  near(p.modes.C2!.netUsdc, 0.25 * 6 + 0.75 * 0.5 - 0.05, 'C2 with the real entry fee')
})

test('4. funding: the recorded result counts every funding hour held, also a row written after the close (A8)', () => {
  const closeAt = T + 3 * Q + 60_000 // the recorded close comes after bar 2, where C1 exits
  const r = replayExits(input({
    fills: [fill('SHORT', 100, T - 60_000), fill('BUY', 100, closeAt)],
    funding: [{ symbol: 'XRP', fundingTime: T, status: 'settled', amount: -0.2, rate: 0.002, oraclePrice: 100 }],
  }))
  near(r.positions[0]!.recorded.netUsdc, -0.2, 'the 12:00 funding is in the realized result')
  // C1 exits at 99.5 at bar 2 (after 12:00): it was open at 12:00, so it pays the same funding
  near(r.positions[0]!.modes.C1!.netUsdc, 0.5 - 0.2, 'C1 pays the hour it held')
  // a hypothetical exit before the funding hour pays none
  const early = replayExits(input({
    fills: [fill('SHORT', 100, T - 60_000), fill('BUY', 100, closeAt)],
    funding: [{ symbol: 'XRP', fundingTime: T + 2 * Q + 30_000, status: 'settled', amount: -0.2, rate: 0.002, oraclePrice: 100 }],
    bars15: { XRP: bars([[100, 104.5, 99.5, 104]]) },
  }))
  assert.equal(early.positions[0]!.modes.C1!.legs[0]!.kind, 'exit_stop')
  near(early.positions[0]!.modes.C1!.netUsdc, -4, 'stopped before the funding hour: no funding')
})

test('5. costs: the taker fee on every exit leg, the estimated half spread and the stop slippage', () => {
  const r = replayExits(input({ feeRate: 0.0005, halfSpread: { XRP: 0.0001 }, stopSlippage: 0.0002, modes: ['C1'] }))
  // exit at 99.5: fee 0.0005 + half spread 0.0001 + slippage 0.0002 on 99.5
  near(r.positions[0]!.modes.C1!.netUsdc, 0.5 - 99.5 * (0.0005 + 0.0001 + 0.0002), 'C1 net of costs')
})

test('6. not replayable without candles for the period or without enough hours for the ATR; said so', () => {
  const short = input({ bars15: { XRP: bars([]).slice(-20) } })
  assert.equal(short.bars15.XRP!.length, 20)
  const r = replayExits(short)
  assert.equal(r.verifiable, false)
  assert.ok(r.limits.some((l) => /not replayable/.test(l)))
  const late = replayExits(input({ runEnd: T + 40 * Q }))
  assert.equal(late.verifiable, false)
  assert.ok(late.limits.some((l) => /fetch newer candles/.test(l)))
  assert.equal(replayExits(input({ fills: [] })).verifiable, false)
})

test('7. prompt prices are checked against the candles (two sources: mids and trades)', () => {
  const r = replayExits(input({ samples: [{ ms: T + 1000, prices: { XRP: 98 } }, { ms: T + Q + 1000, prices: { XRP: 90 } }] }))
  assert.deepEqual(r.positions[0]!.promptCheck, { samples: 2, outsideBarRange: 1 })
})

test('8. deterministic', () => {
  assert.deepEqual(replayExits(input()), replayExits(input()))
})
