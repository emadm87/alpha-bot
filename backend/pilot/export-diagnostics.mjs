// ALPHA BOT (007E) — esportazione diagnostica delle decisioni AI di una prova, in SOLA LETTURA.
//
// Uso (da backend/, nessun loader necessario):
//   node pilot/export-diagnostics.mjs <cartella-della-prova> --out <file.json> [--no-news-titles]
// Legge trace.jsonl, run-meta.json, report.json e pilot.db (aperto in sola lettura) e scrive UN file JSON
// fuori dalla cartella della prova, con le sole informazioni derivate necessarie all'analisi delle decisioni:
//   - per ciclo: ora, prezzi del prompt, portafoglio, versione delle informazioni sulle posizioni, statistiche
//     delle notizie (numero, eta, monete citate, titoli salvo --no-news-titles), decisione di Gemini (operazione,
//     moneta, direzione, quota, leva, motivazione), token, latenza, esito; per ogni numero citato nella motivazione,
//     se compare nei prezzi del prompt, nel testo delle notizie o in nessuno dei due;
//   - fill, funding, eventi del modulo di uscita, sintesi di report.json e del piano della prova.
// NON contiene: il testo dei prompt, il testo delle notizie (solo i titoli, disattivabili), chiavi API (la colonna
// api_key non viene letta), percorsi locali. Prima di scrivere, l'output viene controllato con i pattern di chiave
// di check-run: se ne trova uno, non scrive nulla. Non sovrascrive file esistenti e rifiuta di scrivere nella
// cartella della prova.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const args = process.argv.slice(2)
const flagValue = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1] === '--out'))
const outFile = flagValue('--out')
if (!positional[0] || !outFile) {
  console.error('uso: node pilot/export-diagnostics.mjs <cartella-della-prova> --out <file.json> [--no-news-titles]')
  process.exit(64)
}
const runDir = path.resolve(positional[0])
const out = path.resolve(outFile)
if (!fs.existsSync(path.join(runDir, 'trace.jsonl'))) { console.error(`trace.jsonl non trovato in ${runDir}`); process.exit(65) }
if (out.startsWith(runDir + path.sep)) { console.error('il file di uscita non puo stare nella cartella della prova'); process.exit(65) }
if (fs.existsSync(out)) { console.error(`${out} esiste gia: non viene sovrascritto`); process.exit(65) }
const withTitles = !args.includes('--no-news-titles')

const COINS = { BTC: /\b(BTC|Bitcoin)\b/i, ETH: /\b(ETH|Ether|Ethereum)\b/i, SOL: /\b(SOL|Solana)\b/i, BNB: /\b(BNB|Binance Coin)\b/i, XRP: /\b(XRP|Ripple)\b/i, DOGE: /\b(DOGE|Dogecoin)\b/i }
const KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{20,}|Bearer (?!\[REDACTED\])[A-Za-z0-9._-]{8,}|\bsk-[A-Za-z0-9_-]{16,}/
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null)

function section(text, start, end) {
  const i = text.indexOf(start)
  if (i < 0) return null
  const j = text.indexOf(end, i + start.length)
  return text.slice(i + start.length, j < 0 ? undefined : j)
}
/** Numbers written like prices in a text ($81,265 / 81,265.5 / 1.32), as numbers. */
function amounts(text) {
  return [...text.matchAll(/\$?\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\$\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/[$,]/g, ''))).filter((n) => n > 0)
}
function parsePrompt(content, ts) {
  const pricesText = section(content, 'Current Market Prices:\n', '\n\n')
  const prices = pricesText ? JSON.parse(pricesText) : null
  const positionsText = section(content, '- Current Positions (', '\n\nCurrent Market Prices')
  const positions = positionsText ? JSON.parse(positionsText.slice(positionsText.indexOf('):\n') + 3).split('\n- Reopening blocked')[0]) : null
  const num = (label) => { const m = content.match(new RegExp(`${label}: \\$([0-9.\\-]+)`)); return m ? Number(m[1]) : null }
  const news = section(content, 'Latest Crypto News (CoinJournal):\n', '\n\nAnalyze the market') ?? ''
  const items = news.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ) \| ([^:]*?)(?::\s|$)/)
    const t = m ? Date.parse(m[1].replace(' ', 'T')) : NaN
    return { ageHours: Number.isFinite(t) ? Math.round(((Date.parse(ts) - t) / 3_600_000) * 10) / 10 : null, title: m ? m[2] : line.slice(0, 80),
      coins: Object.entries(COINS).filter(([, re]) => re.test(line)).map(([c]) => c) }
  })
  return {
    chars: content.length, has_time: /\b20\d\d-\d\d-\d\d[ T]\d\d:\d\d/.test(content.split('Latest Crypto News')[0]),
    position_info: positionsText?.startsWith('each shows quantity, avg_cost, current_value, side') ? 'v1' : 'v2',
    portfolio: { cash: num('Cash Available'), total_assets: num('Total Assets'), positions },
    prices, news, newsItems: items,
  }
}
/**
 * Where a number cited in the reason can come from: written exactly in the news text, equal to a prompt price
 * (0.05%), close to one (0.5%: a rounded or derived figure), or none of them (computed or invented by the model).
 * An exact copy from the news wins over closeness to a price.
 */
