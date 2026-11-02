// Preload (NODE_OPTIONS=--import <file URL>) che impone un limite RIGIDO ai tentativi HTTP verso l'host AI.
// Usato nel pilota 006G-7; dal 007G il launcher lo carica SEMPRE (--max-attempts) e verifica la riga di avvio.
// Conta ogni chiamata fetch verso AI_BUDGET_HOST PRIMA dell'invio, compresi i retry del client originale
// (fino a 3 per ciclo) e i tentativi finiti in timeout; oltre AI_BUDGET_MAX la chiamata viene rifiutata SENZA
// essere inviata. Il conteggio e sincrono (nessuna attesa tra controllo e incremento): chiamate concorrenti non
// possono superare il limite. Il limite non dipende dai controlli periodici del launcher.
// Riavvio dell'app con lo stesso AI_BUDGET_FILE: i tentativi gia registrati ("sent") restano contati.
// Caricato due volte nello stesso processo: il secondo caricamento non fa nulla (nessun doppio conteggio).
// Non conosce la quota del provider: un 429 indica limite di frequenza o quota (es. RPD) raggiunti, e una
// quota dichiarata (es. 500 RPD) non garantisce che le richieste vengano servite.
// Dopo una risposta 401/403/404 (chiave o modello non validi; AI_BUDGET_STOP_ON per cambiarli) ogni
// richiesta successiva viene rifiutata senza essere inviata, anche se il monitor del launcher non ha
// ancora fermato l'app.
// Registro JSONL in AI_BUDGET_FILE: ora, pid, numero del tentativo, percorso, stato HTTP o errore, classe.
// Non legge ne registra intestazioni, corpi o chiavi.
//
// Uso con il launcher (nessuna modifica a run-pilot.mjs: il launcher aggiunge il proprio shim a NODE_OPTIONS):
//   AI_BUDGET_MAX=300 AI_BUDGET_FILE=<run-dir>/ai-attempts.jsonl \
//   NODE_OPTIONS="--import file:///<percorso>/backend/pilot/ai-budget.mjs" node pilot/run-pilot.mjs --authorized ...
import fs from 'node:fs'

const HOST = process.env.AI_BUDGET_HOST ?? 'generativelanguage.googleapis.com'
const RAW_MAX = process.env.AI_BUDGET_MAX ?? '12'
const MAX = /^\d+$/.test(String(RAW_MAX).trim()) ? Number(RAW_MAX) : NaN
const FILE = process.env.AI_BUDGET_FILE
const STOP_ON = new Set(String(process.env.AI_BUDGET_STOP_ON ?? '401,403,404').split(',').map(Number).filter(Boolean))
// tentativi gia inviati da un processo precedente con lo stesso registro (riavvio dell'app)
const previouslySent = (() => {
  if (!FILE) return 0
  try {
    return fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter((l) => l.includes('"result":"sent"')).length
  } catch {
    return 0
  }
})()
let used = previouslySent
let tripped = null

const record = (x) => {
  if (!FILE) return
  try {
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...x }) + '\n')
  } catch {}
}
export const classify = (status) =>
  status === 200 ? 'ok' : status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'auth' : status === 404 ? 'not_found' : status >= 500 ? 'server_error' : 'http_error'

const original = globalThis.fetch
const ALREADY = Symbol.for('alpha-bot.ai-budget')
if (globalThis[ALREADY]) {
  // gia attivo in questo processo (preload indicato due volte): un solo contatore
} else if (typeof original !== 'function' || !Number.isFinite(MAX)) {
  // riga di controllo per il launcher: senza la riga "attivo" il pilota non parte
  process.stderr.write(`[ai-budget] NON attivo: AI_BUDGET_MAX non valido (${RAW_MAX}) o fetch assente\n`)
} else {
  globalThis[ALREADY] = true
  globalThis.fetch = async function budgetedFetch(input, init) {
    let url = null
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    } catch {}
    if (!url || url.hostname !== HOST) return original(input, init)
    if (tripped !== null) {
      record({ attempt: null, path: url.pathname, result: 'blocked_after_error', status: tripped })
      throw new Error(`AI requests disabled after HTTP ${tripped}: request not sent`)
    }
    if (used >= MAX) {
      record({ attempt: null, path: url.pathname, result: 'blocked_budget_exhausted', max: MAX })
      throw new Error(`AI attempt budget exhausted (${MAX}): request not sent`)
    }
    // registrato PRIMA dell'invio: se il registro non si puo scrivere la richiesta non parte
    const n = used + 1
    if (FILE) {
      try {
        fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, attempt: n, path: url.pathname, result: 'sent' }) + '\n')
      } catch (e) {
        throw new Error(`AI attempt log not writable (${e?.code ?? e}): request not sent`)
      }
    }
    used = n
    try {
      const res = await original(input, init)
      record({ attempt: n, status: res.status, result: 'response', class: classify(res.status) })
      if (STOP_ON.has(res.status)) tripped = res.status
      return res
    } catch (e) {
      const name = String(e?.name ?? 'Error')
      record({ attempt: n, result: 'error', class: ['TimeoutError', 'AbortError'].includes(name) ? 'timeout' : 'network', error: name })
      throw e
    }
  }
  // riga di controllo per il launcher (nessun dato sensibile)
  process.stderr.write(`[ai-budget] attivo: max ${MAX} tentativi verso ${HOST}, gia inviati ${previouslySent}\n`)
}
