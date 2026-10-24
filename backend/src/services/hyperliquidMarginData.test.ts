/**
 * Tests for hyperliquidMarginData.ts (Task 006G-1).
 *
 * Run: npx tsx --test src/services/hyperliquidMarginData.test.ts
 *
 * MAC is a fixed excerpt of the public `metaAndAssetCtxs` response read on
 * 2026-10-24 00:10 UTC (universe entries, their contexts in the same order,
 * and the margin tables they use): BTC, ETH, SOL, BNB, DOGE, XRP, ATOM
 * (table 5, not in the response) and MATIC (delisted). The network is
 * disabled: every request goes through injected fetch functions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch
process.env.LOG_LEVEL = 'error'

const {
  diffMarginTables,
  evaluateCoin,
  fetchInfo,
  marksFromAssetContexts,
  parseMarks,
  parseMetaResponse,
  prepareCrossInput,
} = await import('./hyperliquidMarginData.js')
const { crossState, liquidationPrice } = await import('./hyperliquidMargin.js')
type MarginTables = Exclude<ReturnType<typeof parseMetaResponse>, { error: string }>

const META = {
    universe: [
      { szDecimals: 5, name: 'BTC', maxLeverage: 40, marginTableId: 56 },
      { szDecimals: 4, name: 'ETH', maxLeverage: 25, marginTableId: 55 },
      { szDecimals: 2, name: 'SOL', maxLeverage: 20, marginTableId: 54 },
      { szDecimals: 3, name: 'BNB', maxLeverage: 10, marginTableId: 51 },
      { szDecimals: 0, name: 'DOGE', maxLeverage: 10, marginTableId: 52 },
      { szDecimals: 0, name: 'XRP', maxLeverage: 20, marginTableId: 53 },
      { szDecimals: 2, name: 'ATOM', maxLeverage: 5, marginTableId: 5 },
      { szDecimals: 1, name: 'MATIC', maxLeverage: 20, marginTableId: 20, isDelisted: true },
    ],
    marginTables: [
      [51, { description: 'tiered 10x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 10 }, { lowerBound: '3000000.0', maxLeverage: 5 }] }],
      [52, { description: 'tiered 10x (2)', marginTiers: [{ lowerBound: '0.0', maxLeverage: 10 }, { lowerBound: '20000000.0', maxLeverage: 5 }] }],
      [53, { description: 'tiered 20x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '40000000.0', maxLeverage: 10 }] }],
      [54, { description: 'tiered 20x (2)', marginTiers: [{ lowerBound: '0.0', maxLeverage: 20 }, { lowerBound: '70000000.0', maxLeverage: 10 }] }],
      [55, { description: 'tiered 25x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 25 }, { lowerBound: '100000000.0', maxLeverage: 15 }] }],
      [56, { description: 'tiered 40x', marginTiers: [{ lowerBound: '0.0', maxLeverage: 40 }, { lowerBound: '150000000.0', maxLeverage: 20 }] }],
    ],
    collateralToken: 0,
}
const CTXS: Record<string, unknown>[] = [
    { funding: '0.0000125', openInterest: '44354.5107', prevDayPx: '81222.0', oraclePx: '81045.9', markPx: '81034.0', midPx: '81035.5' },
    { funding: '-0.0000018134', openInterest: '1079763.6356', prevDayPx: '2387.6', oraclePx: '2384.08', markPx: '2382.8', midPx: '2383.15' },
    { funding: '-0.0000128275', openInterest: '5396135.58', prevDayPx: '103.59', oraclePx: '102.69', markPx: '102.63', midPx: '102.635' },
    { funding: '0.0000125', openInterest: '58399.456', prevDayPx: '730.63', oraclePx: '738.874', markPx: '738.68', midPx: '738.73' },
    { funding: '-0.0000144996', openInterest: '1096692072.0', prevDayPx: '0.078812', oraclePx: '0.078589', markPx: '0.078539', midPx: '0.078552' },
    { funding: '0.0000125', openInterest: '173937708.0', prevDayPx: '1.3078', oraclePx: '1.293329', markPx: '1.2929', midPx: '1.29295' },
    { funding: '-0.0000051285', openInterest: '2175126.34', prevDayPx: '1.7166', oraclePx: '1.6961', markPx: '1.6939', midPx: '1.6954' },
    { funding: '0.0', openInterest: '0.0', prevDayPx: '0.37621', oraclePx: '0.3754', markPx: '0.37621', midPx: null },
]
const MAC = [META, CTXS]
const SIX = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE', 'XRP']
const T = Date.UTC(2026, 9, 24, 0, 10, 27)
const clone = <V>(v: V): V => structuredClone(v)

function tablesOf(raw: unknown = MAC, at = T): MarginTables {
  const t = parseMetaResponse(raw, at)
  assert.ok(!('error' in t), JSON.stringify(t))
  return t as MarginTables
}
function marksOf(raw: unknown = MAC, at = T) {
  const m = parseMarks(raw, at)
  assert.ok(!('error' in m), JSON.stringify(m))
  return m as Exclude<typeof m, { error: string }>
}
/** A 006E-style asset context: universe entry merged with its context. */
const ctxOf = (i: number, receivedAt = T) => ({
  info: { ...META.universe[i], ...CTXS[i] } as Record<string, unknown>,
  receivedAt,
})

