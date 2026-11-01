/** Port of `services/news_feed.py`. */
import { XMLParser } from 'fast-xml-parser'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.newsFeed')

const NEWS_FEED_URL = 'https://coinjournal.net/news/feed/'

const parser = new XMLParser({
  ignoreAttributes: true,
  processEntities: true,
  trimValues: true,
})

/** Mirrors Python's `html.unescape` for the handful of named entities in RSS. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&amp;/g, '&')
}

function stripHtmlTags(text: string): string {
  if (!text) return ''
  const cleaned = unescapeHtml(text).replace(/<[^>]+>/g, ' ')
  return cleaned.replace(/\s+/g, ' ').trim()
}

/** RFC 2822 pubDate -> 'YYYY-MM-DD HH:MM:SSZ' in UTC. */
function formatPubDate(raw: string): string {
  if (!raw) return raw
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')}Z`
}

function asText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && '#text' in (value as object)) {
    return String((value as Record<string, unknown>)['#text'] ?? '')
  }
  return ''
}

export async function fetchLatestNews(maxChars = 4000): Promise<string> {
  try {
    const response = await fetch(NEWS_FEED_URL, {
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 200) {
      logger.warning(`Failed to fetch news feed: status ${response.status}`)
      return ''
    }

    const xml = await response.text()
    const doc = parser.parse(xml) as Record<string, any>
    const channel = doc?.rss?.channel ?? doc?.channel
    if (!channel) return ''

    const rawItems = channel.item
    const items: Record<string, unknown>[] = Array.isArray(rawItems)
      ? rawItems
      : rawItems
        ? [rawItems]
        : []

    const entries: string[] = []

    for (const item of items) {
      const title = stripHtmlTags(asText(item.title))
      const pubDateRaw = asText(item.pubDate).trim()

      let summary = stripHtmlTags(asText(item.description))
      summary = summary
        .replace(/The post .*? appeared first on .*/i, '')
        .trim()

      const formattedTime = pubDateRaw ? formatPubDate(pubDateRaw) : pubDateRaw

      const parts: string[] = []
      if (formattedTime) parts.push(formattedTime)
      if (title) parts.push(title)

      let entryText = parts.join(' | ')
      if (summary) {
        entryText = entryText ? `${entryText}: ${summary}` : summary
      }
      entryText = entryText.trim()
      if (!entryText) continue

      const existingText = entries.join('\n')
      const candidateText = existingText
        ? `${existingText}\n${entryText}`
        : entryText

      if (candidateText.length > maxChars) {
        let remaining = maxChars - existingText.length
        if (existingText) remaining -= 1
        if (remaining <= 0) break

        let truncated = entryText.slice(0, remaining).replace(/\s+$/, '')
        if (truncated) {
          if (truncated.length < entryText.length) {
            truncated = `${truncated.replace(/[ .,;:-]+$/, '')}...`
          }
          entries.push(truncated)
        }
        break
      }

      entries.push(entryText)
    }

    return entries.join('\n')
  } catch (err) {
    logger.warning(`Failed to process news feed: ${err}`)
    return ''
  }
}


// ---------------------------------------------------------------------------
// Task 007F (ALPHA_PROMPT=v3 only): structured news items and their filter.
// fetchLatestNews above is unchanged and remains what the original prompt uses.

export const NEWS_SOURCE = 'coinjournal.net'

export interface NewsItem {
  title: string
  summary: string
  /** Publication time (ms), null when the feed gives none or an unreadable one. */
  publishedAt: number | null
  source: string
}

/** The feed's items with their publication time; [] on any failure (logged). */
export async function fetchNewsItems(): Promise<{ items: NewsItem[]; error?: string }> {
  try {
    const response = await fetch(NEWS_FEED_URL, { signal: AbortSignal.timeout(10_000) })
    if (response.status !== 200) return { items: [], error: `status ${response.status}` }
    return { items: parseNewsXml(await response.text()) }
  } catch (err) {
    logger.warning(`Failed to process news feed (v3): ${err}`)
    return { items: [], error: String(err) }
  }
}

export function parseNewsXml(xml: string): NewsItem[] {
  const doc = parser.parse(xml) as Record<string, any>
  const channel = doc?.rss?.channel ?? doc?.channel
  const raw = channel?.item
  const items: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return items.map((item) => {
    const date = new Date(asText(item.pubDate).trim())
    return {
      title: stripHtmlTags(asText(item.title)),
      summary: stripHtmlTags(asText(item.description)).replace(/The post .*? appeared first on .*/i, '').trim(),
      publishedAt: Number.isNaN(date.getTime()) ? null : date.getTime(),
      source: NEWS_SOURCE,
    }
  }).filter((i) => i.title || i.summary)
}

/** Words that tie a news item to a coin (whole words, case-insensitive). */
export const COIN_TERMS: Record<string, string[]> = {
  BTC: ['bitcoin', 'btc'],
  ETH: ['ethereum', 'ether', 'eth'],
  SOL: ['solana', 'sol'],
  BNB: ['bnb', 'binance coin', 'bnb chain'],
  XRP: ['xrp', 'ripple'],
  DOGE: ['dogecoin', 'doge'],
}
/** Words that make an item about the whole crypto market or its macro drivers. */
export const MARKET_TERMS = [
  'crypto market', 'cryptocurrency market', 'crypto markets', 'altcoins', 'altcoin', 'liquidations', 'liquidated',
  'federal reserve', 'fed', 'fomc', 'interest rate', 'interest rates', 'rate cut', 'inflation', 'cpi', 'sec',
  'etf', 'etfs', 'stablecoin', 'stablecoins', 'tariff', 'tariffs', 'regulation', 'treasury',
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const termRe = (terms: string[]) => new RegExp(`(^|[^a-z0-9])(${terms.map(escapeRe).join('|')})(?=$|[^a-z0-9])`, 'i')
const COIN_RE = Object.fromEntries(Object.entries(COIN_TERMS).map(([c, t]) => [c, termRe(t)])) as Record<string, RegExp>
const MARKET_RE = termRe(MARKET_TERMS)

export const NEWS_LIMITS = {
  maxAgeMs: 24 * 3_600_000,
  /** A publication time this far in the future is refused (clock skew allowance). */
  futureToleranceMs: 5 * 60_000,
  maxItems: 8,
  maxTitleChars: 160,
  maxSummaryChars: 280,
  /** Two titles sharing at least this share of their words are the same story. */
  duplicateSimilarity: 0.8,
} as const

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 2))
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const w of a) if (b.has(w)) common++
  return common / Math.min(a.size, b.size)
}
/** Removes control characters and collapses whitespace; cuts at `max` characters with an ellipsis. */
export function cleanNewsText(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3).replace(/[ .,;:-]+$/, '')}...` : t
}

export interface SelectedNews {
  published: string
  age_hours: number
  source: string
  coins: string[]
  scope: 'coin' | 'market'
  /** false when the same item was already in an earlier cycle's prompt (it is still current, not new). */
  new_since_last_cycle: boolean
  title: string
  summary: string
}
export interface NewsSelection {
  items: SelectedNews[]
  /** Why items were left out, by reason (counts). */
  dropped: { no_date: number; future_dated: number; older_than_24h: number; not_relevant: number; duplicate: number; over_limit: number }
  fetched: number
  error?: string
}

/**
 * The news the v3 prompt shows at `now`: dated, at most 24 h old, not in the
 * future, about the six coins or the whole market, without duplicates,
 * newest first, at most maxItems, each with its age. `seen` (key -> first
 * time shown) marks what earlier cycles already showed; it is updated.
 */
export function selectNews(fetched: readonly NewsItem[], now: number, seen: Map<string, number>, error?: string): NewsSelection {
  const dropped = { no_date: 0, future_dated: 0, older_than_24h: 0, not_relevant: 0, duplicate: 0, over_limit: 0 }
  const kept: { item: NewsItem; coins: string[]; key: string; w: Set<string> }[] = []
  const sorted = [...fetched].sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
  for (const item of sorted) {
    if (item.publishedAt === null) { dropped.no_date++; continue }
    if (item.publishedAt > now + NEWS_LIMITS.futureToleranceMs) { dropped.future_dated++; continue }
    if (now - item.publishedAt > NEWS_LIMITS.maxAgeMs) { dropped.older_than_24h++; continue }
    const text = `${item.title} ${item.summary}`
    const coins = Object.keys(COIN_RE).filter((c) => COIN_RE[c]!.test(text))
    if (!coins.length && !MARKET_RE.test(text)) { dropped.not_relevant++; continue }
    const w = words(item.title || item.summary)
    const key = [...w].sort().join(' ')
    if (kept.some((k) => k.key === key || similarity(k.w, w) >= NEWS_LIMITS.duplicateSimilarity)) { dropped.duplicate++; continue }
    if (kept.length >= NEWS_LIMITS.maxItems) { dropped.over_limit++; continue }
    kept.push({ item, coins, key, w })
  }
  for (const [k, t] of seen) if (now - t > 2 * NEWS_LIMITS.maxAgeMs) seen.delete(k)
  const items = kept.map(({ item, coins, key }) => {
    const first = seen.get(key)
    if (first === undefined) seen.set(key, now)
    return {
      published: new Date(item.publishedAt!).toISOString().slice(0, 16) + 'Z',
      age_hours: Math.round(((now - item.publishedAt!) / 3_600_000) * 10) / 10,
      source: item.source, coins, scope: coins.length ? 'coin' as const : 'market' as const,
      new_since_last_cycle: first === undefined || first === now,
      title: cleanNewsText(item.title, NEWS_LIMITS.maxTitleChars), summary: cleanNewsText(item.summary, NEWS_LIMITS.maxSummaryChars),
    }
  })
  return { items, dropped, fetched: fetched.length, ...(error ? { error } : {}) }
}
