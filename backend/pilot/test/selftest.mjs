// SOLO TEST, OFFLINE: verifica gli script del pilota senza rete, senza AI e senza l'app reale.
// Uso (da backend/): node pilot/test/selftest.mjs
// Crea file temporanei nella cartella temporanea del sistema e li rimuove alla fine.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { evaluateRun } from '../check-run.mjs'
import { buildReport } from '../report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pilotDir = path.resolve(here, '..')
const backendDir = path.resolve(pilotDir, '..')
const tsx = path.join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-pilot-selftest-'))
const results = []
const near = (a, b, what, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`)
async function step(name, fn) {
  try {
    await fn()
    results.push(`OK   ${name}`)
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`)
  }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const node = (argv, env = {}) => spawnSync(process.execPath, argv, { cwd: backendDir, env: { ...process.env, ...env }, encoding: 'utf8' })

await step('sintassi degli script', () => {
  for (const f of ['check-run.mjs', 'report.mjs', 'ccxt-proxy.mjs', 'run-pilot.mjs', 'ai-budget.mjs', 'test/fake-backend.mjs', 'test/selftest.mjs']) {
    const r = node(['--check', path.join(pilotDir, f)])
    assert.equal(r.status, 0, `${f}: ${r.stderr}`)
  }
})

await step('shim ccxt: httpsProxy solo con HTTPS_PROXY, nessuna credenziale (senza rete)', () => {
  const shim = pathToFileURL(path.join(pilotDir, 'ccxt-proxy.mjs')).href
  const code = "import ccxt from 'ccxt'; const e = new ccxt.hyperliquid({}); console.log(JSON.stringify({ p: e.httpsProxy ?? null, k: Boolean(e.apiKey || e.secret || e.privateKey || e.walletAddress) }))"
  const run = (proxy) => spawnSync(process.execPath, ['--import', shim, '--input-type=module', '-e', code], {
    cwd: backendDir, encoding: 'utf8', env: { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy },
  })
  const on = run('http://127.0.0.1:9')
  assert.equal(on.status, 0, on.stderr)
  assert.deepEqual(JSON.parse(on.stdout.trim().split('\n').at(-1)), { p: 'http://127.0.0.1:9', k: false })
  const off = run('')
  assert.deepEqual(JSON.parse(off.stdout.trim().split('\n').at(-1)), { p: null, k: false })
})

const dbFile = path.join(tmp, 'synthetic.db')
await step('database sintetico dal motore reale (nessuna rete)', () => {
  const r = node([tsx, 'pilot/test/build-synthetic.mts', dbFile], { LOG_LEVEL: 'error' })
  assert.equal(r.status, 0, r.stderr.slice(-500))
})

await step('report: valori attesi e riconciliazione', () => {
  const before = sha(dbFile)
  const rep = buildReport({ dbFile, traceFile: dbFile.replace(/\.db$/, '.jsonl'), at: '2026-10-25T04:00:00.000Z', priceIn: 0.3, priceOut: 2.5 })
  near(rep.capital.final_equity, 1007.6757, 'equity finale')
  near(rep.pnl.realized, 2, 'realizzato')
  near(rep.pnl.unrealized, 6, 'non realizzato')
  near(rep.pnl.fees, 0.3164, 'commissioni')
  near(rep.pnl.interest_charged, 0.0079, 'interessi')
  near(rep.pnl.net_usdc, 7.6757, 'netto')
  near(rep.risk.max_drawdown_pct, 1.2961, 'drawdown')
  assert.equal(rep.operations.liquidations, 1)
  assert.deepEqual(rep.operations.opens, { LONG: 2, SHORT: 1 })
  assert.equal(rep.operations.winning_closes, 2)
  assert.equal(rep.operations.losing_closes, 1)
  assert.equal(rep.reconciliation.ok, true, JSON.stringify(rep.issues))
  near(rep.ai_usage.cost_usd, 0.00108, 'costo', 1e-9)
  near(rep.benchmarks.btc_buy_and_hold_1x_usdc, 1198.3212, 'BTC compra e tieni')
  assert.equal(sha(dbFile), before, 'il report ha modificato il database')
})

