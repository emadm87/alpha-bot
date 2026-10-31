// ALPHA BOT 007E — descriptive analysis of the AI decisions of one or more pilot runs, from the read-only exports of
// pilot/export-diagnostics.mjs. No network, no AI call, deterministic.
//
//   npx tsx research/ai-decisions/analyze.mts <export.json> [more exports...] [--out <dir>]
//
// It describes WHAT the model received and WHAT it answered; it never states what Gemini would have decided with
// another prompt, and it does not label a HOLD as an error: market moves during HOLD streaks are reported as
// context, without hindsight judgement.
import fs from 'node:fs'
import path from 'node:path'
import { atrFromHourBars, hourBars, type Bar } from '../../src/services/exitRules.ts'
import { asBar15, COINS, DATA_DIR, loadBars, verifiedManifest } from '../exit-rules/lib.mts'

/** Words that tag a reason (a reason can have several tags). Literal, case-insensitive, listed here to be checked. */
export const REASON_TAGS: Record<string, RegExp> = {
  uncertainty_wait: /\b(mixed|unclear|uncertain|wait|waiting|clearer|neutral|sideways|consolidat|lack(?:ing|s)? (?:of )?(?:strong|clear)|no clear|indecis)/i,
  support_resistance: /\b(support|resistance|level|breakout|breakdown|range)\b/i,
  trend_momentum: /\b(trend|momentum|bullish|bearish|uptrend|downtrend|rally|recovery|rebound)\b/i,
  indicators: /\b(EMA|SMA|RSI|MACD|moving average|overbought|oversold)\b/i,
  news_flows: /\b(news|report|ETF|inflow|outflow|launch|regulat|institution)/i,
  position_management: /\b(position|profit|loss|unrealized|P&L|PnL|stop|take profit|close)\b/i,
  costs_risk: /\b(fee|funding|cost|risk|leverage|liquidat|volatil)/i,
}

interface Export {
  schema: string; source: { run: string }; run: { started_at: string; stopped_at: string; plan?: { model?: string } } | null
  cycles: {
    ts: string; prompt_chars: number; prompt_has_current_time: boolean; position_info: string
    prices: Record<string, number> | null; portfolio: { positions: Record<string, unknown> | null }
    news: { items: number; hash: string; newest_age_h: number | null; oldest_age_h: number | null; items_about_none_of_the_six: number }
    decision: { operation: string | null; symbol: string | null; direction: string | null; reason: string | null; leverage: number | null; target_portion_of_balance: number | null
      reason_numbers: { value: number; source: string }[] } | null
    response: { prompt_tokens: number | null; completion_tokens: number | null; latency_ms: number } | null
    outcome: { status: string } | null; api_errors: unknown[]
  }[]
  fills: { trade_time: string; symbol: string; side: string; price: number; quantity: number; leverage: number }[]
}

const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]! }
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)
const r2 = (x: number) => Math.round(x * 100) / 100

