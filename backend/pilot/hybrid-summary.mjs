// ALPHA BOT pilota (009D) — sintesi in sola lettura di una prova con ALPHA_PROMPT=hybrid, per i criteri di valutazione:
// gestione delle posizioni, motivi verificabili delle chiusure, risultato netto, peso dei costi, controlli di rischio,
// uso della memoria da parte di Gemini, uso delle API. Non scrive nulla, non fa richieste di rete.
//
// CLI:    node pilot/hybrid-summary.mjs <cartella-della-prova>      (usa pilot.db, report.json, ai-attempts.jsonl)
// Modulo: summarizeHybrid({ dbFile, accountId, report, attemptsText })
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const Database = createRequire(import.meta.url)('better-sqlite3')
const share = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null)

export function summarizeHybrid({ dbFile, accountId, report = null, attemptsText = null }) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const acc = accountId ?? db.prepare("SELECT id FROM accounts WHERE account_type='AI' ORDER BY id DESC LIMIT 1").get()?.id
    const rows = db.prepare('SELECT at, operation, symbol, executed, outcome, issues, decision, context FROM ai_decisions_v3 WHERE account_id=? ORDER BY at, id').all(acc)
      .filter((r) => JSON.parse(r.context).prompt === 'hybrid')
    const status = (r) => (r.outcome ?? 'none').split(':')[0]
    const by = (f) => rows.reduce((m, r) => ((m[f(r)] = (m[f(r)] ?? 0) + 1), m), {})
    const withPositions = rows.filter((r) => (JSON.parse(r.context).open_positions ?? []).length > 0)
    const reviewed = withPositions.filter((r) => { const d = JSON.parse(r.decision); return typeof d.position_review === 'string' && d.position_review.trim() })
    const opens = rows.filter((r) => r.operation === 'open')
    const opensWithInvalidation = opens.filter((r) => { const d = JSON.parse(r.decision); return typeof d.invalidation === 'string' && d.invalidation.trim() })
    const exits = db.prepare("SELECT kind, status, COUNT(*) n FROM exit_events WHERE account_id=? AND kind LIKE 'exit_%' GROUP BY kind, status").all(acc)
    const aiCloses = rows.filter((r) => r.operation === 'close' && status(r) === 'executed').length
    const pnl = report?.pnl ?? null
    // execution costs vs mid are already inside the gross P&L (real fill prices); fees and funding are subtracted after it
    const costs = pnl ? { fees_usdc: pnl.fees, funding_net_usdc: pnl.funding_net, spread_and_depth_vs_mid_usdc: report?.execution?.cost_vs_mid_usdc ?? null,
      gross_usdc: pnl.gross_usdc, net_usdc: pnl.net_usdc, fees_share_of_abs_gross_pct: share(pnl.fees, Math.abs(pnl.gross_usdc)) } : 'report.json assente'
    let attempts = null
    if (attemptsText !== null) {
      const a = attemptsText.split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
      attempts = { sent: a.filter((x) => x.result === 'sent').length, refused: a.filter((x) => String(x.result).startsWith('blocked')).length,
        by_class: a.filter((x) => x.class).reduce((m, x) => ((m[x.class] = (m[x.class] ?? 0) + 1), m), {}) }
    }
    return {
      account_id: acc, decisions: rows.length, by_operation: by((r) => r.operation ?? 'none'), by_outcome: by(status),
      memory_use: {
        decisions_with_open_positions: withPositions.length, with_position_review: reviewed.length, review_share_pct: share(reviewed.length, withPositions.length),
        opens: opens.length, opens_with_stated_invalidation: opensWithInvalidation.length,
      },
      closes: { by_ai_executed: aiCloses, by_exit_module: exits },
      net_result: pnl ? { net_usdc: pnl.net_usdc, net_pct: pnl.net_pct, max_drawdown_pct: report?.risk?.max_drawdown_pct ?? null } : null,
      costs, api_attempts: attempts ?? 'ai-attempts.jsonl assente',
      reconciliation_ok: report?.reconciliation?.ok ?? null,
    }
  } finally {
    db.close()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const dir = process.argv[2]
  if (!dir) { console.error('uso: node pilot/hybrid-summary.mjs <cartella-della-prova>'); process.exit(64) }
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null)
  const report = read('report.json') ? JSON.parse(read('report.json')) : null
  const meta = read('run-meta.json') ? JSON.parse(read('run-meta.json')) : null
  console.log(JSON.stringify(summarizeHybrid({ dbFile: path.join(dir, 'pilot.db'), accountId: meta?.account_id ?? undefined, report, attemptsText: read('ai-attempts.jsonl') }), null, 2))
}
