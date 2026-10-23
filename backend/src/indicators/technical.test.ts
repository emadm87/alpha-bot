/**
 * Tests for technical.ts against independent references:
 * - TA-Lib 0.8.2 on 250 closed BTC daily bars from Hyperliquid
 *   (__fixtures__/talib-reference.json, see generate_talib_reference.py);
 * - Wilder's RSI steps worked out by hand on a textbook series;
 * - closed forms on constant and linear series.
 *
 * Run: npx tsx --test src/indicators/technical.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  atr,
  closedCandles,
  ema,
  emaWarmupBars,
  indicatorSnapshot,
  macd,
  macdWarmupBars,
  relativeVolume,
  rsi,
  SEED_RESIDUAL,
  wilderWarmupBars,
  type Candle,
  type Output,
} from './technical.js'

const readJson = (name: string) =>
  JSON.parse(fs.readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'))
const CANDLES: Candle[] = readJson('btc-1d-candles.json').candles
const REF = readJson('talib-reference.json')
const DAY = 86_400_000

const closes = CANDLES.map((c) => c.close)
const highs = CANDLES.map((c) => c.high)
const lows = CANDLES.map((c) => c.low)
const volumes = CANDLES.map((c) => c.volume)

/** Equal within a relative tolerance; null only matches null. */
function near(actual: number | null, expected: number | null, rel: number, what: string) {
  if (expected === null || actual === null) {
    assert.equal(actual, expected, what)
    return
  }
  const tol = rel * Math.max(1, Math.abs(expected))
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: actual=${actual} expected=${expected}`)
}

/** Compares from index `from`; everything before must be null. */
function series(actual: Output, expected: (number | null)[], from: number, rel: number, what: string) {
  assert.equal(actual.length, expected.length, `${what}: length`)
  for (let i = 0; i < actual.length; i++) {
    if (i < from) assert.equal(actual[i], null, `${what}[${i}] before warm-up`)
    else near(actual[i]!, expected[i]!, rel, `${what}[${i}]`)
  }
}

const REL = 1e-10

// --- TA-Lib reference ------------------------------------------------------

test('EMA20 and EMA50 match TA-Lib from the first value (SMA seed)', () => {
  series(ema(closes, 20, { warmup: 20 }), REF.ema20, 19, REL, 'EMA20 raw')
  series(ema(closes, 50, { warmup: 50 }), REF.ema50, 49, REL, 'EMA50 raw')
})

test('EMA default warm-up: EMA20 from bar 67, EMA50 from bar 166', () => {
  series(ema(closes, 20), REF.ema20, 66, REL, 'EMA20')
  series(ema(closes, 50), REF.ema50, 165, REL, 'EMA50')
})

test('RSI14 (Wilder) matches TA-Lib; reported from bar 78 by default', () => {
  series(rsi(closes, 14, { warmup: 15 }), REF.rsi14, 14, REL, 'RSI14 raw')
  series(rsi(closes, 14), REF.rsi14, 77, REL, 'RSI14')
})

test('ATR14 (Wilder) matches TA-Lib; reported from bar 78 by default', () => {
  series(atr(highs, lows, closes, 14, { warmup: 15 }), REF.atr14, 14, REL, 'ATR14 raw')
  series(atr(highs, lows, closes, 14), REF.atr14, 77, REL, 'ATR14')
})

test('MACD 12/26/9 matches EMA12 - EMA26 and EMA9 of the line built from TA-Lib EMAs', () => {
  const m = macd(closes, 12, 26, 9, { warmup: 26 })
  series(m.macd, REF.composedMacd.macd, 25, REL, 'line raw')
  series(m.signal, REF.composedMacd.signal, 33, REL, 'signal raw')
  series(m.histogram, REF.composedMacd.histogram, 33, 1e-8, 'histogram raw')
})

test('MACD after warm-up agrees with TA-Lib MACD despite its different seeding', (t) => {
  const m = macd(closes)
  series(m.macd, REF.composedMacd.macd, 85, REL, 'line')
  series(m.signal, REF.composedMacd.signal, 114, REL, 'signal')
  // TA-Lib seeds EMA12 on bars 14..25 instead of 0..11: the difference has
  // decayed to the cent on BTC (MACD values in the hundreds of USDC).
  let worst = 0
  for (let i = 114; i < closes.length; i++) {
    for (const k of ['macd', 'signal', 'histogram'] as const) {
      worst = Math.max(worst, Math.abs(m[k][i]! - REF.talibMacd[k][i]))
    }
  }
  t.diagnostic(`max |ours - TA-Lib MACD| from bar 115: ${worst.toExponential(3)} USDC`)
  assert.ok(worst < 0.01, `worst=${worst}`)
})

test('relative volume matches pandas volume / rolling(20).mean().shift(1)', () => {
  series(relativeVolume(volumes, 20), REF.relativeVolume20, 20, 1e-12, 'RV20')
})

// --- Published example and closed forms -------------------------------------

test('RSI14 first Wilder steps computed by hand', () => {
  // Classic textbook series; values checked by hand, not taken from a table
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89,
    46.03, 45.61, 46.28, 46.28, 46.00, 46.03]
  // 14 changes: gains 0.06+0.72+0.50+0.27+0.32+0.42+0.24+0.14+0.67 = 3.34,
  // losses 0.25+0.54+0.19+0.42 = 1.40 (the 0.00 change counts in neither)
  let gain = 3.34 / 14
  let loss = 1.40 / 14
  const expected = [100 - 100 / (1 + gain / loss)] // 70.4641
  gain = (gain * 13 + 0) / 14 // change -0.28
  loss = (loss * 13 + 0.28) / 14
  expected.push(100 - 100 / (1 + gain / loss))
  gain = (gain * 13 + 0.03) / 14 // change +0.03
  loss = (loss * 13 + 0) / 14
  expected.push(100 - 100 / (1 + gain / loss))
  const r = rsi(c, 14, { warmup: 15 })
  expected.forEach((v, j) => near(r[14 + j]!, v, 1e-9, `RSI[${14 + j}]`))
  near(r[14]!, 70.4641, 1e-5, 'first RSI to 4 decimals')
})

test('hand-checked relative volume and true range with a gap', () => {
  const v = [...Array(20).fill(10), 25, 0]
  assert.equal(relativeVolume(v, 20)[20], 2.5) // 25 / mean(10 x 20)
  assert.equal(relativeVolume(v, 20)[21], (0 / ((19 * 10 + 25) / 20))) // zero volume is valid
  // TR uses the previous close when it lies outside the bar: |high - prevClose|
  const h = [11, 20, 21]; const l = [9, 18, 19]; const c = [10, 19, 20]
  assert.deepEqual(atr(h, l, c, 2, { warmup: 3 }), [null, null, (10 + 2) / 2])
})

test('constant series: EMA = price, RSI 50, MACD 0, ATR = range, RV 1', () => {
  const n = 200
  const c = Array(n).fill(100)
  const e = ema(c, 20)
  assert.ok(e.slice(66).every((v) => v === 100))
  assert.ok(rsi(c, 14).slice(77).every((v) => v === 50))
  const m = macd(c)
  for (const k of ['macd', 'signal', 'histogram'] as const) {
    assert.ok(m[k].slice(114).every((v) => v === 0), k)
  }
  assert.ok(atr(Array(n).fill(101), Array(n).fill(99), c).slice(77).every((v) => Math.abs(v! - 2) < 1e-12))
  assert.ok(relativeVolume(Array(n).fill(5)).slice(20).every((v) => v === 1))
})

test('linear series: EMA lags by slope*(n-1)/2, MACD = 7*slope, RSI 100 / 0', () => {
  const n = 200
  const up = Array.from({ length: n }, (_, i) => 100 + 2 * i)
  const down = Array.from({ length: n }, (_, i) => 1000 - 3 * i)
  ema(up, 20).forEach((v, i) => v !== null && near(v, up[i]! - 19, 1e-12, `EMA20 up[${i}]`))
  ema(up, 50).forEach((v, i) => v !== null && near(v, up[i]! - 49, 1e-12, `EMA50 up[${i}]`))
  ema(down, 20).forEach((v, i) => v !== null && near(v, down[i]! + 28.5, 1e-12, `EMA20 down[${i}]`))
  assert.ok(rsi(up).slice(77).every((v) => v === 100))
  assert.ok(rsi(down).slice(77).every((v) => v === 0))
  const mu = macd(up)
  const md = macd(down)
  for (let i = 114; i < n; i++) {
    near(mu.macd[i]!, 14, 1e-9, `MACD up[${i}]`)
    near(mu.histogram[i]!, 0, 1e-9, `hist up[${i}]`)
    near(md.macd[i]!, -21, 1e-9, `MACD down[${i}]`)
  }
})

// --- Warm-up -----------------------------------------------------------------

test('warm-up lengths leave at most 1% of the seed error', () => {
  assert.deepEqual(
    [emaWarmupBars(20), emaWarmupBars(50), wilderWarmupBars(14), macdWarmupBars()],
    [67, 166, 78, 115],
  )
  for (const [period, alpha] of [[20, 2 / 21], [50, 2 / 51]] as const) {
    const k = emaWarmupBars(period) - period
    assert.ok((1 - alpha) ** k <= SEED_RESIDUAL && (1 - alpha) ** (k - 1) > SEED_RESIDUAL)
  }
  const k = wilderWarmupBars(14) - 15
  assert.ok((13 / 14) ** k <= SEED_RESIDUAL && (13 / 14) ** (k - 1) > SEED_RESIDUAL)
})

test('EMA50 with only 50-60 bars still depends on its seed; after 166 it does not', (t) => {
  // Same market, two histories: the full one and one starting 60 bars later.
  const late = closes.slice(60)
  const full = ema(closes, 50, { warmup: 50 })
  const short = ema(late, 50, { warmup: 50 })
  const seedGap = Math.abs(short[49]! - full[60 + 49]!)
  const at60 = Math.abs(short[59]! - full[60 + 59]!)
  const at166 = Math.abs(short[165]! - full[60 + 165]!)
  t.diagnostic(`EMA50 seed gap ${seedGap.toFixed(2)}, after 60 bars ${at60.toFixed(2)}, after 166 bars ${at166.toFixed(2)}`)
  assert.ok(at60 > 0.5 * seedGap, 'with 60 bars most of the seed error remains')
  assert.ok(at166 <= SEED_RESIDUAL * seedGap + 1e-9, 'after the default warm-up <= 1%')
  assert.equal(ema(late, 50)[164], null)
  assert.notEqual(ema(late, 50)[165], null)
})

// --- Insufficient history and invalid values ----------------------------------

test('insufficient history gives null, never 0', () => {
  assert.ok(ema(closes.slice(0, 19), 20, { warmup: 20 }).every((v) => v === null))
  assert.ok(ema(closes.slice(0, 165), 50).every((v) => v === null))
  assert.ok(rsi(closes.slice(0, 14), 14, { warmup: 15 }).every((v) => v === null))
  assert.ok(atr(highs.slice(0, 14), lows.slice(0, 14), closes.slice(0, 14), 14, { warmup: 15 }).every((v) => v === null))
  const m = macd(closes.slice(0, 114))
  assert.ok(m.signal.every((v) => v === null) && m.histogram.every((v) => v === null))
  assert.ok(relativeVolume(volumes.slice(0, 20)).every((v) => v === null))
  assert.deepEqual(ema([], 20), [])
})

test('invalid values break the series: null there, recursions restart after', () => {
  const k = 100
  for (const bad of [null, undefined, Number.NaN, Infinity, -Infinity, 0, -5]) {
    const c = [...closes] as (number | null | undefined)[]
    c[k] = bad
    const cases: [string, (x: typeof c) => Output][] = [
      ['EMA20', (x) => ema(x, 20, { warmup: 20 })],
      ['RSI14', (x) => rsi(x, 14, { warmup: 15 })],
      ['MACD', (x) => macd(x, 12, 26, 9, { warmup: 26 }).histogram],
    ]
    for (const [name, f] of cases) {
      const out = f(c)
      const before = f(c.slice(0, k))
      const after = f(c.slice(k + 1))
      assert.equal(out[k], null, `${name} at the bad value ${bad}`)
      assert.deepEqual(out.slice(0, k), before, `${name} before ${bad}`)
      assert.deepEqual(out.slice(k + 1), after, `${name} restarts after ${bad}`)
    }
  }
})

test('invalid bars for ATR and invalid volumes are excluded, not zeroed', () => {
  const h = [...highs]; const l = [...lows]
  h[100] = l[100]! - 1 // high < low
  const out = atr(h, l, closes, 14, { warmup: 15 })
  assert.equal(out[100], null)
  assert.deepEqual(out.slice(101), atr(h.slice(101), l.slice(101), closes.slice(101), 14, { warmup: 15 }))
  const v = [...volumes] as (number | null)[]
  v[100] = -1
  const rv = relativeVolume(v)
  assert.ok(rv.slice(100, 121).every((x) => x === null))
  assert.notEqual(rv[121], null)
  assert.throws(() => ema(closes, 0), RangeError)
  assert.throws(() => ema(closes, 50, { warmup: 10 }), RangeError)
  assert.throws(() => atr(highs, lows.slice(1), closes), RangeError)
})

// --- No look-ahead and immutability -----------------------------------------------

test('no future data: every value equals the value computed on the prefix up to it', () => {
  const full = {
    ema20: ema(closes, 20), ema50: ema(closes, 50), rsi: rsi(closes),
    macd: macd(closes).histogram, atr: atr(highs, lows, closes), rv: relativeVolume(volumes),
  }
  for (let k = 1; k <= closes.length; k++) {
    const last = (xs: Output) => xs[k - 1]
    assert.equal(last(ema(closes.slice(0, k), 20)), full.ema20[k - 1])
    assert.equal(last(ema(closes.slice(0, k), 50)), full.ema50[k - 1])
    assert.equal(last(rsi(closes.slice(0, k))), full.rsi[k - 1])
    assert.equal(last(macd(closes.slice(0, k)).histogram), full.macd[k - 1])
    assert.equal(last(atr(highs.slice(0, k), lows.slice(0, k), closes.slice(0, k))), full.atr[k - 1])
    assert.equal(last(relativeVolume(volumes.slice(0, k))), full.rv[k - 1])
  }
})

test('inputs are not modified', () => {
  const frozen = CANDLES.map((c) => Object.freeze({ ...c }))
  Object.freeze(frozen)
  const copy = structuredClone(frozen)
  const arrays = [closes, highs, lows, volumes].map((a) => Object.freeze([...a]))
  ema(arrays[0]!, 20); rsi(arrays[0]!); macd(arrays[0]!)
  atr(arrays[1]!, arrays[2]!, arrays[0]!); relativeVolume(arrays[3]!)
  indicatorSnapshot(frozen, DAY, Date.now())
  closedCandles(frozen, Date.now())
  assert.deepEqual(frozen, copy)
  assert.deepEqual(arrays.map((a) => [...a]), [closes, highs, lows, volumes])
})

// --- Snapshot on candles ----------------------------------------------------------

const lastClosed = CANDLES[CANDLES.length - 1]!
const forming: Candle = {
  openTime: lastClosed.openTime + DAY, closeTime: lastClosed.closeTime + DAY,
  open: 81410, high: 99999, low: 1000, close: 99000, volume: 1e9,
}

test('snapshot excludes the bar still forming and reports its as-of time', () => {
  const asOf = forming.openTime + 3_600_000 // one hour into the forming bar
  const withForming = indicatorSnapshot([...CANDLES, forming], DAY, asOf)
  const closedOnly = indicatorSnapshot(CANDLES, DAY, asOf)
  assert.equal(withForming.asOf, lastClosed.closeTime)
  assert.equal(withForming.close, lastClosed.close)
  assert.deepEqual({ ...withForming, issues: [] }, { ...closedOnly, issues: [] })
  assert.ok(withForming.issues.some((s) => s.includes('not closed')))
  // Once it has closed it is used
  const later = indicatorSnapshot([...CANDLES, forming], DAY, forming.closeTime + 1)
  assert.equal(later.close, 99000)
})

test('snapshot values equal the last values of the series functions', () => {
  const s = indicatorSnapshot(CANDLES, DAY, lastClosed.closeTime + 1)
  const last = (xs: Output) => xs[xs.length - 1]
  const m = macd(closes)
  assert.equal(s.bars, 250)
  assert.equal(s.ema20, last(ema(closes, 20)))
  assert.equal(s.ema50, last(ema(closes, 50)))
  assert.equal(s.rsi14, last(rsi(closes)))
  assert.equal(s.macd, last(m.macd))
  assert.equal(s.macdSignal, last(m.signal))
  assert.equal(s.macdHistogram, last(m.histogram))
  assert.equal(s.atr14, last(atr(highs, lows, closes)))
  near(s.atr14Pct, (s.atr14! / lastClosed.close!) * 100, 1e-12, 'ATR%')
  assert.equal(s.relativeVolume20, last(relativeVolume(volumes)))
  near(s.ema50, REF.ema50[249], REL, 'EMA50 vs TA-Lib')
  assert.deepEqual(s.issues, [])
})

test('snapshot restarts after a gap or an invalid bar and flags warm-up', () => {
  const asOf = lastClosed.closeTime + 1
  const gapped = CANDLES.filter((_, i) => i !== 200)
  const g = indicatorSnapshot(gapped, DAY, asOf)
  assert.equal(g.bars, 49)
  assert.equal(g.ema50, null)
  assert.equal(g.ema20, null) // 49 bars: EMA20 needs 67
  assert.notEqual(g.relativeVolume20, null)
  assert.ok(g.issues.some((s) => s.startsWith('gap before')))
  assert.ok(g.issues.some((s) => s.includes('warming up')))

  const broken = CANDLES.map((c, i) => (i === 240 ? { ...c, close: null } : c))
  const b = indicatorSnapshot(broken, DAY, asOf)
  assert.equal(b.bars, 9)
  assert.ok(b.issues.some((s) => s.startsWith('invalid bar')))
  assert.equal(b.rsi14, null)
})

test('snapshot rejects unordered candles and handles no closed bar', () => {
  const swapped = [...CANDLES]
  ;[swapped[10], swapped[11]] = [swapped[11]!, swapped[10]!]
  const u = indicatorSnapshot(swapped, DAY, lastClosed.closeTime + 1)
  assert.equal(u.asOf, null)
  assert.equal(u.close, null)
  assert.deepEqual(u.issues, ['candles not in strictly ascending order'])
  const none = indicatorSnapshot([forming], DAY, forming.openTime + 1)
  assert.equal(none.asOf, null)
  assert.equal(none.bars, 0)
})
