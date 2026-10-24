/**
 * Data for the Hyperliquid cross margin calculator (Task 006G-1): mark prices
 * and margin tables, validated and turned into hyperliquidMargin inputs.
 * Not used by the bot: nothing imports it, so it adds no traffic.
 *
 * Sources (public info endpoint, POST /info):
 * - `meta` / `metaAndAssetCtxs`: `universe` (name, maxLeverage,
 *   marginTableId, isDelisted) and `marginTables`; `metaAndAssetCtxs` also
 *   returns the asset contexts (markPx...), matched to `universe` by index;
 * - the contexts the price path already keeps (getAssetContext, 006E): ccxt
 *   merges universe[i] and ctx[i], so they carry name, marginTableId and
 *   markPx, but ccxt drops `marginTables`.
 * Neither gives the time a mark price was computed: freshness can only be
 * measured from the time the response was received.
 * A coin without a valid mark price, with a missing or stale table, or not
 * supported, is never evaluated: no last/mid price is used in its place.
 */
import { getAssetContext, type AssetContext } from './hyperliquid.js'
import type { CrossInput, CrossPosition, MarginTier } from './hyperliquidMargin.js'
import { TICKER_MAX_AGE_MS } from './quantData.js'

export const INFO_URL = 'https://api.hyperliquid.xyz/info'
/** Margin tables older than this are stale (they change rarely). */
export const TABLES_MAX_AGE_MS = 24 * 3_600_000

export interface AssetMeta {
  coin: string
  maxLeverage: number
  marginTableId: number
  delisted: boolean
}

export interface MarginTables {
  /** Local time the meta response was received. */
  receivedAt: number
  assets: Map<string, AssetMeta>
  tables: Map<number, MarginTier[]>
  /** Tables rejected while parsing, with the reason. */
  issues: string[]
}

export interface MarkQuote {
  coin: string
  markPrice: number | null
  /** Local time the response carrying the price was received. */
  receivedAt: number | null
  /** The API gives no time for the mark price itself. */
  priceUpdateTime: null
  source: 'metaAndAssetCtxs' | 'assetContext'
  issue: string | null
}

export type CoinStatus = 'valid' | 'stale' | 'incomplete' | 'unsupported'

