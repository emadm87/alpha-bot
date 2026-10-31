/**
 * Research tools of Task 007E: the read-only export of a run's AI decisions
 * (pilot/export-diagnostics.mjs), the descriptive analysis
 * (research/ai-decisions/analyze.mts) and the proposed market context
 * (research/ai-decisions/context-v3.mts). None of them is used by the app.
 *
 * Run: npx tsx --test src/services/aiDecisionsResearch.test.ts
 *
 * A synthetic run in the exact format of the app's trace (prompt built by
 * the real buildPrompt) and a throwaway SQLite file; no network, no AI.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-research-'))
process.env.DATABASE_PATH = path.join(tmp, 'app.db')
process.env.LOG_LEVEL = 'error'
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { buildPrompt } = await import('./aiDecision.js')
const { rawDb } = await import('../db/client.js')
const { analyzeExport } = (await import(new URL('../../research/ai-decisions/analyze.mts', import.meta.url).href)) as any
const ctx = (await import(new URL('../../research/ai-decisions/context-v3.mts', import.meta.url).href)) as any
after(() => {
  rawDb.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 9, 28, 18, 0, 0)
const SUMMARY = 'Key takeaways BTC traded around $81,593, above its 50-day EMA at $80,878.'
const news = [
  `2026-10-23 08:14:05Z | Bitcoin holds near $81,800 as BTC defends key support: ${SUMMARY}`,
  '2026-10-28 08:53:21Z | NEAR eyes $5 after Jio perpetuals launch: NEAR edges higher.',
].join('\n')
const FAKE_KEY = 'AIza' + 'x'.repeat(30)

/** A run directory with a trace of `n` cycles (prompts from the real buildPrompt) and a database. */
function makeRun(name: string, n: number, reasonOf: (i: number) => string, positions: Record<string, unknown> = {}) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    const ts = new Date(T0 + i * 300_000).toISOString()
    const prompt = buildPrompt({ cash: 1000, frozen_cash: 0, total_assets: 1000, positions: positions as any },
      { BTC: 81265 + i, ETH: 2400, SOL: 100, BNB: 750, XRP: 1.32, DOGE: 0.08 }, news)
    const id = `c${i}`
    const reason = reasonOf(i)
    lines.push(JSON.stringify({ ts, cycle_id: id, event: 'request', account_id: 2, model: 'm', endpoint: 'https://example.invalid/v1/chat', payload: { messages: [{ role: 'user', content: prompt }] } }))
    lines.push(JSON.stringify({ ts: new Date(T0 + i * 300_000 + 1500).toISOString(), cycle_id: id, event: 'response', response: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1755, completion_tokens: 97 } } }))
    lines.push(JSON.stringify({ ts, cycle_id: id, event: 'decision', decision: { operation: i === 1 ? 'open' : 'hold', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.5, leverage: 3, reason } }))
    lines.push(JSON.stringify({ ts, cycle_id: id, event: 'outcome', account_id: 2, status: i === 1 ? 'executed' : 'hold', detail: 'x' }))
  }
  fs.writeFileSync(path.join(dir, 'trace.jsonl'), lines.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify({ account_id: 2, started_at: new Date(T0).toISOString(), stopped_at: new Date(T0 + n * 300_000).toISOString(), status: 'complete', plan: { cycles: n, model: 'm', capital_usdc: 1000 } }))
  const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
  const db = new Database(path.join(dir, 'pilot.db'))
  db.exec(`CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT, model TEXT, api_key TEXT, account_type TEXT, initial_capital REAL, current_cash REAL, cost_model TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, order_no TEXT, leverage INTEGER);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, order_id INTEGER, account_id INTEGER, symbol TEXT, side TEXT, price REAL, quantity REAL, commission REAL, trade_time TEXT);`)
  db.prepare("INSERT INTO accounts VALUES (2, 'pilot-m', 'm', ?, 'AI', 1000, 750, 'hyperliquid')").run('secret-db-value-' + 'q'.repeat(12))
  db.prepare("INSERT INTO orders VALUES (1, 'abc', 3)").run()
  db.prepare("INSERT INTO trades VALUES (1, 1, 2, 'BTC', 'LONG', 81266, 0.006, 0.22, '2026-10-28 18:05:01.000000')").run()
  db.close()
  return dir
}
const exportRun = (dir: string, out: string, extra: string[] = []) =>
  spawnSync(process.execPath, [path.join(backendDir, 'pilot/export-diagnostics.mjs'), dir, '--out', out, ...extra], { encoding: 'utf8' })
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

