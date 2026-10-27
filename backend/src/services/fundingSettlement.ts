/**
 * Hourly funding of the 'hyperliquid' cost model (Task 006I-2).
 *
 * Hyperliquid settles funding every hour on the perpetuals held at that hour
 * (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding):
 *   payment = size * oracle price * hourly funding rate,
 * paid by LONG and received by SHORT when the rate is positive, the other
 * way round when it is negative, at any leverage (1x included).
 *
 * Sources, never guessed:
 * - rate: the realised rate of that coin and hour, from the public
 *   fundingHistory request (`fundingRate` is per hour, `time` a few ms after
 *   the hour);
 * - oracle price: Hyperliquid publishes no oracle price history, so it is
 *   captured live (asset context `oraclePx`) within ORACLE_WINDOW_MS after
 *   each hour and stored in funding_oracle_prices. An hour without such a
 *   capture (app stopped) is recorded as 'missing_oracle', with no payment:
 *   a later price is never used for a past hour;
 * - size and side held at the hour: rebuilt from the account's fills dated
 *   strictly before it (the engine dates them to the millisecond in this
 *   model), so the result does not depend on when the job runs.
 *
 * Each (account, coin, hour) gets one funding_payments row, inserted in the
 * same transaction as the cash change: a repeated or concurrent run, or a
 * restart, cannot pay twice. The 'original' model is never touched.
 */
import { and, eq, gte } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  fundingOraclePrices,
  fundingPayments,
  trades,
  type Account,
} from '../db/schema.js'
import {
  getAssetContext,
  getFundingHistoryFromHyperliquid,
  getLastPricesFromHyperliquid,
  MAINSTREAM_CRYPTOS,
} from './hyperliquid.js'
import { dbDateMs } from '../utils/datetime.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.fundingSettlement')

export const HOUR_MS = 3_600_000
/** An oracle price counts for an hour only if received within this time after it. */
export const ORACLE_WINDOW_MS = 60_000
/** The fundingHistory entry of hour H has `time` in [H, H + RATE_MATCH_MS). */
export const RATE_MATCH_MS = 60_000
/** A rate still unpublished this long after its hour is given up ('missing_rate'). */
export const RATE_GIVE_UP_MS = 6 * HOUR_MS
/** Minimum time between two fundingHistory requests for the same coin. */
export const RATE_RETRY_MS = 60_000
/** Hours further back are not settled any more. */
export const LOOKBACK_MS = 48 * HOUR_MS

export type OraclePrices = Record<string, { oraclePx: number; receivedAt: number }>

export interface FundingDeps {
  /** Raw fundingHistory rows of a coin; throws on errors. */
  fetchFundingHistory: (coin: string, startTime: number, endTime: number) => Promise<unknown>
  /** Oracle prices from a fresh asset-context request, or null on error. */
  fetchOraclePrices: () => Promise<OraclePrices | null>
  /** Oracle prices the price path already received, without a request. */
  cachedOraclePrices: () => OraclePrices
}

function contextOracles(): OraclePrices {
  const out: OraclePrices = {}
  for (const coin of MAINSTREAM_CRYPTOS) {
    const ctx = getAssetContext(coin)
    const px = Number(ctx?.info.oraclePx)
    if (ctx && Number.isFinite(px) && px > 0) out[coin] = { oraclePx: px, receivedAt: ctx.receivedAt }
  }
  return out
}

export const defaultFundingDeps: FundingDeps = {
  fetchFundingHistory: getFundingHistoryFromHyperliquid,
  fetchOraclePrices: async () => {
    // the same single request as the price path; it refreshes the contexts
    const prices = await getLastPricesFromHyperliquid(MAINSTREAM_CRYPTOS)
    return Object.values(prices).some((p) => p !== null) ? contextOracles() : null
  },
  cachedOraclePrices: contextOracles,
}

const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS
const hyperliquidAccounts = (): Account[] =>
  db.select().from(accounts).where(eq(accounts.costModel, 'hyperliquid')).all()

// ---------------------------------------------------------------- positions

export interface PerpFill {
  symbol: string
  side: string
  quantity: number
  timeMs: number
}

/** Perpetual-engine fills of an account (manual fills carry no fee rate), oldest first. */
export function accountPerpFills(accountId: number): PerpFill[] {
  return db.select().from(trades).where(eq(trades.accountId, accountId)).all()
    .filter((t) => t.feeRate !== null)
    .map((t) => ({ symbol: t.symbol, side: t.side, quantity: t.quantity, timeMs: dbDateMs(t.tradeTime) }))
    .sort((a, b) => a.timeMs - b.timeMs)
}

