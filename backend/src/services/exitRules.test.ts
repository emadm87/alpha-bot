/**
 * Pure rules C1 / C2 / C3, ATR, risk on the capital (Task 007C).
 *
 * Run: npx tsx --test src/services/exitRules.test.ts
 *
 * Hand-computed values. Reference position: entry 80000, ATR 400, so
 * R = 2 x ATR = 800 (stop 79200 LONG / 80800 SHORT), chandelier 3 x ATR = 1200,
 * C3 take profit +2R = 81600, C2 partial at +1.5R = 81200.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeLevel, assessRisk, atrAt, atrFromHourBars, createPlan, decide, DEFAULT_EXIT_CONFIG, foldLifecycle, hourBars,
  initialExitState, loadExitConfig, netResult, positionInfoVersion, retryDelay, updateBest, type Bar, type Bar15, type ExitConfig,
} from './exitRules.js'

const cfg = (over: Partial<ExitConfig> = {}): ExitConfig => ({ ...DEFAULT_EXIT_CONFIG, mode: 'C1', ...over })
const near = (a: number, b: number, what: string, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
const H = 3_600_000
const T0 = Date.UTC(2026, 9, 1)

test('1. configuration: off by default, C1/C2/C3, overrides validated; the 007A "on" is refused with a reason', () => {
  assert.equal(loadExitConfig({}).mode, 'off')
  for (const m of ['C1', 'c2', 'C3']) assert.equal(loadExitConfig({ ALPHA_PROTECTION: m }).mode, m.toUpperCase())
  const c = loadExitConfig({ ALPHA_PROTECTION: 'C2', ALPHA_PROTECTION_CONFIG: '{"cooldownMs":3600000,"partialFraction":0.5}' })
  assert.equal(c.cooldownMs, 3_600_000)
  assert.equal(c.partialFraction, 0.5)
  assert.equal(c.stopAtr, 2, 'others keep the default')
  assert.throws(() => loadExitConfig({ ALPHA_PROTECTION: 'on' }), /replaced by C1\/C2\/C3/)
  for (const bad of ['{"typo":1}', '{"stopAtr":0.1}', '{"stopAtr":"2"}', '{"atrPeriod":14.5}', '[1]', '{x', '{"retryBaseMs":60000,"retryMaxMs":2000}']) {
    assert.throws(() => loadExitConfig({ ALPHA_PROTECTION: 'C1', ALPHA_PROTECTION_CONFIG: bad }), /ALPHA_PROTECTION_CONFIG/, bad)
  }
  assert.equal(positionInfoVersion({}), 'v1')
  assert.throws(() => positionInfoVersion({ ALPHA_POSITION_INFO: 'v3' }), /v1 or v2/)
})

/** 15 m bars of one hour with the given high, low and close (open = previous close). */
function quarters(hourStart: number, open: number, high: number, low: number, close: number): Bar15[] {
  return [0, 1, 2, 3].map((k) => ({
    openTime: hourStart + k * 900_000, open: k === 0 ? open : close,
    high: k === 1 ? high : Math.max(open, close), low: k === 2 ? low : Math.min(open, close), close: k === 0 ? open : close,
  }))
}

test('2. ATR(14) on 1 h bars from 15 m bars: Wilder, only bars ended before the decision, gaps restart, too few bars refused', () => {
  // 20 hours, true range 10 each hour (high - low), flat closes: ATR = 10
  const bars: Bar15[] = []
  for (let h = 0; h < 20; h++) bars.push(...quarters(T0 + h * H, 100, 105, 95, 100))
  const hb = hourBars(bars)
  assert.equal(hb.length, 20)
  assert.deepEqual([hb[0]!.high, hb[0]!.low, hb[0]!.close], [105, 95, 100])
  const r = atrAt(bars, T0 + 20 * H, 14)
  assert.ok(!('error' in r))
  near((r as any).atr, 10, 'ATR')
  assert.equal((r as any).asOf, T0 + 20 * H)
  // hour 19 has a range of 50: it changes the ATR only when it has ended
  bars.splice(76, 4, ...quarters(T0 + 19 * H, 100, 140, 90, 100))
  near((atrAt(bars, T0 + 20 * H - 1, 14) as any).atr, 10, 'hour 19 not ended: not used (no look-ahead)')
  near((atrAt(bars, T0 + 20 * H, 14) as any).atr, (10 * 13 + 50) / 14, 'Wilder update with hour 19')
  // a missing quarter drops the hour and restarts the run
  const gap = bars.filter((b) => b.openTime !== T0 + 10 * H + 900_000)
  const g = atrAt(gap, T0 + 20 * H, 14)
  assert.ok('error' in g, 'only 9 contiguous hours after the gap')
  assert.match((g as any).error, /9 contiguous closed 1 h bars/)
  // the first true range is high - low, later ones include the previous close
  const h1: Bar[] = [{ openTime: 0, endTime: H, open: 100, high: 101, low: 99, close: 100 }, { openTime: H, endTime: 2 * H, open: 110, high: 111, low: 109, close: 110 }]
  near((atrFromHourBars(h1, 2 * H, 1) as any).atr, (2 + 11) / 2 * 0 + 11, 'period 1: last true range = |111 - 100|')
})

