/**
 * Hyperliquid cross margin math, as documented by Hyperliquid (Task 006G-0).
 * Pure functions: positions, mark prices and margin tables are inputs; no
 * network, no database. Not connected to the margin monitor.
 *
 * Rules implemented (official docs: trading/margining, trading/liquidations,
 * trading/margin-tiers):
 * - account value = collateral + unrealized P&L at mark prices;
 * - maintenance margin of a position = notional * mmr - deduction of its tier,
 *   where mmr = 1 / (2 * tier max leverage) (half the initial margin at max
 *   leverage) and deduction_0 = 0, deduction_i = deduction_(i-1) +
 *   lowerBound_i * (mmr_i - mmr_(i-1)), so the requirement is continuous;
 * - cross liquidation when account value < total maintenance margin; the
 *   leverage chosen for a cross position does not change it;
 * - backstop (liquidator vault) when account value < 2/3 of maintenance;
 * - liquidation price = price - side * margin_available / size / (1 - l * side)
 *   with l = mmr and margin_available = account value - maintenance margin.
 * Not modelled: order book execution, partial liquidation of positions above
 * 100k USDC, the vault and ADL themselves, fees and funding.
 */

export interface MarginTier {
  /** Notional (USDC) from which the tier applies. */
  lowerBound: number
  maxLeverage: number
}

export interface TierSchedule extends MarginTier {
  /** Maintenance margin rate: 1 / (2 * maxLeverage). */
  mmr: number
  /** Subtracted from notional * mmr so the requirement is continuous. */
  deduction: number
}

export type Side = 'LONG' | 'SHORT'

export interface CrossPosition {
  coin: string
  side: Side
  /** Size in coins, > 0. */
  size: number
  entryPrice: number
  /** Leverage chosen at open: informative only in cross margin. */
  leverage?: number
}

export interface CrossInput {
  /** USDC balance backing the account, before unrealized P&L. */
  collateral: number
  positions: CrossPosition[]
  /** Mark price per coin; a missing or invalid price blocks every decision. */
  markPrices: Record<string, number | null | undefined>
  /** Margin tiers per coin (from the meta endpoint). */
  tiers: Record<string, MarginTier[]>
}

export interface PositionState {
  coin: string
  side: Side
  size: number
  markPrice: number
  notional: number
  unrealizedPnl: number
  mmr: number
  maintenanceMargin: number
  tierIndex: number
  /** notional / leverage when a leverage was given. */
  initialMargin: number | null
}

export interface CrossState {
  /** 'incomplete' when a mark price or tier table is missing: no decision. */
  status: 'ok' | 'incomplete'
  accountValue: number | null
  unrealizedPnl: number | null
  totalNotional: number | null
  maintenanceMargin: number | null
  /** accountValue - maintenanceMargin (margin_available in the docs). */
  buffer: number | null
  liquidatable: boolean | null
  /** accountValue < 2/3 maintenance margin. */
  belowBackstop: boolean | null
  /** Loss beyond zero equity (what the vault/ADL would absorb). */
  shortfall: number | null
  positions: PositionState[]
  issues: string[]
}

const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0

/** Tiers of a coin from the meta endpoint response, or an explanation. */
export function tiersFromMeta(
  meta: {
    universe: { name: string; maxLeverage: number; marginTableId?: number }[]
    marginTables: [number, { marginTiers: { lowerBound: string | number; maxLeverage: number }[] }][]
  },
  coin: string,
): { tiers: MarginTier[] } | { error: string } {
  const asset = meta.universe.find((u) => u.name === coin)
  if (!asset) return { error: `${coin} not in meta universe` }
  const table = meta.marginTables.find(([id]) => id === asset.marginTableId)
  if (!table) {
    // Some assets reference an id with no table in the response: the rule
    // for them is not documented, so it is not guessed here.
    return { error: `${coin}: margin table ${asset.marginTableId} not in meta response` }
  }
  const tiers = table[1].marginTiers.map((t) => ({ lowerBound: Number(t.lowerBound), maxLeverage: t.maxLeverage }))
  return { tiers }
}

/** mmr and cumulative deduction of every tier. */
export function maintenanceSchedule(tiers: MarginTier[]): TierSchedule[] {
  if (tiers.length === 0) throw new RangeError('at least one margin tier is required')
  const sorted = [...tiers].sort((a, b) => a.lowerBound - b.lowerBound)
  if (sorted[0]!.lowerBound !== 0) throw new RangeError('the first tier must start at 0')
  const out: TierSchedule[] = []
  sorted.forEach((t, i) => {
    if (!(t.maxLeverage > 0)) throw new RangeError(`invalid maxLeverage ${t.maxLeverage}`)
    const mmr = 1 / (2 * t.maxLeverage)
    const deduction = i === 0 ? 0 : out[i - 1]!.deduction + t.lowerBound * (mmr - out[i - 1]!.mmr)
    out.push({ ...t, mmr, deduction })
  })
  return out
}

