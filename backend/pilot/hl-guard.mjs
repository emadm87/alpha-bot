// ALPHA BOT pilota (006J-4B) — sorveglianza dei problemi Hyperliquid, in sola lettura.
//
// Usato da run-pilot.mjs a ogni controllo (15 s): se un problema e bloccante il launcher arresta il pilota
// in modo controllato (stessa procedura del file STOP: database, log, traccia e report conservati).
// Non tocca il motore: legge backend.log e il database della prova aperto in sola lettura.
//
// Bloccanti (stop):
//   - posizione aperta (conto hyperliquid) e monitor cross margin senza valutazioni affidabili da oltre 5 min:
//     episodio "not evaluated" non ancora seguito da "evaluated again", oppure nessun prezzo aggiornato da 5 min
//     (con una posizione aperta il monitor aggiorna i prezzi almeno ogni ~35 s);
//   - HTTP 429 di Hyperliquid persistenti: almeno 2 eventi senza un aggiornamento prezzi riuscito per oltre
//     10 min, oppure piu di 30 eventi nell'ultima ora;
//   - funding non regolato per 3 ore consecutive con posizione aperta (modello hyperliquid);
//   - riconciliazione contabile errata in 2 controlli consecutivi, o non verificabile in 5 di fila (deciso dal
//     launcher con reconciliationTracker()); sorveglianza che non legge i dati per 20 controlli di fila.
// Recuperabili (solo avvisi): un 429 isolato o seguito da prezzi validi, un controllo del monitor saltato e
// recuperato entro 5 min, un'ora di funding non regolata, un errore temporaneo di lettura del database.
//
// CLI (stato in qualunque momento, anche da un'altra finestra):
//   node pilot/hl-guard.mjs <cartella-della-prova>
// Esito: 0 = nessun problema bloccante, 2 = problema bloccante, 64 = uso errato.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const Database = createRequire(path.join(here, '..', 'package.json'))('better-sqlite3')

export const LIMITS = {
  monitorBlindMs: 5 * 60_000,
  rateLimitPersistMs: 10 * 60_000,
  rateLimitPerHour: 30,
  fundingUnsettledHours: 3,
  fundingGraceMs: 60 * 60_000,
  reconciliationFailures: 2,
  reconciliationReadErrors: 5,
}
const HOUR = 3_600_000
const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) /
// righe di un 429 di Hyperliquid; le righe del client AI (Gemini) sono escluse
const HL_429 = /RateLimitExceeded|429 Too Many Requests|Hyperliquid rate limit \(HTTP 429\)/
const PRICES_OK = /services\.hyperliquid: Got prices for /
const NOT_EVALUATED = /Hyperliquid margin of account (.+?) not evaluated, no liquidation: (.*)$/
const EVALUATED_AGAIN = /Hyperliquid margin of account (.+?) evaluated again after (\d+) skipped checks/
/** Righe di uno stesso 429 (errore del client, avviso del backoff, chiamanti in attesa) entro 2 s. */
const SAME_EVENT_MS = 2_000

const dbMs = (s) => (s ? Date.parse(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z') : NaN)
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const minutes = (ms) => Math.round(ms / 6_000) / 10

/** Righe del log con orario, in ordine (anche con fine riga Windows). */
export function parseLog(logText) {
  const out = []
  for (const raw of logText.split(/\r?\n/)) {
    const m = LINE.exec(raw)
    if (m) out.push({ ms: Date.parse(m[1]), text: raw })
  }
  return out
}

/** Dati del conto dal database della prova, aperto in sola lettura. Tabelle assenti = nessun dato. */
export function loadGuardData(dbFile, accountId) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 })
  try {
    const has = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))
    const acc = has('accounts') ? db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) : null
    return {
      accountName: acc?.name ?? null,
      costModel: acc?.cost_model ?? null,
      hasLedger: has('trades') && has('positions'),
      openPositions: has('positions')
        ? db.prepare('SELECT symbol, quantity FROM positions WHERE account_id=? AND quantity>0').all(accountId)
        : [],
      trades: has('trades')
        ? db.prepare('SELECT symbol, side, quantity, taker_fee, trade_time FROM trades WHERE account_id=? ORDER BY trade_time, id')
          .all(accountId).map((t) => ({ ...t, ms: dbMs(t.trade_time) }))
        : [],
      funding: has('funding_payments')
        ? db.prepare('SELECT symbol, funding_time, status FROM funding_payments WHERE account_id=?').all(accountId)
        : [],
    }
  } finally {
    db.close()
  }
}

/**
 * Ore di funding non regolate consecutive, fino all'ora piu recente, contando solo le ore con una posizione
 * perpetual aperta (fill del motore datati prima dell'ora, come nel report). Un'ora senza riga conta come non
 * regolata solo dopo `graceMs` (la regolazione arriva di solito entro pochi minuti); un'ora senza posizione
 * interrompe la serie.
 */
