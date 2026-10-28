// SOLO TEST, OFFLINE: verifica gli script del pilota senza rete, senza AI e senza l'app reale.
// Uso (da backend/): node pilot/test/selftest.mjs
// Crea file temporanei nella cartella temporanea del sistema e li rimuove alla fine.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { evaluateRun } from '../check-run.mjs'
import { buildReport } from '../report.mjs'
import { evaluateGuard, parseLog, reconciliation, reconciliationTracker } from '../hl-guard.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const pilotDir = path.resolve(here, '..')
const backendDir = path.resolve(pilotDir, '..')
// un solo processo Node con il loader tsx, come il launcher (niente processo figlio della CLI tsx)
const tsx = ['--import', 'tsx']
const isWindows = process.platform === 'win32'
const portFree = (port) => new Promise((resolve) => {
  const s = net.connect({ port, host: '127.0.0.1' })
  s.once('connect', () => (s.destroy(), resolve(false)))
  s.once('error', () => resolve(true))
})
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-pilot-selftest-'))
const results = []
// segnaposto della chiave nel conto (run-pilot.mjs); costruito a pezzi per il controllo finale sulle chiavi
const PLACEHOLDER = 'network-secret-' + 'placeholder'
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
  for (const f of ['check-run.mjs', 'report.mjs', 'compare.mjs', 'ccxt-proxy.mjs', 'run-pilot.mjs', 'ai-budget.mjs', 'hl-guard.mjs', 'key-inject.mjs', 'test/fake-backend.mjs', 'test/selftest.mjs']) {
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
  const r = node([...tsx, 'pilot/test/build-synthetic.mts', dbFile], { LOG_LEVEL: 'error' })
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
  // chiusura ipotetica: BTC LONG 0,3 ancora aperto a 120 -> commissione 0,3 * 120 * 0,07% = 0,0252;
  // interessi maturati 0 (ultimo addebito dopo la data del report)
  near(rep.if_closed.closing_fees_estimated, 0.0252, 'commissione di chiusura stimata')
  near(rep.if_closed.accrued_interest_not_charged, 0, 'interessi maturati')
  near(rep.if_closed.net_usdc, 7.6505, 'netto se chiuso')
  near(rep.if_closed.final_equity_usdc, 1007.6505, 'equity se chiuso')
  assert.equal(rep.if_closed.complete, true)
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
        // blocco dopo 401/403/404 disattivato qui: si verificano solo limite e classificazione (blocco: test dedicato)
    encoding: 'utf8', env: { ...process.env, AI_BUDGET_HOST: '127.0.0.1', AI_BUDGET_MAX: '300', AI_BUDGET_FILE: file, AI_BUDGET_STOP_ON: '' },
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
  const r = spawnSync(process.execPath, [...tsx, 'pilot/test/budget-client.mts', '2'], {
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

await step('ai-budget: dopo 401/403/404 nessuna altra richiesta viene inviata', () => {
  for (const status of [401, 403, 404]) {
    const file = path.join(tmp, `budget-stop-${status}.jsonl`)
    const code = `
      import http from 'node:http'
      let hits = 0
      const srv = http.createServer((q, r) => { hits++; r.writeHead(${status}); r.end('{}') }).listen(0, '127.0.0.1')
      await new Promise((r) => srv.once('listening', r))
      const url = 'http://127.0.0.1:' + srv.address().port + '/v1beta/openai/chat/completions'
      const out = []
      for (let i = 0; i < 3; i++) { try { out.push((await fetch(url, { method: 'POST' })).status) } catch (e) { out.push(/disabled after HTTP/.test(e.message) ? 'blocked' : e.message) } }
      srv.closeAllConnections(); srv.close()
      console.log(JSON.stringify({ hits, out }))`
    const r = spawnSync(process.execPath, ['--import', budget, '--input-type=module', '-e', code], {
      encoding: 'utf8', env: { ...process.env, AI_BUDGET_HOST: '127.0.0.1', AI_BUDGET_MAX: '300', AI_BUDGET_FILE: file },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout.trim()), { hits: 1, out: [status, 'blocked', 'blocked'] }, String(status))
    assert.equal(readJsonl(file).filter((x) => x.result === 'blocked_after_error').length, 2)
  }
  // 429 non blocca: i retry del client restano possibili entro il budget
  const file = path.join(tmp, 'budget-429.jsonl')
  const r = spawnSync(process.execPath, ['--import', budget, '--input-type=module', '-e', `
    import http from 'node:http'
    const srv = http.createServer((q, r) => { r.writeHead(429); r.end('{}') }).listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const url = 'http://127.0.0.1:' + srv.address().port + '/x'
    const out = []
    for (let i = 0; i < 3; i++) out.push((await fetch(url)).status)
    srv.closeAllConnections(); srv.close()
    console.log(JSON.stringify(out))`], { encoding: 'utf8', env: { ...process.env, AI_BUDGET_HOST: '127.0.0.1', AI_BUDGET_MAX: '300', AI_BUDGET_FILE: file } })
  assert.deepEqual(JSON.parse(r.stdout.trim()), [429, 429, 429])
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

await step('launcher: modello economico nel piano; valore non valido rifiutato', () => {
  const plan = (extra) => JSON.parse(runPilot(path.join(tmp, 'no-auth'), 'complete', extra).stdout).plan
  assert.equal(plan([]).cost_model, 'original')
  assert.equal(plan(['--cost-model', 'hyperliquid']).cost_model, 'hyperliquid')
  const bad = runPilot(path.join(tmp, 'no-auth'), 'complete', ['--cost-model', 'binance'])
  assert.equal(bad.status, 64, bad.stderr)
  assert.equal(fs.existsSync(path.join(tmp, 'no-auth')), false)
})

const fakeArgs = (port) => ['--authorized', '--test-backend', path.join(here, 'fake-backend.mjs'), '--poll-ms', '300', '--port', String(port), '--proxy-shim', 'off', '--startup-ms', '10000']
await step('launcher: pilota completo (12 cicli) e arresto', async () => {
  const dir = path.join(tmp, 'complete')
  const r = runPilot(dir, 'complete', fakeArgs(5791))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.status, 'complete')
  assert.ok(meta.exit, 'app arrestata')
  // Windows non ha SIGTERM: l'app viene terminata con taskkill e non scrive la riga di chiusura
  if (!isWindows) assert.match(fs.readFileSync(path.join(dir, 'backend.log'), 'utf8'), /Received SIGTERM/)
  assert.ok(await portFree(5791), 'porta ancora occupata: processo dell app rimasto attivo')
})

await step('launcher: --cost-model hyperliquid inviato alla creazione del conto e verificato', async () => {
  const dir = path.join(tmp, 'complete-hl')
  const r = runPilot(dir, 'complete', [...fakeArgs(5796), '--cost-model', 'hyperliquid'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.plan.cost_model, 'hyperliquid')
  assert.equal(meta.status, 'complete')
  assert.ok(await portFree(5796), 'porta ancora occupata')
})

await step('launcher: errore di avvio -> nessun conto creato, nessuna chiamata', () => {
  const dir = path.join(tmp, 'startup-fail')
  const r = runPilot(dir, 'startup_fail', fakeArgs(5792))
  assert.equal(r.status, 2)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8')).status, 'aborted_before_ai')
  assert.equal(fs.existsSync(path.join(dir, 'fake-post-received')), false)
})

// Il client originale non ripete le richieste dopo 401/403/404 e i cicli reali distano 300 s: il
// launcher deve fermare l'app prima del ciclo successivo. Qui i cicli distano 3 s, molto piu del tempo di
// rilevamento (controllo ogni 300 ms) e di arresto (anche con taskkill su Windows): deve partire 1 sola richiesta.
await step('launcher: errore 403 -> arresto prima del ciclo successivo', () => {
  const dir = path.join(tmp, 'auth')
  const r = node([path.join(pilotDir, 'run-pilot.mjs'), '--run-dir', dir, ...fakeArgs(5793)], { FAKE_SCENARIO: 'auth_error', FAKE_CYCLE_MS: '3000' })
  assert.equal(r.status, 2)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.status, 'stopped')
  assert.ok(meta.reasons.some((x) => x.includes('401/403/404')), meta.reasons.join('; '))
  const trace = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"request"'))
  assert.equal(trace.length, 1, `${trace.length} richieste prima dell'arresto`)
})

async function startFake(dir, port, extraEnv = {}, extraArgs = []) {
  const { spawn } = await import('node:child_process')
  const p = spawn(process.execPath, [path.join(pilotDir, 'run-pilot.mjs'), '--run-dir', dir, ...fakeArgs(port), ...extraArgs], {
    cwd: backendDir, env: { ...process.env, FAKE_SCENARIO: 'complete', FAKE_CYCLES: '1', ...extraEnv },
  })
  const exit = new Promise((r) => p.on('exit', (code) => r(code)))
  const meta = path.join(dir, 'run-meta.json')
  for (let i = 0; i < 100 && !(fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).account_id); i++) await new Promise((r) => setTimeout(r, 100))
  return { p, exit, meta }
}

// Su Windows un segnale inviato da un altro processo termina il launcher senza eseguire gli handler:
// lo stop da programma si fa con il file STOP; Ctrl+C dalla console resta gestito (non simulabile qui).
if (!isWindows) {
  await step('launcher: interruzione (SIGINT) arresta l app e salva lo stato', async () => {
    const { p, exit, meta } = await startFake(path.join(tmp, 'interrupt'), 5795)
    p.kill('SIGINT')
    assert.equal(await exit, 2)
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
    assert.equal(m.status, 'interrupted')
    assert.ok(m.exit, 'app arrestata')
    assert.ok(await portFree(5795), 'porta ancora occupata')
  })
}

await step('launcher: file STOP (tutti i sistemi) arresta, salva stato e report, rimuove la chiave', async () => {
  const dir = path.join(tmp, 'stop-file')
  const fakeKey = 'fake-' + 'k'.repeat(24)
  const { exit, meta } = await startFake(dir, 5796, { FAKE_TEST_KEY: fakeKey }, ['--key-mode', 'env', '--key-env', 'FAKE_TEST_KEY'])
  fs.writeFileSync(path.join(dir, 'STOP'), '')
  assert.equal(await exit, 2)
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'))
  assert.equal(m.status, 'interrupted')
  assert.deepEqual(m.reasons.slice(0, 1), ['file STOP'])
  assert.ok(m.exit, 'app arrestata')
  assert.equal(m.key_scrubbed, true)
  assert.ok(fs.existsSync(path.join(dir, 'check.json')))
  assert.ok(await portFree(5796), 'porta ancora occupata')
  const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
  const db = new Database(path.join(dir, 'pilot.db'), { readonly: true })
  const keys = db.prepare('SELECT api_key FROM accounts').all().map((r) => r.api_key)
  db.close()
  // 006J-4B: il conto contiene solo il segnaposto, la chiave non e mai stata scritta nel database
  assert.deepEqual(keys, [PLACEHOLDER])
  assert.match(fs.readFileSync(path.join(dir, 'backend.log'), 'utf8'), /\[key-inject\] attivo/)
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).includes(fakeKey), `chiave in ${f}`)
})

// --- 006J-4B: sorveglianza Hyperliquid (hl-guard.mjs) ---------------------------------------------------
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const MIN = 60_000
const line = (ms, level, name, msg) => `${new Date(ms).toISOString()} ${level.padEnd(7)} ${name}: ${msg}`
const pricesOk = (ms) => line(ms, 'INFO', 'services.hyperliquid', 'Got prices for BTC/USDC:USDC, ETH/USDC:USDC')
const hl429 = (ms) => [
  line(ms, 'ERROR', 'services.hyperliquid', 'Error fetching prices for BTC, ETH: RateLimitExceeded: hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null'),
  line(ms + 1, 'WARNING', 'services.marketData', 'Hyperliquid rate limit (HTTP 429): next price refresh in 5 s'),
  line(ms + 2, 'ERROR', 'services.marketData', 'Failed to get price from Hyperliquid: RateLimitExceeded: 429 Too Many Requests'),
]
const notEval = (ms, reason) => line(ms, 'WARNING', 'services.scheduler', `Hyperliquid margin of account p not evaluated, no liquidation: ${reason}`)
const evalAgain = (ms, n) => line(ms, 'INFO', 'services.scheduler', `Hyperliquid margin of account p evaluated again after ${n} skipped checks`)
const everyHalfMinute = (fromMin, toMin = 0) => Array.from({ length: (fromMin - toMin) * 2 + 1 }, (_, i) => pricesOk(NOW - fromMin * MIN + i * 30_000))
const open = (extra = {}) => ({
  accountName: 'p', costModel: 'hyperliquid', hasLedger: true, openPositions: [{ symbol: 'BTC', quantity: 0.01 }],
  trades: [{ symbol: 'BTC', side: 'LONG', quantity: 0.01, taker_fee: 0.36, ms: NOW - 3 * 60 * MIN }],
  funding: [9, 10, 11].map((h) => ({ symbol: 'BTC', funding_time: Date.UTC(2026, 9, 28, h), status: 'settled' })), ...extra,
})
const guard = (lines, data = open(), now = NOW) => evaluateGuard({ lines: parseLog(lines.join('\n')), data, now, accountCreatedMs: NOW - 4 * 60 * MIN })

await step('hl-guard: funzionamento normale con posizione aperta -> nessun arresto, nessun avviso', () => {
  const r = guard(everyHalfMinute(20))
  assert.deepEqual(r.stop, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.stats.hl_429_events_total, 0)
})

await step('hl-guard: 429 singoli e recuperati -> solo avvisi; le righe di uno stesso 429 contano una volta', () => {
  const lines = [...everyHalfMinute(20, 11), ...hl429(NOW - 10 * MIN), ...hl429(NOW - 9.5 * MIN), ...everyHalfMinute(9), ...hl429(NOW - 20_000)]
  const r = guard(lines.sort())
  assert.deepEqual(r.stop, [])
  assert.equal(r.stats.hl_429_events_last_hour, 3)
  assert.ok(r.warnings.some((w) => w.startsWith('HTTP 429 Hyperliquid: 3 eventi')), r.warnings.join('; '))
  // un 429 del client Gemini non e un 429 Hyperliquid
  const ai = line(NOW - MIN, 'WARNING', 'services.aiDecision', 'AI API rate limited after 3 attempts: 429 Too Many Requests')
  assert.equal(guard([...everyHalfMinute(20), ai].sort()).stats.hl_429_events_total, 0)
})

await step('hl-guard: 429 persistenti oltre 10 min -> arresto; piu di 30 in un ora -> arresto; 30 -> avviso', () => {
  const flat = open({ openPositions: [], trades: [] })
  const persistent = [pricesOk(NOW - 12 * MIN), ...Array.from({ length: 23 }, (_, i) => hl429(NOW - 11 * MIN + i * 30_000)).flat()]
  const p = guard(persistent, flat)
  assert.ok(p.stop.some((x) => x.startsWith('HTTP 429 Hyperliquid persistenti da 11 min')), p.stop.join('; '))
  // 9 minuti: non ancora bloccante
  assert.deepEqual(guard(persistent, flat, NOW - 2 * MIN).stop, [])
  const burst = (n) => Array.from({ length: n }, (_, i) => [...hl429(NOW - 59 * MIN + i * MIN), pricesOk(NOW - 59 * MIN + i * MIN + 20_000)]).flat()
  const over = guard(burst(31), flat)
  assert.ok(over.stop.some((x) => x.includes("31 eventi nell'ultima ora")), over.stop.join('; '))
  const at = guard(burst(30), flat)
  assert.deepEqual(at.stop, [])
  assert.ok(at.warnings.some((w) => w.includes('30 eventi')))
})

await step('hl-guard: monitor non valutabile oltre 5 min con posizione aperta -> arresto; casi recuperabili senza arresto', () => {
  const blind = guard([...everyHalfMinute(20), notEval(NOW - 6 * MIN, 'margin tables unavailable')].sort())
  assert.ok(blind.stop.some((x) => x.startsWith('monitor cross margin senza valutazioni da 6 min')), blind.stop.join('; '))
  const four = guard([...everyHalfMinute(20), notEval(NOW - 4 * MIN, 'BTC: mark price 61 s old')].sort())
  assert.deepEqual(four.stop, [])
  assert.ok(four.warnings.some((w) => w.startsWith('monitor cross margin non valutato da 4 min')))
  const recovered = guard([...everyHalfMinute(20), notEval(NOW - 10 * MIN, 'BTC: mark price 61 s old'), evalAgain(NOW - 9 * MIN, 12)].sort())
  assert.deepEqual(recovered.stop, [])
  assert.equal(recovered.stats.monitor_skipped_then_recovered, 12)
  assert.equal(recovered.stats.monitor_stale_mark_lines, 1)
  const closed = guard([...everyHalfMinute(20), notEval(NOW - 10 * MIN, 'x')].sort(), open({ openPositions: [] }))
  assert.deepEqual(closed.stop, [], 'posizione chiusa: nessun rischio da sorvegliare')
  const reopened = open()
  reopened.trades = [...reopened.trades, { symbol: 'BTC', side: 'LONG', quantity: 0.01, taker_fee: 0.36, ms: NOW - 2 * MIN }]
  assert.deepEqual(guard([...everyHalfMinute(20), notEval(NOW - 10 * MIN, 'x')].sort(), reopened).stop, [], 'riapertura recente')
  // nessun prezzo aggiornato da 6 min con posizione aperta (il monitor li aggiorna ogni ~35 s)
  const noPrices = guard([pricesOk(NOW - 6 * MIN)])
  assert.ok(noPrices.stop.some((x) => x.startsWith('nessun prezzo Hyperliquid aggiornato da 6 min')), noPrices.stop.join('; '))
  // modello originale: il monitor cross margin non si applica
  assert.deepEqual(guard([pricesOk(NOW - 6 * MIN), notEval(NOW - 6 * MIN, 'x')], open({ costModel: 'original' })).stop, [])
})

await step('hl-guard: funding non regolato per 3 ore consecutive con posizione aperta -> arresto; casi recuperabili', () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 28, h, m)
  const fill = (side, h, m) => ({ symbol: 'BTC', side, quantity: 0.01, taker_fee: 0.36, ms: at(h, m) })
  const f = (h, status) => ({ symbol: 'BTC', funding_time: at(h), status })
  const now = at(12, 30)
  // 09 manca l'oracle, 10 manca il tasso, 11 nessuna riga oltre l'ora di tolleranza; 12 in attesa
  const three = guard([pricesOk(now - 20_000)], open({ trades: [fill('LONG', 8, 30)], funding: [f(9, 'missing_oracle'), f(10, 'missing_rate')] }), now)
  assert.ok(three.stop.some((x) => x.startsWith('funding non regolato per 3 ore consecutive')), three.stop.join('; '))
  const two = guard([pricesOk(now - 20_000)], open({ trades: [fill('LONG', 8, 30)], funding: [f(9, 'settled'), f(10, 'missing_oracle'), f(11, 'missing_rate')] }), now)
  assert.deepEqual(two.stop, [])
  assert.ok(two.warnings.some((w) => w.startsWith('funding non regolato per 2')))
  // un'ora senza posizione interrompe la serie
  const gap = guard([pricesOk(now - 20_000)], open({ trades: [fill('LONG', 8, 30), fill('SELL', 9, 30), fill('LONG', 10, 30)], funding: [f(9, 'missing_oracle'), f(11, 'missing_rate')] }), now)
  assert.deepEqual(gap.stop, [])
  assert.equal(gap.stats.funding_unsettled_streak_hours, 1)
})