/** Maintenance margin of one position notional (USDC). */
export function maintenanceMargin(notional: number, tiers: MarginTier[]) {
  const schedule = maintenanceSchedule(tiers)
  let tierIndex = 0
  for (let i = 0; i < schedule.length; i++) if (notional >= schedule[i]!.lowerBound) tierIndex = i
  const tier = schedule[tierIndex]!
  return { margin: notional * tier.mmr - tier.deduction, mmr: tier.mmr, deduction: tier.deduction, tierIndex }
}

/** Account value, maintenance margin and liquidation status in cross margin. */
export function crossState(input: CrossInput): CrossState {
  const issues: string[] = []
  const positions: PositionState[] = []
  if (!Number.isFinite(input.collateral)) issues.push('collateral is not a number')
  for (const p of input.positions) {
    if (!valid(p.size) || !valid(p.entryPrice)) {
      issues.push(`${p.coin}: invalid size or entry price`)
      continue
    }
    const mark = input.markPrices[p.coin]
    if (!valid(mark)) {
      issues.push(`${p.coin}: mark price missing or invalid`)
      continue
    }
    const tiers = input.tiers[p.coin]
    if (!tiers || tiers.length === 0) {
      issues.push(`${p.coin}: margin tiers missing`)
      continue
    }
    const notional = p.size * mark
    const mm = maintenanceMargin(notional, tiers)
    const sign = p.side === 'LONG' ? 1 : -1
    if (p.leverage !== undefined && p.leverage > maintenanceSchedule(tiers)[mm.tierIndex]!.maxLeverage) {
      issues.push(`${p.coin}: leverage ${p.leverage} above the tier maximum`)
    }
    positions.push({
      coin: p.coin, side: p.side, size: p.size, markPrice: mark, notional,
      unrealizedPnl: sign * p.size * (mark - p.entryPrice),
      mmr: mm.mmr, maintenanceMargin: mm.margin, tierIndex: mm.tierIndex,
      initialMargin: p.leverage !== undefined && p.leverage > 0 ? notional / p.leverage : null,
    })
  }
  const blocking = issues.filter((i) => !i.includes('above the tier maximum'))
  if (blocking.length > 0) {
    return {
      status: 'incomplete', accountValue: null, unrealizedPnl: null, totalNotional: null,
      maintenanceMargin: null, buffer: null, liquidatable: null, belowBackstop: null,
      shortfall: null, positions, issues,
    }
  }
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0)
  const maintenance = positions.reduce((s, p) => s + p.maintenanceMargin, 0)
  const accountValue = input.collateral + unrealizedPnl
  return {
    status: 'ok',
    accountValue,
    unrealizedPnl,
    totalNotional: positions.reduce((s, p) => s + p.notional, 0),
    maintenanceMargin: maintenance,
    buffer: accountValue - maintenance,
    liquidatable: positions.length > 0 && accountValue < maintenance,
    belowBackstop: positions.length > 0 && accountValue < (2 / 3) * maintenance,
    shortfall: accountValue < 0 ? -accountValue : 0,
    positions,
    issues,
  }
}

export interface LiquidationPrice {
  /** Mark price of `coin` at which the account becomes liquidatable. */
  price: number | null
  /** True when other positions exist: their prices are held fixed. */
  conditional: boolean
  reason: string
}

/**
 * Official formula, solved for one position with the others held at their
 * mark prices. Within a tier it is exact; when the price crosses into another
 * tier the computation is repeated with that tier.
 */
export function liquidationPrice(input: CrossInput, coin: string): LiquidationPrice {
  const state = crossState(input)
  const conditional = input.positions.length > 1
  if (state.status !== 'ok') return { price: null, conditional, reason: `not computable: ${state.issues.join('; ')}` }
  const pos = state.positions.find((p) => p.coin === coin)
  if (!pos) return { price: null, conditional, reason: `${coin}: no open position` }
  if (state.liquidatable) return { price: pos.markPrice, conditional, reason: 'already below maintenance margin' }

  const side = pos.side === 'LONG' ? 1 : -1
  const tiers = input.tiers[coin]!
  const otherMaintenance = state.maintenanceMargin! - pos.maintenanceMargin
  let tier = maintenanceSchedule(tiers)[pos.tierIndex]!
  for (let i = 0; i <= tiers.length; i++) {
    // maintenance at this tier, evaluated at the current mark price
    const maintenance = otherMaintenance + pos.notional * tier.mmr - tier.deduction
    const marginAvailable = state.accountValue! - maintenance
    const price = pos.markPrice - (side * marginAvailable) / pos.size / (1 - tier.mmr * side)
    if (!(price > 0)) return { price: null, conditional, reason: 'not reachable at a positive price' }
    const reached = maintenanceMargin(pos.size * price, tiers)
    const next = maintenanceSchedule(tiers)[reached.tierIndex]!
    if (next.lowerBound === tier.lowerBound) return { price, conditional, reason: 'official cross formula' }
    tier = next
  }
  return { price: null, conditional, reason: 'tier search did not settle' }
}