function citations(reason, prices, news) {
  const priceList = Object.values(prices ?? {})
  const newsNumbers = new Set(amounts(news))
  return amounts(reason).map((n) => {
    const nearest = priceList.length ? Math.min(...priceList.map((p) => Math.abs(n - p) / p)) : Infinity
    const source = newsNumbers.has(n) ? 'news_text' : nearest <= 0.0005 ? 'prompt_price' : nearest <= 0.005 ? 'near_prompt_price' : 'neither'
    return { value: n, source, distance_to_nearest_price_pct: Number.isFinite(nearest) ? Math.round(nearest * 1e4) / 100 : null }
  })
}

// ---------------------------------------------------------------- trace
const events = fs.readFileSync(path.join(runDir, 'trace.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
const byCycle = new Map()
for (const e of events) (byCycle.get(e.cycle_id) ?? byCycle.set(e.cycle_id, []).get(e.cycle_id)).push(e)
const cycles = []
for (const [, evs] of byCycle) {
  const req = evs.find((e) => e.event === 'request')
  if (!req) continue
  const content = req.payload?.messages?.[0]?.content ?? ''
  const p = parsePrompt(content, req.ts)
  const res = evs.find((e) => e.event === 'response')
  const dec = evs.find((e) => e.event === 'decision')?.decision ?? null
  const outcome = evs.find((e) => e.event === 'outcome')
  const errors = evs.filter((e) => e.event === 'api_error').map((e) => ({ status: e.status ?? null }))
  cycles.push({
    ts: req.ts, model: req.model, prompt_chars: p.chars, prompt_has_current_time: p.has_time, position_info: p.position_info,
    prices: p.prices, portfolio: p.portfolio,
    news: {
      items: p.newsItems.length, chars: p.news.length, hash: sha(p.news).slice(0, 16),
      newest_age_h: p.newsItems.length ? Math.min(...p.newsItems.map((n) => n.ageHours ?? Infinity)) : null,
      oldest_age_h: p.newsItems.length ? Math.max(...p.newsItems.map((n) => n.ageHours ?? -Infinity)) : null,
      items_mentioning: Object.fromEntries(Object.keys(COINS).map((c) => [c, p.newsItems.filter((n) => n.coins.includes(c)).length])),
      items_about_none_of_the_six: p.newsItems.filter((n) => n.coins.length === 0).length,
      ...(withTitles ? { titles: p.newsItems.map((n) => ({ age_h: n.ageHours, title: n.title, coins: n.coins })) } : {}),
    },
    decision: dec && {
      operation: dec.operation ?? null, symbol: dec.symbol ?? null, direction: dec.direction ?? null,
      target_portion_of_balance: dec.target_portion_of_balance ?? null, leverage: dec.leverage ?? null, reason: dec.reason ?? null,
      reason_numbers: dec.reason ? citations(String(dec.reason), p.prices, p.news) : [],
    },
    response: res && {
      finish_reason: res.response?.choices?.[0]?.finish_reason ?? null,
      prompt_tokens: res.response?.usage?.prompt_tokens ?? null, completion_tokens: res.response?.usage?.completion_tokens ?? null,
      latency_ms: Date.parse(res.ts) - Date.parse(req.ts),
    },
    outcome: outcome ? { status: outcome.status, detail: String(outcome.detail ?? '').slice(0, 200) } : null,
    api_errors: errors,
  })
}
cycles.sort((a, b) => a.ts.localeCompare(b.ts))

// ---------------------------------------------------------------- database (read only, no api_key column)
let db = null
const dbFile = path.join(runDir, 'pilot.db')
const fromDb = { account: null, fills: [], funding: null, exit_events: [] }
if (fs.existsSync(dbFile)) {
  const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
  db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
    const meta = readJson(path.join(runDir, 'run-meta.json'))
    const accountId = meta?.account_id ?? db.prepare("SELECT id FROM accounts WHERE account_type='AI' AND name LIKE 'pilot-%' ORDER BY id DESC").get()?.id
    if (accountId) {
      const cols = db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name)
      fromDb.account = db.prepare(`SELECT id, name, model, initial_capital, current_cash${cols.includes('cost_model') ? ', cost_model' : ''} FROM accounts WHERE id=?`).get(accountId)
      fromDb.fills = db.prepare(`SELECT t.trade_time, t.symbol, t.side, t.price, t.quantity, t.commission, o.leverage, o.order_no
        FROM trades t JOIN orders o ON o.id = t.order_id WHERE t.account_id=? ORDER BY t.trade_time, t.id`).all(accountId)
        .map((t) => ({ ...t, order_no: String(t.order_no).startsWith('PRT-') ? 'PRT' : String(t.order_no).startsWith('LIQ-') ? 'LIQ' : 'AI' }))
      if (has('funding_payments')) {
        const rows = db.prepare('SELECT status, amount FROM funding_payments WHERE account_id=?').all(accountId)
        fromDb.funding = { hours: rows.length, settled: rows.filter((r) => r.status === 'settled').length, net_usdc: rows.reduce((s, r) => s + r.amount, 0) }
      }
      if (has('exit_events')) fromDb.exit_events = db.prepare('SELECT at, symbol, side, kind, status, level, fill_price, fraction FROM exit_events WHERE account_id=? ORDER BY at').all(accountId)
    }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- report and plan
const report = readJson(path.join(runDir, 'report.json'))
const meta = readJson(path.join(runDir, 'run-meta.json'))
const plan = meta?.plan ? { cycles: meta.plan.cycles, interval_s: meta.plan.interval_s, model: meta.plan.model, cost_model: meta.plan.cost_model,
  capital_usdc: meta.plan.capital_usdc, experiment: meta.plan.experiment ?? null } : null
const output = {
  schema: 'alpha-bot-ai-diagnostics/1',
  exported_at: new Date().toISOString(),
  source: {
    run: path.basename(runDir),
    files: Object.fromEntries(['trace.jsonl', 'pilot.db', 'report.json', 'run-meta.json'].filter((f) => fs.existsSync(path.join(runDir, f)))
      .map((f) => [f, sha(fs.readFileSync(path.join(runDir, f)))])),
    note: 'checksums of the run files at export time (they let the export be matched with its run without sharing the run)',
  },
  run: meta ? { started_at: meta.started_at, account_created_at: meta.account_created_at, stopped_at: meta.stopped_at, status: meta.status, reasons: meta.reasons, plan } : null,
  account: fromDb.account,
  report: report ? {
    capital: report.capital, pnl: report.pnl, funding: report.funding && { paid_usdc: report.funding.paid_usdc, received_usdc: report.funding.received_usdc, net_usdc: report.funding.net_usdc, intervals: report.funding.intervals },
    operations: report.operations, decisions: report.decisions, ai_usage: report.ai_usage, risk: report.risk,
    if_closed: report.if_closed && { net_usdc: report.if_closed.net_usdc, final_equity_usdc: report.if_closed.final_equity_usdc, complete: report.if_closed.complete },
  } : null,
  cycles,
  fills: fromDb.fills,
  funding: fromDb.funding,
  exit_events: fromDb.exit_events,
  privacy: {
    excluded: ['prompt text', 'news summaries' + (withTitles ? '' : ' and titles'), 'api_key (column not read)', 'endpoint URL', 'local paths'],
    key_scan: 'clean',
  },
}
const text = JSON.stringify(output, null, 2)
if (KEY_PATTERN.test(text)) {
  console.error('possibile chiave nell\'output: nessun file scritto')
  process.exit(66)
}
fs.writeFileSync(out, text + '\n', { flag: 'wx' })
console.log(JSON.stringify({ written: out, cycles: cycles.length, fills: fromDb.fills.length, bytes: Buffer.byteLength(text) + 1 }, null, 2))
