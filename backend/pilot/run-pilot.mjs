// ALPHA BOT pilota (006G-6D) — avvio sorvegliato della prova forward AI, con arresto automatico.
//
// ATTENZIONE: con --authorized avvia l'app e fa CHIAMATE AI A PAGAMENTO. Usarlo solo dopo
// un'autorizzazione esplicita. Senza --authorized stampa il piano e termina senza fare nulla.
//
// Uso (da backend/):
//   node pilot/run-pilot.mjs --authorized --run-dir <cartella-nuova> [opzioni]
// Opzioni:
//   --cycles 12             cicli AI da completare (eventi `outcome` nella traccia)
//   --max-attempts 12       tentativi HTTP verso l'AI oltre i quali si arresta
//   --timeout-min 62        arresto comunque dopo N minuti dalla creazione del conto
//   --port 5611             porta HTTP locale dell'app
//   --model gemini-3.5-flash-lite
//   --base-url https://generativelanguage.googleapis.com/v1beta/openai
//   --key-mode network-secret | env    (default network-secret: la chiave la aggiunge il proxy)
//   --key-env GEMINI_API_KEY           variabile d'ambiente con la chiave, solo con --key-mode env
//   --proxy-shim auto | on | off       (auto: carica ccxt-proxy.mjs se HTTPS_PROXY e impostata)
//   --price-in / --price-out           USD per 1M token, solo per il costo nel report
//
// Non modifica codice, prompt, strategie, sizing, monitor o liquidazioni: avvia l'app originale
// (src/index.ts) con un database nuovo, crea UN conto da 1.000 USDC e sorveglia log e traccia.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluateRun } from './check-run.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const backendDir = path.resolve(here, '..')
const args = process.argv.slice(2)
const flag = (n, def) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : def
}
const cfg = {
  authorized: args.includes('--authorized'),
  runDir: flag('--run-dir'),
  cycles: Number(flag('--cycles', 12)),
  maxAttempts: Number(flag('--max-attempts', 12)),
  timeoutMin: Number(flag('--timeout-min', 62)),
  port: Number(flag('--port', 5611)),
  model: flag('--model', 'gemini-3.5-flash-lite'),
  baseUrl: flag('--base-url', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  keyMode: flag('--key-mode', 'network-secret'),
  keyEnv: flag('--key-env', 'GEMINI_API_KEY'),
  proxyShim: flag('--proxy-shim', 'auto'),
  priceIn: flag('--price-in'),
  priceOut: flag('--price-out'),
  // solo per selftest.mjs: sostituisce l'app con un backend finto, senza rete
  testBackend: flag('--test-backend'),
  pollMs: Number(flag('--poll-ms', 15_000)),
  firstCallMs: Number(flag('--first-call-ms', 360_000)),
  startupMs: Number(flag('--startup-ms', 180_000)),
}
const PLACEHOLDER_KEY = 'network-secret-placeholder'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()

function fail(code, message) {
  console.error(`[pilot] ${message}`)
  process.exit(code)
}

if (!cfg.runDir) fail(64, 'manca --run-dir (cartella nuova per database, log e traccia)')
if (!['network-secret', 'env'].includes(cfg.keyMode)) fail(64, `--key-mode non valido: ${cfg.keyMode}`)
const runDir = path.resolve(cfg.runDir)
const files = {
  db: path.join(runDir, 'pilot.db'),
  trace: path.join(runDir, 'trace.jsonl'),
  log: path.join(runDir, 'backend.log'),
  meta: path.join(runDir, 'run-meta.json'),
  check: path.join(runDir, 'check.json'),
  report: path.join(runDir, 'report.json'),
}
const useShim =
  cfg.proxyShim === 'on' || (cfg.proxyShim === 'auto' && Boolean(process.env.HTTPS_PROXY || process.env.https_proxy))

const plan = {
  run_dir: runDir, cycles: cfg.cycles, max_attempts: cfg.maxAttempts, timeout_min: cfg.timeoutMin,
  model: cfg.model, base_url: cfg.baseUrl, key_mode: cfg.keyMode, proxy_shim: useShim, port: cfg.port,
  capital_usdc: 1000, markets: 'BTC ETH SOL BNB XRP DOGE (prompt originale)', interval_s: 300,
}
if (!cfg.authorized) {
  console.log(JSON.stringify({ status: 'not_started', reason: 'manca --authorized: nessuna chiamata AI eseguita', plan }, null, 2))
  process.exit(3)
}

// --- controlli preliminari, prima di qualsiasi avvio ------------------------------------------
if (fs.existsSync(runDir) && fs.readdirSync(runDir).length > 0) {
  fail(65, `la cartella ${runDir} non e vuota: serve un database nuovo e dedicato`)
}
let apiKey = PLACEHOLDER_KEY
if (cfg.keyMode === 'env') {
  apiKey = process.env[cfg.keyEnv] ?? ''
  if (!apiKey.trim()) fail(65, `variabile ${cfg.keyEnv} vuota o assente`)
}
const portBusy = await new Promise((resolve) => {
  const s = net.connect({ port: cfg.port, host: '127.0.0.1' })
  s.once('connect', () => (s.destroy(), resolve(true)))
  s.once('error', () => resolve(false))
})
if (portBusy) fail(65, `la porta ${cfg.port} e gia in uso: un'altra istanza dell'app e attiva?`)
fs.mkdirSync(runDir, { recursive: true })

// --- avvio dell'app originale ----------------------------------------------------------------
const env = {
  ...process.env,
  DATABASE_PATH: files.db,
  AI_DIAGNOSTICS_FILE: files.trace,
  LOG_LEVEL: 'info',
  PORT: String(cfg.port),
}
if (useShim) {
  env.NODE_USE_ENV_PROXY = '1'
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${pathToFileURL(path.join(here, 'ccxt-proxy.mjs')).href}`.trim()
}
const command = cfg.testBackend
  ? [path.resolve(cfg.testBackend)]
  : [path.join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts']
const logStream = fs.createWriteStream(files.log, { flags: 'a' })
const child = spawn(process.execPath, command, { cwd: backendDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(logStream)
child.stderr.pipe(logStream)
let exited = null
child.on('exit', (code, signal) => (exited = { code, signal, at: now() }))

const meta = { plan, started_at: now(), account_created_at: null, account_id: null, stopped_at: null, status: 'starting', reasons: [] }
const saveMeta = () => fs.writeFileSync(files.meta, JSON.stringify(meta, null, 2))
saveMeta()
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const evaluate = () =>
  evaluateRun({ logText: read(files.log), traceText: read(files.trace), maxAttempts: cfg.maxAttempts, expectCycles: cfg.cycles })

async function stopApp(status, reasons) {
  meta.status = status
  meta.reasons = reasons
  if (!exited) {
    // SIGTERM: l'app ferma lo scheduler e chiude il server (src/index.ts). Su Windows il
    // segnale termina il processo subito; le scritture SQLite sono transazioni atomiche.
    child.kill('SIGTERM')
    for (let i = 0; i < 40 && !exited; i++) await sleep(250)
    if (!exited) child.kill('SIGKILL')
    for (let i = 0; i < 20 && !exited; i++) await sleep(250)
  }
  meta.stopped_at = now()
  meta.exit = exited
  saveMeta()
}

async function finish(status, reasons) {
  await stopApp(status, reasons)
  await new Promise((r) => logStream.end(r))
  const check = evaluate()
  fs.writeFileSync(files.check, JSON.stringify(check, null, 2))
  if (cfg.keyMode === 'env' && fs.existsSync(files.db)) {
    // la chiave reale non deve restare nel database della prova
    const { createRequire } = await import('node:module')
    const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
    const db = new Database(files.db)
    db.prepare("UPDATE accounts SET api_key='redacted-after-run' WHERE api_key=?").run(apiKey)
    db.close()
  }
  let report = null
  if (meta.account_id && fs.existsSync(files.db)) {
    try {
      const { buildReport } = await import('./report.mjs')
      report = buildReport({ dbFile: files.db, traceFile: files.trace, accountId: meta.account_id, priceIn: cfg.priceIn, priceOut: cfg.priceOut })
      fs.writeFileSync(files.report, JSON.stringify(report, null, 2))
    } catch (e) {
      meta.reasons.push(`report non generato: ${e}`)
      saveMeta()
    }
  }
  console.log(JSON.stringify({
    status: meta.status, reasons: meta.reasons, cycles: check.cycles, outcomes: check.outcomes,
    attempts: check.trace?.http_attempts_estimate ?? 0, blocking: check.blocking,
    final_equity: report?.capital.final_equity ?? null, net_usdc: report?.pnl.net_usdc ?? null,
    reconciliation_ok: report?.reconciliation.ok ?? null, files,
  }, null, 2))
  process.exit(meta.status === 'complete' ? 0 : 2)
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void finish('interrupted', [`${sig} ricevuto dal launcher`]))

// --- 1. attesa dell'avvio, PRIMA di creare il conto (nessuna chiamata AI finora) ----------------
const startDeadline = Date.now() + cfg.startupMs
while (Date.now() < startDeadline && !exited && !/All services initialized successfully|Service initialization failed/.test(read(files.log))) {
  await sleep(500)
}
const startup = evaluate()
const startupProblems = [
  ...(exited ? [`app terminata all'avvio: ${JSON.stringify(exited)}`] : []),
  ...(/All services initialized successfully/.test(read(files.log)) ? [] : ['avvio non completato']),
  ...startup.blocking,
  ...startup.stop,
]
if (startupProblems.length) await finish('aborted_before_ai', startupProblems)
const resetsBefore = startup.scheduler_resets

// --- 2. creazione del conto (UNA sola volta): avvia il ciclo 1 --------------------------------------
meta.account_created_at = now()
saveMeta()
let created
try {
  const res = await fetch(`http://127.0.0.1:${cfg.port}/api/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `pilot-${cfg.model}`, model: cfg.model, base_url: cfg.baseUrl, api_key: apiKey, initial_capital: 1000 }),
  })
  created = await res.json()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (e) {
  await finish('aborted_account', [`creazione del conto fallita: ${e}`])
}
meta.account_id = created.id
saveMeta()
const t0 = Date.now()

// --- 3. sorveglianza fino a fine pilota, errore o timeout ------------------------------------------
for (;;) {
  await sleep(cfg.pollMs)
  const r = evaluate()
  const elapsed = Date.now() - t0
  if (exited) await finish('crashed', [`app terminata: ${JSON.stringify(exited)}`])
  if (r.scheduler_resets <= resetsBefore && elapsed > 60_000) await finish('stopped', ['nessun reset dello scheduler dopo la creazione del conto'])
  if (r.stop.length) await finish('stopped', r.stop)
  if (r.blocking.length) await finish('stopped', r.blocking)
  if ((r.trace?.requests ?? 0) === 0 && elapsed > cfg.firstCallMs) await finish('stopped', ['nessuna chiamata AI dopo la creazione del conto'])
  if (r.cycles_complete) await finish('complete', [`${r.outcomes} cicli completati`])
  if (elapsed > cfg.timeoutMin * 60_000) await finish('stopped', [`timeout di ${cfg.timeoutMin} minuti`])
}
