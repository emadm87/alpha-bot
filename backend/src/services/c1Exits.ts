/**
 * C1 automatic exits (Task 009D, function 3) on the original engine of ac66d28.
 *
 * Called once per tick of the original margin monitor (every 5 s), right after
 * the original margin check (liquidation first). Independent of Gemini: Gemini
 * still decides HOLD and CLOSE; this only closes a position whose exit level
 * is reached.
 *
 * Per perpetual position of an AI account:
 * - plan, made once: ATR(14) of the 1 h bars closed before the first fill
 *   (Hyperliquid candleSnapshot), stop at 2 ATR from the entry; without an
 *   ATR no level is set (the row waits, retried at most once a minute);
 * - trailing exit at 3 ATR from the best price seen by these checks; the
 *   exit level is the tighter of the stop and the trailing level;
 * - when the price reaches it: the WHOLE position is closed through the
 *   original paper engine (placeAndExecuteCrypto: its price, its fee), and the
 *   close is recorded with its reason. Values of the C1 agreed in Task 007C.
 * Safety: a missing price is never replaced (the check is skipped); a close is
 * not started while a scheduled AI cycle is running (that cycle works on an
 * account read at its start), and is deferred to the next tick; a position
 * closed by Gemini or a liquidation is marked as closed elsewhere; a row in
 * "closing" is never executed twice.
 */