export function fundingStreak({ trades, funding, now, graceMs = LIMITS.fundingGraceMs }) {
  const perp = trades.filter((t) => t.taker_fee > 0 && Number.isFinite(t.ms))
  const status = new Map(funding.map((f) => [`${f.symbol} ${f.funding_time}`, f.status]))
  let streak = []
  if (!perp.length) return streak
  for (let h = Math.floor(perp[0].ms / HOUR) * HOUR + HOUR; h <= now; h += HOUR) {
    const held = {}
    for (const t of perp) {
      if (!(t.ms < h)) break
      const q = held[t.symbol] ?? 0
      held[t.symbol] = Number((t.side === 'LONG' || t.side === 'SHORT' ? q + t.quantity : q - t.quantity).toFixed(6))
    }
    const symbols = Object.keys(held).filter((s) => held[s] > 0)
    if (!symbols.length) {
      streak = []
      continue
    }
    const states = symbols.map((s) => status.get(`${s} ${h}`) ?? (now >= h + graceMs ? 'not_recorded' : 'pending'))
    if (states.some((s) => s !== 'settled' && s !== 'pending')) {
      streak.push({ hour: iso(h), states: Object.fromEntries(symbols.map((s, i) => [s, states[i]])) })
    } else if (states.includes('pending')) {
      break // ora recente non ancora regolata: esito non ancora noto
    } else {
      streak = []
    }
  }
  return streak
}

/**
 * Valutazione dei problemi Hyperliquid in un momento `now`. Puro: riceve le righe del log e i dati del
 * database. Restituisce { stop: [motivi bloccanti], warnings: [eventi recuperabili], stats }.
 */
export function evaluateGuard({ lines, data, now, accountCreatedMs = NaN, limits = LIMITS }) {
  const stop = []
  const warnings = []
  const hyperliquid = data?.costModel === 'hyperliquid'
  const open = (data?.openPositions ?? []).length > 0
  const lastFill = Math.max(-Infinity, ...(data?.trades ?? []).map((t) => t.ms).filter(Number.isFinite))

  // --- HTTP 429 di Hyperliquid ---
  const events = []
  let lastPricesOk = -Infinity
  let streak = [] // eventi 429 dopo l'ultimo aggiornamento prezzi riuscito
  for (const l of lines) {
    if (PRICES_OK.test(l.text)) {
      lastPricesOk = l.ms
      streak = []
    } else if (HL_429.test(l.text) && !l.text.includes('services.aiDecision')) {
      if (!events.length || l.ms - events.at(-1) > SAME_EVENT_MS) {
        events.push(l.ms)
        streak.push(l.ms)
      }
    }
  }
  const lastHour = events.filter((t) => t > now - HOUR && t <= now)
  if (streak.length >= 2 && now - streak[0] > limits.rateLimitPersistMs) {
    stop.push(`HTTP 429 Hyperliquid persistenti da ${minutes(now - streak[0])} min (${streak.length} eventi, nessun prezzo valido dal ${iso(streak[0])})`)
  }
  if (lastHour.length > limits.rateLimitPerHour) {
    stop.push(`HTTP 429 Hyperliquid: ${lastHour.length} eventi nell'ultima ora (limite ${limits.rateLimitPerHour})`)
  }
  if (lastHour.length && !stop.some((s) => s.startsWith('HTTP 429'))) {
    warnings.push(`HTTP 429 Hyperliquid: ${lastHour.length} eventi nell'ultima ora${streak.length ? ', recupero in corso' : ', recuperati'}`)
  }

  // --- monitor cross margin con posizione aperta ---
  let episode = null // { start, reason }
  let skippedRecovered = 0
  let notEvaluated = 0
  let staleMark = 0
  const name = data?.accountName
  for (const l of lines) {
    if (!name) break
    const ne = NOT_EVALUATED.exec(l.text)
    if (ne && ne[1] === name) {
      notEvaluated++
      if (/mark price \d+ s old/.test(ne[2])) staleMark++
      episode ??= { start: l.ms, reason: ne[2] }
      episode.reason = ne[2]
      continue
    }
    const ea = EVALUATED_AGAIN.exec(l.text)
    if (ea && ea[1] === name) {
      skippedRecovered += Number(ea[2])
      episode = null
    }
  }
  if (hyperliquid && open) {
    if (episode) {
      const from = Math.max(episode.start, lastFill)
      if (now - from > limits.monitorBlindMs) {
        stop.push(`monitor cross margin senza valutazioni da ${minutes(now - from)} min con posizione aperta: ${episode.reason}`)
      } else {
        warnings.push(`monitor cross margin non valutato da ${minutes(now - from)} min (recuperabile fino a ${limits.monitorBlindMs / 60_000} min): ${episode.reason}`)
      }
    }
    const fresh = Math.max(lastPricesOk, lastFill, accountCreatedMs)
    if (Number.isFinite(fresh) && now - fresh > limits.monitorBlindMs) {
      stop.push(`nessun prezzo Hyperliquid aggiornato da ${minutes(now - fresh)} min con posizione aperta: il monitor non puo valutare`)
    }
  }

  // --- funding orario ---
  const unsettled = hyperliquid ? fundingStreak({ trades: data?.trades ?? [], funding: data?.funding ?? [], now, graceMs: limits.fundingGraceMs }) : []
  if (unsettled.length >= limits.fundingUnsettledHours) {
    stop.push(`funding non regolato per ${unsettled.length} ore consecutive con posizione aperta (dal ${unsettled[0].hour})`)
  } else if (unsettled.length) {
    warnings.push(`funding non regolato per ${unsettled.length} ora/e consecutive (${unsettled.map((u) => u.hour).join(', ')})`)
  }

  return {
    stop,
    warnings,
    stats: {
      at: iso(now),
      cost_model: data?.costModel ?? null,
      open_positions: (data?.openPositions ?? []).map((p) => `${p.symbol} ${p.quantity}`),
      hl_429_events_total: events.length,
      hl_429_events_last_hour: lastHour.length,
      hl_429_streak: streak.length,
      last_prices_ok: iso(lastPricesOk),
      monitor_not_evaluated_lines: notEvaluated,
      monitor_stale_mark_lines: staleMark,
      monitor_skipped_then_recovered: skippedRecovered,
      monitor_episode_open_since: episode ? iso(episode.start) : null,
      funding_unsettled_streak_hours: unsettled.length,
    },
  }
}

