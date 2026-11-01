/**
 * Local market history for the v3 decision context (Task 007F): closed 1 h
 * bars of each market, persisted in the run's database, filled
 * progressively. Used only when ALPHA_PROMPT=v3.
 *
 * - Only CLOSED bars are stored (a bar is closed once its end time plus a
 *   short grace has passed), so a value computed from the history never uses
 *   information later than the moment of the decision.
 * - Every bar is validated (alignment, coin, interval, prices, OHLC order);
 *   a bad bar is refused, never "fixed".
 * - Upsert by (symbol, interval, open time): a repeated bar is not
 *   duplicated; a restart reads what is stored and asks only for what is
 *   missing (new hours, or a gap).
 * - At most one request per coin per closed hour; after a failure no new
 *   request for retryMs (what is stored stays usable and is reported with
 *   its age).
 * - Bars older than keepDays are pruned.
 */
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { marketBars } from '../db/schema.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.marketHistory')

export const HISTORY = {
  interval: '1h',
  ms: 3_600_000,
  /** 4 h EMA50 needs ~27.5 days with its warm-up, the ATR percentile 30 days: 45 days kept. */
  keepDays: 45,
  /** First fill: 45 days of 1 h bars (one request; Hyperliquid serves up to 5000). */
  backfillBars: 45 * 24,
  /** A bar counts as closed this long after its end. */
  graceMs: 5_000,
  /** No new request for a coin this long after a failed one. */
  retryMs: 120_000,
  /** Minimum time between two requests for the same coin while it is behind (e.g. the newest bar not published yet). */
  minSpacingMs: 60_000,
} as const

