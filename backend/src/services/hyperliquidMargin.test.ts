/**
 * Tests for the Hyperliquid cross margin calculator (hyperliquidMargin.ts).
 *
 * Run: npx tsx --test src/services/hyperliquidMargin.test.ts
 *
 * META is a fixed sample of the public `meta` info endpoint (POST
 * api.hyperliquid.xyz/info {"type":"meta"}, read on 2026-10-23) for the six
 * coins of the bot. Expected prices are the theoretical results of the
 * 006F-5 report (1,000 USDC, entry 100, 0.07% opening fee taken from the
 * collateral). ENGINE holds what the current ALPHA BOT engine and monitor did
 * in 006F-5 on a temporary database, for comparison only: the calculator
 * itself closes nothing, so its "final capital" is account value minus a
 * 0.07% closing fee, computed, not simulated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  crossState,
  liquidationPrice,
  maintenanceMargin,
  maintenanceSchedule,
  tiersFromMeta,
  type CrossInput,
  type CrossPosition,
  type MarginTier,
} from './hyperliquidMargin.js'

const META = {
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25, marginTableId: 55 },
    { name: 'SOL', szDecimals: 2, maxLeverage: 20, marginTableId: 54 },
    { name: 'BNB', szDecimals: 3, maxLeverage: 10, marginTableId: 51 },
    { name: 'DOGE', szDecimals: 0, maxLeverage: 10, marginTableId: 52 },
    { name: 'XRP', szDecimals: 0, maxLeverage: 20, marginTableId: 53 },
    { name: 'NOTABLE', szDecimals: 0, maxLeverage: 3, marginTableId: 3 },
  ],
  marginTables: [
    [51, { description: 'tiered 10x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 10 }, { lowerBound: '3000000.0', maxLeverage: 5 }] }],
    [52, { description: 'tiered 10x (2)', marginTiers: [{ lowerBound: '0.0', maxLeverage: 10 }, { lowerBound: '20000000.0', maxLeverage: 5 }] }],
    [53, { description: 'tiered 20x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '40000000.0', maxLeverage: 10 }] }],
    [54, { description: 'tiered 20x (2)', marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '70000000.0', maxLeverage: 10 }] }],
    [55, { description: 'tiered 25x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 25 }, { lowerBound: '100000000.0', maxLeverage: 15 }] }],
    [56, { description: 'tiered 40x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 40 }, { lowerBound: '150000000.0', maxLeverage: 20 }] }],
  ] as [number, { description: string; marginTiers: { lowerBound: string; maxLeverage: number }[] }][],
}
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP']
const TIERS: Record<string, MarginTier[]> = Object.fromEntries(
  COINS.map((c) => {
    const r = tiersFromMeta(META, c)
    assert.ok('tiers' in r, c)
    return [c, r.tiers]
  }),
)

const FEE = 0.0007
const CAPITAL = 1000

/** One position opened at 100 with notional N on a fresh 1,000 USDC account. */
function single(coin: string, side: 'LONG' | 'SHORT', notional: number, leverage: number, mark = 100): CrossInput {
  return {
    collateral: CAPITAL - FEE * notional,
    positions: [{ coin, side, size: notional / 100, entryPrice: 100, leverage }],
    markPrices: { [coin]: mark },
    tiers: TIERS,
  }
}
const at = (input: CrossInput, coin: string, mark: number): CrossInput => ({
  ...input, markPrices: { ...input.markPrices, [coin]: mark },
})
function near(actual: number | null | undefined, expected: number, what: string, eps = 0.005) {
  assert.ok(actual !== null && actual !== undefined, `${what}: got ${actual}`)
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: actual=${actual} expected=${expected}`)
}
/** Theoretical capital if everything is closed at the given state (not simulated). */
const finalCapital = (input: CrossInput, coin: string, price: number) => {
  const s = crossState(at(input, coin, price))
  return s.accountValue! - FEE * s.totalNotional!
}

// --- official tables -------------------------------------------------------------

test('tiers come from the meta sample; ids below 50 give the documented single tier', () => {
  assert.deepEqual(TIERS.BTC, [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150_000_000, maxLeverage: 20 }])
  assert.deepEqual(TIERS.BNB, [{ lowerBound: 0, maxLeverage: 10 }, { lowerBound: 3_000_000, maxLeverage: 5 }])
  assert.deepEqual(tiersFromMeta(META, 'NOTABLE'), { tiers: [{ lowerBound: 0, maxLeverage: 3 }] })
  assert.deepEqual(tiersFromMeta(META, 'XYZ'), { error: 'XYZ not in meta universe' })
  const other = (u: { name: string; maxLeverage: number; marginTableId?: number }) => ({ ...META, universe: [u] })
  assert.deepEqual(tiersFromMeta(other({ name: 'A', maxLeverage: 10, marginTableId: 5 }), 'A'), {
    error: 'A: margin table 5 implies 5x, asset maxLeverage is 10',
  })
  for (const id of [0, -3, 2.5]) {
    const r = tiersFromMeta(other({ name: 'A', maxLeverage: id, marginTableId: id }), 'A')
    assert.deepEqual(r, { error: `A: margin table ${id} is not a single-tier id (integer 1-49)` })
  }
  assert.deepEqual(tiersFromMeta(other({ name: 'A', maxLeverage: 5 }), 'A'), { error: 'A: marginTableId missing' })
  assert.deepEqual(tiersFromMeta(other({ name: 'A', maxLeverage: 50, marginTableId: 50 }), 'A'), {
    error: 'A: margin table 50 not in meta response',
  })
})

test('maintenance rate is half the initial margin at max leverage; deductions keep it continuous', () => {
  const btc = maintenanceSchedule(TIERS.BTC!)
  near(btc[0]!.mmr, 0.0125, 'BTC tier 0 mmr', 1e-12)
  near(btc[1]!.mmr, 0.025, 'BTC tier 1 mmr', 1e-12)
  near(btc[1]!.deduction, 1_875_000, 'BTC tier 1 deduction', 1e-6) // 150M * (0.025 - 0.0125)
  near(maintenanceMargin(5_000_000, TIERS.BNB!).margin, 5_000_000 * 0.1 - 150_000, 'BNB 5M notional', 1e-6)
  for (const coin of COINS) {
    const s = maintenanceSchedule(TIERS[coin]!)
    for (const t of s.slice(1)) {
      const below = maintenanceMargin(t.lowerBound - 1e-6, TIERS[coin]!)
      const above = maintenanceMargin(t.lowerBound, TIERS[coin]!)
      assert.equal(below.tierIndex + 1, above.tierIndex)
      near(above.margin, below.margin, `${coin} continuous at ${t.lowerBound}`, 1e-4)
    }
  }
  assert.throws(() => maintenanceSchedule([]), RangeError)
  assert.throws(() => maintenanceSchedule([{ lowerBound: 10, maxLeverage: 5 }]), RangeError)
})

// --- single positions vs 006F-5 ---------------------------------------------------

/** 006F-5 theory (B) and the engine/monitor runs (A) for the same scenarios. */
const CASES: { name: string; side: 'LONG' | 'SHORT'; L: number; N: number; liq: number | null; final: number | null; engine: string }[] = [
  { name: 'LONG 1x near all capital', side: 'LONG', L: 1, N: 990, liq: null, final: null, engine: 'never liquidated (1x not monitored)' },
  { name: 'SHORT 1x near all capital', side: 'SHORT', L: 1, N: 990, liq: 198.46, final: 23.18, engine: 'never liquidated; -485.69 equity at 250' },
  { name: 'LONG 2x margin 500', side: 'LONG', L: 2, N: 1000, liq: 0.07, final: 0.01, engine: 'liquidated at 25.07 -> 249.72' },
  { name: 'SHORT 2x margin 500', side: 'SHORT', L: 2, N: 1000, liq: 197.46, final: 23.30, engine: 'liquidated at 174.93 -> 248.68' },
  { name: 'LONG 3x margin 500', side: 'LONG', L: 3, N: 1500, liq: 33.83, final: 5.99, engine: 'liquidated at 50.07 -> 249.32' },
  { name: 'SHORT 3x margin 500', side: 'SHORT', L: 3, N: 1500, liq: 164.54, final: 29.12, engine: 'liquidated at 149.93 -> 248.28' },
  { name: 'LONG 5x margin 500', side: 'LONG', L: 5, N: 2500, liq: 60.83, final: 17.94, engine: 'liquidated at 70.07 -> 248.52' },
  { name: 'SHORT 5x margin 500', side: 'SHORT', L: 5, N: 2500, liq: 138.20, final: 40.77, engine: 'liquidated at 129.93 -> 247.48' },
  { name: 'LONG 5x margin 990', side: 'LONG', L: 5, N: 4950, liq: 80.88, final: 47.24, engine: 'liquidated at 89.87 -> 491.39' },
  { name: 'SHORT 5x margin 990', side: 'SHORT', L: 5, N: 4950, liq: 118.65, final: 69.30, engine: 'liquidated at 110.13 -> 490.69' },
]

for (const c of CASES) {
  test(`BTC ${c.name}: liquidation price and capital vs 006F-5`, (t) => {
    const input = single('BTC', c.side, c.N, c.L)
    const lp = liquidationPrice(input, 'BTC')
    if (c.liq === null) {
      assert.equal(lp.price, null)
      assert.match(lp.reason, /not reachable/)
      // a long at 1x keeps a positive account value even at a near-zero price
      assert.equal(crossState(at(input, 'BTC', 0.01)).liquidatable, false)
      t.diagnostic(`calculator: no liquidation | engine: ${c.engine}`)
      return
    }
    near(lp.price, c.liq, 'liquidation price')
    assert.equal(lp.reason, 'official cross formula')
    const final = finalCapital(input, 'BTC', lp.price!)
    near(final, c.final!, 'theoretical final capital')
    // above / below the threshold by one cent
    const away = c.side === 'LONG' ? 0.01 : -0.01
    assert.equal(crossState(at(input, 'BTC', lp.price! + away)).liquidatable, false, 'one cent before')
    assert.equal(crossState(at(input, 'BTC', lp.price! - away)).liquidatable, true, 'one cent after')
    const pnl = final - CAPITAL
    t.diagnostic(`calculator: liq ${lp.price!.toFixed(2)}, final ${final.toFixed(2)} (P&L ${pnl.toFixed(2)} USDC, ${(pnl / 10).toFixed(2)}%), not simulated | engine: ${c.engine}`)
  })
}

test('same notional, different leverage: one cross liquidation price', () => {
  const prices = [2, 3, 5].map((L) => [liquidationPrice(single('BTC', 'LONG', 1500, L), 'BTC').price!, liquidationPrice(single('BTC', 'SHORT', 1500, L), 'BTC').price!])
  for (const [long, short] of prices) {
    near(long, 33.83, 'long')
    near(short, 164.54, 'short')
  }
  assert.equal(prices[0]![0], prices[2]![0])
  // engine (006F-5): LONG 58.40 / 50.07 / 43.40, SHORT 141.60 / 149.93 / 156.60
})

test('small position: a 3x short of 100 USDC is liquidated near +986%', () => {
  near(liquidationPrice(single('BTC', 'SHORT', 100, 3), 'BTC').price, 1086.35, 'short')
  assert.equal(liquidationPrice(single('BTC', 'LONG', 100, 3), 'BTC').price, null)
})

test('10x-max coin (BNB): higher maintenance rate, earlier liquidation', () => {
  near(liquidationPrice(single('BNB', 'LONG', 4950, 5), 'BNB').price, 84.07, 'long')
  near(liquidationPrice(single('BNB', 'SHORT', 4950, 5), 'BNB').price, 114.41, 'short')
})

test('matches the documented formula liq = price - side * margin_available / size / (1 - l * side)', () => {
  const input = single('ETH', 'SHORT', 2500, 5)
  const s = crossState(input)
  const l = 1 / 50
  const expected = 100 - (-1 * s.buffer!) / 25 / (1 - l * -1)
  near(liquidationPrice(input, 'ETH').price, expected, 'formula', 1e-9)
})

// --- accounts with several positions, gaps, missing prices -----------------------

test('two positions: Y short liquidation with X held in profit (006F-5 S10)', () => {
  const input: CrossInput = {
    collateral: CAPITAL - FEE * (1500 + 800),
    positions: [
      { coin: 'BTC', side: 'LONG', size: 15, entryPrice: 100, leverage: 3 },
      { coin: 'ETH', side: 'SHORT', size: 8, entryPrice: 100, leverage: 2 },
    ],
    markPrices: { BTC: 110, ETH: 100 },
    tiers: { BTC: [{ lowerBound: 0, maxLeverage: 40 }], ETH: [{ lowerBound: 0, maxLeverage: 40 }] },
  }
  const lp = liquidationPrice(input, 'ETH')
  near(lp.price, 238.0, 'Y liquidation price', 0.01)
  assert.equal(lp.conditional, true)
  near(finalCapital(input, 'ETH', lp.price!), 41.94, 'final capital', 0.01) // engine: 187.30 -> 447.71
  assert.equal(crossState(at(input, 'ETH', lp.price! - 0.01)).liquidatable, false)
  assert.equal(crossState(at(input, 'ETH', lp.price! + 0.01)).liquidatable, true)
})

test('gap: SHORT 3x from 100 straight to 200 is below the backstop with a shortfall', () => {
  const s = crossState(single('BTC', 'SHORT', 1500, 3, 200))
  near(s.accountValue, -501.05, 'account value')
  assert.equal(s.liquidatable, true)
  assert.equal(s.belowBackstop, true)
  near(s.shortfall, 501.05, 'shortfall the vault would absorb')
  // engine (006F-5 S11): closed at 200 with cash -503.15
})

test('backstop boundary: between 2/3 and 1x maintenance it is liquidatable but not backstop', () => {
  const input = single('BTC', 'SHORT', 4950, 5)
  const lp = liquidationPrice(input, 'BTC').price!
  const s = crossState(at(input, 'BTC', lp + 0.05))
  assert.equal(s.liquidatable, true)
  assert.equal(s.belowBackstop, false)
  assert.ok(s.accountValue! > (2 / 3) * s.maintenanceMargin!)
})

test('missing or invalid mark price: no decision, no zeros', () => {
  for (const mark of [undefined, null, 0, -5, Number.NaN]) {
    const s = crossState({ ...single('BTC', 'SHORT', 1500, 3), markPrices: { BTC: mark as number } })
    assert.equal(s.status, 'incomplete')
    assert.equal(s.accountValue, null)
    assert.equal(s.liquidatable, null)
    assert.equal(s.belowBackstop, null)
    assert.ok(s.issues.some((i) => i.includes('mark price')))
  }
  const lp = liquidationPrice({ ...single('BTC', 'SHORT', 1500, 3), markPrices: {} }, 'BTC')
  assert.equal(lp.price, null)
  assert.match(lp.reason, /not computable/)
  const noTiers = crossState({ ...single('BTC', 'SHORT', 1500, 3), tiers: {} })
  assert.equal(noTiers.status, 'incomplete')
})

test('tier change during the move: the price is recomputed with the new tier', () => {
  // 25,000 BNB short at 100 (2.5M notional, tier 0); the account fails in tier 1
  const input: CrossInput = {
    collateral: 2_000_000,
    positions: [{ coin: 'BNB', side: 'SHORT', size: 25_000, entryPrice: 100, leverage: 2 }],
    markPrices: { BNB: 100 },
    tiers: TIERS,
  }
  const lp = liquidationPrice(input, 'BNB')
  near(lp.price, 4_650_000 / 27_500, 'tier-1 solution', 1e-6) // 2M + 2.5M - 25000 P = 2500 P - 150000
  assert.ok(lp.price! * 25_000 > 3_000_000)
  assert.equal(crossState(at(input, 'BNB', lp.price! - 0.01)).liquidatable, false)
  assert.equal(crossState(at(input, 'BNB', lp.price! + 0.01)).liquidatable, true)
})

test('account without positions, leverage above the tier maximum, input left untouched', () => {
  const empty = crossState({ collateral: 1000, positions: [], markPrices: {}, tiers: TIERS })
  assert.deepEqual([empty.status, empty.accountValue, empty.liquidatable, empty.belowBackstop], ['ok', 1000, false, false])
  const over = crossState(single('BNB', 'LONG', 1500, 20))
  assert.equal(over.status, 'ok')
  assert.ok(over.issues.includes('BNB: leverage 20 above the tier maximum'))
  near(over.positions[0]!.initialMargin, 75, 'initial margin informative')
  const input = single('BTC', 'SHORT', 990, 1)
  const frozen = Object.freeze({ ...input, positions: Object.freeze(input.positions.map((p) => Object.freeze({ ...p }))) as CrossPosition[] })
  const copy = structuredClone(frozen)
  crossState(frozen); liquidationPrice(frozen, 'BTC')
  assert.deepEqual(frozen, copy)
})