/** Side and size of each perpetual held at `hourMs`: fills dated strictly before it. */
export function positionsAt(fills: PerpFill[], hourMs: number): Map<string, { side: 'LONG' | 'SHORT'; quantity: number }> {
  const book = new Map<string, { side: 'LONG' | 'SHORT'; quantity: number }>()
  for (const f of fills) {
    if (!(f.timeMs < hourMs)) break
    const held = book.get(f.symbol)
    if (f.side === 'LONG' || f.side === 'SHORT') {
      if (held && held.side === f.side) held.quantity = Number((held.quantity + f.quantity).toFixed(6))
      else book.set(f.symbol, { side: f.side, quantity: f.quantity })
    } else if (held && ((f.side === 'SELL' && held.side === 'LONG') || (f.side === 'BUY' && held.side === 'SHORT'))) {
      held.quantity = Number((held.quantity - f.quantity).toFixed(6))
      if (held.quantity <= 0) book.delete(f.symbol)
    }
  }
  return book
}

// ---------------------------------------------------------------- oracle capture

/**
 * Stores the oracle price of each coin for the current funding hour, if the
 * hour started less than ORACLE_WINDOW_MS ago and a hyperliquid account
 * exists. Prices the price path received in the window are reused; otherwise
 * one asset-context request is made.
 */
export async function captureFundingOracle(nowMs = Date.now(), deps: FundingDeps = defaultFundingDeps): Promise<number> {
  const hour = hourOf(nowMs)
  if (nowMs - hour > ORACLE_WINDOW_MS || hyperliquidAccounts().length === 0) return 0
  const have = new Set(
    db.select().from(fundingOraclePrices).where(eq(fundingOraclePrices.fundingTime, hour)).all().map((r) => r.symbol),
  )
  const missing = MAINSTREAM_CRYPTOS.filter((c) => !have.has(c))
  if (missing.length === 0) return 0

  const inWindow = (q: { oraclePx: number; receivedAt: number } | undefined) =>
    q && q.oraclePx > 0 && q.receivedAt >= hour && q.receivedAt <= hour + ORACLE_WINDOW_MS ? q : undefined
  let prices = deps.cachedOraclePrices()
  if (missing.some((c) => !inWindow(prices[c]))) {
    const fresh = await deps.fetchOraclePrices()
    if (fresh) prices = { ...prices, ...fresh }
  }
  let stored = 0
  for (const coin of missing) {
    const q = inWindow(prices[coin])
    if (!q) continue
    stored += db.insert(fundingOraclePrices)
      .values({ fundingTime: hour, symbol: coin, oraclePrice: q.oraclePx, receivedAt: q.receivedAt })
      .onConflictDoNothing().run().changes
  }
  if (stored > 0) logger.info(`Captured ${stored} oracle prices for funding hour ${new Date(hour).toISOString()}`)
  return stored
}

// ---------------------------------------------------------------- rates

/** coin -> funding hour -> realised rate. */
const rates = new Map<string, Map<number, { rate: number; time: number }>>()
const lastRateRequest = new Map<string, number>()

/** Clears the rate cache (tests). */
export function resetFundingRates(): void {
  rates.clear()
  lastRateRequest.clear()
}

function storeRates(coin: string, raw: unknown): void {
  if (!Array.isArray(raw)) throw new Error(`fundingHistory ${coin}: not a list`)
  const byHour = rates.get(coin) ?? new Map()
  for (const row of raw) {
    const time = Number(row?.time)
    const rate = Number(row?.fundingRate)
    if (row?.coin !== coin || !Number.isFinite(time) || !Number.isFinite(rate) || typeof row?.fundingRate !== 'string') continue
    const hour = hourOf(time)
    if (time - hour < RATE_MATCH_MS) byHour.set(hour, { rate, time })
  }
  rates.set(coin, byHour)
}

async function loadRates(coin: string, fromHour: number, nowMs: number, deps: FundingDeps): Promise<void> {
  const last = lastRateRequest.get(coin)
  if (last !== undefined && nowMs - last < RATE_RETRY_MS) return
  lastRateRequest.set(coin, nowMs)
  try {
    storeRates(coin, await deps.fetchFundingHistory(coin, fromHour, nowMs))
  } catch (e) {
    logger.warning(`fundingHistory request for ${coin} failed, retry in ${RATE_RETRY_MS / 1000}s: ${e}`)
  }
}

// ---------------------------------------------------------------- settlement

export interface SettlementSummary {
  settled: number
  missingOracle: number
  missingRate: number
  pending: number
}

/**
 * Settles every funding hour due for the hyperliquid accounts (up to
 * LOOKBACK_MS back): pays or collects it when its rate and oracle price are
 * known, records it as missing when they cannot be, and leaves it pending
 * otherwise. Safe to run repeatedly and concurrently with the engine.
 */