await step('hl-guard: riconciliazione errata -> avviso al primo controllo, arresto al secondo; errore di lettura solo avviso', async () => {
  const good = await reconciliation(dbFile, dbFile.replace(/\.db$/, '.jsonl'), 2)
  assert.equal(good.ok, true)
  const copy = path.join(tmp, 'tampered-guard.db')
  fs.copyFileSync(dbFile, copy)
  const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
  const db = new Database(copy)
  db.prepare('UPDATE accounts SET current_cash = current_cash + 50 WHERE id = 2').run()
  db.close()
  const bad = await reconciliation(copy, dbFile.replace(/\.db$/, '.jsonl'), 2)
  assert.equal(bad.ok, false)
  const track = reconciliationTracker()
  assert.equal(track(good).stop, null)
  const first = track(bad)
  assert.equal(first.stop, null)
  assert.match(first.warning, /riconciliazione contabile errata \(1/)
  assert.match(track(bad).stop, /riconciliazione contabile errata \(2 controlli consecutivi\): cassa non riconciliata/)
  const t2 = reconciliationTracker()
  assert.equal(t2(bad).stop, null)
  assert.equal(t2(good).stop, null, 'un esito corretto azzera il conteggio')
  assert.equal(t2(bad).stop, null)
  assert.equal(t2({ error: 'SQLITE_BUSY' }).stop, null)
  // lettura impossibile: avviso, poi bloccante al quinto controllo di fila
  const t3 = reconciliationTracker()
  for (let i = 0; i < 4; i++) assert.equal(t3({ error: 'SQLITE_BUSY' }).stop, null)
  assert.match(t3({ error: 'SQLITE_BUSY' }).stop, /riconciliazione non verificabile \(5 controlli di fila\)/)
})

await step('hl-guard (Windows): fine riga CRLF e CLI su una cartella con spazi', () => {
  const lines = [...everyHalfMinute(20), notEval(NOW - 6 * MIN, 'x')].sort()
  const crlf = evaluateGuard({ lines: parseLog(lines.join('\r\n')), data: open(), now: NOW, accountCreatedMs: NaN })
  assert.ok(crlf.stop.some((x) => x.startsWith('monitor cross margin')))
  const dir = path.join(tmp, 'run con spazi')
  fs.mkdirSync(dir)
  fs.copyFileSync(dbFile, path.join(dir, 'pilot.db'))
  fs.copyFileSync(dbFile.replace(/\.db$/, '.jsonl'), path.join(dir, 'trace.jsonl'))
  fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify({ status: 'running', account_id: 2, account_created_at: new Date(Date.now() - 2 * 60 * MIN).toISOString() }))
  const t = Date.now()
  const log = Array.from({ length: 31 }, (_, i) => [...hl429(t - (31 - i) * MIN), pricesOk(t - (31 - i) * MIN + 20_000)]).flat()
  fs.writeFileSync(path.join(dir, 'backend.log'), log.join('\r\n'))
  const r = node([path.join(pilotDir, 'hl-guard.mjs'), dir])
  assert.equal(r.status, 2, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.ok(out.stop.some((x) => x.includes("31 eventi nell'ultima ora")))
  assert.equal(out.reconciliation.ok, true)
  fs.writeFileSync(path.join(dir, 'backend.log'), log.slice(-6).join('\r\n'))
  assert.equal(node([path.join(pilotDir, 'hl-guard.mjs'), dir]).status, 0)
})

async function guardStop(scenario, port, reason) {
  const dir = path.join(tmp, scenario)
  const r = node([path.join(pilotDir, 'run-pilot.mjs'), '--run-dir', dir, ...fakeArgs(port), '--cost-model', 'hyperliquid'], { FAKE_SCENARIO: scenario, FAKE_CYCLE_MS: '3000' })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
  assert.equal(meta.status, 'stopped')
  assert.ok(meta.reasons.some((x) => reason.test(x)), meta.reasons.join('; '))
  assert.ok(meta.exit, 'app arrestata')
  const check = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8'))
  assert.ok(check.guard?.stop.some((x) => reason.test(x)), 'esito del guard in check.json')
  for (const f of ['pilot.db', 'backend.log', 'trace.jsonl']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} conservato`)
  assert.ok(await portFree(port), 'porta ancora occupata')
  assert.ok(check.outcomes < 12, 'arrestato prima della fine dei cicli')
}

await step('launcher: 429 Hyperliquid persistenti -> arresto controllato, database, log, traccia e controlli conservati', () =>
  guardStop('hl_429', 5797, /HTTP 429 Hyperliquid: 31 eventi/))

await step('launcher: posizione aperta e monitor non valutato da oltre 5 min -> arresto controllato', () =>
  guardStop('hl_blind', 5798, /monitor cross margin senza valutazioni da 6 min/))

// --- 006J-4B: chiave AI solo in memoria (key-inject.mjs) -----------------------------------------------
const inject = pathToFileURL(path.join(pilotDir, 'key-inject.mjs')).href

await step('key-inject: chiave solo verso l host AI e solo al posto del segnaposto; variabile rimossa; percorso con spazi', () => {
  const spaced = path.join(tmp, 'cartella con spazi')
  fs.mkdirSync(spaced)
  fs.copyFileSync(path.join(pilotDir, 'key-inject.mjs'), path.join(spaced, 'key-inject.mjs'))
  const fakeKey = 'fake-' + 'q'.repeat(30)
  const code = `
    import http from 'node:http'
    const seen = []
    const srv = http.createServer((q, r) => { seen.push(q.headers.authorization ?? ''); r.end('{}') }).listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const base = 'http://127.0.0.1:' + srv.address().port
    const bearer = (k) => ({ Authorization: 'Bea' + 'rer ' + k, 'Content-Type': 'application/json' })
    await fetch(base + '/v1beta/openai/chat/completions', { method: 'POST', headers: bearer(process.env.PH) })
    await fetch(base + '/x', { headers: bearer('other-value') })
    await fetch(new Request(base + '/req', { headers: bearer(process.env.PH) }))
    await fetch('http://localhost:' + srv.address().port + '/other-host', { headers: bearer(process.env.PH) })
    srv.close()
    console.log(JSON.stringify({ seen, envLeft: process.env.FAKE_AI_KEY ?? null }))`
  const run = (insecure) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: {
      ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(path.join(spaced, 'key-inject.mjs')).href}`, PH: PLACEHOLDER,
      FAKE_AI_KEY: fakeKey, ALPHA_PILOT_KEY_ENV: 'FAKE_AI_KEY', ALPHA_PILOT_KEY_HOST: '127.0.0.1', ALPHA_PILOT_KEY_INSECURE_TEST: insecure,
    },
  })
  const ok = run('1')
  assert.equal(ok.status, 0, ok.stderr)
  const out = JSON.parse(ok.stdout.trim().split('\n').at(-1))
  const b = (k) => 'Bea' + 'rer ' + k
  assert.deepEqual(out.seen, [b(fakeKey), b('other-value'), b(fakeKey), b(PLACEHOLDER)])
  assert.equal(out.envLeft, null, 'variabile rimossa dal processo dell app')
  assert.match(ok.stderr, /\[key-inject\] attivo/)
  assert.ok(!ok.stderr.includes(fakeKey), 'chiave stampata')
  // senza HTTPS la chiave non viene inviata
  const plain = JSON.parse(run('0').stdout.trim().split('\n').at(-1))
  assert.deepEqual(plain.seen, [b(PLACEHOLDER), b('other-value'), b(PLACEHOLDER), b(PLACEHOLDER)])
})

