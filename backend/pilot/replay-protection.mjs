// ALPHA BOT (007A) — replay cronologico delle regole di protezione del profitto su una prova registrata.
//
// Uso (da backend/, serve il loader tsx perche le regole sono quelle TypeScript dell'app):
//   node --import tsx pilot/replay-protection.mjs <cartella-della-prova | pilot.db> [trace.jsonl]
//        [--account ID] [--config '{"giveBackFraction":0.4}'] [--text]
// Sola lettura: il database e aperto in sola lettura, non scrive nulla, non fa richieste di rete.
//
// Ogni decisione usa solo cio che esisteva in quel momento (prezzi dei prompt fino a li, fill fino a li,
// funding registrato fino a li). Il risultato e IPOTETICO: non e mai un risultato della prova. I limiti dei
// dati (prezzi mid ogni ciclo, nessun book storico, nessun mark, percorso successivo non simulabile) sono
// nell'output, campo `limits`, e `verifiable` dice se la prova contiene dati sufficienti.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
const { replayProtection } = await import(pathToFileURL(path.join(backendDir, 'src/services/protectionReplay.ts')).href)
const { DEFAULT_PROTECTION_CONFIG, loadProtectionConfig } = await import(pathToFileURL(path.join(backendDir, 'src/services/profitProtection.ts')).href)

const args = process.argv.slice(2)
const flagValue = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--account', '--config'].includes(args[i - 1])))
if (!positional[0]) {
  console.error('uso: node --import tsx pilot/replay-protection.mjs <cartella | pilot.db> [trace.jsonl] [--account ID] [--config JSON] [--text]')
  process.exit(64)
}
const target = path.resolve(positional[0])
const isDir = fs.statSync(target).isDirectory()
const dbFile = isDir ? path.join(target, 'pilot.db') : target
const traceFile = positional[1] ? path.resolve(positional[1]) : isDir ? path.join(target, 'trace.jsonl') : dbFile.replace(/\.db$/, '.jsonl')

const dbMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : NaN)
const db = new Database(dbFile, { readonly: true, fileMustExist: true })
let input
try {
  const valid = db.prepare("SELECT * FROM accounts WHERE account_type='AI' AND is_active='true' AND api_key NOT IN ('default-key-please-update-in-settings','default','')").all()
  const accountId = Number(flagValue('--account') ?? (valid.length === 1 ? valid[0].id : NaN))
  if (!Number.isFinite(accountId)) throw new Error(`specificare --account: ${valid.length} conti AI operativi`)
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId)
  if (!acc) throw new Error(`conto ${accountId} non trovato`)
  const costModel = acc.cost_model ?? 'original'
  const feeRate = costModel === 'hyperliquid' ? 0.00045 : 0.0007
  const fills = db.prepare(`SELECT t.symbol, t.side, t.price, t.quantity, t.commission, t.interest_charged, t.trade_time, o.leverage
    FROM trades t JOIN orders o ON o.id = t.order_id WHERE t.account_id=? ORDER BY t.trade_time, t.id`).all(accountId)
    .map((t) => ({ symbol: t.symbol, side: t.side, price: t.price, quantity: t.quantity, commission: t.commission, interest: t.interest_charged, ms: dbMs(t.trade_time), leverage: t.leverage }))
  const hasFunding = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='funding_payments'").get()
  const funding = hasFunding
    ? db.prepare('SELECT symbol, funding_time, status, amount, created_at FROM funding_payments WHERE account_id=?').all(accountId)
      .map((f) => ({ symbol: f.symbol, fundingTime: f.funding_time, recordedAt: dbMs(f.created_at), amount: f.amount, status: f.status }))
    : []
  const samples = []
  if (fs.existsSync(traceFile)) {
    for (const line of fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(line)
      if (e.event !== 'request' || (e.account_id !== undefined && e.account_id !== accountId)) continue
      const text = e.payload?.messages?.[0]?.content ?? ''
      const m = text.match(/Current Market Prices:\n(\{[\s\S]*?\n\})/)
      if (m) samples.push({ ms: Date.parse(e.ts), prices: JSON.parse(m[1]) })
    }
  }
  const config = flagValue('--config')
    ? loadProtectionConfig({ ALPHA_PROTECTION: 'on', ALPHA_PROTECTION_CONFIG: flagValue('--config') })
    : { ...DEFAULT_PROTECTION_CONFIG, enabled: true }
  input = { costModel, initialCapital: acc.initial_capital, feeRate, fills, funding, samples, config }
  const result = replayProtection(input)
  const out = { source: { db: dbFile, trace: fs.existsSync(traceFile) ? traceFile : null, account: acc.name, cost_model: costModel, fills: fills.length, price_samples: samples.length }, ...result }
  if (args.includes('--text')) {
    const f = (x) => (x === null || x === undefined ? 'n/d' : Number(x).toFixed(4))
    const lines = [`Replay protezione (IPOTETICO) - ${acc.name} (${costModel}), ${samples.length} campioni di prezzo, ${fills.length} fill`, `verificabile: ${result.verifiable}`]
    for (const p of result.positions) {
      lines.push(`- ${p.symbol} ${p.side} aperta ${new Date(p.openedAt).toISOString()} | registrato: ${p.recorded.status} netto ${f(p.recorded.net)} | R ${f(p.riskUsdc)} picco ${f(p.peakNet)} fase max ${p.maxStage}`)
      if (p.hypothetical.exits.length) for (const x of p.hypothetical.exits) lines.push(`    uscita ipotetica ${new Date(x.ms).toISOString()} ${x.kind} ${x.fraction * 100}% a ${x.price}: netto ${f(x.netAtExit)} | ${x.reason}`)
      else lines.push('    nessuna uscita: le regole non sarebbero scattate')
      lines.push(`    netto ipotetico ${f(p.hypothetical.net)} (delta ${f(p.hypothetical.deltaVsRecorded)} rispetto al registrato)`)
    }
    lines.push('Limiti:', ...result.limits.map((l) => `  * ${l}`))
    console.log(lines.join('\n'))
  } else {
    console.log(JSON.stringify(out, null, 2))
  }
} finally {
  db.close()
}
