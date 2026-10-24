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
  for (const f of ['check-run.mjs', 'report.mjs', 'ccxt-proxy.mjs', 'run-pilot.mjs', 'test/fake-backend.mjs', 'test/selftest.mjs']) {
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

await step('launcher: cartella non vuota rifiutata', () => {
  const dir = path.join(tmp, 'complete') // gia usata
  assert.equal(runPilot(dir, 'complete', fakeArgs(5794)).status, 65)
})

await step('nessuna chiave o credenziale nei file del pilota', () => {
  // costruito a pezzi, cosi questo file non corrisponde a se stesso
  const pattern = new RegExp(['AI' + 'za[0-9A-Za-z_-]{20,}', 's' + 'k-[A-Za-z0-9_-]{16,}', 'Bea' + 'rer [A-Za-z0-9._-]{16,}', '-'.repeat(5) + 'BEGIN'].join('|'))
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  for (const f of walk(pilotDir)) assert.ok(!pattern.test(fs.readFileSync(f, 'utf8')), f)
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${results.length - failed}/${results.length} verifiche superate`)
process.exit(failed ? 1 : 0)