export interface HourBar {
  openTime: number
  endTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type FetchCandles = (coin: string, interval: string, startTime: number, endTime: number) => Promise<unknown>

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** One candleSnapshot row as a closed 1 h bar, or why it is refused. */
export function validateBar(row: unknown, coin: string, now: number): HourBar | { error: string } {
  const r = row as Record<string, unknown> | null
  const t = num(r?.t), T = num(r?.T)
  if (t === null || T === null) return { error: 'no timestamps' }
  if (r?.s !== undefined && r.s !== coin) return { error: `belongs to ${String(r.s)}` }
  if (r?.i !== undefined && r.i !== HISTORY.interval) return { error: `interval ${String(r.i)}` }
  if (t % HISTORY.ms !== 0 || T !== t + HISTORY.ms - 1) return { error: `misaligned bar at ${new Date(t).toISOString()}` }
  if (t + HISTORY.ms + HISTORY.graceMs > now) return { error: 'bar not closed yet' }
  const [o, h, l, c, v] = [num(r?.o), num(r?.h), num(r?.l), num(r?.c), num(r?.v)]
  if (o === null || h === null || l === null || c === null || v === null || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) return { error: 'missing or invalid price/volume' }
  if (l > Math.min(o, c) + 1e-12 || h < Math.max(o, c) - 1e-12 || l > h) return { error: 'inconsistent high/low' }
  return { openTime: t, endTime: t + HISTORY.ms, open: o, high: h, low: l, close: c, volume: v }
}

/** Open time of the last 1 h bar closed at `now`. */
export const lastClosedOpen = (now: number) => Math.floor((now - HISTORY.graceMs) / HISTORY.ms) * HISTORY.ms - HISTORY.ms

/** Stored closed bars of a coin that ended at or before `untilMs`, oldest first. */
export function loadHistory(symbol: string, untilMs: number): HourBar[] {
  return db.select().from(marketBars)
    .where(and(eq(marketBars.symbol, symbol), eq(marketBars.interval, HISTORY.interval), lt(marketBars.openTime, untilMs - HISTORY.ms + 1)))
    .orderBy(asc(marketBars.openTime)).all()
    .map((b) => ({ openTime: b.openTime, endTime: b.openTime + HISTORY.ms, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
}

export interface HistoryQuality {
  bars: number
  firstOpen: string | null
  lastClose: string | null
  /** Minutes since the end of the last stored bar. */
  lastAgeMin: number | null
  /** Missing hours inside the stored window. */
  gaps: number
  /** Closed hours not stored yet at `now`. */
  behindHours: number
}

export function historyQuality(bars: HourBar[], now: number): HistoryQuality {
  let gaps = 0
  for (let i = 1; i < bars.length; i++) gaps += Math.max(0, (bars[i]!.openTime - bars[i - 1]!.openTime) / HISTORY.ms - 1)
  const last = bars.at(-1)
  return {
    bars: bars.length, firstOpen: bars[0] ? new Date(bars[0].openTime).toISOString() : null,
    lastClose: last ? new Date(last.endTime).toISOString() : null, lastAgeMin: last ? Math.round((now - last.endTime) / 60_000) : null,
    gaps, behindHours: last ? Math.max(0, (lastClosedOpen(now) - last.openTime) / HISTORY.ms) : HISTORY.backfillBars,
  }
}

const attempts = new Map<string, { lastAt: number; blockedUntil: number }>()

/** Clears the request bookkeeping (tests: a "restart" of the process). */
export function resetHistoryState(): void {
  attempts.clear()
}

export interface RefreshResult {
  symbol: string
  requested: boolean
  stored: number
  refused: string[]
  error?: string
}

/**
 * Brings the stored history of a coin up to the last closed hour: nothing to
 * do when it is already there; otherwise one request from the first missing
 * hour (a gap inside the window, the hour after the last stored bar, or the
 * whole backfill window).
 */
export async function refreshHistory(symbol: string, now: number, fetchCandles: FetchCandles): Promise<RefreshResult> {
  const result: RefreshResult = { symbol, requested: false, stored: 0, refused: [] }
  const target = lastClosedOpen(now)
  const windowStart = target - (HISTORY.backfillBars - 1) * HISTORY.ms
  const stored = db.select({ t: marketBars.openTime }).from(marketBars)
    .where(and(eq(marketBars.symbol, symbol), eq(marketBars.interval, HISTORY.interval), gte(marketBars.openTime, windowStart)))
    .orderBy(asc(marketBars.openTime)).all().map((r) => r.t)
  // first hour missing in the window
  let from: number | null = null
  const have = new Set(stored)
  if (!stored.length) from = windowStart
  else {
    for (let t = Math.max(windowStart, stored[0]!); t <= target; t += HISTORY.ms) if (!have.has(t)) { from = t; break }
  }
  if (from === null) return result
  const a = attempts.get(symbol)
  if (a && (now < a.blockedUntil || now - a.lastAt < HISTORY.minSpacingMs)) return result // failed recently, or asked a moment ago
  attempts.set(symbol, { lastAt: now, blockedUntil: 0 })
  result.requested = true
  try {
    const raw = await fetchCandles(symbol, HISTORY.interval, from, now)
    if (!Array.isArray(raw)) throw new Error('candleSnapshot answer is not an array')
    const rows: (typeof marketBars.$inferInsert)[] = []
    for (const row of raw) {
      const b = validateBar(row, symbol, now)
      if ('error' in b) { if (b.error !== 'bar not closed yet') result.refused.push(b.error); continue }
      rows.push({ symbol, interval: HISTORY.interval, openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, receivedAt: now })
    }
    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(marketBars).values(r).onConflictDoUpdate({
          target: [marketBars.symbol, marketBars.interval, marketBars.openTime],
          set: { open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, receivedAt: r.receivedAt },
        }).run()
      }
      tx.delete(marketBars).where(and(eq(marketBars.symbol, symbol), lt(marketBars.openTime, windowStart))).run() // keepDays = the backfill window
    })
    result.stored = rows.length
    if (result.refused.length) logger.warning(`Market history ${symbol}: ${result.refused.length} bar(s) refused (${[...new Set(result.refused)].join('; ')})`)
  } catch (e) {
    result.error = String(e)
    attempts.set(symbol, { lastAt: now, blockedUntil: now + HISTORY.retryMs })
    logger.warning(`Market history ${symbol} not refreshed, next attempt after ${new Date(now + HISTORY.retryMs).toISOString()}: ${e}`)
  }
  return result
}

/** The most recent stored bar of a coin (tests, diagnostics). */
export function lastStoredBar(symbol: string) {
  return db.select().from(marketBars).where(and(eq(marketBars.symbol, symbol), eq(marketBars.interval, HISTORY.interval)))
    .orderBy(desc(marketBars.openTime)).get() ?? null
}
