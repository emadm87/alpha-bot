/**
 * Order book execution for the 'hyperliquid' cost model (Task 006I-5).
 *
 * Source: the public `l2Book` info request (docs for-developers/api/
 * info-endpoint): { coin, time, levels: [bids, asks] }, each level
 * { px, sz, n } as strings, best first, at most 20 levels per side.
 *
 * Hyperliquid has no market order type: a market order is a limit order with
 * time in force IOC at a price beyond the mid, so it takes the resting levels
 * up to that price and the rest is cancelled. Reproduced here:
 *   buy (LONG open, SHORT close)  -> takes the asks, best first;
 *   sell (SHORT open, LONG close) -> takes the bids, best first;
 *   average price = volume-weighted over the levels taken;
 *   AI orders stop at mid * (1 +/- HL_MARKET_SLIPPAGE), liquidations do not;
 *   size beyond the visible levels (or the bound) is not filled: partial fill.
 * A snapshot that is invalid, crossed, one-sided, stale or for another coin is
 * never used: no price is invented.
 */
import { getL2BookFromHyperliquid } from './hyperliquid.js'

/** Oldest snapshot accepted, measured from the exchange's own `time`. */
export const BOOK_MAX_AGE_MS = 10_000
/** Clock skew tolerated for a snapshot time ahead of the local clock. */
export const BOOK_FUTURE_TOLERANCE_MS = 5_000
/**
 * Slippage bound of a market order: the default of Hyperliquid's official
 * Python SDK (market_open / market_close, DEFAULT_SLIPPAGE = 0.05). It is a
 * client convention, not an exchange rule.
 */
export const HL_MARKET_SLIPPAGE = 0.05

export interface BookLevel {
  px: number
  sz: number
}

export interface BookSnapshot {
  coin: string
  /** Snapshot time from Hyperliquid, ms since epoch. */
  time: number
  /** Local time the snapshot was received. */
  receivedAt: number
  bids: BookLevel[]
  asks: BookLevel[]
  bestBid: number
  bestAsk: number
  mid: number
  spread: number
}

export type BookSide = 'buy' | 'sell'

export interface BookFill {
  side: BookSide
  requested: number
  filled: number
  avgPrice: number
  /** Sum of px * sz over the levels taken. */
  notional: number
  /** Price of the last level taken. */
  worstPrice: number
  limitPrice: number | null
  levels: BookLevel[]
  partial: boolean
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const positive = (v: unknown): number | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  if (v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Validated snapshot, or why it cannot be used. */
export function parseL2Book(raw: unknown, coin: string, receivedAt: number, now = receivedAt): BookSnapshot | { error: string } {
  if (!isObject(raw)) return { error: `${coin} book: not an object` }
  if (raw.coin !== coin) return { error: `${coin} book: belongs to ${String(raw.coin)}` }
  const time = typeof raw.time === 'number' ? raw.time : Number.NaN
  if (!Number.isFinite(time) || time <= 0) return { error: `${coin} book: snapshot time missing` }
  if (time - now > BOOK_FUTURE_TOLERANCE_MS) return { error: `${coin} book: snapshot time ${time - now} ms in the future` }
  if (now - time > BOOK_MAX_AGE_MS) return { error: `${coin} book: snapshot ${Math.round((now - time) / 1000)} s old` }
  if (!Array.isArray(raw.levels) || raw.levels.length !== 2) return { error: `${coin} book: levels missing` }
  const sides: BookLevel[][] = []
  for (const [i, name] of [[0, 'bids'], [1, 'asks']] as const) {
    const levels = raw.levels[i]
    if (!Array.isArray(levels) || levels.length === 0) return { error: `${coin} book: no ${name}` }
    const parsed: BookLevel[] = []
    for (const l of levels) {
      const px = positive(isObject(l) ? l.px : null)
      const sz = positive(isObject(l) ? l.sz : null)
      if (px === null || sz === null) return { error: `${coin} book: invalid ${name} level ${JSON.stringify(l)}` }
      const prev = parsed.at(-1)
      // best first: bids strictly descending, asks strictly ascending
      if (prev && (name === 'bids' ? px >= prev.px : px <= prev.px)) return { error: `${coin} book: ${name} not ordered best first` }
      parsed.push({ px, sz })
    }
    sides.push(parsed)
  }
  const [bids, asks] = sides as [BookLevel[], BookLevel[]]
  const bestBid = bids[0]!.px
  const bestAsk = asks[0]!.px
  if (bestBid > bestAsk) return { error: `${coin} book: crossed (bid ${bestBid} > ask ${bestAsk})` }
  return { coin, time, receivedAt, bids, asks, bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid }
}

/**
 * Takes the levels of one side for `quantity`, best first, without going past
 * `limitPrice` (null: no bound). The size filled is the sum of the sizes
 * taken; when everything is taken it is exactly `quantity`.
 */
export function walkBook(book: BookSnapshot, side: BookSide, quantity: number, limitPrice: number | null): BookFill {
  const levels = side === 'buy' ? book.asks : book.bids
  const taken: BookLevel[] = []
  let remaining = quantity
  let filled = 0
  let notional = 0
  for (const level of levels) {
    if (remaining <= 1e-12) break
    if (limitPrice !== null && (side === 'buy' ? level.px > limitPrice : level.px < limitPrice)) break
    const take = Math.min(remaining, level.sz)
    taken.push({ px: level.px, sz: take })
    filled += take
    notional += take * level.px
    remaining -= take
  }
  const complete = remaining <= 1e-12
  if (complete) filled = quantity
  else filled = Number(filled.toFixed(10))
  return {
    side,
    requested: quantity,
    filled,
    avgPrice: filled > 0 ? notional / filled : 0,
    notional,
    worstPrice: taken.at(-1)?.px ?? 0,
    limitPrice,
    levels: taken,
    partial: !complete,
  }
}

/** IOC limit price of a market order: mid moved by the slippage bound. */
export function marketLimitPrice(book: BookSnapshot, side: BookSide): number {
  return side === 'buy' ? book.mid * (1 + HL_MARKET_SLIPPAGE) : book.mid * (1 - HL_MARKET_SLIPPAGE)
}

/** One `l2Book` request, validated; never throws. */
export async function fetchBook(coin: string): Promise<BookSnapshot | { error: string }> {
  try {
    const raw = await getL2BookFromHyperliquid(coin)
    const now = Date.now()
    return parseL2Book(raw, coin, now, now)
  } catch (e) {
    return { error: `${coin} book request failed: ${e}` }
  }
}