test('1. export: derived data only (no prompt, no news text, no api_key), number sources, read-only, news titles optional', () => {
  const dir = makeRun('run-a', 4, (i) => (i === 1 ? 'Bitcoin is holding above its 50-day EMA ($80,878) near $81,266.' : 'Mixed signals, waiting for a clearer trend.'))
  const before = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, sha(path.join(dir, f))]))
  const out = path.join(tmp, 'a.json')
  const r = exportRun(dir, out)
  assert.equal(r.status, 0, r.stderr)
  const text = fs.readFileSync(out, 'utf8')
  const e = JSON.parse(text)
  assert.equal(e.schema, 'alpha-bot-ai-diagnostics/1')
  assert.equal(e.cycles.length, 4)
  assert.ok(!text.includes('You are a cryptocurrency trading AI'), 'prompt text')
  assert.ok(!text.includes('Key takeaways'), 'news summary')
  assert.ok(!text.includes('secret-db-value'), 'api_key')
  assert.ok(!text.includes('example.invalid'), 'endpoint')
  assert.ok(!text.includes(tmp), 'local path')
  const c1 = e.cycles[1]
  assert.equal(c1.prompt_has_current_time, false)
  assert.equal(c1.position_info, 'v1')
  assert.deepEqual(c1.decision.reason_numbers.map((x: any) => [x.value, x.source]), [[80878, 'news_text'], [81266, 'prompt_price']])
  assert.equal(c1.news.items, 2)
  assert.equal(c1.news.items_about_none_of_the_six, 1)
  assert.ok(c1.news.oldest_age_h > 100, '5-day-old article')
  assert.equal(c1.news.titles[0].title, 'Bitcoin holds near $81,800 as BTC defends key support')
  assert.deepEqual(e.fills.map((f: any) => [f.symbol, f.side, f.order_no]), [['BTC', 'LONG', 'AI']])
  assert.equal(e.account.model, 'm')
  assert.ok(!('api_key' in e.account))
  for (const [f, h] of Object.entries(before)) assert.equal(sha(path.join(dir, f)), h, `${f} changed`)
  const noTitles = path.join(tmp, 'a-nt.json')
  assert.equal(exportRun(dir, noTitles, ['--no-news-titles']).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(noTitles, 'utf8')).cycles[0].news.titles, undefined)
})

test('2. export safety: a key-like string in the output -> nothing written; no overwrite; never inside the run folder', () => {
  const dir = makeRun('run-b', 2, () => `leaked ${FAKE_KEY}`)
  const out = path.join(tmp, 'b.json')
  const r = exportRun(dir, out)
  assert.equal(r.status, 66)
  assert.equal(fs.existsSync(out), false)
  const ok = makeRun('run-c', 2, () => 'fine')
  const out2 = path.join(tmp, 'c.json')
  assert.equal(exportRun(ok, out2).status, 0)
  assert.equal(exportRun(ok, out2).status, 65, 'no overwrite')
  assert.equal(exportRun(ok, path.join(ok, 'x.json')).status, 65, 'not inside the run folder')
})

