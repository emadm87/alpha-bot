/**
 * Tests for hyperliquidMarginData.ts (Task 006G-1).
 *
 * Run: npx tsx --test src/services/hyperliquidMarginData.test.ts
 *
 * MAC is a fixed excerpt of the public `metaAndAssetCtxs` response read on
 * 2026-10-24 00:10 UTC (universe entries, their contexts in the same order,
 * and the margin tables they use): BTC, ETH, SOL, BNB, DOGE, XRP, ATOM
 * (table 5, not in the response: single tier 5x, Task 006G-5) and MATIC
 * (delisted). The network is
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
    { coin: 'XYZ', side: 'SHORT' as const, size: 10, entryPrice: 1.7 },
  ]
  const p = prepareCrossInput({ collateral: 1000, positions, marks: marksOf(), tables: tablesOf(), now: T + 1000 })
  assert.equal(p.status, 'not_evaluable')
  assert.ok(!('input' in p))
  if (p.status === 'not_evaluable') {
    assert.deepEqual(p.reasons, ['XYZ unsupported', 'XYZ not in the meta universe'])
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

// --- margin table ids below 50 (Task 006G-5) -------------------------------------
// Hyperliquid docs, Trading > Margin tiers: "For IDs < 50, there is a single
// tier with max leverage equal to ID". Ids from 50 up need their listed table.

const { maintenanceMargin, singleTierFromId } = await import('./hyperliquidMargin.js')
/** META with one universe entry changed (or added) for coin. */
function withAsset(entry: Record<string, unknown>, tablesPatch?: (t: unknown[]) => void) {
  const raw = clone(MAC)
  const universe = (raw[0] as any).universe as Record<string, unknown>[]
  const i = universe.findIndex((u) => u.name === entry.name)
  if (i >= 0) universe[i] = { szDecimals: 2, ...entry }
  else {
    universe.push({ szDecimals: 2, ...entry })
    ;(raw[1] as unknown[]).push({ markPx: '2.0' })
  }
  tablesPatch?.((raw[0] as any).marginTables)
  return raw
}

test('ATOM (id 5, maxLeverage 5, no listed table): single 5x tier, valid', () => {
  const atom = evaluateCoin('ATOM', marksOf(), tablesOf(), { now: T + 1000 })
  assert.equal(atom.status, 'valid', String(atom.issues))
  assert.deepEqual(atom.tiers, [{ lowerBound: 0, maxLeverage: 5 }])
  assert.equal(atom.maxLeverage, 5)
  assert.equal(atom.markPrice, 1.6939)
  assert.deepEqual(singleTierFromId(5, 5), { tiers: [{ lowerBound: 0, maxLeverage: 5 }] })
})

test('ATOM maintenance margin on 1,000 USDC notional is 100 USDC (mmr 1/(2*5))', () => {
  const tiers = evaluateCoin('ATOM', marksOf(), tablesOf(), { now: T }).tiers!
  const m = maintenanceMargin(1000, tiers)
  assert.ok(Math.abs(m.margin - 100) < 1e-9, String(m.margin))
  assert.equal(m.mmr, 0.1)
  assert.equal(m.deduction, 0)
})

test('id below 50 that does not match maxLeverage: refused', () => {
  const c = evaluateCoin('ATOM', marksOf(), tablesOf(withAsset({ name: 'ATOM', maxLeverage: 10, marginTableId: 5 })), { now: T })
  assert.equal(c.status, 'unsupported')
  assert.deepEqual(c.tiers, null)
  assert.deepEqual(c.issues, ['ATOM: margin table 5 implies 5x, asset maxLeverage is 10'])
})