test('3. plan levels for C1, C2, C3, LONG and SHORT', () => {
  const l1 = createPlan('C1', 'LONG', 80000, 400, T0, cfg())
  assert.deepEqual([l1.stopPrice, l1.riskPrice, l1.trailDistance, l1.takeProfitPrice, l1.partialPrice], [79200, 800, 1200, null, null])
  const s3 = createPlan('C3', 'SHORT', 80000, 400, T0, cfg())
  assert.deepEqual([s3.stopPrice, s3.takeProfitPrice], [80800, 78400])
  const l2 = createPlan('C2', 'LONG', 80000, 400, T0, cfg())
  assert.deepEqual([l2.partialPrice, l2.partialFraction], [81200, 0.25])
  assert.deepEqual(initialExitState(l2), { best: 80000, partial: 'pending' })
  assert.deepEqual(initialExitState(l1), { best: 80000, partial: 'n/a' })
})

/** Runs a plan over prices as the live monitor does: decision with the best price before, then update. */
function run(mode: 'C1' | 'C2' | 'C3', side: 'LONG' | 'SHORT', prices: number[]) {
  const plan = createPlan(mode, side, 80000, 400, T0, cfg({ mode }))
  let state = initialExitState(plan)
  const out = []
  for (const p of prices) {
    const d = decide(plan, state, p)
    out.push(d)
    if (d.action === 'partial') state = { ...state, partial: 'done' }
    if (d.action === 'exit') break
    state = updateBest(plan, state, p)
  }
  return out
}

test('4. C1: initial stop, then the chandelier ratchets with the best price and never falls; SHORT mirrors', () => {
  const d = run('C1', 'LONG', [80000, 80500, 81000, 82000, 81500, 80900, 80799])
  assert.deepEqual(d.map((x) => x.action), ['hold', 'hold', 'hold', 'hold', 'hold', 'hold', 'exit'])
  // best 82000 -> trailing 80800 above the stop 79200
  assert.deepEqual(d.map((x) => x.level), [79200, 79200, 79300, 79800, 80800, 80800, 80800])
  assert.equal(d.at(-1)!.kind, 'exit_trailing')
  assert.match(d.at(-1)!.reason, /chandelier 80800\.00 = best 82000\.00 - 3 ATR/)
  // before the best moves 1 ATR above the entry, the stop is the level
  assert.equal(run('C1', 'LONG', [80000, 79200])[1]!.kind, 'exit_stop')
  const s = run('C1', 'SHORT', [80000, 79000, 78000, 79201])
  assert.equal(s.at(-1)!.kind, 'exit_trailing')
  assert.equal(s.at(-1)!.level, 79200)
  assert.equal(run('C1', 'SHORT', [80000, 80800])[1]!.kind, 'exit_stop')
  // the level only rises: from the stop 79200 to trailing levels, never back
  const lv = run('C1', 'LONG', [80000, 81000, 80000, 82000, 81000]).map((x) => x.level)
  for (let i = 1; i < lv.length; i++) assert.ok(lv[i]! >= lv[i - 1]!)
})

test('5. C2: 25% at +1.5R; then break-even and chandelier on the rest; before the partial only the stop', () => {
  const d = run('C2', 'LONG', [80000, 81000, 81200, 81100, 79999])
  assert.deepEqual(d.map((x) => x.action), ['hold', 'hold', 'partial', 'hold', 'exit'])
  assert.equal(d[1]!.level, 79200, 'before the partial: the stop only (no trailing)')
  assert.equal(d[2]!.kind, 'partial_take_profit')
  assert.equal(d[2]!.fraction, 0.25)
  assert.equal(d.at(-1)!.kind, 'exit_breakeven')
  assert.equal(d.at(-1)!.level, 80000)
  // with a higher best the chandelier is above the break-even
  const t = run('C2', 'LONG', [80000, 81200, 82500, 81299])
  assert.equal(t.at(-1)!.kind, 'exit_trailing')
  assert.equal(t.at(-1)!.level, 81300)
  // the partial happens once
  assert.equal(run('C2', 'LONG', [80000, 81200, 81300, 81400]).filter((x) => x.action === 'partial').length, 1)
  // SHORT
  const s = run('C2', 'SHORT', [80000, 78800, 80001])
  assert.deepEqual(s.map((x) => x.kind ?? x.action), ['hold', 'partial_take_profit', 'exit_breakeven'])
})