export async function settleFunding(nowMs = Date.now(), deps: FundingDeps = defaultFundingDeps): Promise<SettlementSummary> {
  const summary: SettlementSummary = { settled: 0, missingOracle: 0, missingRate: 0, pending: 0 }
  const lastHour = hourOf(nowMs)
  const due: { accountId: number; symbol: string; hour: number; side: 'LONG' | 'SHORT'; quantity: number }[] = []

  for (const account of hyperliquidAccounts()) {
    const fills = accountPerpFills(account.id)
    if (fills.length === 0) continue
    const from = Math.max(hourOf(fills[0]!.timeMs) + HOUR_MS, lastHour - LOOKBACK_MS)
    const recorded = new Set(
      db.select().from(fundingPayments)
        .where(and(eq(fundingPayments.accountId, account.id), gte(fundingPayments.fundingTime, from))).all()
        .map((r) => `${r.symbol} ${r.fundingTime}`),
    )
    for (let hour = from; hour <= lastHour; hour += HOUR_MS) {
      for (const [symbol, held] of positionsAt(fills, hour)) {
        if (!recorded.has(`${symbol} ${hour}`)) due.push({ accountId: account.id, symbol, hour, ...held })
      }
    }
  }
  if (due.length === 0) return summary

  // one fundingHistory request per coin still missing a rate (rate-limited)
  const needRate = new Map<string, number>()
  for (const d of due) {
    if (!rates.get(d.symbol)?.has(d.hour)) needRate.set(d.symbol, Math.min(needRate.get(d.symbol) ?? d.hour, d.hour))
  }
  for (const [coin, fromHour] of needRate) await loadRates(coin, fromHour, nowMs, deps)

  for (const d of due) {
    const oracle = db.select().from(fundingOraclePrices)
      .where(and(eq(fundingOraclePrices.fundingTime, d.hour), eq(fundingOraclePrices.symbol, d.symbol))).get()
    const rate = rates.get(d.symbol)?.get(d.hour)
    let row: typeof fundingPayments.$inferInsert | null = null
    const base = { accountId: d.accountId, symbol: d.symbol, fundingTime: d.hour, side: d.side, quantity: d.quantity }
    if (!oracle) {
      if (nowMs > d.hour + ORACLE_WINDOW_MS) row = { ...base, status: 'missing_oracle', fundingRate: rate?.rate, rateTime: rate?.time }
    } else if (!rate) {
      if (nowMs > d.hour + RATE_GIVE_UP_MS) {
        row = { ...base, status: 'missing_rate', oraclePrice: oracle.oraclePrice, oracleReceivedAt: oracle.receivedAt }
      }
    } else {
      // positive rate: LONG pays, SHORT receives
      const amount = (d.side === 'LONG' ? -1 : 1) * d.quantity * oracle.oraclePrice * rate.rate
      row = {
        ...base, status: 'settled', oraclePrice: oracle.oraclePrice, oracleReceivedAt: oracle.receivedAt,
        fundingRate: rate.rate, rateTime: rate.time, amount,
      }
    }
    if (!row) {
      summary.pending++
      continue
    }
    const payment = row
    const written = db.transaction((tx) => {
      if (tx.insert(fundingPayments).values(payment).onConflictDoNothing().run().changes !== 1) return false
      if (payment.status === 'settled') {
        const acc = tx.select().from(accounts).where(eq(accounts.id, d.accountId)).get()!
        tx.update(accounts).set({ currentCash: acc.currentCash + payment.amount! }).where(eq(accounts.id, d.accountId)).run()
      }
      return true
    })
    if (!written) continue
    if (payment.status === 'settled') {
      summary.settled++
      logger.info(
        `Funding ${d.symbol} ${new Date(d.hour).toISOString()} account ${d.accountId}: ${d.side} ${d.quantity} ` +
          `x ${payment.oraclePrice} x ${payment.fundingRate} = ${payment.amount!.toFixed(6)} USDC`,
      )
    } else {
      if (payment.status === 'missing_oracle') summary.missingOracle++
      else summary.missingRate++
      logger.warning(
        `Funding ${d.symbol} ${new Date(d.hour).toISOString()} account ${d.accountId} NOT settled: ${payment.status}`,
      )
    }
  }
  return summary
}

/** Scheduler entry point: oracle capture, then settlement. */
export async function runFundingTasks(nowMs = Date.now(), deps: FundingDeps = defaultFundingDeps): Promise<void> {
  try {
    await captureFundingOracle(nowMs, deps)
  } catch (e) {
    logger.error(`Funding oracle capture failed: ${e}`)
  }
  try {
    await settleFunding(nowMs, deps)
  } catch (e) {
    logger.error(`Funding settlement failed: ${e}`)
  }
}
