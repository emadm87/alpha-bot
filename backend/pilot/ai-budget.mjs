// Preload (NODE_OPTIONS=--import <file URL>) che impone un limite RIGIDO ai tentativi HTTP verso l'host AI.
// Usato nel pilota 006G-7. Conta ogni chiamata fetch verso AI_BUDGET_HOST, compresi i retry del client
// originale (fino a 3 per ciclo); oltre AI_BUDGET_MAX la chiamata viene rifiutata SENZA essere inviata.
// Il limite vale per il processo dell'app: un riavvio dell'app riparte da zero.
// Non conosce la quota del provider: un 429 indica limite di frequenza o quota (es. RPD) raggiunti, e una
// quota dichiarata (es. 500 RPD) non garantisce che le richieste vengano servite.
// Registro JSONL in AI_BUDGET_FILE: ora, pid, numero del tentativo, percorso, stato HTTP o errore, classe.
// Non legge ne registra intestazioni, corpi o chiavi.
//
// Uso con il launcher (nessuna modifica a run-pilot.mjs: il launcher aggiunge il proprio shim a NODE_OPTIONS):
//   AI_BUDGET_MAX=300 AI_BUDGET_FILE=<run-dir>/ai-attempts.jsonl \
//   NODE_OPTIONS="--import file:///<percorso>/backend/pilot/ai-budget.mjs" node pilot/run-pilot.mjs --authorized ...
import fs from 'node:fs'

const HOST = process.env.AI_BUDGET_HOST ?? 'generativelanguage.googleapis.com'
const MAX = Number(process.env.AI_BUDGET_MAX ?? 12)
const FILE = process.env.AI_BUDGET_FILE
let used = 0

const record = (x) => {
  if (!FILE) return
  try {
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...x }) + '\n')
  } catch {}
}
export const classify = (status) =>
  status === 200 ? 'ok' : status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'auth' : status === 404 ? 'not_found' : status >= 500 ? 'server_error' : 'http_error'

const original = globalThis.fetch
if (typeof original === 'function' && Number.isFinite(MAX)) {
  globalThis.fetch = async function budgetedFetch(input, init) {
    let url = null
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    } catch {}
    if (!url || url.hostname !== HOST) return original(input, init)
    if (used >= MAX) {
      record({ attempt: null, path: url.pathname, result: 'blocked_budget_exhausted', max: MAX })
      throw new Error(`AI attempt budget exhausted (${MAX}): request not sent`)
    }
    used += 1
    const n = used
    record({ attempt: n, path: url.pathname, result: 'sent' })
    try {
      const res = await original(input, init)
      record({ attempt: n, status: res.status, result: 'response', class: classify(res.status) })
      return res
    } catch (e) {
      const name = String(e?.name ?? 'Error')
      record({ attempt: n, result: 'error', class: ['TimeoutError', 'AbortError'].includes(name) ? 'timeout' : 'network', error: name })
      throw e
    }
  }
}