test('6. C3: whole position at +2R, or the stop; exits checked before targets', () => {
  assert.equal(run('C3', 'LONG', [80000, 81599, 81600]).at(-1)!.kind, 'exit_take_profit')
  assert.equal(run('C3', 'LONG', [80000, 81000, 79200]).at(-1)!.kind, 'exit_stop')
  assert.equal(run('C3', 'SHORT', [80000, 78400]).at(-1)!.kind, 'exit_take_profit')
  // C3 never trails: a big run and a return to just above the stop holds
  assert.equal(run('C3', 'LONG', [80000, 81500, 79201]).at(-1)!.action, 'hold')
  assert.equal(activeLevel(createPlan('C3', 'LONG', 80000, 400, T0, cfg()), { best: 81500, partial: 'n/a' }).kind, 'stop')
})

test('7. risk on the capital: loss at the stop with fees and slippage, profiles 0.5/1/2%, oversized vs the 1% reference', () => {
  const plan = createPlan('C1', 'LONG', 80000, 400, T0, cfg())
  // 0.01 BTC: move to the stop filled 2 bps worse = 0.01 x (80000 - 79184.16) = 8.1584; + fees 0.36; + exit fee 0.01 x 79184.16 x 0.00045
  const r = assessRisk({ plan, quantity: 0.01, feesPaid: 0.36, exitFeeRate: 0.00045, equityBase: 999.64, config: cfg() })
  near(r.riskUsdc, 0.01 * (80000 - 79200 * 0.9998) + 0.36 + 0.01 * 79200 * 0.9998 * 0.00045, 'risk USDC')
  near(r.riskPct, r.riskUsdc / 999.64, 'risk %')
  assert.deepEqual(r.fits, { '0.5%': false, '1%': true, '2%': true })
  assert.equal(r.oversized, false)
  // ten times the size: 8.9% of the account
  const big = assessRisk({ plan, quantity: 0.1, feesPaid: 3.6, exitFeeRate: 0.00045, equityBase: 999.64, config: cfg() })
  assert.equal(big.oversized, true)
  assert.deepEqual(big.fits, { '0.5%': false, '1%': false, '2%': false })
  assert.match(big.note, /oversized: 8\.\d+% of the account at the stop, above the 1% reference/)
  assert.match(big.note, /Sizing is unchanged/)
  // the reference notional: 1% of the account over the loss per unit at the stop
  near(big.referenceNotional, (0.01 * 999.64) / (80000 - 79200 * 0.9998 + 80000 * 0.00045 * 2) * 80000, 'reference notional', 1e-6)
})

test('8. retry delay doubles from 15 s up to 15 min', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 12].map((n) => retryDelay(n, cfg())), [15_000, 30_000, 60_000, 120_000, 900_000, 900_000])
})

test('9. lifecycle from fills: fees, partial realized, additions counted, reset on a full close; net result', () => {
  const t = (side: string, price: number, quantity: number, ms: number, commission = 0.1) => ({ side, price, quantity, commission, ms, leverage: 2 })
  const life = foldLifecycle([t('LONG', 100, 2, 1), t('LONG', 110, 2, 2), t('SELL', 120, 1, 3)])
  assert.equal(life.openedAt, 1)
  assert.equal(life.additions, 1)
  near(life.feesPaid, 0.3, 'fees')
  near(life.realizedGross, 15, 'realized on 1 unit at average 105')
  near(life.avgCost, 105, 'average')
  near(life.margin, (200 + 220) / 2 * 3 / 4, 'margin released pro rata')
  assert.equal(foldLifecycle([t('SHORT', 100, 1, 1), t('BUY', 90, 1, 2), t('LONG', 50, 1, 5)]).openedAt, 5)
  assert.equal(foldLifecycle([t('LONG', 100, 1, 1), t('SELL', 101, 1, 2)]).openedAt, null)
  const n = netResult({ side: 'SHORT', quantity: 1, avgCost: 100, price: 90, realizedGross: 2, feesPaid: 0.5, fundingNet: 0.1, exitFeeRate: 0.001 })
  near(n.net, 10 + 2 - 0.5 - 0.09 + 0.1, 'SHORT net')
})
