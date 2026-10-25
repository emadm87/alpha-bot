// SOLO TEST, OFFLINE: il client AI originale (callAIForDecision) contro un server locale che risponde 429,
// con ai-budget.mjs caricato: i retry del client devono consumare il budget. Nessuna rete esterna.
// Uso: AI_BUDGET_HOST=127.0.0.1 AI_BUDGET_MAX=N AI_BUDGET_FILE=... NODE_OPTIONS=--import <ai-budget> \
//      node node_modules/tsx/dist/cli.mjs pilot/test/budget-client.mts <cicli>
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-client-'))
process.env.DATABASE_PATH = path.join(dir, 't.db')
process.env.LOG_LEVEL = 'error'
const srv = http.createServer((req, res) => {
  if (req.url?.startsWith('/rss')) return res.end('')
  res.writeHead(429, { 'Content-Type': 'application/json' })
  res.end('{"error":"rate limited"}')
}).listen(0, '127.0.0.1')
await new Promise((r) => srv.once('listening', r))
const port = (srv.address() as { port: number }).port
// il feed notizie non deve uscire in rete: fetchLatestNews riceve un errore e il prompt usa il testo di riserva
const realFetch = globalThis.fetch
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.hostname !== '127.0.0.1') return Promise.reject(new Error('network disabled in test'))
  return realFetch(input, init)
}) as typeof fetch
const { callAIForDecision } = await import('../../src/services/aiDecision.js')
const account = { id: 1, name: 't', apiKey: 'test-placeholder-key', model: 'm', baseUrl: `http://127.0.0.1:${port}/v1beta/openai` } as any
const portfolio = { cash: 1000, frozen_cash: 0, total_assets: 1000, positions: {} } as any
const cycles = Number(process.argv[2] ?? 1)
const decisions = []
for (let c = 0; c < cycles; c++) decisions.push(await callAIForDecision(account, portfolio, { BTC: 1 }))
srv.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ decisions }))
