// ALPHA BOT pilota (006G-6D) — report economico da database (sola lettura) e traccia 006B.
//
// CLI:    node pilot/report.mjs <db> [trace.jsonl] [--account ID] [--prices '{"BTC":1}'] [--at ISO]
//                                [--price-in USD_per_1M] [--price-out USD_per_1M]
// Modulo: buildReport({ dbFile, traceFile, accountId, prices, at, priceIn, priceOut }).
// Nessuna rete, nessuna scrittura: il database e aperto in readonly. Non usa la curva della dashboard.
// Commissione e tasso d'interesse sono letti dalle costanti del motore in src/db/schema.ts
// (lo script gira con node, senza tsx, quindi il file TypeScript e letto come testo).
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../package.json', import.meta.url))
const Database = require('better-sqlite3')

/** Valore numerico di `export const NAME = ...` in src/db/schema.ts; errore se manca. */
export function engineConstant(name, schemaText = fs.readFileSync(new URL('../src/db/schema.ts', import.meta.url), 'utf8')) {
  const m = schemaText.match(new RegExp(`^export const ${name} = ([0-9.eE+-]+)\\s*$`, 'm'))
  const value = m ? Number(m[1]) : NaN
  if (!Number.isFinite(value)) throw new Error(`costante ${name} non trovata in src/db/schema.ts`)
  return value
}
// commissione taker del motore per modello economico del conto (takerFeeRate in schema.ts)
const FEE_BY_MODEL = {
  original: engineConstant('CRYPTO_TAKER_FEE_RATE'),
  hyperliquid: engineConstant('HL_PERP_TAKER_FEE_RATE'),
}
const RATE_H = engineConstant('CRYPTO_INTEREST_RATE_HOURLY') // interessi orari sulla parte presa a prestito
const MODEL_NOTES = {
  original: 'regole economiche dell\'autore: commissione taker 0,07%, interessi sulla parte a prestito, liquidazione e prezzi originali',
  hyperliquid: 'riproduce la commissione taker perpetual di Hyperliquid al livello base (ipotesi: volume a 14 giorni < 5M USD, ' +
    'nessuno sconto) e il funding orario (tasso realizzato da fundingHistory x oracle price catturato all\'ora x quantita; ' +
    'gli interessi dell\'originale non si applicano). Mark price, liquidazioni cross, precisione degli ordini e bid/ask NON ' +
    'sono ancora modellati: monitor, liquidazioni e prezzi di esecuzione restano quelli dell\'originale',
}