import { and, eq, gt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { accounts, c1Exits, positions as positionsTable } from '../db/schema.js'
import { atr as atrSeries } from '../indicators/technical.js'
import { getLogger } from '../utils/logger.js'
import { getCandleSnapshotFromHyperliquid } from './hyperliquid.js'
import { getLastPrice } from './marketData.js'
import { placeAndExecuteCrypto } from './orderExecutorLeverage.js'
import { positionLifecycle } from './positionState.js'

const logger = getLogger('services.c1Exits')

/** C1 of Task 007C: stop at 2 ATR from the entry, trailing exit at 3 ATR from the best price; ATR(14) on 1 h bars. */
export const C1 = { stopAtr: 2, trailAtr: 3, atrPeriod: 14, barMs: 3_600_000, barsRequested: 150, atrRetryMs: 60_000 } as const

export interface C1Deps {
  fetchCandles: (coin: string, interval: string, startTime: number, endTime: number) => Promise<unknown>
  price: (symbol: string) => Promise<number>
  now: () => number
}
export const c1Deps: C1Deps = {
  fetchCandles: getCandleSnapshotFromHyperliquid,
  price: (symbol) => getLastPrice(symbol, 'CRYPTO'),
  now: () => Date.now(),
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/** ATR(14) of the closed, aligned, valid 1 h bars that ended before `asOf`; null when there are not enough. */
export function atrBefore(raw: unknown, coin: string, asOf: number): { atr: number; bars: number } | null {
  if (!Array.isArray(raw)) return null
  const bars = raw.flatMap((r: any) => {
    const t = num(r?.t), T = num(r?.T), o = num(r?.o), h = num(r?.h), l = num(r?.l), c = num(r?.c)
    if (t === null || T === null || o === null || h === null || l === null || c === null) return []
    if ((r.s !== undefined && r.s !== coin) || t % C1.barMs !== 0 || T !== t + C1.barMs - 1 || t + C1.barMs > asOf) return []
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || l > Math.min(o, c) || h < Math.max(o, c)) return []
    return [{ t, h, l, c }]
  }).sort((a, b) => a.t - b.t)
  // the last contiguous run only (a missing hour would make the true range wrong)
  let start = bars.length - 1
  while (start > 0 && bars[start - 1]!.t === bars[start]!.t - C1.barMs) start--
  const run = bars.slice(Math.max(start, 0))
  const series = atrSeries(run.map((b) => b.h), run.map((b) => b.l), run.map((b) => b.c), C1.atrPeriod)
  const value = series.at(-1)
  return typeof value === 'number' && value > 0 ? { atr: value, bars: run.length } : null
}

/** Exit level of a plan: the tighter of the stop and the trailing level. */
export function exitLevel(side: string, stop: number, best: number, trail: number): number {
  return side === 'SHORT' ? Math.min(stop, best + trail) : Math.max(stop, best - trail)
}

const lastAtrTry = new Map<string, number>()
const executing = new Set<number>()

/** Clears the in-memory retry bookkeeping (tests). */
export function resetC1State(): void {
  lastAtrTry.clear()
  executing.clear()
}

type Row = typeof c1Exits.$inferSelect

async function makePlan(row: Row, deps: C1Deps): Promise<Row> {
  const now = deps.now()
  const key = `${row.accountId}:${row.symbol}:${row.openedAt}`
  if (now - (lastAtrTry.get(key) ?? 0) < C1.atrRetryMs) return row
  lastAtrTry.set(key, now)
  let found: { atr: number; bars: number } | null = null
  let error: string | null = null
  try {
    const end = row.openedAt
    found = atrBefore(await deps.fetchCandles(row.symbol, '1h', end - C1.barsRequested * C1.barMs, end), row.symbol, row.openedAt)
    if (!found) error = 'ATR not available: not enough closed 1 h bars before the opening'
  } catch (e) {
    error = `ATR not available: candles request failed (${e})`
  }
  if (!found) {
    db.update(c1Exits).set({ lastError: error, updatedAt: now }).where(eq(c1Exits.id, row.id)).run()
    logger.warning(`C1 ${row.symbol} (account ${row.accountId}): ${error}; no level set, retry in ${C1.atrRetryMs / 1000} s`)
    return { ...row, lastError: error }
  }
  const dir = row.side === 'SHORT' ? -1 : 1
  const stop = row.entryPrice - dir * C1.stopAtr * found.atr
  const trail = C1.trailAtr * found.atr
  const level = exitLevel(row.side, stop, row.entryPrice, trail)
  db.update(c1Exits).set({ atr: found.atr, atrBars: found.bars, stopPrice: stop, trailDistance: trail, bestPrice: row.entryPrice,
    exitLevel: level, status: 'active', lastError: null, updatedAt: now }).where(eq(c1Exits.id, row.id)).run()
  logger.info(`C1 plan ${row.symbol} ${row.side} (account ${row.accountId}): entry ${row.entryPrice}, ATR ${found.atr.toFixed(6)}, stop ${stop.toFixed(6)}, trailing ${trail.toFixed(6)}`)
  return { ...row, atr: found.atr, atrBars: found.bars, stopPrice: stop, trailDistance: trail, bestPrice: row.entryPrice, exitLevel: level, status: 'active', lastError: null }
}

/**
 * One C1 pass over the perpetual positions of the AI accounts. Never throws.
 * `aiCycleRunning`: true while the scheduled AI cycle runs (closes wait for the next tick).
 */
export async function runC1Pass(aiCycleRunning: () => boolean, deps: C1Deps = c1Deps): Promise<{ checked: number; closed: number; deferred: number }> {
  const summary = { checked: 0, closed: 0, deferred: 0 }
  try {
    const open = db.select({ pos: positionsTable, acc: accounts }).from(positionsTable)
      .innerJoin(accounts, eq(accounts.id, positionsTable.accountId))
      .where(and(gt(positionsTable.quantity, 0), eq(accounts.accountType, 'AI'))).all()
      .filter((r) => r.pos.side === 'LONG' || r.pos.side === 'SHORT')
    const openKeys = new Set<string>()
    for (const { pos } of open) {
      const openedAt = positionLifecycle(pos.accountId, pos.symbol).openedAt
      if (openedAt === null) continue
      openKeys.add(`${pos.accountId}:${pos.symbol}:${openedAt}`)
      let row = db.select().from(c1Exits).where(and(eq(c1Exits.accountId, pos.accountId), eq(c1Exits.symbol, pos.symbol), eq(c1Exits.openedAt, openedAt))).get()
      if (!row) {
        const now = deps.now()
        row = db.insert(c1Exits).values({ accountId: pos.accountId, symbol: pos.symbol, side: pos.side!, openedAt, entryPrice: pos.avgCost,
          status: 'waiting_atr', createdAt: now, updatedAt: now }).returning().get()
      }
      if (row.status === 'waiting_atr') row = await makePlan(row, deps)
      if (row.status !== 'active' || executing.has(row.id)) continue
      summary.checked++
      let price: number
      try {
        price = await deps.price(pos.symbol)
        if (!(price > 0)) throw new Error(`invalid price ${price}`)
      } catch (e) {
        db.update(c1Exits).set({ lastError: `price unavailable, not checked: ${e}`, updatedAt: deps.now() }).where(eq(c1Exits.id, row.id)).run()
        continue
      }
      const long = row.side !== 'SHORT'
      const best = long ? Math.max(row.bestPrice!, price) : Math.min(row.bestPrice!, price)
      const level = exitLevel(row.side, row.stopPrice!, best, row.trailDistance!)
      const hit = long ? price <= level : price >= level
      db.update(c1Exits).set({ bestPrice: best, exitLevel: level, updatedAt: deps.now(), ...(hit ? {} : { lastError: null }) }).where(eq(c1Exits.id, row.id)).run()
      if (!hit) continue
      const kind = level === row.stopPrice ? `stop at ${C1.stopAtr} ATR` : `trailing exit at ${C1.trailAtr} ATR from the best price ${best}`
      const reason = `C1 ${kind}: price ${price} ${long ? '<=' : '>='} exit level ${level} (entry ${row.entryPrice}, ATR ${row.atr}, stop ${row.stopPrice})`
      if (aiCycleRunning()) {
        summary.deferred++
        db.update(c1Exits).set({ lastError: `deferred while an AI cycle runs: ${reason}` }).where(eq(c1Exits.id, row.id)).run()
        continue
      }
      // the close: fresh rows, read right before the engine call (no older account or position is used)
      const current = db.select().from(positionsTable).where(and(eq(positionsTable.accountId, pos.accountId), eq(positionsTable.symbol, pos.symbol))).get()
      const account = db.select().from(accounts).where(eq(accounts.id, pos.accountId)).get()
      if (!current || !(current.quantity > 0) || current.side !== row.side || !account) continue
      // checked again with no await before the mark: another pass may have started this close meanwhile
      const latest = db.select({ status: c1Exits.status }).from(c1Exits).where(eq(c1Exits.id, row.id)).get()
      if (executing.has(row.id) || latest?.status !== 'active') continue
      executing.add(row.id)
      db.update(c1Exits).set({ status: 'closing', updatedAt: deps.now() }).where(eq(c1Exits.id, row.id)).run()
      try {
        const order = await placeAndExecuteCrypto({ account, symbol: current.symbol, name: current.symbol, side: long ? 'SELL' : 'BUY',
          orderType: 'MARKET', price: null, quantity: current.quantity, leverage: current.leverage })
        db.update(c1Exits).set({ status: 'closed', closedAt: deps.now(), closePrice: order.price, closeQuantity: current.quantity, closeReason: reason,
          orderId: order.id, lastError: null, updatedAt: deps.now() }).where(eq(c1Exits.id, row.id)).run()
        summary.closed++
        logger.warning(`🛑 ${reason}: ${current.symbol} ${row.side} ${current.quantity} closed (account ${account.name})`)
      } catch (e) {
        db.update(c1Exits).set({ status: 'active', lastError: `close failed, retried next check: ${e}`, updatedAt: deps.now() })
          .where(and(eq(c1Exits.id, row.id), eq(c1Exits.status, 'closing'))).run()
        logger.error(`C1 close of ${current.symbol} failed (account ${account.name}): ${e}`)
      } finally {
        executing.delete(row.id)
      }
    }
    // plans whose position no longer exists: closed by Gemini, a liquidation or by hand
    for (const r of db.select().from(c1Exits).all()) {
      if ((r.status === 'active' || r.status === 'waiting_atr') && !openKeys.has(`${r.accountId}:${r.symbol}:${r.openedAt}`)) {
        db.update(c1Exits).set({ status: 'closed_elsewhere', closeReason: 'position closed outside C1 (Gemini, liquidation or manual)', closedAt: deps.now(), updatedAt: deps.now() })
          .where(eq(c1Exits.id, r.id)).run()
      }
    }
  } catch (e) {
    logger.error(`C1 pass failed: ${e}`)
  }
  return summary
}