export function analyzeExport(e: Export, bars15?: Record<string, Bar[]>) {
  const c = e.cycles
  const ops: Record<string, number> = {}
  for (const x of c) { const k = x.decision?.operation ?? 'no_decision'; ops[k] = (ops[k] ?? 0) + 1 }
  // HOLD streaks
  const streaks: number[] = []
  let run = 0
  for (const x of c) { if (x.decision?.operation === 'hold') run++; else { if (run) streaks.push(run); run = 0 } }
  if (run) streaks.push(run)
  // input variability: identical news between consecutive cycles, price change between consecutive prompts
  let sameNews = 0
  const priceMoves: number[] = []
  for (let i = 1; i < c.length; i++) {
    if (c[i]!.news.hash === c[i - 1]!.news.hash) sameNews++
    const a = c[i - 1]!.prices, b = c[i]!.prices
    if (a && b) priceMoves.push(Math.max(...Object.keys(b).filter((k) => a[k]).map((k) => Math.abs(b[k]! / a[k]! - 1) * 100)))
  }
  // reasons
  const tags: Record<string, number> = Object.fromEntries(Object.keys(REASON_TAGS).map((k) => [k, 0]))
  const numberSources: Record<string, number> = {}
  for (const x of c) {
    const reason = x.decision?.reason ?? ''
    for (const [k, re] of Object.entries(REASON_TAGS)) if (re.test(reason)) tags[k]!++
    for (const n of x.decision?.reason_numbers ?? []) numberSources[n.source] = (numberSources[n.source] ?? 0) + 1
  }
  const withPosition = c.filter((x) => x.portfolio.positions && Object.keys(x.portfolio.positions).length > 0)
  const positionMentioned = withPosition.filter((x) => {
    const reason = x.decision?.reason ?? ''
    return Object.keys(x.portfolio.positions!).some((s) => new RegExp(`\\b${s}\\b`, 'i').test(reason)) && REASON_TAGS.position_management!.test(reason)
  }).length
  // market context from candles (when they cover the run): moves of at least 2 ATR(1 h) in the 4 h before a cycle
  let context: Record<string, unknown> | null = null
  if (bars15) {
    const hourly = Object.fromEntries(COINS.map((k) => [k, hourBars(asBar15(bars15[k] ?? []))]))
    const lastBar = Math.min(...COINS.map((k) => bars15[k]?.at(-1)?.endTime ?? 0))
    const covered = c.filter((x) => Date.parse(x.ts) <= lastBar && Date.parse(x.ts) - 4 * 3_600_000 >= (bars15.BTC?.[0]?.openTime ?? Infinity) + 20 * 3_600_000)
    if (covered.length) {
      let holdsAfterBigMove = 0, cyclesAfterBigMove = 0
      const perCoin: Record<string, number> = Object.fromEntries(COINS.map((k) => [k, 0]))
      for (const x of covered) {
        const t = Date.parse(x.ts)
        const big = COINS.filter((k) => {
          const a = atrFromHourBars(hourly[k]!, t, 14)
          if ('error' in a) return false
          const before = (bars15[k] ?? []).filter((b) => b.endTime <= t)
          const now = before.at(-1)?.close, then = before.find((b) => b.endTime >= t - 4 * 3_600_000)?.close
          return now !== undefined && then !== undefined && Math.abs(now - then) >= 2 * a.atr
        })
        if (big.length) { cyclesAfterBigMove++; big.forEach((k) => perCoin[k]!++); if (x.decision?.operation === 'hold') holdsAfterBigMove++ }
      }
      context = { cycles_covered: covered.length, cycles_after_a_move_of_2ATR_in_4h: cyclesAfterBigMove, of_which_hold: holdsAfterBigMove, by_coin: perCoin,
        note: 'a move of at least 2 ATR(14, 1h) in the 4 h before the cycle on any of the six coins; context only, not a judgement of the decision' }
    }
  }
  const tokensIn = c.map((x) => x.response?.prompt_tokens).filter((x): x is number => typeof x === 'number')
  const tokensOut = c.map((x) => x.response?.completion_tokens).filter((x): x is number => typeof x === 'number')
  return {
    run: e.source.run, cycles: c.length, from: c[0]?.ts ?? null, to: c.at(-1)?.ts ?? null,
    operations: ops, entries: e.fills.filter((f) => f.side === 'LONG' || f.side === 'SHORT').map((f) => `${f.symbol} ${f.side} ${f.quantity} @ ${f.price} ${f.leverage}x ${f.trade_time}`),
    hold_streaks: { count: streaks.length, longest: Math.max(0, ...streaks), median: median(streaks) },
    prompt: {
      chars_median: median(c.map((x) => x.prompt_chars)), has_current_time_share: r2(c.filter((x) => x.prompt_has_current_time).length / Math.max(1, c.length)),
      position_info: [...new Set(c.map((x) => x.position_info))], prompt_tokens_median: median(tokensIn), completion_tokens_median: median(tokensOut),
    },
    news: {
      items_median: median(c.map((x) => x.news.items)), newest_age_h_median: r1(median(c.map((x) => x.news.newest_age_h ?? NaN).filter(Number.isFinite))),
      oldest_age_h_median: r1(median(c.map((x) => x.news.oldest_age_h ?? NaN).filter(Number.isFinite))),
      share_items_about_none_of_the_six: r2(c.reduce((s, x) => s + x.news.items_about_none_of_the_six, 0) / Math.max(1, c.reduce((s, x) => s + x.news.items, 0))),
      identical_to_previous_cycle_share: r2(sameNews / Math.max(1, c.length - 1)), distinct_news_blocks: new Set(c.map((x) => x.news.hash)).size,
    },
    prompt_price_change_between_cycles_pct: { median_of_max_coin: r2(median(priceMoves) ?? 0), max: r2(Math.max(0, ...priceMoves)) },
    reasons: { tagged: tags, cited_number_sources: numberSources },
    open_position_cycles: { cycles: withPosition.length, reasons_about_that_position: positionMentioned },
    market_context: context,
  }
}

if (process.argv[1] && process.argv[1].endsWith('analyze.mts')) {
  const args = process.argv.slice(2)
  const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : null
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
  if (!files.length) { console.error('usage: npx tsx research/ai-decisions/analyze.mts <export.json> [...] [--out DIR]'); process.exit(64) }
  const m = verifiedManifest()
  const bars15 = loadBars(path.join(DATA_DIR, 'candles-15m.csv.gz'), 900_000, Date.parse(m.files['candles-15m.csv.gz']!.fetched_at))
  const results = files.map((f) => {
    const e = JSON.parse(fs.readFileSync(f, 'utf8')) as Export
    if (e.schema !== 'alpha-bot-ai-diagnostics/1') throw new Error(`${f}: not an export of pilot/export-diagnostics.mjs`)
    return analyzeExport(e, bars15)
  })
  const text = JSON.stringify({ generated_by: 'research/ai-decisions/analyze.mts', reason_tags: Object.fromEntries(Object.entries(REASON_TAGS).map(([k, v]) => [k, v.source])), runs: results }, null, 2)
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'ai-decisions.json'), text + '\n') }
  console.log(text)
}
