/**
 * Hyperliquid market rules used by the 'hyperliquid' cost model (Task
 * 006I-3): margin tables and maximum leverage from the public `meta` request,
 * kept for TABLES_MAX_AGE_MS, and the leverage check on opens.
 * Docs: trading/margin-tiers, trading/margining.
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
