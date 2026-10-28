// SOLO TEST: finto backend per verificare run-pilot.mjs senza rete, senza AI e senza l'app reale.
// Scrive righe di log nel formato dell'app, serve POST /api/account e produce eventi di traccia 006B
// con orari sintetici distanziati di 300 s. Scenario da FAKE_SCENARIO: complete | startup_fail | auth_error |
// hl_429 (31 errori 429 Hyperliquid nell'ultima ora) | hl_blind (posizione aperta, monitor non valutato da 6 min).
// Scrive il proprio pid in fake-pid (test di crash).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'

const scenario = process.env.FAKE_SCENARIO ?? 'complete'
const trace = process.env.AI_DIAGNOSTICS_FILE
const marker = path.join(path.dirname(process.env.DATABASE_PATH), 'fake-post-received')
// Come l'app reale: database aperto per tutta la durata del processo (su Windows il file resta bloccato)
const Database = createRequire(new URL('../../package.json', import.meta.url))('better-sqlite3')
const db = new Database(process.env.DATABASE_PATH)
db.exec('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, api_key TEXT, name TEXT, cost_model TEXT)')
fs.writeFileSync(path.join(path.dirname(process.env.DATABASE_PATH), 'fake-pid'), String(process.pid))
// righe con l'orario reale (gli scenari hl_* sono valutati da hl-guard rispetto all'ora attuale)
const logAt = (ms, level, name, msg) => console.log(`${new Date(ms).toISOString()} ${level.padEnd(7)} ${name}: ${msg}`)
let clock = Date.UTC(2026, 9, 25, 10, 0, 0)
const log = (level, name, msg) => console.log(`${new Date(clock).toISOString()} ${level.padEnd(7)} ${name}: ${msg}`)
const event = (cycle, ev, data) =>
  fs.appendFileSync(trace, JSON.stringify({ ts: new Date(clock).toISOString(), cycle_id: `c${cycle}`, event: ev, ...data }) + '\n')

log('INFO', 'services.hyperliquid', 'Hyperliquid exchange initialized successfully')
if (scenario === 'startup_fail') {
  log('ERROR', 'services.scheduler', 'Market data readiness check failed: Market data not ready for symbols: BTC')
  log('ERROR', 'services.scheduler', 'Failed to reset auto trading job: Error: Market data not ready for symbols: BTC')
} else {
  log('INFO', 'services.scheduler', 'Auto trading job reset successfully - interval: 300s; Jobs: []')
}
log('INFO', 'services.startup', 'Margin monitor started (5-second interval)')
log('INFO', 'services.startup', 'All services initialized successfully')

let cycle = 0
const maxCycles = Number(process.env.FAKE_CYCLES ?? 12)
function runCycle() {
  if (cycle >= maxCycles) return
  cycle++
  clock += cycle === 1 ? 1000 : 300_000
  log('INFO', 'services.tradingCommands', 'Processing AI trading for account: pilot-fake')
  event(cycle, 'request', { account_id: 2, model: 'gemini-3.5-flash-lite', payload: { messages: [{ role: 'user', content: 'Total Assets: $1000.00' }] } })
  if (scenario === 'auth_error') {
    event(cycle, 'api_error', { status: 403, body: 'denied' })
    event(cycle, 'outcome', { account_id: 2, status: 'no_decision', detail: 'x' })
    return
  }
  event(cycle, 'response', { response: { choices: [], usage: { prompt_tokens: 2000, completion_tokens: 100 } } })
  event(cycle, 'decision', { decision: { operation: 'hold' } })
  event(cycle, 'outcome', { account_id: 2, status: 'hold', detail: 'No order placed' })
}

function hyperliquidScenario(name) {
  const t = Date.now()
  if (scenario === 'hl_429') {
    for (let i = 31; i >= 1; i--) {
      logAt(t - i * 60_000, 'INFO', 'services.hyperliquid', 'Got prices for BTC/USDC:USDC, ETH/USDC:USDC')
      logAt(t - i * 60_000 + 30_000, 'ERROR', 'services.hyperliquid', 'Error fetching prices for BTC, ETH: RateLimitExceeded: hyperliquid POST https://api.hyperliquid.xyz/info 429 Too Many Requests null')
      logAt(t - i * 60_000 + 30_001, 'WARNING', 'services.marketData', 'Hyperliquid rate limit (HTTP 429): next price refresh in 5 s')
    }
  }
  if (scenario === 'hl_blind') {
    db.exec('CREATE TABLE positions (account_id INTEGER, symbol TEXT, quantity REAL); CREATE TABLE trades (id INTEGER PRIMARY KEY, account_id INTEGER, symbol TEXT, side TEXT, quantity REAL, taker_fee REAL, trade_time TEXT)')
    db.prepare("INSERT INTO positions VALUES (2, 'BTC', 0.001)").run()
    db.prepare("INSERT INTO trades (account_id, symbol, side, quantity, taker_fee, trade_time) VALUES (2, 'BTC', 'LONG', 0.001, 0.036, ?)")
      .run(new Date(t - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19))
    logAt(t - 7 * 60_000, 'INFO', 'services.hyperliquid', 'Got prices for BTC/USDC:USDC, ETH/USDC:USDC')
    logAt(t - 6 * 60_000, 'WARNING', 'services.scheduler', `Hyperliquid margin of account ${name} not evaluated, no liquidation: BTC: mark price 61 s old`)
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/account') {
    fs.writeFileSync(marker, 'yes')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const payload = JSON.parse(body)
      db.prepare('INSERT INTO accounts (id, api_key, name, cost_model) VALUES (2, ?, ?, ?)')
        .run(payload.api_key, payload.name, payload.cost_model ?? 'original')
      hyperliquidScenario(payload.name)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 2, cost_model: payload.cost_model ?? 'original' }))
    })
    log('INFO', 'services.scheduler', 'Auto trading job reset successfully - interval: 300s; Jobs: []')
    runCycle()
    // cadenza dei cicli (reale: 300 s); FAKE_CYCLE_MS la rende piu lenta del tempo di rilevamento
    setInterval(runCycle, Number(process.env.FAKE_CYCLE_MS ?? 200))
  } else {
    res.writeHead(404)
    res.end()
  }
})
server.listen(Number(process.env.PORT), '127.0.0.1')
process.on('SIGTERM', () => {
  log('INFO', 'main', 'Received SIGTERM, shutting down...')
  db.close()
  process.exit(0)
})