export interface CoinData {
  coin: string
  status: CoinStatus
  markPrice: number | null
  tiers: MarginTier[] | null
  maxLeverage: number | null
  markAgeMs: number | null
  tablesAgeMs: number
  issues: string[]
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function parseTiers(raw: unknown): MarginTier[] | string {
  if (!isObject(raw) || !Array.isArray(raw.marginTiers) || raw.marginTiers.length === 0) {
    return 'no marginTiers'
  }
  const tiers: MarginTier[] = []
  for (const t of raw.marginTiers) {
    const lowerBound = num(isObject(t) ? t.lowerBound : null)
    const maxLeverage = num(isObject(t) ? t.maxLeverage : null)
    if (lowerBound === null || lowerBound < 0 || maxLeverage === null || maxLeverage <= 0) {
      return `invalid tier ${JSON.stringify(t)}`
    }
    tiers.push({ lowerBound, maxLeverage })
  }
  if (tiers[0]!.lowerBound !== 0) return 'first tier does not start at 0'
  for (let i = 1; i < tiers.length; i++) {
    if (!(tiers[i]!.lowerBound > tiers[i - 1]!.lowerBound)) return 'tier bounds not increasing'
    if (tiers[i]!.maxLeverage > tiers[i - 1]!.maxLeverage) return 'max leverage grows with notional'
  }
  return tiers
}

/** Universe and margin tables from a `meta` or `metaAndAssetCtxs` response. */
export function parseMetaResponse(raw: unknown, receivedAt: number): MarginTables | { error: string } {
  const meta = Array.isArray(raw) ? raw[0] : raw
  if (!isObject(meta) || !Array.isArray(meta.universe) || !Array.isArray(meta.marginTables)) {
    return { error: 'incomplete meta response: universe or marginTables missing' }
  }
  if (!Number.isFinite(receivedAt)) return { error: 'receipt time missing' }
  const assets = new Map<string, AssetMeta>()
  for (const u of meta.universe) {
    if (!isObject(u) || typeof u.name !== 'string') return { error: 'universe entry without a name' }
    if (assets.has(u.name)) return { error: `duplicate universe entry ${u.name}` }
    const maxLeverage = num(u.maxLeverage)
    const marginTableId = num(u.marginTableId)
    if (maxLeverage === null || marginTableId === null) return { error: `${u.name}: maxLeverage or marginTableId missing` }
    assets.set(u.name, { coin: u.name, maxLeverage, marginTableId, delisted: u.isDelisted === true })
  }
  const tables = new Map<number, MarginTier[]>()
  const issues: string[] = []
  for (const entry of meta.marginTables) {
    const id = Array.isArray(entry) ? num(entry[0]) : null
    if (id === null) {
      issues.push(`margin table entry without an id: ${JSON.stringify(entry).slice(0, 80)}`)
      continue
    }
    const tiers = parseTiers(entry[1])
    if (typeof tiers === 'string') issues.push(`margin table ${id} rejected: ${tiers}`)
    else tables.set(id, tiers)
  }
  return { receivedAt, assets, tables, issues }
}

/** Mark prices of a `metaAndAssetCtxs` response, matched to universe by index. */
export function parseMarks(raw: unknown, receivedAt: number): Record<string, MarkQuote> | { error: string } {
  if (!Array.isArray(raw) || raw.length < 2 || !isObject(raw[0]) || !Array.isArray(raw[1])) {
    return { error: 'incomplete metaAndAssetCtxs response' }
  }
  const universe = raw[0].universe
  const ctxs = raw[1]
  if (!Array.isArray(universe) || universe.length !== ctxs.length) {
    // contexts carry no name: with different lengths the pairing is unknown
    return { error: `universe (${Array.isArray(universe) ? universe.length : 'none'}) and contexts (${ctxs.length}) do not match` }
  }
  const out: Record<string, MarkQuote> = {}
  universe.forEach((u, i) => {
    if (!isObject(u) || typeof u.name !== 'string') return
    const ctx = ctxs[i]
    const mark = num(isObject(ctx) ? ctx.markPx : null)
    out[u.name] = {
      coin: u.name,
      markPrice: mark !== null && mark > 0 ? mark : null,
      receivedAt,
      priceUpdateTime: null,
      source: 'metaAndAssetCtxs',
      issue: mark !== null && mark > 0 ? null : 'markPx missing or invalid',
    }
  })
  return out
}

/** Mark prices already kept by the price path (006E): no request is made. */
export function marksFromAssetContexts(
  coins: string[],
  read: (coin: string) => AssetContext | null = getAssetContext,
): Record<string, MarkQuote> {
  const out: Record<string, MarkQuote> = {}
  for (const coin of coins) {
    const ctx = read(coin)
    let issue: string | null = null
    let mark: number | null = null
    if (!ctx) issue = 'no asset context received yet'
    else if (ctx.info.name !== coin) issue = `asset context belongs to ${String(ctx.info.name)}`
    else {
      mark = num(ctx.info.markPx)
      if (mark === null || mark <= 0) {
        mark = null
        issue = 'markPx missing or invalid'
      }
    }
    out[coin] = {
      coin, markPrice: issue ? null : mark, receivedAt: ctx ? ctx.receivedAt : null,
      priceUpdateTime: null, source: 'assetContext', issue,
    }
  }
  return out
}

/** Whether one coin can be evaluated, and with which mark price and tiers. */
export function evaluateCoin(
  coin: string,
  marks: Record<string, MarkQuote>,
  tables: MarginTables,
  options: { now: number; maxMarkAgeMs?: number; maxTablesAgeMs?: number },
): CoinData {
  const maxMarkAgeMs = options.maxMarkAgeMs ?? TICKER_MAX_AGE_MS
  const maxTablesAgeMs = options.maxTablesAgeMs ?? TABLES_MAX_AGE_MS
  const tablesAgeMs = options.now - tables.receivedAt
  const base = { coin, markPrice: null, tiers: null, maxLeverage: null, markAgeMs: null, tablesAgeMs }

  const asset = tables.assets.get(coin)
  if (!asset) return { ...base, status: 'unsupported', issues: [`${coin} not in the meta universe`] }
  if (asset.delisted) return { ...base, status: 'unsupported', issues: [`${coin} is delisted`] }
  const tiers = tables.tables.get(asset.marginTableId)
  if (!tiers) {
    return { ...base, status: 'unsupported', issues: [`${coin}: margin table ${asset.marginTableId} not available`] }
  }
  const withTiers = { ...base, tiers, maxLeverage: asset.maxLeverage }
  if (tiers[0]!.maxLeverage !== asset.maxLeverage) {
    return { ...withTiers, status: 'incomplete', issues: [`${coin}: maxLeverage ${asset.maxLeverage} differs from tier 0 (${tiers[0]!.maxLeverage})`] }
  }

  const quote = marks[coin]
  if (!quote) return { ...withTiers, status: 'incomplete', issues: [`${coin}: no mark price quote`] }
  if (quote.issue || quote.markPrice === null) {
    return { ...withTiers, status: 'incomplete', issues: [`${coin}: ${quote.issue ?? 'mark price missing'}`] }
  }
  if (quote.receivedAt === null || !Number.isFinite(quote.receivedAt)) {
    return { ...withTiers, status: 'incomplete', issues: [`${coin}: mark price without receipt time`] }
  }
  const markAgeMs = options.now - quote.receivedAt
  const issues: string[] = []
  if (markAgeMs < 0) issues.push(`${coin}: mark price received in the future (${markAgeMs} ms)`)
  if (markAgeMs > maxMarkAgeMs) issues.push(`${coin}: mark price ${Math.round(markAgeMs / 1000)} s old`)
  if (tablesAgeMs > maxTablesAgeMs) issues.push(`margin tables ${Math.round(tablesAgeMs / 3_600_000)} h old`)
  const status: CoinStatus = markAgeMs < 0 ? 'incomplete' : issues.length > 0 ? 'stale' : 'valid'
  return { ...withTiers, status, markPrice: quote.markPrice, markAgeMs, issues }
}

export type PreparedInput =
  | { status: 'ready'; input: CrossInput; coins: CoinData[] }
  | { status: 'not_evaluable'; coins: CoinData[]; reasons: string[] }

/**
 * A hyperliquidMargin input for the given positions, only when every coin is
 * valid. Otherwise the account is not evaluable: no decision may be taken.
 */
export function prepareCrossInput(params: {
  collateral: number
  positions: CrossPosition[]
  marks: Record<string, MarkQuote>
  tables: MarginTables
  now: number
  maxMarkAgeMs?: number
  maxTablesAgeMs?: number
}): PreparedInput {
  const coinNames = [...new Set(params.positions.map((p) => p.coin))]
  const coins = coinNames.map((c) => evaluateCoin(c, params.marks, params.tables, params))
  const reasons = coins.filter((c) => c.status !== 'valid').flatMap((c) => [`${c.coin} ${c.status}`, ...c.issues])
  if (!Number.isFinite(params.collateral)) reasons.push('collateral is not a number')
  if (reasons.length > 0) return { status: 'not_evaluable', coins, reasons }
  return {
    status: 'ready',
    coins,
    input: {
      collateral: params.collateral,
      positions: params.positions,
      markPrices: Object.fromEntries(coins.map((c) => [c.coin, c.markPrice!])),
      tiers: Object.fromEntries(coins.map((c) => [c.coin, c.tiers!])),
    },
  }
}

/** Differences between two meta snapshots for the given coins. */
export function diffMarginTables(prev: MarginTables, next: MarginTables, coins: string[]): string[] {
  const changes: string[] = []
  for (const coin of coins) {
    const a = prev.assets.get(coin)
    const b = next.assets.get(coin)
    if (!a || !b) {
      if (a !== b) changes.push(`${coin}: ${a ? 'removed' : 'added'}`)
      continue
    }
    if (a.maxLeverage !== b.maxLeverage) changes.push(`${coin}: maxLeverage ${a.maxLeverage} -> ${b.maxLeverage}`)
    if (a.delisted !== b.delisted) changes.push(`${coin}: delisted ${a.delisted} -> ${b.delisted}`)
    if (a.marginTableId !== b.marginTableId) changes.push(`${coin}: margin table ${a.marginTableId} -> ${b.marginTableId}`)
    const ta = JSON.stringify(prev.tables.get(a.marginTableId) ?? null)
    const tb = JSON.stringify(next.tables.get(b.marginTableId) ?? null)
    if (ta !== tb) changes.push(`${coin}: tiers ${ta} -> ${tb}`)
  }
  return changes
}

/**
 * One public info request (opt-in; nothing in the bot calls it). Returns the
 * parsed JSON with its receipt time, or an error for timeouts, HTTP errors
 * and invalid JSON. No retry.
 */
export async function fetchInfo(
  body: { type: 'meta' | 'metaAndAssetCtxs' },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; url?: string } = {},
): Promise<{ data: unknown; receivedAt: number } | { error: string }> {
  const { fetchImpl = globalThis.fetch, timeoutMs = 10_000, url = INFO_URL } = options
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return { error: `HTTP ${response.status}` }
    const data = await response.json()
    return { data, receivedAt: Date.now() }
  } catch (err) {
    const name = (err as Error)?.name
    return { error: name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${timeoutMs} ms` : `unavailable: ${err}` }
  }
}