export function buildReport({ dbFile, traceFile, accountId: requested, prices, at, priceIn, priceOut }) {
const db = new Database(dbFile, { readonly: true, fileMustExist: true })
try {
const dbMs = (s) => (s ? Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z') : NaN)

// --- account -------------------------------------------------------------------
const valid = db.prepare(`SELECT * FROM accounts WHERE account_type='AI' AND is_active='true'
  AND api_key NOT IN ('default-key-please-update-in-settings','default','')`).all()
const accountId = Number(requested ?? (valid.length === 1 ? valid[0].id : NaN))
if (!Number.isFinite(accountId)) throw new Error(`specify --account: ${valid.length} operating AI accounts`)
const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId)
if (!acc) throw new Error(`account ${accountId} non trovato`)
const costModel = acc.cost_model ?? 'original' // database precedenti al 006I-1: solo regole originali
const FEE = FEE_BY_MODEL[costModel]
if (FEE === undefined) throw new Error(`modello economico sconosciuto: ${costModel}`)
const trades = db.prepare('SELECT t.*, o.order_no, o.leverage AS order_leverage FROM trades t JOIN orders o ON o.id=t.order_id WHERE t.account_id=? ORDER BY t.trade_time, t.id').all(accountId)
const orders = db.prepare('SELECT * FROM orders WHERE account_id=?').all(accountId)
const positions = db.prepare('SELECT * FROM positions WHERE account_id=? AND quantity>0').all(accountId)
const decisions = db.prepare('SELECT * FROM ai_decision_logs WHERE account_id=? ORDER BY decision_time, id').all(accountId)
const hasFunding = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='funding_payments'").get()
const fundingRows = hasFunding
  ? db.prepare('SELECT * FROM funding_payments WHERE account_id=? ORDER BY funding_time, symbol').all(accountId)
  : [] // database precedenti al 006I-2: nessun funding

// --- traccia: prezzi e Total Assets per ciclo ------------------------------------------
let trace = []
if (traceFile && fs.existsSync(traceFile)) {
  trace = fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}
const prompts = trace.filter((e) => e.event === 'request' && e.account_id === accountId).map((e) => {
  const text = e.payload?.messages?.[0]?.content ?? ''
  const total = Number((text.match(/Total Assets: \$([0-9.\-]+)/) ?? [])[1])
  const m = text.match(/Current Market Prices:\n(\{[\s\S]*?\n\})/)
  return { ts: e.ts, total, prices: m ? JSON.parse(m[1]) : null }
})
const finalPrices = prices ?? prompts.at(-1)?.prices ?? null
const asOf = at ?? prompts.at(-1)?.ts ?? new Date().toISOString()

// --- riesecuzione dei fill (regole del motore dal 006G-4) ---------------------------------
const issues = []
const book = {} // symbol -> { side, qty, avg }
const closes = [] // P&L lordo per chiusura
const lifecycles = [] // P&L lordo per posizione aperta->chiusa
let fees = 0, interest = 0, realized = 0
const feeRates = new Set()
const count = { LONG: 0, SHORT: 0, close_long: 0, close_short: 0 }
for (const t of trades) {
  fees += t.commission // commissione registrata una sola volta per fill (= taker_fee nel motore)
  interest += t.interest_charged
  if (costModel === 'hyperliquid' && t.interest_charged !== 0) issues.push(`trade ${t.id}: interessi dell'originale in modalita hyperliquid`)
  if (t.taker_fee === 0) issues.push(`trade ${t.id}: taker_fee 0 (orderMatching, non motore perpetual)`)
  else {
    // tasso registrato dal fill (dal 006I-1) o, per i fill precedenti, quello del modello del conto
    const rate = t.fee_rate ?? FEE
    feeRates.add(rate)
    if (t.fee_rate != null && t.fee_rate !== FEE) issues.push(`trade ${t.id}: tasso ${t.fee_rate} diverso dal modello ${costModel} (${FEE})`)
    if (Math.abs(t.commission - t.price * t.quantity * rate) > 1e-9) issues.push(`trade ${t.id}: commissione ${t.commission} diversa da ${rate} x nozionale`)
  }
  const b = (book[t.symbol] ??= { side: null, qty: 0, avg: 0, pnl: 0 })
  if (t.side === 'LONG' || t.side === 'SHORT') {
    count[t.side]++
    if (b.qty > 0 && b.side !== t.side) issues.push(`trade ${t.id}: apertura opposta su posizione aperta`)
    b.avg = (b.avg * b.qty + t.price * t.quantity) / (b.qty + t.quantity)
    b.qty = Number((b.qty + t.quantity).toFixed(6)); b.side = t.side
  } else if (t.side === 'SELL' || t.side === 'BUY') {
    if (!(b.qty > 0)) { issues.push(`trade ${t.id}: chiusura senza posizione`); continue }
    const want = t.side === 'SELL' ? 'LONG' : 'SHORT'
    if (b.side !== want) issues.push(`trade ${t.id}: ${t.side} su ${b.side}`)
    const pnl = (b.side === 'LONG' ? 1 : -1) * (t.price - b.avg) * t.quantity
    count[b.side === 'LONG' ? 'close_long' : 'close_short']++
    realized += pnl; b.pnl += pnl
    closes.push({ id: t.id, symbol: t.symbol, side: b.side, pnl, liquidation: t.order_no.startsWith('LIQ-') })
    b.qty = Number((b.qty - t.quantity).toFixed(6))
    if (b.qty === 0) { lifecycles.push({ symbol: t.symbol, side: b.side, gross: b.pnl }); b.side = null; b.avg = 0; b.pnl = 0 }
  } else issues.push(`trade ${t.id}: side ${t.side}`)
}

// --- confronto con le posizioni registrate ----------------------------------------------
let unrealized = 0, openMargin = 0, accrued = 0
// chiusura ipotetica: per ogni posizione aperta la commissione del motore al prezzo finale
// e gli interessi maturati dall'ultimo addebito (calculatePositionInterest), nient'altro
const closing = []
let closingComplete = true
for (const p of positions) {
  const b = book[p.symbol]
  if (!p.side) issues.push(`${p.symbol}: riga SPOT aperta (fuori dal perimetro)`)
  if (!b || Math.abs(b.qty - p.quantity) > 1e-9 || Math.abs(b.avg - p.avg_cost) > 1e-6 * p.avg_cost) {
    issues.push(`${p.symbol}: la riesecuzione dei fill non coincide con la riga (qty ${b?.qty} vs ${p.quantity})`)
  }
  if (p.margin === null) issues.push(`${p.symbol}: margine non registrato`)
  openMargin += p.margin ?? (p.quantity * p.avg_cost) / Math.max(p.leverage, 1)
  // interessi maturati non addebitati: stessa formula del motore, margine ricostruito come
  // positionMargin quando la riga non lo registra
  let positionAccrued = 0
  if (costModel !== 'hyperliquid' && p.leverage > 1 && p.last_interest_time) {
    const hours = (Date.parse(asOf) - dbMs(p.last_interest_time)) / 3_600_000
    const margin = p.margin ?? (p.quantity * p.avg_cost) / p.leverage
    positionAccrued = Math.max(p.quantity * p.avg_cost - margin, 0) * RATE_H * Math.max(hours, 0)
    accrued += positionAccrued
  }
  const price = finalPrices?.[p.symbol]
  if (!(price > 0)) {
    issues.push(`${p.symbol}: prezzo finale mancante, PnL non realizzato escluso`)
    closingComplete = false
    closing.push({ symbol: p.symbol, side: p.side, quantity: p.quantity, price: null, closing_fee: null, accrued_interest: positionAccrued })
    continue
  }
  unrealized += (p.side === 'SHORT' ? -1 : 1) * p.quantity * (price - p.avg_cost)
  closing.push({ symbol: p.symbol, side: p.side, quantity: p.quantity, price, closing_fee: p.quantity * price * FEE, accrued_interest: positionAccrued })
}
for (const [s, b] of Object.entries(book)) {
  if (b.qty > 0 && !positions.some((p) => p.symbol === s)) issues.push(`${s}: fill aperti senza riga di posizione`)
}

// --- funding orario (modello hyperliquid) ---------------------------------------------------
// Le righe regolate hanno gia cambiato la cassa; le altre non hanno importo. Le ore in cui il conto
// teneva una perpetual senza alcuna riga sono "non registrate" (in attesa o app ferma).
const HOUR = 3_600_000
let fundingNet = 0, fundingPaid = 0, fundingReceived = 0
const fundingStatus = { settled: 0, missing_oracle: 0, missing_rate: 0 }
for (const f of fundingRows) {
  fundingStatus[f.status] = (fundingStatus[f.status] ?? 0) + 1
  if (f.status !== 'settled') {
    if (f.amount !== 0) issues.push(`funding ${f.id}: importo ${f.amount} su un'ora non regolata`)
    continue
  }
  const expected = (f.side === 'LONG' ? -1 : 1) * f.quantity * f.oracle_price * f.funding_rate
  if (Math.abs(f.amount - expected) > 1e-9) issues.push(`funding ${f.id}: importo ${f.amount} diverso da quantita x oracle x tasso (${expected})`)
  fundingNet += f.amount
  if (f.amount < 0) fundingPaid -= f.amount
  else fundingReceived += f.amount
}
if (costModel !== 'hyperliquid' && fundingRows.length) issues.push('funding registrato su un conto non hyperliquid')
let fundingNotRecorded = 0
if (costModel === 'hyperliquid') {
  // posizioni tenute a ogni ora: fill del motore datati strettamente prima dell'ora
  const perp = trades.filter((t) => t.taker_fee > 0).map((t) => ({ ...t, ms: dbMs(t.trade_time) })).sort((a, b) => a.ms - b.ms)
  const recorded = new Set(fundingRows.map((f) => `${f.symbol} ${f.funding_time}`))
  const end = Math.floor(Date.parse(asOf) / HOUR) * HOUR
  for (let h = perp.length ? Math.floor(perp[0].ms / HOUR) * HOUR + HOUR : Infinity; h <= end; h += HOUR) {
    const held = {}
    for (const t of perp) {
      if (!(t.ms < h)) break
      const q = held[t.symbol] ?? 0
      held[t.symbol] = Number((t.side === 'LONG' || t.side === 'SHORT' ? q + t.quantity : q - t.quantity).toFixed(6))
    }
    for (const [sym, q] of Object.entries(held)) if (q > 0 && !recorded.has(`${sym} ${h}`)) fundingNotRecorded++
  }
}

// --- riconciliazione: ogni costo compare una sola volta --------------------------------------
// cassa = capitale + P&L realizzato - commissioni - interessi addebitati + funding netto
//         - margine delle posizioni aperte
const cashExpected = acc.initial_capital + realized - fees - interest + fundingNet - openMargin
const cashDiff = acc.current_cash - cashExpected
if (Math.abs(cashDiff) > 1e-6) issues.push(`cassa non riconciliata: registrata ${acc.current_cash}, attesa ${cashExpected} (diff ${cashDiff})`)
// margine ricostruito come positionMargin per le righe senza margine registrato (database precedenti)
const marginUsedExpected = positions.filter((p) => p.leverage > 1)
  .reduce((s, p) => s + (p.margin ?? (p.quantity * p.avg_cost) / p.leverage), 0)
if (Math.abs(acc.margin_used - marginUsedExpected) > 1e-6) issues.push(`marginUsed ${acc.margin_used} vs ${marginUsedExpected}`)
const finalEquity = acc.current_cash + openMargin + unrealized
const gross = realized + unrealized
const net = finalEquity - acc.initial_capital // = lordo - commissioni - interessi addebitati + funding netto
if (Math.abs(net - (gross - fees - interest + fundingNet)) > 1e-6) issues.push('identita netto = lordo - costi non verificata')
for (const o of orders) if (o.status !== 'FILLED') issues.push(`ordine ${o.id} ${o.status}`)

// --- serie di equity: Total Assets per ciclo + valore finale -----------------------------------
const series = [
  { ts: null, equity: acc.initial_capital, source: 'initial' },
  ...prompts.map((p) => ({ ts: p.ts, equity: p.total, source: 'prompt' })),
  ...(prompts.length ? [] : decisions.map((d) => ({ ts: d.decision_time, equity: d.total_balance, source: 'decision_log' }))),
  { ts: asOf, equity: finalEquity, source: 'final' },
].filter((x) => Number.isFinite(x.equity))
let peak = -Infinity, maxDD = 0, maxDDAt = null
for (const x of series) { peak = Math.max(peak, x.equity); const dd = (peak - x.equity) / peak; if (dd > maxDD) { maxDD = dd; maxDDAt = x.ts } }
const daily = {}
for (const x of series.filter((x) => x.ts)) {
  const day = String(x.ts).slice(0, 10)
  ;(daily[day] ??= { first: x.equity, last: x.equity }).last = x.equity
}

// --- decisioni ------------------------------------------------------------------------
const ops = decisions.reduce((m, d) => { const k = `${d.operation || '(vuota)'}${d.executed === 'true' ? '' : ' non eseguita'}`; m[k] = (m[k] ?? 0) + 1; return m }, {})
const outcomes = trace.filter((e) => e.event === 'outcome').reduce((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {})
const apiErrors = trace.filter((e) => e.event === 'api_error').length
const usage = trace.filter((e) => e.event === 'response').reduce((u, e) => {
  const x = e.response?.usage ?? {}
  u.responses++; u.prompt_tokens += x.prompt_tokens ?? 0; u.completion_tokens += x.completion_tokens ?? 0
  if (!e.response?.usage) u.without_usage++
  return u
}, { responses: 0, prompt_tokens: 0, completion_tokens: 0, without_usage: 0 })
const inPrice = Number(priceIn ?? NaN), outPrice = Number(priceOut ?? NaN) // USD per 1M token
usage.cost_usd = Number.isFinite(inPrice) && Number.isFinite(outPrice) ? (usage.prompt_tokens * inPrice + usage.completion_tokens * outPrice) / 1e6 : null

// --- benchmark (stessa finestra: primo e ultimo prezzo della traccia) ---------------------------------
const p0 = prompts[0]?.prices?.BTC, p1 = finalPrices?.BTC
const btcBH = p0 > 0 && p1 > 0 ? (acc.initial_capital / (1 + FEE)) * (p1 / p0) * (1 - FEE) : null

// --- chiusura ipotetica: equity registrata - commissioni di chiusura - interessi maturati -----------
// Le commissioni e gli interessi gia addebitati sono nella cassa (quindi nell'equity) e non si
// ripetono; il P&L non realizzato diventa realizzato allo stesso prezzo finale.
const closingFees = closing.reduce((t, c) => t + (c.closing_fee ?? 0), 0)
const finalIfClosed = closingComplete ? finalEquity - closingFees - accrued : null
const netIfClosed = closingComplete ? finalIfClosed - acc.initial_capital : null

const r = (x, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)))
const pct = (x) => r((x / acc.initial_capital) * 100, 4)
return {
  account: { id: acc.id, name: acc.name, model: acc.model },
  cost_model: {
    model: costModel,
    taker_fee_rate: FEE,
    fee_rates_applied: [...feeRates].sort(),
    interest_rate_hourly: RATE_H,
    note: MODEL_NOTES[costModel],
  },
  window: { from: prompts[0]?.ts ?? decisions[0]?.decision_time ?? null, to: asOf, final_prices_source: prices ? 'argument' : 'last prompt' },
  capital: { initial: acc.initial_capital, final_equity: r(finalEquity), cash: r(acc.current_cash), open_margin: r(openMargin) },
  pnl: {
    gross_usdc: r(gross), gross_pct: pct(gross), realized: r(realized), unrealized: r(unrealized),
    fees: r(fees), interest_charged: r(interest), funding_net: r(fundingNet, 6), net_usdc: r(net), net_pct: pct(net),
    accrued_interest_not_charged: r(accrued, 6), net_after_accrued_usdc: r(net - accrued),
  },
  // Funding orario Hyperliquid: separato da commissioni e interessi, gia incluso in cassa, equity e netto.
  funding: {
    applies: costModel === 'hyperliquid',
    paid_usdc: r(fundingPaid, 6), received_usdc: r(fundingReceived, 6), net_usdc: r(fundingNet, 6),
    intervals: {
      settled: fundingStatus.settled,
      not_settled_missing_oracle: fundingStatus.missing_oracle,
      not_settled_missing_rate: fundingStatus.missing_rate,
      not_recorded: fundingNotRecorded,
    },
    note: costModel === 'hyperliquid'
      ? 'ore non regolate: nessun importo (prezzo oracle non catturato entro 60 s dall\'ora, o tasso non pubblicato entro 6 h); ' +
        'non registrate: ore con posizione senza riga (regolazione in attesa o app ferma)'
      : 'non applicato: il modello originale usa gli interessi',
  },
  // Stima, non un risultato registrato: tutte le posizioni aperte chiuse ai prezzi finali.
  if_closed: {
    basis: `chiusura ipotetica di ${positions.length} posizioni aperte ai prezzi finali (${prices ? 'argomento' : 'ultimo prompt'}) alle ${asOf}; ` +
      `commissione taker del modello ${costModel} ${r(FEE * 100, 4)}% sul nozionale di uscita; ` +
      (costModel === 'hyperliquid'
        ? 'funding delle ore gia regolate incluso nell\'equity, nessun funding per l\'ora in corso (si paga solo allo scoccare dell\'ora); '
        : `interessi maturati a ${r(RATE_H * 100, 6)}%/h sulla parte a prestito; `) +
      'nessuno spread, slippage o impatto di prezzo',
    funding_not_settled_intervals: fundingStatus.missing_oracle + fundingStatus.missing_rate + fundingNotRecorded,
    open_positions: positions.length,
    complete: closingComplete,
    closing_fees_estimated: r(closingFees, 6),
    accrued_interest_not_charged: r(accrued, 6),
    final_equity_usdc: r(finalIfClosed),
    net_usdc: r(netIfClosed),
    net_pct: netIfClosed === null ? null : pct(netIfClosed),
    positions: closing.map((c) => ({ ...c, closing_fee: r(c.closing_fee, 6), accrued_interest: r(c.accrued_interest, 6) })),
  },
  operations: {
    opens: { LONG: count.LONG, SHORT: count.SHORT }, closes: { LONG: count.close_long, SHORT: count.close_short },
    winning_closes: closes.filter((c) => c.pnl > 0).length, losing_closes: closes.filter((c) => c.pnl < 0).length,
    winning_positions: lifecycles.filter((l) => l.gross > 0).length, losing_positions: lifecycles.filter((l) => l.gross < 0).length,
    liquidations: closes.filter((c) => c.liquidation).length, open_positions: positions.map((p) => `${p.symbol} ${p.side} ${p.quantity} @ ${p.avg_cost} ${p.leverage}x`),
  },
  decisions: { by_operation: ops, outcomes, api_errors: apiErrors, cycles_with_prompt: prompts.length },
  ai_usage: usage,
  risk: { max_drawdown_pct: r(maxDD * 100), max_drawdown_at: maxDDAt, samples: series.length, sampling: prompts.length ? 'Total Assets per ciclo (5 min)' : 'ai_decision_logs' },
  daily: Object.fromEntries(Object.entries(daily).map(([d, v]) => [d, { first: r(v.first), last: r(v.last), change_usdc: r(v.last - v.first) }])),
  benchmarks: { hold_usdc: acc.initial_capital, btc_buy_and_hold_1x_usdc: r(btcBH), btc_from: p0 ?? null, btc_to: p1 ?? null },
  reconciliation: { cash_expected: r(cashExpected, 6), cash_recorded: r(acc.current_cash, 6), ok: issues.length === 0 },
  issues,
}
} finally {
  db.close()
}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
  if (!files[0]) {
    console.error('uso: node pilot/report.mjs <db> [trace.jsonl] [--account ID] [--prices JSON] [--at ISO] [--price-in N --price-out N]')
    process.exit(64)
  }
  const report = buildReport({
    dbFile: files[0], traceFile: files[1], accountId: flag('--account'),
    prices: flag('--prices') ? JSON.parse(flag('--prices')) : undefined, at: flag('--at'),
    priceIn: flag('--price-in'), priceOut: flag('--price-out'),
  })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.reconciliation.ok ? 0 : 1)
}