test('official snapshot: the six coins are valid, with markPx (not midPx) and their tables', () => {
  const tables = tablesOf()
  const marks = marksOf()
  assert.deepEqual(tables.issues, [])
  for (const coin of SIX) {
    const c = evaluateCoin(coin, marks, tables, { now: T + 1000 })
    assert.equal(c.status, 'valid', `${coin}: ${c.issues}`)
    assert.equal(c.markAgeMs, 1000)
  }
  const btc = evaluateCoin('BTC', marks, tables, { now: T + 1000 })
  assert.equal(btc.markPrice, 81034.0) // midPx 81035.5 is not used
  assert.deepEqual(btc.tiers, [{ lowerBound: 0, maxLeverage: 40 }, { lowerBound: 150_000_000, maxLeverage: 20 }])
  assert.equal(btc.maxLeverage, 40)
  assert.deepEqual(evaluateCoin('BNB', marks, tables, { now: T }).tiers, [{ lowerBound: 0, maxLeverage: 10 }, { lowerBound: 3_000_000, maxLeverage: 5 }])
  assert.equal(marks.BTC!.priceUpdateTime, null)
})

test('ready input feeds hyperliquidMargin unchanged', () => {
  const p = prepareCrossInput({
    collateral: 1000 - 0.0007 * 990,
    positions: [{ coin: 'BTC', side: 'SHORT', size: 990 / 81034, entryPrice: 81034, leverage: 1 }],
    marks: marksOf(), tables: tablesOf(), now: T + 5000,
  })
  assert.equal(p.status, 'ready')
  if (p.status !== 'ready') return
  assert.deepEqual(p.input.markPrices, { BTC: 81034 })
  const s = crossState(p.input)
  assert.equal(s.status, 'ok')
  assert.equal(s.liquidatable, false)
  // same relative threshold as 006G-0 (SHORT 1x near all capital: +98.46%)
  const lp = liquidationPrice(p.input, 'BTC').price!
  assert.ok(Math.abs(lp / 81034 - 1.9846) < 0.0001, String(lp / 81034))
})

test('missing, zero, negative or non-numeric mark price: incomplete, never the mid price', () => {
  for (const bad of [undefined, null, '', '0', '0.0', '-5', 'abc']) {
    const raw = clone(MAC)
    ;(raw[1] as Record<string, unknown>[])[0]!.markPx = bad
    const c = evaluateCoin('BTC', marksOf(raw), tablesOf(), { now: T })
    assert.equal(c.status, 'incomplete', `markPx ${String(bad)}`)
    assert.equal(c.markPrice, null)
    assert.ok(c.issues.some((i) => i.includes('markPx missing or invalid')))
  }
  // same rule for the contexts kept by the price path
  const read = () => ({ info: { name: 'BTC', midPx: '81035.5', markPx: null }, receivedAt: T })
  const q = marksFromAssetContexts(['BTC'], read)
  assert.equal(q.BTC!.markPrice, null)
  assert.equal(evaluateCoin('BTC', q, tablesOf(), { now: T }).status, 'incomplete')
})

test('margin information missing or invalid: unsupported, tables not invented', () => {
  const tables = tablesOf()
  assert.deepEqual(evaluateCoin('ATOM', marksOf(), tables, { now: T }).issues, ['ATOM: margin table 5 not available'])
  assert.equal(evaluateCoin('ATOM', marksOf(), tables, { now: T }).status, 'unsupported')
  const raw = clone(MAC)
  ;(raw[0] as any).marginTables[5][1].marginTiers = [{ lowerBound: '10.0', maxLeverage: 40 }]
  const broken = tablesOf(raw)
  assert.ok(broken.issues.includes('margin table 56 rejected: first tier does not start at 0'))
  assert.equal(evaluateCoin('BTC', marksOf(), broken, { now: T }).status, 'unsupported')
  const growing = clone(MAC)
  ;(growing[0] as any).marginTables[0][1].marginTiers[1].maxLeverage = 20
  assert.ok(tablesOf(growing).issues.includes('margin table 51 rejected: max leverage grows with notional'))
  const mismatch = clone(MAC)
  ;(mismatch[0] as any).universe[0].maxLeverage = 50
  const c = evaluateCoin('BTC', marksOf(), tablesOf(mismatch), { now: T })
  assert.equal(c.status, 'incomplete')
  assert.match(c.issues[0]!, /differs from tier 0/)
})