await step('key-inject + client AI originale: il server riceve la chiave, il conto contiene solo il segnaposto', () => {
  const authLog = path.join(tmp, 'auth.log')
  const fakeKey = 'fake-' + 'w'.repeat(30)
  const r = spawnSync(process.execPath, [...tsx, 'pilot/test/budget-client.mts', '1'], {
    cwd: backendDir, encoding: 'utf8',
    env: {
      ...process.env, NODE_OPTIONS: `--import ${inject}`, LOG_LEVEL: 'error', TEST_ACCOUNT_KEY: PLACEHOLDER, TEST_AUTH_LOG: authLog,
      FAKE_AI_KEY: fakeKey, ALPHA_PILOT_KEY_ENV: 'FAKE_AI_KEY', ALPHA_PILOT_KEY_HOST: '127.0.0.1', ALPHA_PILOT_KEY_INSECURE_TEST: '1',
    },
  })
  assert.equal(r.status, 0, r.stderr.slice(-400))
  const seen = fs.readFileSync(authLog, 'utf8').trim().split('\n')
  assert.ok(seen.length >= 1)
  assert.ok(seen.every((h) => h === 'Bea' + 'rer ' + fakeKey), 'ogni tentativo (retry compresi) con la chiave reale')
  assert.ok(!r.stdout.includes(fakeKey) && !r.stderr.includes(fakeKey), 'chiave nell output')
})

