// ALPHA BOT pilota (006G-6D) — controllo di backend.log e della traccia 006B, in sola lettura.
//
// CLI:   node pilot/check-run.mjs <backend.log> [trace.jsonl] [--max-attempts N] [--expect-cycles N]
// Esito: 0 = OK, 1 = problemi bloccanti, 2 = STOP immediato (limite superato o errori).
// Modulo: evaluateRun({ logText, traceText, maxAttempts, expectCycles }) usato da run-pilot.mjs.
// Non legge chiavi, non fa richieste di rete, non scrive nulla.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const LINE = /^\d{4}-\d\d-\d\dT/
const SCHEDULER_RESET = /services\.scheduler: Auto trading job reset successfully - interval: 300s/
const KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}|Bearer (?!\[REDACTED\])[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9_-]{16,}/

export function evaluateRun({ logText, traceText = '', maxAttempts = 12, expectCycles = 12 }) {
  const lines = logText.split(/\r?\n/).filter((l) => LINE.test(l))
  const ts = (l) => Date.parse(l.slice(0, 24))
  const has = (re) => lines.filter((l) => re.test(l))
  const checks = []
  const add = (name, ok, detail = '', severity = 'block') =>
    checks.push({ name, ok, severity: ok ? 'ok' : severity, detail })

  // --- avvio ---
  add('exchange inizializzato', has(/Hyperliquid exchange initialized successfully/).length > 0)
  const notReady = has(/Market data readiness check failed/)
  add('prezzi pronti (nessun readiness failure)', notReady.length === 0, notReady.map((l) => l.slice(0, 160)).join(' | '))
  const resets = has(SCHEDULER_RESET)
  add('job AI pianificato a 300 s (messaggio dello scheduler)', resets.length > 0, `${resets.length} reset`)
  const failedReset = has(/Failed to reset auto trading job/)
  add('nessun reset fallito', failedReset.length === 0, failedReset.join(' | ').slice(0, 300))
  add('nessun ripiego su ordini casuali', has(/Falling back to random trading|Scheduling random crypto trading/).length === 0)
  add('monitor originale avviato (5 s)', has(/Margin monitor started \(5-second interval\)/).length > 0)

  // --- cicli ---
  const cycles = has(/Processing AI trading for account: /)
  const accountsSeen = [...new Set(cycles.map((l) => l.split('Processing AI trading for account: ')[1].trim()))]
  add('un solo account AI operativo', accountsSeen.length <= 1, accountsSeen.join(', '))
  const gaps = cycles.slice(1).map((l, i) => (ts(l) - ts(cycles[i])) / 1000)
  add('intervallo tra cicli 240-420 s', gaps.every((g) => g >= 240 && g <= 420), `gap: ${gaps.map((g) => g.toFixed(0)).join(',')}`, 'warn')
  const skipped = has(/Failed to fetch market prices, skipping AI trading/)
  add('nessun ciclo saltato per prezzi assenti', skipped.length === 0, `${skipped.length}`, 'warn')
  const priceErrors = has(/Error fetching prices|Failed to get price from Hyperliquid/)
  add('errori prezzo', priceErrors.length === 0, `${priceErrors.length} righe`, 'warn')
  const equityNoPnl = has(/counting margin without unrealized P&L/)
  add('equity senza PnL per prezzo mancante', equityNoPnl.length === 0, `${equityNoPnl.length} righe`, 'warn')

  // --- chiamate AI ---
  const retries = has(/AI API request failed \(attempt|AI API rate limited \(attempt/)
  add('nessun tentativo ripetuto (ogni ripetizione puo essere fatturata)', retries.length === 0, `${retries.length}`, 'warn')
  const truncated = has(/AI response was truncated due to token limit|Empty content in AI response|AI response is not an object/)
  add('risposte AI complete (nessun troncamento o contenuto vuoto)', truncated.length === 0, `${truncated.length}`, 'warn')
  const liquidations = has(/LIQUIDATED:/)
  add('liquidazioni', true, `${liquidations.length}`, 'info')
  const manual = has(/Created limit order|order_pending|Order \S+ executed: /)
  add('nessun ordine manuale/SPOT (orderMatching)', manual.length === 0, `${manual.length}`)
  const logLeak = lines.some((l) => KEY_PATTERN.test(l))
  add('nessuna chiave nel log', !logLeak)

  const stop = []
  let trace = null
  let outcomesCount = 0
  if (traceText.trim()) {
    const ev = traceText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const by = (e) => ev.filter((x) => x.event === e)
    const requests = by('request')
    const httpAttempts = requests.length + retries.length
    const outcomes = by('outcome')
    outcomesCount = outcomes.length
    const status = outcomes.reduce((m, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {})
    const reqTimes = requests.map((r) => Date.parse(r.ts))
    const dup = reqTimes.slice(1).filter((t, i) => (t - reqTimes[i]) / 1000 < 240).length
    const models = [...new Set(requests.map((r) => r.model))]
    const leak = ev.some((x) => KEY_PATTERN.test(JSON.stringify(x)))
    const authErrors = by('api_error').filter((e) => [401, 403, 404].includes(e.status))
    trace = {
      requests: requests.length, http_attempts_estimate: httpAttempts, responses: by('response').length,
      decisions: by('decision').length, api_errors: by('api_error').length, outcomes: status, models,
    }
    add('cicli con traccia = cicli nel log', requests.length === cycles.length, `traccia ${requests.length}, log ${cycles.length}`, 'warn')
    add('nessuna chiamata duplicata (<240 s)', dup === 0, `${dup}`)
    add('un solo modello', models.length <= 1, models.join(', '))
    add('nessuna chiave nella traccia', !leak)
    if (httpAttempts > maxAttempts) stop.push(`limite tentativi superato: ${httpAttempts}/${maxAttempts}`)
    let consecutive = 0
    let worst = 0
    for (const o of outcomes) {
      consecutive = ['no_decision', 'execution_failed'].includes(o.status) ? consecutive + 1 : 0
      worst = Math.max(worst, consecutive)
    }
    if (worst >= 3) stop.push(`${worst} cicli consecutivi senza decisione o con esecuzione fallita`)
    if (dup > 0) stop.push('chiamate duplicate')
    if (leak) stop.push('possibile chiave nella traccia')
    if (authErrors.length > 0) stop.push('errore di autenticazione o modello (401/403/404)')
  }
  if (failedReset.length || has(/Falling back to random trading/).length) stop.push('scheduler non affidabile')
  if (manual.length) stop.push('ordini manuali presenti')
  if (logLeak) stop.push('possibile chiave nel log')

  const blocking = checks.filter((c) => c.severity === 'block')
  return {
    checks, blocking: blocking.map((c) => c.name), cycles: cycles.length, expected: expectCycles,
    outcomes: outcomesCount, cycles_complete: outcomesCount >= expectCycles, scheduler_resets: resets.length,
    trace, stop, exitCode: stop.length ? 2 : blocking.length ? 1 : 0,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2)
  const opt = (name, def) => {
    const i = args.indexOf(name)
    return i >= 0 ? Number(args[i + 1]) : def
  }
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
  if (!files[0]) {
    console.error('uso: node pilot/check-run.mjs <backend.log> [trace.jsonl] [--max-attempts N] [--expect-cycles N]')
    process.exit(64)
  }
  const result = evaluateRun({
    logText: fs.readFileSync(files[0], 'utf8'),
    traceText: files[1] && fs.existsSync(files[1]) ? fs.readFileSync(files[1], 'utf8') : '',
    maxAttempts: opt('--max-attempts', 12),
    expectCycles: opt('--expect-cycles', 12),
  })
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.exitCode)
}
