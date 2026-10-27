/**
 * Adapter from ALPHA BOT accounting rows to the Hyperliquid cross margin
 * calculator (Task 006G-3). Pure: account and position rows, mark quotes and
 * margin tables are inputs; no database, no network. Used by the margin
 * monitor for 'hyperliquid' accounts (Task 006I-3).
 *
 * Collateral reconciliation. The perpetual engine takes each position's
 * margin out of cash at open and gives it back at close, so the USDC backing
 * the perpetuals is
 *   collateral = cash + sum over perpetual rows of positionMargin(row)
 * (the margin recorded by the engine; rebuilt from the leverage for older rows)
 * and Hyperliquid's account value = collateral + unrealized P&L at mark.
 * With no spot rows this equals calcAccountEquity at the same prices.
 * Spot rows (side null, from orderMatching) are left out: they are coins the
 * account bought, not USDC collateral; that separation is an assumption about
 * how a Hyperliquid perp account would hold them, reported with the result.
 */
import type { Account, Position } from '../db/schema.js'
import { positionMargin } from './assetCalculator.js'
import { crossState, type CrossInput, type CrossPosition, type CrossState } from './hyperliquidMargin.js'
import {
  prepareCrossInput,
  type CoinData,
  type MarginTables,
  type MarkQuote,
} from './hyperliquidMarginData.js'

export type AccountRow = Pick<Account, 'currentCash' | 'marginUsed'>
export type PositionRow = Pick<Position, 'symbol' | 'market' | 'quantity' | 'avgCost' | 'leverage' | 'side' | 'margin'>

export interface SpotHolding {
  symbol: string
  quantity: number
  avgCost: number
}

export interface CollateralBreakdown {
  cash: number
  /** Margin of the perpetual rows: quantity * avgCost / leverage. */
  perpMargin: number
  /** cash + perpMargin */
  total: number
}

interface Common {
  spotExcluded: SpotHolding[]
  /** Assumptions and amounts not included. */
  notes: string[]
}

export type AdapterResult =
  | (Common & {
      status: 'ready'
      collateral: CollateralBreakdown
      input: CrossInput
      state: CrossState
      coins: CoinData[]
    })
  | (Common & {
      status: 'not_evaluable'
      /** Accounting that cannot be rebuilt reliably. */
      anomalies: string[]
      /** Missing, stale or unsupported market data. */
      reasons: string[]
      coins: CoinData[]
    })

/** Relative tolerance between booked and rebuilt margin. */
const MARGIN_TOLERANCE = 1e-9

export function crossInputFromAccount(params: {
  account: AccountRow
  positions: PositionRow[]
  marks: Record<string, MarkQuote>
  tables: MarginTables
  now: number
  maxMarkAgeMs?: number
  maxTablesAgeMs?: number
  /** Interest accrued and not yet charged, per symbol (calculatePositionInterest). */
  accruedInterest?: Record<string, number>
}): AdapterResult {
  const { account } = params
  const anomalies: string[] = []
  const notes: string[] = ['funding already settled is part of cash (hyperliquid cost model, 006I-2); the hour in progress is not']
  const spotExcluded: SpotHolding[] = []
  const perps: CrossPosition[] = []
  let perpMargin = 0
  let leveragedMargin = 0
  const legacy: string[] = []

  if (!Number.isFinite(account.currentCash)) anomalies.push('cash is not a number')
  if (!Number.isFinite(account.marginUsed)) anomalies.push('marginUsed is not a number')

  const open = params.positions.filter((p) => p.quantity > 0)
  const symbols = new Set<string>()
  for (const p of open) {
    if (symbols.has(p.symbol)) anomalies.push(`${p.symbol}: more than one open row`)
    symbols.add(p.symbol)
    if (p.market !== 'CRYPTO') {
      anomalies.push(`${p.symbol}: market ${p.market} not supported`)
      continue
    }
    if (!(p.avgCost > 0) || !Number.isFinite(p.quantity)) {
      anomalies.push(`${p.symbol}: invalid quantity or average cost`)
      continue
    }
    if (p.side === null) {
      if (p.leverage > 1) {
        // a manual leveraged buy (orderMatching): neither spot nor engine perp
        anomalies.push(`${p.symbol}: manual leveraged row (side null, leverage ${p.leverage}) cannot be classified`)
      } else {
        spotExcluded.push({ symbol: p.symbol, quantity: p.quantity, avgCost: p.avgCost })
      }
      continue
    }
    if (p.side !== 'LONG' && p.side !== 'SHORT') {
      anomalies.push(`${p.symbol}: unknown side ${p.side}`)
      continue
    }
    const leverage = p.leverage > 1 ? p.leverage : 1
    const margin = positionMargin(p)
    if (p.margin === null) legacy.push(p.symbol)
    perpMargin += margin
    if (leverage > 1) leveragedMargin += margin
    perps.push({ coin: p.symbol, side: p.side, size: p.quantity, entryPrice: p.avgCost, leverage })
  }

  // The engine books margin only above 1x. If the rows do not rebuild it
  // (older rows whose fills used different leverages), the collateral is
  // unknown.
  if (Math.abs(leveragedMargin - account.marginUsed) > MARGIN_TOLERANCE * Math.max(1, account.marginUsed)) {
    anomalies.push(
      `margin not reconstructable: rows give ${leveragedMargin} above 1x, account marginUsed is ${account.marginUsed} (e.g. an older row built from fills at different leverages)`,
    )
  }

  if (legacy.length > 0) {
    notes.push(`margin not recorded for ${legacy.join(', ')} (rows written before 006G-4): rebuilt as quantity * avgCost / leverage and accepted only because it matches marginUsed`)
  }
  if (spotExcluded.length > 0) {
    notes.push(
      `spot holdings excluded from collateral (${spotExcluded.map((s) => s.symbol).join(', ')}): assumed separate from the perp account; the original monitor counts them in equity`,
    )
  }
  if (params.accruedInterest) {
    const accrued = Object.entries(params.accruedInterest).filter(([, v]) => v > 0)
    const total = accrued.reduce((s, [, v]) => s + v, 0)
    if (accrued.length > 0) {
      notes.push(`accrued interest not included in collateral: ${total} USDC (${accrued.map(([s, v]) => `${s} ${v}`).join(', ')}), charged by the engine only at close`)
    }
  } else if (perps.some((p) => (p.leverage ?? 1) > 1)) {
    notes.push('accrued interest not provided: collateral excludes any interest still to be charged')
  }

  const collateral = { cash: account.currentCash, perpMargin, total: account.currentCash + perpMargin }
  if (anomalies.length > 0) {
    return { status: 'not_evaluable', anomalies, reasons: [], coins: [], spotExcluded, notes }
  }

  const prepared = prepareCrossInput({
    collateral: collateral.total,
    positions: perps,
    marks: params.marks,
    tables: params.tables,
    now: params.now,
    maxMarkAgeMs: params.maxMarkAgeMs,
    maxTablesAgeMs: params.maxTablesAgeMs,
  })
  if (prepared.status !== 'ready') {
    return { status: 'not_evaluable', anomalies, reasons: prepared.reasons, coins: prepared.coins, spotExcluded, notes }
  }
  const state = crossState(prepared.input)
  if (state.accountValue !== null && state.accountValue < 0) {
    notes.push(`account value is negative (${state.accountValue}): shortfall ${state.shortfall}; balances are not changed`)
  }
  if (state.belowBackstop) notes.push('below the backstop level (2/3 of maintenance): reported only, no backstop is executed')
  return { status: 'ready', collateral, input: prepared.input, state, coins: prepared.coins, spotExcluded, notes }
}
