// ALPHA BOT 007F — the v3 prompt rendered OFFLINE from the committed public data, with its size and estimated cost.
// No network, no AI call, no database: the same builder functions as the app (coinBrief, buildMessagesV3), fed with the
// committed Hyperliquid candles and funding at a past time.
//
//   npx tsx research/ai-decisions/prompt-v3-example.mts [--at 2026-10-28T18:37:00Z] [--protection C3] [--out <file>]
//
// What differs from a live cycle (said in the output too):
// - price = close of the last 15 m candle closed at --at (live: Hyperliquid mark price);
// - funding = last committed hourly funding rate at or before --at (live: the asset context);
// - impact prices and 24 h notional volume are not in the committed data: null, listed as missing;
// - account flat (1000 USDC, no position), no previous decision, news unavailable offline.
// So the example shows exactly what an empty account would send; the size of a full prompt (one position, 6 decisions
// in memory, 8 news items) is estimated by adding the measured size of those blocks at their maximum length.
import fs from 'node:fs'
import path from 'node:path'
import { coinBrief, briefSnapshot } from '../../src/services/marketContext.ts'
import { loadExitConfig } from '../../src/services/exitRules.ts'
import { selectNews } from '../../src/services/newsFeed.ts'
import { buildMessagesV3, estimateDailyCost, estimateTokens } from '../../src/services/promptV3.ts'
import type { V3Context } from '../../src/services/v3Context.ts'
import { COINS, DATA_DIR, loadFunding, verifiedManifest } from '../exit-rules/lib.mts'
import { aggregate, loadBarsWithVolume } from './context-v3.mts'

const HOUR = 3_600_000
const args = process.argv.slice(2)
const flag = (name: string, def: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : def)
const at = Date.parse(flag('--at', '2026-10-28T18:37:00Z'))
if (!Number.isFinite(at)) { console.error('invalid --at'); process.exit(64) }
const exitModule = loadExitConfig({ ALPHA_PROTECTION: flag('--protection', 'off') })

const m = verifiedManifest()
const b15 = loadBarsWithVolume(path.join(DATA_DIR, 'candles-15m.csv.gz'), Date.parse(m.files['candles-15m.csv.gz']!.fetched_at))
const funding = loadFunding(path.join(DATA_DIR, 'funding-1h.csv.gz'))
const markets: V3Context['markets'] = {}
const snapshots: V3Context['snapshots'] = {}
const prices: V3Context['prices'] = {}
for (const c of COINS) {
  const closed15 = b15[c]!.filter((b) => b.endTime <= at)
  const h1 = aggregate(closed15, HOUR).filter((b) => b.openTime >= at - 45 * 24 * HOUR)
  const f = [...(funding[c] ?? new Map())].filter(([h]) => h <= at).sort((x, y) => x[0] - y[0]).at(-1)?.[1] ?? null
  const live = { markPx: closed15.at(-1)?.close ?? null, midPx: null, funding: f, premium: null, openInterest: null, dayNtlVlm: null, impactPxs: null, receivedAt: at }
  const brief = coinBrief(h1, live, at, { feeRate: 0.00045, equityBase: 1000 })
  // offline the "live" price is the last 15 m trade close, not a mark price: say so
  markets[c] = { ...brief, ...(brief.price_source ? { price_source: 'last 15 m trade close (offline example; live: mark price)' } : {}), mid_price: closed15.at(-1)?.close ?? null }
  snapshots[c] = briefSnapshot(brief)
  prices[c] = brief.price
}
const ctx: V3Context = {
  now: at,
  account: { cash_usdc: 1000, frozen_cash_usdc: 0, total_assets_usdc: 1000, cost_model: 'hyperliquid', taker_fee_pct_each_side: 0.045, open_positions: 0 },
  positions: [], cooldowns: [], exitModule, memory: [], markets, snapshots, prices, history: {},
  news: selectNews([], at, new Map(), 'offline example: the news feed is not read'),
}
const [sys, usr] = buildMessagesV3(ctx)
const tokens = { system: estimateTokens(sys!.content), user: estimateTokens(usr!.content) }
// maximum-size blocks of a full prompt, measured on their JSON lines (values at their length limits)
const memoryLine = JSON.stringify({ minutes_ago: 1435, operation: 'hold', symbol: 'DOGE', direction: 'short', outcome: 'execution_failed', valid: false,
  reason: 'x'.repeat(220), thesis: 'y'.repeat(160), invalidation_price: 0.212345, target_price: 0.198765, price_then: 0.205432, price_now: 0.206789, change_since_pct: 0.66 })
const newsLine = JSON.stringify({ published: '2026-10-28T18:00Z', age_hours: 23.9, source: 'coinjournal.net', coins: ['BTC', 'ETH'], scope: 'coin', new_since_last_cycle: false,
  title: 't'.repeat(160), summary: 's'.repeat(280) })
const positionLineChars = 1300 // upper bound of a v3 position line with its exit plan, enforced by tests 7 and 10 of src/services/aiV3.test.ts
const extra = 6 * (memoryLine.length + 1) + 8 * (newsLine.length + 1) + positionLineChars
const full = tokens.system + tokens.user + estimateTokens('x'.repeat(extra))
const out = [
  `# v3 prompt, offline example at ${new Date(at).toISOString()} (exit module ${exitModule.mode})`,
  '# Data: committed Hyperliquid candles and funding (backend/research/exit-rules/data, SHA-256 verified). Price = last 15 m close;',
  '# impact prices and 24 h volume not in the committed data (null, listed as missing); flat account, no memory, no news.',
  '', '## SYSTEM', sys!.content, '', '## USER', usr!.content, '',
  '## SIZE (estimates: characters / 3.2; no API call)',
  JSON.stringify({
    system_chars: sys!.content.length, user_chars: usr!.content.length, tokens_this_example: tokens.system + tokens.user,
    tokens_full_prompt_estimate: full, note_full: 'plus one position with exit plan, 6 decisions in memory and 8 news items at their maximum length',
    output_tokens_assumed: 250, cost_per_day_5min: estimateDailyCost(full, 250), cost_per_day_original_measured: estimateDailyCost(1800, 97),
  }, null, 2),
].join('\n') + '\n'
const file = args.includes('--out') ? flag('--out', '') : null
if (file) {
  if (fs.existsSync(file)) { console.error(`${file} exists: not overwritten`); process.exit(73) }
  fs.writeFileSync(file, out)
  console.log(`written ${file}`)
} else process.stdout.write(out)
