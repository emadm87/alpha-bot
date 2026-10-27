/**
 * Hyperliquid market rules used by the 'hyperliquid' cost model: margin
 * tables and maximum leverage from the public `meta` request, kept for
 * TABLES_MAX_AGE_MS, and the leverage check on opens (Task 006I-3); order size
 * precision and minimum order value (Task 006I-4).
 * Docs: trading/margin-tiers, trading/margining, for-developers/api/tick-and-lot-size,
 * for-developers/api/error-responses.
 */
import { getMetaFromHyperliquid } from './hyperliquid.js'
import { maintenanceSchedule } from './hyperliquidMargin.js'
import { parseMetaResponse, TABLES_MAX_AGE_MS, type MarginTables } from './hyperliquidMarginData.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.hyperliquidMarket')

/** Minimum time between two `meta` requests after a failure. */
export const META_RETRY_MS = 60_000

let tables: MarginTables | null = null
let lastAttempt = 0

/** Forgets the cached tables (tests). */
export function resetMarginTables(): void {
  tables = null
  lastAttempt = 0
}

/**
 * Margin tables no older than TABLES_MAX_AGE_MS, fetched when needed (at most
 * one request per META_RETRY_MS after a failure). Older tables are returned
 * as they are, so the caller's validation reports them stale; null when
 * nothing was ever received.
 */
export async function loadMarginTables(now = Date.now()): Promise<MarginTables | null> {
  if (tables && now - tables.receivedAt < TABLES_MAX_AGE_MS) return tables
  if (now - lastAttempt < META_RETRY_MS) return tables
  lastAttempt = now
  try {
    const parsed = parseMetaResponse(await getMetaFromHyperliquid(), Date.now())
    if ('error' in parsed) throw new Error(parsed.error)
    if (parsed.issues.length > 0) logger.warning(`Hyperliquid meta: ${parsed.issues.join('; ')}`)
    tables = parsed
  } catch (e) {
    logger.warning(`Hyperliquid meta request failed: ${e}`)
  }
  return tables
}

/**
 * Why Hyperliquid would refuse an open at this leverage, or null. The limit
 * is the max leverage of the margin tier the position notional falls in
 * (tier 0 is the asset's maxLeverage). Without valid tables the open is
 * refused: the limit cannot be verified.
 */
export async function hyperliquidLeverageIssue(symbol: string, leverage: number, notional: number): Promise<string | null> {
  const t = await loadMarginTables()
  if (!t) return `Cannot verify the Hyperliquid leverage limit for ${symbol}: margin tables unavailable`
  const asset = t.assets.get(symbol)
  if (!asset || asset.delisted) return `${symbol} is not a listed Hyperliquid perpetual`
  const explicit = t.tables.get(asset.marginTableId)
  const tiers = explicit ?? (asset.marginTableId < 50 ? [{ lowerBound: 0, maxLeverage: asset.maxLeverage }] : null)
  if (!tiers) return `Cannot verify the Hyperliquid leverage limit for ${symbol}: margin table ${asset.marginTableId} missing`
  const schedule = maintenanceSchedule(tiers)
  let max = schedule[0]!.maxLeverage
  for (const tier of schedule) if (notional >= tier.lowerBound) max = tier.maxLeverage
  max = Math.min(max, asset.maxLeverage)
  return leverage > max ? `Leverage ${leverage}x above the Hyperliquid maximum of ${max}x for ${symbol}` : null
}

/** Minimum order value of a perpetual order (error MinTradeNtl, "Order must have minimum value of $10"). */
export const HL_MIN_ORDER_NOTIONAL = 10

/**
 * Size decimals of a listed perpetual from the meta response, or why they are
 * unknown. Nothing is assumed when the meta is missing or the value invalid.
 */
export async function hyperliquidSizeDecimals(symbol: string): Promise<{ szDecimals: number } | { error: string }> {
  const t = await loadMarginTables()
  if (!t) return { error: `Hyperliquid size rules for ${symbol} unavailable: meta not received` }
  const asset = t.assets.get(symbol)
  if (!asset || asset.delisted) return { error: `${symbol} is not a listed Hyperliquid perpetual` }
  if (asset.szDecimals === null) return { error: `Hyperliquid szDecimals for ${symbol} missing or invalid in meta` }
  return { szDecimals: asset.szDecimals }
}

/**
 * Size rounded DOWN to the lot 10^-szDecimals, so an order never exceeds the
 * requested exposure. The size is scaled to whole lots with a tolerance for
 * binary representation (0.00002 * 1e5 = 2.0000000000000004), then rebuilt
 * from the integer number of lots.
 */
export function floorToLot(size: number, szDecimals: number): number {
  const scale = 10 ** szDecimals
  const lots = size * scale
  const nearest = Math.round(lots)
  const whole = Math.abs(lots - nearest) <= 1e-9 * Math.max(1, nearest) ? nearest : Math.floor(lots)
  return Number((whole / scale).toFixed(szDecimals))
}