await step('report: anomalie su copia alterata', () => {
  const copy = path.join(tmp, 'tampered.db')
  fs.copyFileSync(dbFile, copy)
  const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
  const db = new Database(copy)
  db.prepare('UPDATE accounts SET current_cash = current_cash + 50 WHERE id = 2').run()
  db.prepare("INSERT INTO trades(order_id,account_id,symbol,name,market,side,price,quantity,commission,taker_fee,interest_charged) VALUES (1,2,'XRP','XRP','CRYPTO','BUY',1,1,0.1,0,0)").run()
  db.close()
  const rep = buildReport({ dbFile: copy, traceFile: dbFile.replace(/\.db$/, '.jsonl') })
  assert.equal(rep.reconciliation.ok, false)
  assert.ok(rep.issues.some((i) => i.startsWith('cassa non riconciliata')))
  assert.ok(rep.issues.some((i) => i.includes('taker_fee 0')))
})

function logOf(cycles, extra = []) {
  let t = Date.UTC(2026, 9, 25, 10, 0, 0)
  const at = () => new Date(t).toISOString()
  const out = [
    `${at()} INFO    services.hyperliquid: Hyperliquid exchange initialized successfully`,
    `${at()} INFO    services.scheduler: Auto trading job reset successfully - interval: 300s; Jobs: []`,
    `${at()} INFO    services.startup: Margin monitor started (5-second interval)`,
  ]
  for (let i = 0; i < cycles; i++) {
    t += 300_000
    out.push(`${at()} INFO    services.tradingCommands: Processing AI trading for account: pilot`)
  }
  return [...out, ...extra].join('\n')
}

await step('check-run: log corretto (12 cicli) e log con errori', () => {
  assert.equal(evaluateRun({ logText: logOf(12) }).exitCode, 0)
  const bad = evaluateRun({ logText: logOf(1, ['2026-10-25T11:00:00.000Z ERROR   services.scheduler: Failed to reset auto trading job: x']) })
  assert.equal(bad.exitCode, 2)
  const crlf = evaluateRun({ logText: logOf(12).replace(/\n/g, '\r\n') })
  assert.equal(crlf.exitCode, 0, 'fine riga Windows')
  const dupTrace = ['2026-10-25T10:00:00.000Z', '2026-10-25T10:00:10.000Z']
    .map((ts) => JSON.stringify({ ts, event: 'request', model: 'm' })).join('\n')
  assert.ok(evaluateRun({ logText: logOf(2), traceText: dupTrace }).stop.includes('chiamate duplicate'))
  const leak = evaluateRun({ logText: logOf(1), traceText: JSON.stringify({ ts: 'x', event: 'request', h: `Bearer ${'x'.repeat(20)}` }) })
  assert.ok(leak.stop.includes('possibile chiave nella traccia'))
})

const budget = pathToFileURL(path.join(pilotDir, 'ai-budget.mjs')).href
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