test('unsupported or delisted symbol', () => {
  assert.equal(evaluateCoin('XYZ', marksOf(), tablesOf(), { now: T }).status, 'unsupported')
  const matic = evaluateCoin('MATIC', marksOf(), tablesOf(), { now: T })
  assert.equal(matic.status, 'unsupported')
  assert.deepEqual(matic.issues, ['MATIC is delisted'])
})

test('incomplete API responses are refused', () => {
  assert.deepEqual(parseMetaResponse({ universe: [] }, T), { error: 'incomplete meta response: universe or marginTables missing' })
  assert.deepEqual(parseMetaResponse([{}], T), { error: 'incomplete meta response: universe or marginTables missing' })
  const dup = clone(MAC)
  ;(dup[0] as any).universe.push({ name: 'BTC', maxLeverage: 40, marginTableId: 56 })
  assert.deepEqual(parseMetaResponse(dup, T), { error: 'duplicate universe entry BTC' })
  const noId = clone(MAC)
  delete (noId[0] as any).universe[1].marginTableId
  assert.deepEqual(parseMetaResponse(noId, T), { error: 'ETH: maxLeverage or marginTableId missing' })
  assert.deepEqual(parseMarks([MAC[0]], T), { error: 'incomplete metaAndAssetCtxs response' })
  assert.deepEqual(parseMarks('nope', T), { error: 'incomplete metaAndAssetCtxs response' })
  assert.deepEqual(parseMetaResponse(MAC, Number.NaN), { error: 'receipt time missing' })
})

test('freshness: mark price and tables beyond configurable limits are stale', () => {
  const tables = tablesOf()
  const marks = marksOf()
  assert.equal(evaluateCoin('BTC', marks, tables, { now: T + 60_000 }).status, 'valid')
  const stale = evaluateCoin('BTC', marks, tables, { now: T + 61_000 })
  assert.equal(stale.status, 'stale')
  assert.ok(stale.issues.includes('BTC: mark price 61 s old'))
  assert.equal(evaluateCoin('BTC', marks, tables, { now: T + 10_000, maxMarkAgeMs: 5_000 }).status, 'stale')
  // fresh prices with tables read more than 24 h earlier
  const oldTables = tablesOf(MAC, T - 25 * 3_600_000)
  const c = evaluateCoin('BTC', marks, oldTables, { now: T + 1000 })
  assert.equal(c.status, 'stale')
  assert.ok(c.issues.includes('margin tables 25 h old'))
  assert.equal(evaluateCoin('BTC', marks, oldTables, { now: T + 1000, maxTablesAgeMs: 48 * 3_600_000 }).status, 'valid')
  // a receipt time in the future is not trusted
  assert.equal(evaluateCoin('BTC', marks, tables, { now: T - 1000 }).status, 'incomplete')
})

test('price update time is not provided: only receipt time; without it nothing is evaluated', () => {
  const quote = marksOf().BTC!
  assert.equal(quote.priceUpdateTime, null)
  assert.equal(quote.receivedAt, T)
  const noTime = { BTC: { ...quote, receivedAt: null } }
  const c = evaluateCoin('BTC', noTime, tablesOf(), { now: T })
  assert.equal(c.status, 'incomplete')
  assert.deepEqual(c.issues, ['BTC: mark price without receipt time'])
  const nan = marksFromAssetContexts(['BTC'], () => ctxOf(0, Number.NaN))
  assert.equal(evaluateCoin('BTC', nan, tablesOf(), { now: T }).status, 'incomplete')
})

test('margin table changes are detected and the new table is used', () => {
  const before = tablesOf()
  const raw = clone(MAC)
  ;(raw[0] as any).marginTables[0][1].marginTiers[1].lowerBound = '2000000.0' // BNB tier 1 from 3M to 2M
  ;(raw[0] as any).universe[2].marginTableId = 53 // SOL moved to table 53
  const after = tablesOf(raw, T + 3_600_000)
  assert.deepEqual(diffMarginTables(before, after, SIX), [
    'SOL: margin table 54 -> 53',
    'SOL: tiers [{"lowerBound":0,"maxLeverage":20},{"lowerBound":70000000,"maxLeverage":10}] -> [{"lowerBound":0,"maxLeverage":20},{"lowerBound":40000000,"maxLeverage":10}]',
    'BNB: tiers [{"lowerBound":0,"maxLeverage":10},{"lowerBound":3000000,"maxLeverage":5}] -> [{"lowerBound":0,"maxLeverage":10},{"lowerBound":2000000,"maxLeverage":5}]',
  ])
  assert.deepEqual(diffMarginTables(before, before, SIX), [])
  assert.equal(evaluateCoin('BNB', marksOf(), after, { now: T + 3_600_000 }).tiers![1]!.lowerBound, 2_000_000)
})

