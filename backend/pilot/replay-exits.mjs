// ALPHA BOT (007C) — replay cronologico delle configurazioni di uscita C1 / C2 / C3 su una prova registrata.
//
// Uso (da backend/, serve il loader tsx perche le regole sono quelle TypeScript dell'app):
//   node --import tsx pilot/replay-exits.mjs <cartella-della-prova> [--modes C1,C2,C3] [--account ID] [--text]
//        [--candles <file.csv.gz> --candles-fetched-at <ISO>]
// SOLA LETTURA: pilot.db aperto in sola lettura, nessuna scrittura, nessuna rete, nessuna AI.
//
// Prezzi: le candele 15 m Hyperliquid di research/exit-rules/data (verificate con lo SHA-256 del MANIFEST), che
// coprono 2026-09-09 -> 2026-10-31 20:45 UTC; per una prova successiva scaricare candele nuove con
// research/exit-rules/fetch-data.mjs recent e passarle con --candles (il loro SHA-256 finisce nell'output).
// Il risultato e IPOTETICO: mai un risultato della prova. I limiti sono nel campo `limits`.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
const imp = (p) => import(pathToFileURL(path.join(backendDir, p)).href)
const { replayExits } = await imp('src/services/exitReplay.ts')
const { DEFAULT_EXIT_CONFIG } = await imp('src/services/exitRules.ts')
const { verifiedManifest, loadBars, halfSpreads, DATA_DIR } = await imp('research/exit-rules/lib.mts')

const args = process.argv.slice(2)
const flagValue = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const withValue = ['--modes', '--account', '--candles', '--candles-fetched-at']
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && withValue.includes(args[i - 1])))
if (!positional[0]) {
  console.error('uso: node --import tsx pilot/replay-exits.mjs <cartella-della-prova> [--modes C1,C2,C3] [--account ID] [--text] [--candles FILE --candles-fetched-at ISO]')
  process.exit(64)
}
const runDir = path.resolve(positional[0])
const dbFile = path.join(runDir, 'pilot.db')
const traceFile = path.join(runDir, 'trace.jsonl')
const metaFile = path.join(runDir, 'run-meta.json')
const modes = (flagValue('--modes') ?? 'C1,C2,C3').split(',').map((m) => m.trim().toUpperCase())
for (const m of modes) if (!['C1', 'C2', 'C3'].includes(m)) { console.error(`modo non valido: ${m}`); process.exit(64) }

// candles: the committed, verified data set, or a file given by the user (its checksum goes in the output)
let candleSource
let bars15
if (flagValue('--candles')) {
  const file = path.resolve(flagValue('--candles'))
  const fetchedAt = Date.parse(flagValue('--candles-fetched-at') ?? '')
  if (!Number.isFinite(fetchedAt)) { console.error('--candles richiede --candles-fetched-at <ISO>'); process.exit(64) }
  bars15 = loadBars(file, 900_000, fetchedAt)
  candleSource = { file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), fetched_at: new Date(fetchedAt).toISOString() }
} else {
  const manifest = verifiedManifest()
  const f = manifest.files['candles-15m.csv.gz']
  bars15 = loadBars(path.join(DATA_DIR, 'candles-15m.csv.gz'), 900_000, Date.parse(f.fetched_at))
  candleSource = { file: 'research/exit-rules/data/candles-15m.csv.gz', sha256: f.sha256, fetched_at: f.fetched_at, verified: true }
}

const dbMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : NaN)
const db = new Database(dbFile, { readonly: true, fileMustExist: true })
try {
  const valid = db.prepare("SELECT * FROM accounts WHERE account_type='AI' AND api_key NOT IN ('default-key-please-update-in-settings','default','')").all()
  const accountId = Number(flagValue('--account') ?? (valid.length === 1 ? valid[0].id : NaN))
  if (!Number.isFinite(accountId)) throw new Error(`specificare --account: ${valid.length} conti AI`)
  const acc = db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId)
  if (!acc) throw new Error(`conto ${accountId} non trovato`)
  const costModel = acc.cost_model ?? 'original'
  const feeRate = costModel === 'hyperliquid' ? 0.00045 : 0.0007
  const fills = db.prepare(`SELECT t.symbol, t.side, t.price, t.quantity, t.commission, t.trade_time, o.leverage
    FROM trades t JOIN orders o ON o.id = t.order_id WHERE t.account_id=? ORDER BY t.trade_time, t.id`).all(accountId)
    .map((t) => ({ symbol: t.symbol, side: t.side, price: t.price, quantity: t.quantity, commission: t.commission, ms: dbMs(t.trade_time), leverage: t.leverage }))
  const hasFunding = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='funding_payments'").get()
  const funding = hasFunding
    ? db.prepare('SELECT symbol, funding_time, status, amount, funding_rate, oracle_price FROM funding_payments WHERE account_id=?').all(accountId)
      .map((f) => ({ symbol: f.symbol, fundingTime: f.funding_time, status: f.status, amount: f.amount, rate: f.funding_rate, oraclePrice: f.oracle_price }))
    : []
  const samples = []
  let lastTrace = NaN
  if (fs.existsSync(traceFile)) {
    for (const line of fs.readFileSync(traceFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(line)
      if (e.ts) lastTrace = Math.max(Number.isFinite(lastTrace) ? lastTrace : 0, Date.parse(e.ts))
      if (e.event !== 'request' || (e.account_id !== undefined && e.account_id !== accountId)) continue
      const m = (e.payload?.messages?.[0]?.content ?? '').match(/Current Market Prices:\n(\{[\s\S]*?\n\})/)
      if (m) samples.push({ ms: Date.parse(e.ts), prices: JSON.parse(m[1]) })
    }
  }
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null
  const runEnd = Date.parse(meta?.stopped_at ?? '') || lastTrace
  if (!Number.isFinite(runEnd)) throw new Error('fine della prova sconosciuta (run-meta.json senza stopped_at e traccia vuota)')
  const result = replayExits({
    feeRate, fills, funding, bars15, runEnd, samples, modes, config: { ...DEFAULT_EXIT_CONFIG },
    halfSpread: halfSpreads(), stopSlippage: 0.0002,
  })
  const out = {
    source: { run: runDir, account: acc.name, cost_model: costModel, fills: fills.length, prompt_samples: samples.length, run_end: new Date(runEnd).toISOString(), candles: candleSource },
    assumptions: { fee_rate: feeRate, half_spread: 'median of the books in research/exit-rules/data/books.json (2026-10-31)', stop_slippage_bps: 2, config: DEFAULT_EXIT_CONFIG },
    ...result,
  }
  if (args.includes('--text')) {
    const f = (x) => (x === null || x === undefined ? 'n/d' : Number(x).toFixed(4))
    const lines = [`Replay uscite C1/C2/C3 (IPOTETICO) - ${acc.name} (${costModel}), ${fills.length} fill, ${samples.length} prompt, fine ${out.source.run_end}`,
      `candele: ${candleSource.file} sha256 ${candleSource.sha256.slice(0, 12)}...; verificabile: ${result.verifiable}`]
    for (const p of result.positions) {
      lines.push(`- ${p.symbol} ${p.side} ${p.quantity} @ ${p.entry} aperta ${p.openedAt} | registrato: ${p.recorded.status} netto ${f(p.recorded.netUsdc)} USDC (${p.recorded.basis})`)
      lines.push(`  ATR: ${'error' in p.atr ? p.atr.error : `${p.atr.value} al ${p.atr.asOf}`}; barre 15 m usate ${p.barsUsed}; prompt fuori dall'intervallo delle candele ${p.promptCheck.outsideBarRange}/${p.promptCheck.samples}`)
      for (const [m, r] of Object.entries(p.modes)) {
        lines.push(`  ${m}: stop ${f(r.plan.stop)}${r.plan.takeProfit ? ` TP ${f(r.plan.takeProfit)}` : ''}${r.plan.partialAt ? ` parziale a ${f(r.plan.partialAt)}` : ''} | ` +
          r.legs.map((l) => `${l.kind} ${Math.round(l.fraction * 100)}% a ${f(l.price)} ${l.time}`).join(', ') +
          ` | netto ipotetico ${f(r.netUsdc)} USDC (delta ${f(r.deltaVsRecordedUsdc)}) | ${r.note}`)
      }
    }
    lines.push('Limiti:', ...result.limits.map((l) => `  * ${l}`))
    console.log(lines.join('\n'))
  } else {
    console.log(JSON.stringify(out, null, 2))
  }
} finally {
  db.close()
}