await step('ai-budget: 300 tentativi inviati, oltre bloccati senza rete; 200/429/401/403/404/timeout classificati; chiave non registrata', () => {
  const file = path.join(tmp, 'budget-300.jsonl')
  const code = `
    import http from 'node:http'
    const statuses = [200, 429, 401, 403, 404]
    let n = 0
    const srv = http.createServer((q, r) => { const s = statuses[n++ % statuses.length]; if (q.url === '/hang') return; r.writeHead(s); r.end('{}') }).listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const base = 'http://127.0.0.1:' + srv.address().port
    let sent = 0, blocked = 0, timeouts = 0
    try { await fetch(base + '/hang', { signal: AbortSignal.timeout(200) }) } catch (e) { timeouts++ }
    for (let i = 0; i < 304; i++) {
      try { await fetch(base + '/v1beta/openai/chat/completions', { method: 'POST', headers: { Authorization: 'Bea' + 'rer ' + 'test-secret-value' + '-123456' } }); sent++ }
      catch (e) { if (/budget exhausted/.test(e.message)) blocked++ }
    }
    srv.closeAllConnections(); srv.close()
    console.log(JSON.stringify({ sent, blocked, timeouts }))`
  const r = spawnSync(process.execPath, ['--import', budget, '--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, AI_BUDGET_HOST: '127.0.0.1', AI_BUDGET_MAX: '300', AI_BUDGET_FILE: file },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim()), { sent: 299, blocked: 5, timeouts: 1 })
  const rows = readJsonl(file)
  assert.equal(rows.filter((x) => x.result === 'sent').length, 300)
  assert.equal(rows.filter((x) => x.result.startsWith('blocked')).length, 5)
  assert.equal(Math.max(...rows.map((x) => x.attempt ?? 0)), 300)
  const classes = new Set(rows.map((x) => x.class).filter(Boolean))
  for (const c of ['ok', 'rate_limited', 'auth', 'not_found', 'timeout']) assert.ok(classes.has(c), c)
  assert.ok(!fs.readFileSync(file, 'utf8').includes('test-secret-value'), 'chiave nel registro')
})

await step('ai-budget: i retry 429 del client originale consumano il budget (3 per ciclo)', () => {
  const file = path.join(tmp, 'budget-client.jsonl')
  const r = spawnSync(process.execPath, [tsx, 'pilot/test/budget-client.mts', '2'], {
    cwd: backendDir, encoding: 'utf8',
    env: { ...process.env, AI_BUDGET_HOST: '127.0.0.1', AI_BUDGET_MAX: '4', AI_BUDGET_FILE: file, NODE_OPTIONS: `--import ${budget}`, LOG_LEVEL: 'error' },
  })
  assert.equal(r.status, 0, r.stderr.slice(-400))
  const rows = readJsonl(file)
  assert.equal(rows.filter((x) => x.result === 'sent').length, 4, 'ciclo 1: 3 tentativi, ciclo 2: 1 tentativo')
  assert.equal(rows.filter((x) => x.class === 'rate_limited').length, 4)
  assert.equal(rows.filter((x) => x.result.startsWith('blocked')).length, 2, 'ciclo 2: 2 tentativi bloccati')
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)).decisions, [null, null])
})

await step('check-run: retry AI distinti dai cicli, errori Hyperliquid non contati come tentativi AI, nessun falso allarme dalle notizie', () => {
  const extra = [
    '2026-10-25T11:00:01.000Z WARNING services.aiDecision: AI API rate limited (attempt 1/3), waiting 1.4s...',
    '2026-10-25T11:00:02.000Z ERROR   services.hyperliquid: Error fetching prices for BTC: RateLimitExceeded: hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null',
    '2026-10-25T11:00:02.100Z WARNING services.assetCalculator: Cannot get price for BTC.CRYPTO, counting margin without unrealized P&L: x',
  ]
  const trace = ['2026-10-25T10:05:00.000Z', '2026-10-25T10:10:00.000Z']
    .map((ts) => JSON.stringify({ ts, event: 'request', model: 'm', payload: { c: 'markets turn risk-on-risk-off-sentiment-shift-again today' } })).join('\n')
  const r = evaluateRun({ logText: logOf(2, extra), traceText: trace, maxAttempts: 12, expectCycles: 2 })
  assert.equal(r.trace.requests, 2)
  assert.equal(r.trace.http_attempts_estimate, 3, 'richieste + 1 retry AI; il 429 Hyperliquid non conta')
  assert.deepEqual(r.stop, [])
  const warn = (name) => r.checks.find((c) => c.name === name)
  assert.equal(warn('nessun tentativo ripetuto (ogni ripetizione puo essere fatturata)').severity, 'warn')
  assert.equal(warn('errori prezzo').severity, 'warn')
  assert.equal(warn('equity senza PnL per prezzo mancante').severity, 'warn')
  const over = evaluateRun({ logText: logOf(2, extra), traceText: trace, maxAttempts: 2 })
  assert.ok(over.stop.some((s) => s.startsWith('limite tentativi superato: 3/2')))
})