test('wrong symbol/context association is refused', () => {
  // contexts kept by the price path carry their name: a mismatch is rejected
  const q = marksFromAssetContexts(['BTC'], () => ctxOf(1)) // ETH context returned for BTC
  assert.equal(q.BTC!.markPrice, null)
  assert.equal(q.BTC!.issue, 'asset context belongs to ETH')
  assert.equal(evaluateCoin('BTC', q, tablesOf(), { now: T }).status, 'incomplete')
  // raw contexts have no name: different lengths make the pairing unknown
  const raw = clone(MAC)
  ;(raw[1] as unknown[]).pop()
  assert.deepEqual(parseMarks(raw, T), { error: 'universe (8) and contexts (7) do not match' })
  // correct association through the existing contexts
  const ok = marksFromAssetContexts(SIX, (coin) => ctxOf(META.universe.findIndex((u) => u.name === coin)))
  for (const coin of SIX) assert.equal(evaluateCoin(coin, ok, tablesOf(), { now: T + 1 }).status, 'valid')
  assert.equal(ok.DOGE!.markPrice, 0.078539)
})

test('no asset context recorded yet (default reader of the 006E store)', () => {
  const q = marksFromAssetContexts(['BTC'])
  assert.equal(q.BTC!.issue, 'no asset context received yet')
  assert.equal(evaluateCoin('BTC', q, tablesOf(), { now: T }).status, 'incomplete')
})

test('timeout, HTTP error, invalid JSON and unreachable service', async () => {
  // AbortSignal.timeout does not keep the process alive; a real socket would
  const keepAlive = setTimeout(() => {}, 1000)
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))
    })
  assert.deepEqual(await fetchInfo({ type: 'meta' }, { fetchImpl: hang, timeoutMs: 30 }), { error: 'timeout after 30 ms' })
  const http500 = (async () => new Response('busy', { status: 500 })) as typeof fetch
  assert.deepEqual(await fetchInfo({ type: 'meta' }, { fetchImpl: http500 }), { error: 'HTTP 500' })
  const badJson = (async () => new Response('{not json', { status: 200 })) as typeof fetch
  assert.match((await fetchInfo({ type: 'meta' }, { fetchImpl: badJson }) as { error: string }).error, /^unavailable: /)
  assert.match((await fetchInfo({ type: 'meta' }) as { error: string }).error, /network disabled in tests/)
  // a successful answer keeps its receipt time and the body sent
  let sent = ''
  const ok = (async (_u: unknown, init?: RequestInit) => { sent = String(init?.body); return Response.json(MAC) }) as typeof fetch
  const r = await fetchInfo({ type: 'metaAndAssetCtxs' }, { fetchImpl: ok })
  assert.ok('data' in r && Number.isFinite(r.receivedAt))
  assert.equal(sent, '{"type":"metaAndAssetCtxs"}')
  clearTimeout(keepAlive)
})

test('account not evaluable when any coin is not valid: no input, reasons listed', () => {
  const positions = [
    { coin: 'BTC', side: 'LONG' as const, size: 0.01, entryPrice: 81000 },
    { coin: 'ATOM', side: 'SHORT' as const, size: 10, entryPrice: 1.7 },
  ]
  const p = prepareCrossInput({ collateral: 1000, positions, marks: marksOf(), tables: tablesOf(), now: T + 1000 })
  assert.equal(p.status, 'not_evaluable')
  assert.ok(!('input' in p))
  if (p.status === 'not_evaluable') {
    assert.deepEqual(p.reasons, ['ATOM unsupported', 'ATOM: margin table 5 not available'])
  }
  const stale = prepareCrossInput({ collateral: 1000, positions: positions.slice(0, 1), marks: marksOf(), tables: tablesOf(), now: T + 120_000 })
  assert.equal(stale.status, 'not_evaluable')
  const nanCollateral = prepareCrossInput({ collateral: Number.NaN, positions: positions.slice(0, 1), marks: marksOf(), tables: tablesOf(), now: T })
  assert.equal(nanCollateral.status, 'not_evaluable')
})

test('inputs are not modified', () => {
  const raw = clone(MAC)
  const copy = clone(raw)
  const tables = tablesOf(raw)
  const marks = marksOf(raw)
  prepareCrossInput({ collateral: 1000, positions: [{ coin: 'BTC', side: 'LONG', size: 0.01, entryPrice: 81000 }], marks, tables, now: T })
  assert.deepEqual(raw, copy)
})