/** Riconciliazione del report (sola lettura); null se il database non ha ancora la contabilita. */
export async function reconciliation(dbFile, traceFile, accountId) {
  const { buildReport } = await import('./report.mjs')
  const rep = buildReport({ dbFile, traceFile, accountId })
  return { ok: rep.reconciliation.ok, detail: rep.issues.filter((i) => /riconciliat|marginUsed|identita/.test(i)) }
}

/**
 * Conteggio delle riconciliazioni errate consecutive: un solo esito errato (es. lettura a meta di una
 * scrittura) e un avviso, `LIMITS.reconciliationFailures` consecutivi sono bloccanti. Gli errori di lettura
 * non contano come errori contabili: sono avvisi, ma `readLimit` di fila (~10 min) sono bloccanti perche la
 * contabilita non e piu verificabile.
 */
export function reconciliationTracker(limit = LIMITS.reconciliationFailures, readLimit = LIMITS.reconciliationReadErrors) {
  let failures = 0
  let readErrors = 0
  return (result) => {
    if (result.error) {
      readErrors++
      const text = `riconciliazione non verificabile (${readErrors} controlli di fila): ${result.error}`
      return readErrors >= readLimit ? { stop: text, warning: null } : { stop: null, warning: text }
    }
    readErrors = 0
    if (result.ok) {
      failures = 0
      return { stop: null, warning: null }
    }
    failures++
    const text = `riconciliazione contabile errata (${failures} controlli consecutivi): ${result.detail.join('; ')}`
    return failures >= limit ? { stop: text, warning: null } : { stop: null, warning: text }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('uso: node pilot/hl-guard.mjs <cartella-della-prova>')
    process.exit(64)
  }
  // run-meta.json viene riscritto dal launcher ogni 15 s: una lettura a meta scrittura si ripete
  let meta = null
  for (let i = 0; i < 10 && !meta; i++) {
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'))
    } catch (e) {
      if (i === 9) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
  }
  if (!meta.account_id) {
    console.log(JSON.stringify({ status: meta.status, note: 'conto non ancora creato' }, null, 2))
    process.exit(0)
  }
  const dbFile = path.join(dir, 'pilot.db')
  const data = loadGuardData(dbFile, meta.account_id)
  const result = evaluateGuard({
    lines: parseLog(fs.readFileSync(path.join(dir, 'backend.log'), 'utf8')),
    data, now: Date.now(), accountCreatedMs: Date.parse(meta.account_created_at),
  })
  let recon = null
  if (data.hasLedger) {
    try {
      recon = await reconciliation(dbFile, path.join(dir, 'trace.jsonl'), meta.account_id)
    } catch (e) {
      recon = { error: String(e) }
    }
  }
  console.log(JSON.stringify({ status: meta.status, ...result, reconciliation: recon }, null, 2))
  process.exit(result.stop.length ? 2 : 0)
}