const runPilot = (dir, scenario, extra = []) =>
  node([path.join(pilotDir, 'run-pilot.mjs'), '--run-dir', dir, ...extra], { FAKE_SCENARIO: scenario })

await step('launcher: senza --authorized non avvia nulla', () => {
  const dir = path.join(tmp, 'no-auth')
  const r = runPilot(dir, 'complete')
  assert.equal(r.status, 3, r.stderr)
  assert.equal(fs.existsSync(dir), false)
})

const fakeArgs = (port) => ['--authorized', '--test-backend', path.join(here, 'fake-backend.mjs'), '--poll-ms', '300', '--port', String(port), '--proxy-shim', 'off', '--startup-ms', '10000']
await step('launcher: pilota completo (12 cicli) e arresto', () => {
  const dir = path.join(tmp, 'complete')
  const r = runPilot(dir, 'complete', fakeArgs(5791))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.status, 'complete')
  assert.match(fs.readFileSync(path.join(dir, 'backend.log'), 'utf8'), /Received SIGTERM/)
})

await step('launcher: errore di avvio -> nessun conto creato, nessuna chiamata', () => {
  const dir = path.join(tmp, 'startup-fail')
  const r = runPilot(dir, 'startup_fail', fakeArgs(5792))
  assert.equal(r.status, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8')).status, 'aborted_before_ai')
  assert.equal(fs.existsSync(path.join(dir, 'fake-post-received')), false)
})

await step('launcher: errore 403 -> arresto immediato', () => {
  const dir = path.join(tmp, 'auth')
  const r = runPilot(dir, 'auth_error', fakeArgs(5793))
  assert.equal(r.status, 2)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.status, 'stopped')
  assert.ok(meta.reasons.some((x) => x.includes('401/403/404')), meta.reasons.join('; '))
  const trace = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"request"'))
  assert.ok(trace.length <= 2, `${trace.length} richieste prima dell'arresto`)
})

await step('launcher: interruzione (SIGINT) arresta l app e salva lo stato', async () => {
  const dir = path.join(tmp, 'interrupt')
  const { spawn } = await import('node:child_process')
  const p = spawn(process.execPath, [path.join(pilotDir, 'run-pilot.mjs'), '--run-dir', dir, ...fakeArgs(5795)], {
    cwd: backendDir, env: { ...process.env, FAKE_SCENARIO: 'complete', FAKE_CYCLES: '1' },
  })
  const meta = path.join(dir, 'run-meta.json')
  for (let i = 0; i < 100 && !(fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).account_id); i++) await new Promise((r) => setTimeout(r, 100))
  p.kill('SIGINT')
  const code = await new Promise((r) => p.on('exit', r))
  assert.equal(code, 2)
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
  assert.equal(m.status, 'interrupted')
  assert.ok(m.exit, 'app arrestata')
})

await step('launcher: cartella non vuota rifiutata', () => {
  const dir = path.join(tmp, 'complete') // gia usata
  assert.equal(runPilot(dir, 'complete', fakeArgs(5794)).status, 65)
})

await step('nessuna chiave o credenziale nei file del pilota', () => {
  // costruito a pezzi, cosi questo file non corrisponde a se stesso
  const pattern = new RegExp(['\\bAI' + 'za[0-9A-Za-z_-]{20,}', '\\bs' + 'k-[A-Za-z0-9_-]{16,}', 'Bea' + 'rer [A-Za-z0-9._-]{16,}', '-'.repeat(5) + 'BEGIN'].join('|'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(pilotDir)) assert.ok(!pattern.test(fs.readFileSync(f, 'utf8')), f)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} verifiche superate`)
process.exit(failed ? 1 : 0)