test('id zero, negative, decimal or missing: refused', () => {
  for (const id of [0, -5, 2.5, '7.5']) {
    const raw = withAsset({ name: 'ATOM', maxLeverage: Number(id), marginTableId: id })
    const c = evaluateCoin('ATOM', marksOf(raw), tablesOf(raw), { now: T })
    assert.equal(c.status, 'unsupported', String(id))
    assert.deepEqual(c.issues, [`ATOM: margin table ${Number(id)} is not a single-tier id (integer 1-49)`])
  }
  for (const id of [undefined, null, '', 'abc']) {
    const raw = withAsset({ name: 'ATOM', maxLeverage: 5, marginTableId: id })
    assert.deepEqual(parseMetaResponse(raw, T), { error: 'ATOM: maxLeverage or marginTableId missing' })
  }
})

test('id 50 or above without a listed table: refused', () => {
  for (const id of [50, 57, 99]) {
    const c = evaluateCoin('ATOM', marksOf(), tablesOf(withAsset({ name: 'ATOM', maxLeverage: 5, marginTableId: id })), { now: T })
    assert.equal(c.status, 'unsupported')
    assert.deepEqual(c.issues, [`ATOM: margin table ${id} not available`])
  }
  // BTC without its table 56
  const noBtc = withAsset({ name: 'BTC', maxLeverage: 40, marginTableId: 56 }, (t) => t.splice(5, 1))
  assert.deepEqual(evaluateCoin('BTC', marksOf(noBtc), tablesOf(noBtc), { now: T }).issues, ['BTC: margin table 56 not available'])
})

test('id 50 or above with a valid listed table: used as listed', () => {
  const raw = withAsset({ name: 'NEW', maxLeverage: 3, marginTableId: 60 }, (t) =>
    t.push([60, { marginTiers: [{ lowerBound: '0.0', maxLeverage: 3 }, { lowerBound: '1000000.0', maxLeverage: 2 }] }]))
  const c = evaluateCoin('NEW', marksOf(raw), tablesOf(raw), { now: T })
  assert.equal(c.status, 'valid', String(c.issues))
  assert.deepEqual(c.tiers, [{ lowerBound: 0, maxLeverage: 3 }, { lowerBound: 1_000_000, maxLeverage: 2 }])
})

test('malformed listed table: refused, never replaced by a presumed single tier', () => {
  // a listed table for an id below 50 that fails validation
  const raw = withAsset({ name: 'ATOM', maxLeverage: 5, marginTableId: 5 }, (t) =>
    t.push([5, { marginTiers: [{ lowerBound: '10.0', maxLeverage: 5 }] }]))
  const tables = tablesOf(raw)
  assert.ok(tables.issues.includes('margin table 5 rejected: first tier does not start at 0'))
  const c = evaluateCoin('ATOM', marksOf(raw), tables, { now: T })
  assert.equal(c.status, 'unsupported')
  assert.deepEqual(c.issues, ['ATOM: margin table 5 rejected: first tier does not start at 0'])
  // a listed table for an id below 50 that disagrees with maxLeverage
  const other = withAsset({ name: 'ATOM', maxLeverage: 5, marginTableId: 5 }, (t) =>
    t.push([5, { marginTiers: [{ lowerBound: '0.0', maxLeverage: 4 }] }]))
  const o = evaluateCoin('ATOM', marksOf(other), tablesOf(other), { now: T })
  assert.equal(o.status, 'incomplete')
  assert.match(o.issues[0]!, /differs from tier 0/)
  // a malformed table with id 50 or above
  const btc = withAsset({ name: 'BTC', maxLeverage: 40, marginTableId: 56 }, (t) => {
    ;(t[5] as any)[1].marginTiers = [{ lowerBound: '0.0', maxLeverage: 'x' }]
  })
  assert.equal(evaluateCoin('BTC', marksOf(btc), tablesOf(btc), { now: T }).status, 'unsupported')
})

