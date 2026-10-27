/**
 * Test stand-in for the ccxt Hyperliquid exchange (tests only): fetchTickers
 * answers with the quotes set here, shaped like ccxt's parsed tickers (last =
 * mid, info = the raw asset context with markPx/oraclePx), and
 * publicPostInfo({ type: 'meta' }) with the real metadata snapshot in
 * hyperliquid-meta.json, and publicPostInfo({ type: 'l2Book' }) with the book
 * set in `books` (raw, as the exchange sends it) or, when none is set, a
 * zero-spread book at the coin's mid (the stub quote, else the price cache)
 * with ample depth, so tests written before Task 006I-5 keep filling at the
 * mid. Nothing goes to the network.
 */
import fs from 'node:fs'
import { hyperliquidClient } from '../hyperliquid.js'
import { getCachedPrice, priceCache } from '../priceCache.js'

export const META = JSON.parse(fs.readFileSync(new URL('./hyperliquid-meta.json', import.meta.url), 'utf8'))

export interface StubQuote {
  mid: number
  /** markPx sent as is (a number, a string, null...); omitted when undefined. */
  mark?: unknown
  oracle?: number
}

export const hyperliquidStub = {
  quotes: {} as Record<string, StubQuote>,
  /** When true fetchTickers fails, as on a network error. */
  failTickers: false,
  /** When true the meta request fails. */
  failMeta: false,
  tickerRequests: 0,
  metaRequests: 0,
  /** Raw l2Book answers by coin (any shape, to test validation). */
  books: {} as Record<string, unknown>,
  /** When true the l2Book request fails. */
  failBook: false,
  bookRequests: 0,
}

/** Replaces the exchange of the shared client and empties the price cache. */
export function installHyperliquidStub(): void {
  ;(hyperliquidClient as any).exchange = {
    fetchTickers: async (symbols: string[]) => {
      hyperliquidStub.tickerRequests++
      if (hyperliquidStub.failTickers) throw new Error('network error (stub)')
      const out: Record<string, unknown> = {}
      for (const symbol of symbols) {
        const coin = symbol.split('/')[0]!
        const q = hyperliquidStub.quotes[coin]
        if (!q) continue
        const info: Record<string, unknown> = { name: coin, midPx: String(q.mid), oraclePx: String(q.oracle ?? q.mid) }
        if (q.mark !== undefined) info.markPx = typeof q.mark === 'number' ? String(q.mark) : q.mark
        out[symbol] = { symbol, last: q.mid, close: q.mid, info }
      }
      return out
    },
    publicPostInfo: async (body: { type: string; coin?: string }) => {
      if (body.type === 'l2Book') {
        hyperliquidStub.bookRequests++
        if (hyperliquidStub.failBook) throw new Error('l2Book unavailable (stub)')
        const coin = body.coin!
        if (coin in hyperliquidStub.books) return hyperliquidStub.books[coin]
        const mid = hyperliquidStub.quotes[coin]?.mid ?? getCachedPrice(coin, 'CRYPTO')
        if (!mid) throw new Error(`stub: no price for ${coin}`)
        const level = [{ px: String(mid), sz: '1000000000', n: 1 }]
        return { coin, time: Date.now(), levels: [level, level] }
      }
      if (body.type !== 'meta') throw new Error(`stub: ${body.type} not served`)
      hyperliquidStub.metaRequests++
      if (hyperliquidStub.failMeta) throw new Error('meta unavailable (stub)')
      return META
    },
  }
  clearPrices()
}

/**
 * Sets a coin's mid and mark price (the mid when no mark argument is given;
 * an explicit undefined sends no markPx) and forgets cached prices.
 */
export function quote(coin: string, mid: number, ...mark: unknown[]): void {
  hyperliquidStub.quotes[coin] = { mid, mark: mark.length > 0 ? mark[0] : mid }
  clearPrices()
}

export function clearPrices(): void {
  ;(priceCache as any).cache.clear()
}