test('3. analysis: operations, HOLD streaks, identical inputs, reason tags and number sources; no judgement of HOLD', () => {
  const dir = makeRun('run-d', 6, (i) => (i === 1 ? 'Holding above its 50-day EMA ($80,878).' : 'Mixed signals; waiting for a clearer trend. Our long position is stable.'), {})
  const out = path.join(tmp, 'd.json')
  assert.equal(exportRun(dir, out).status, 0)
  const a = analyzeExport(JSON.parse(fs.readFileSync(out, 'utf8')))
  assert.deepEqual(a.operations, { hold: 5, open: 1 })
  assert.deepEqual(a.hold_streaks, { count: 2, longest: 4, median: 4 })
  assert.equal(a.news.distinct_news_blocks, 1)
  assert.equal(a.news.identical_to_previous_cycle_share, 1)
  assert.equal(a.prompt.has_current_time_share, 0)
  assert.equal(a.reasons.tagged.uncertainty_wait, 5)
  assert.equal(a.reasons.tagged.indicators, 1)
  assert.deepEqual(a.reasons.cited_number_sources, { news_text: 1 })
  assert.equal(a.market_context, null, 'no candles given: no context, nothing invented')
  assert.ok(!JSON.stringify(a).match(/error|wrong|mistake/i))
})

/** 15 m bars: a slow rise with a daily wave, volume 10, from T - 40 days. */
function bars15(until: number) {
  const out = []
  for (let t = Date.UTC(2026, 8, 18); t + 900_000 <= until; t += 900_000) {
    const k = (t - Date.UTC(2026, 8, 18)) / 900_000
    const p = 100 + k * 0.001 + Math.sin(k / 16) * 2
    out.push({ openTime: t, endTime: t + 900_000, open: p, high: p + 0.3, low: p - 0.3, close: p + 0.05, volume: 10 + (k % 7) })
  }
  return out
}

test('4. proposed context: only closed bars (no look-ahead), deterministic, the risk budget follows the ATR and the 1% reference', () => {
  const t = Date.UTC(2026, 9, 28, 12, 7)
  const all = bars15(Date.UTC(2026, 9, 31))
  const opts = { halfSpread: 0.00005, funding: new Map([[Date.UTC(2026, 9, 28, 11), 0.0000125]]), equity: 1000 }
  const b = ctx.coinBrief(all, t, opts)
  assert.ok(!('error' in b))
  assert.equal(b.as_of, new Date(Date.UTC(2026, 9, 28, 12)).toISOString(), 'last bar closed at 12:00')
  // the same brief from data that ends at t: nothing after t was used
  assert.deepEqual(ctx.coinBrief(all.filter((x: any) => x.endTime <= t), t, opts), b)
  assert.deepEqual(ctx.coinBrief(all, t, opts), b, 'deterministic')
  for (const k of ['trend', 'structure', 'momentum', 'volume', 'volatility', 'costs', 'risk_budget']) assert.ok(k in b, k)
  // loss at the stop per unit of notional = 2 ATR + fees both sides + spread + 2 bps slippage (the shown % is rounded)
  const loss = (2 * b.volatility.atr14_1h) / b.price + 2 * 0.00045 + 2 * 0.00005 + 0.0002
  assert.ok(Math.abs(b.risk_budget.max_notional_usdc['1%'] - 10 / loss) <= 1, `1%: ${b.risk_budget.max_notional_usdc['1%']} vs ${10 / loss}`)
  assert.ok(Math.abs(b.risk_budget.max_notional_usdc['2%'] - 20 / loss) <= 1)
  assert.ok(Math.abs(b.risk_budget.max_notional_usdc['0.5%'] - 5 / loss) <= 1)
  assert.equal(b.costs.funding_last_hour_pct, 0.0013)
  assert.match(b.risk_budget.leverage_note, /leverage only changes the margin/)
  // too little history: said so
  assert.match(ctx.coinBrief(all, Date.UTC(2026, 8, 19), opts).error, /not enough closed bars/)
})

test('5. swing points need closed bars on both sides', () => {
  const mk = (h: number[]) => h.map((x, i) => ({ openTime: i, endTime: i + 1, open: x, high: x, low: x - 1, close: x, volume: 1 }))
  const s = ctx.swings(mk([1, 2, 5, 2, 1, 3, 6]))
  assert.deepEqual(s.highs.map((x: any) => x.price), [5], 'the 6 at the end has no closed bars after it')
})