test('single-tier asset still refused when delisted, without mark price or stale', () => {
  const delisted = withAsset({ name: 'ATOM', maxLeverage: 5, marginTableId: 5, isDelisted: true })
  assert.deepEqual(evaluateCoin('ATOM', marksOf(delisted), tablesOf(delisted), { now: T }).issues, ['ATOM is delisted'])
  const noMark = clone(MAC)
  ;(noMark[1] as any)[6].markPx = null
  assert.equal(evaluateCoin('ATOM', marksOf(noMark), tablesOf(noMark), { now: T }).status, 'incomplete')
  const positions = [{ coin: 'ATOM', side: 'SHORT' as const, size: 100, entryPrice: 1.7, leverage: 5 }]
  for (const p of [
    prepareCrossInput({ collateral: 1000, positions, marks: marksOf(noMark), tables: tablesOf(noMark), now: T }),
    prepareCrossInput({ collateral: 1000, positions, marks: marksOf(), tables: tablesOf(), now: T + 120_000 }),
    prepareCrossInput({ collateral: 1000, positions, marks: marksOf(), tables: tablesOf(), now: T + 25 * 3_600_000 }),
  ]) assert.equal(p.status, 'not_evaluable')
})

test('the six main coins keep their listed tables', () => {
  const tables = tablesOf()
  const listed: Record<number, unknown> = Object.fromEntries(
    (META.marginTables as [number, { marginTiers: { lowerBound: string; maxLeverage: number }[] }][]).map(([id, t]) => [
      id, t.marginTiers.map((x) => ({ lowerBound: Number(x.lowerBound), maxLeverage: x.maxLeverage })),
    ]),
  )
  for (const coin of SIX) {
    const asset = META.universe.find((u) => u.name === coin)!
    assert.ok(asset.marginTableId >= 50)
    assert.deepEqual(evaluateCoin(coin, marksOf(), tables, { now: T }).tiers, listed[asset.marginTableId], coin)
  }
})

test('prepareCrossInput with BTC and ATOM: ready, ATOM margined at 5x tier', () => {
  const positions = [
    { coin: 'BTC', side: 'LONG' as const, size: 0.01, entryPrice: 81000, leverage: 2 },
    { coin: 'ATOM', side: 'SHORT' as const, size: 590.35, entryPrice: 1.6939, leverage: 5 },
  ]
  const p = prepareCrossInput({ collateral: 1000, positions, marks: marksOf(), tables: tablesOf(), now: T + 1000 })
  assert.equal(p.status, 'ready')
  if (p.status !== 'ready') return
  assert.deepEqual(p.input.tiers.ATOM, [{ lowerBound: 0, maxLeverage: 5 }])
  const s = crossState(p.input)
  const atom = s.positions.find((x) => x.coin === 'ATOM')!
  assert.ok(Math.abs(atom.maintenanceMargin! - 590.35 * 1.6939 * 0.1) < 1e-9)
  assert.ok(liquidationPrice(p.input, 'ATOM').price! > 1.6939)
})

test('margin table diff follows the single tier of an id below 50', () => {
  const before = tablesOf()
  const after = tablesOf(withAsset({ name: 'ATOM', maxLeverage: 3, marginTableId: 3 }))
  assert.deepEqual(diffMarginTables(before, after, ['ATOM']), [
    'ATOM: maxLeverage 5 -> 3',
    'ATOM: margin table 5 -> 3',
    'ATOM: tiers [{"lowerBound":0,"maxLeverage":5}] -> [{"lowerBound":0,"maxLeverage":3}]',
  ])
})

test('single-tier inputs are not modified', () => {
  const raw = clone(MAC)
  const copy = clone(raw)
  const tables = tablesOf(raw)
  const marks = marksOf(raw)
  const positions = [{ coin: 'ATOM', side: 'LONG' as const, size: 10, entryPrice: 1.7, leverage: 5 }]
  const positionsCopy = clone(positions)
  const p = prepareCrossInput({ collateral: 1000, positions, marks, tables, now: T })
  assert.equal(p.status, 'ready')
  assert.deepEqual(raw, copy)
  assert.deepEqual(positions, positionsCopy)
  assert.equal(tables.tables.has(5), false) // the single tier is not stored as a listed table
})
