/**
 * Diagnostic trace of AI trading cycles: prompt, raw response, parsed
 * decision and execution outcome, written as JSON lines.
 *
 * Off unless AI_DIAGNOSTICS_FILE is set. The file is never served by the API
 * and never stores headers or API keys. Recording never throws, so it cannot
 * change or interrupt trading.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.aiDiagnostics')

export function diagnosticsEnabled(): boolean {
  return Boolean(process.env.AI_DIAGNOSTICS_FILE)
}

/** Identifier linking every record of one account's AI cycle. */
export function newCycleId(): string {
  return randomUUID()
}

/** Removes the account key and any bearer token from the serialized record. */
function redact(text: string, secrets: (string | null | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[REDACTED]')
  }
  return out.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
}

export function recordAICycle(
  cycleId: string | undefined,
  event: string,
  data: Record<string, unknown>,
  secrets: (string | null | undefined)[] = [],
): void {
  const file = process.env.AI_DIAGNOSTICS_FILE
  if (!file || !cycleId) return
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      cycle_id: cycleId,
      event,
      ...data,
    })
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${redact(line, secrets)}\n`, { mode: 0o600 })
  } catch (err) {
    logger.warning(`AI diagnostics record failed (${event}): ${err}`)
  }
}