if (!isWindows) {
  // interruzione brusca (come un crash o un'interruzione di corrente): launcher e app terminati senza handler
  await step('launcher --key-mode env: crash di launcher e app -> nessuna chiave nei file della prova', async () => {
    const dir = path.join(tmp, 'crash')
    const fakeKey = 'fake-' + 'z'.repeat(24)
    const { p, exit } = await startFake(dir, 5799, { FAKE_TEST_KEY: fakeKey }, ['--key-mode', 'env', '--key-env', 'FAKE_TEST_KEY'])
    const appPid = Number(fs.readFileSync(path.join(dir, 'fake-pid'), 'utf8'))
    p.kill('SIGKILL')
    process.kill(appPid, 'SIGKILL')
    await exit
    for (let i = 0; i < 20 && !(await portFree(5799)); i++) await new Promise((r) => setTimeout(r, 100))
    assert.ok(await portFree(5799), 'app ancora attiva')
    assert.equal(fs.existsSync(path.join(dir, 'report.json')), false, 'nessun report: interruzione senza arresto controllato')
    const Database = createRequire(path.join(backendDir, 'package.json'))('better-sqlite3')
    const db = new Database(path.join(dir, 'pilot.db'), { readonly: true })
    const keys = db.prepare('SELECT api_key FROM accounts').all().map((x) => x.api_key)
    db.close()
    assert.deepEqual(keys, [PLACEHOLDER])
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).includes(fakeKey), `chiave in ${f}`)
  })
}

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

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} verifiche superate`)
process.exit(failed ? 1 : 0)
