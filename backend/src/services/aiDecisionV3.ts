/**
 * Output of the v3 prompt (Task 007F): parsing, validation and record.
 *
 * Policy (nothing here changes the size or the leverage the model asks for;
 * the engine's own checks still apply after this):
 * - not a JSON object -> no decision this cycle (recorded);
 * - "open" without a usable plan (thesis, invalidation and target on the
 *   right side of the price, horizon) -> rejected: not executed, recorded;
 * - numbers in the text that are not in the data given -> flagged and
 *   recorded (measured), the decision is not blocked for them;
 * - other schema problems (confidence, key_factors...) -> flagged only.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { aiDecisionsV3, type Account } from '../db/schema.js'
import type { V3Context } from './v3Context.js'

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const TEXT_FIELDS = ['reason', 'thesis', 'changed_since_last'] as const

function unwrapCodeFence(text: string): string {
  let content = text.trim()
  if (content.includes('```json')) content = content.split('```json')[1]!.split('```')[0]!.trim()
  else if (content.includes('```')) {
    const parts = content.split('```')
    if (parts.length > 1) content = parts[1]!.split('```')[0]!.trim()
  }
  return content
}

/** The model's answer as an object, or why not. No field is guessed from a broken answer. */
export function parseV3(text: string): { value: Record<string, unknown> } | { error: string } {
  const body = unwrapCodeFence(text)
  for (const candidate of [body, body.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")]) {
    try {
      const v = JSON.parse(candidate) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v as Record<string, unknown> }
      return { error: 'the answer is JSON but not an object' }
    } catch { /* next */ }
  }
  return { error: 'the answer is not valid JSON' }
}

// ------------------------------------------------------------- numbers

/** Dates and clock times are not quantities: removed before looking for numbers. */
const stripDates = (s: string) => s
  .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/g, ' ')
  .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')

/** Every number of the data (JSON and text), as absolute values. */
export function dataNumbers(text: string): number[] {
  const out: number[] = []
  for (const m of stripDates(text).matchAll(/-?\d[\d,]*(?:\.\d+)?(?:e-?\d+)?/gi)) {
    const v = Number(m[0].replace(/,(?=\d{3}\b)/g, ''))
    if (Number.isFinite(v)) out.push(Math.abs(v))
  }
  return out
}

export interface CitedNumber { text: string; value: number; halfUnit: number }

/**
 * Numbers written by the model as quantities: not part of a word or a name
 * (EMA20, 4h, 2x, 1.5R are not), not a date or time, and not a small
 * integer (<= 10: counts, periods, multiples that cannot be checked).
 */
export function citedNumbers(text: string): CitedNumber[] {
  const out: CitedNumber[] = []
  const s = stripDates(text)
  for (const m of s.matchAll(/(?<![A-Za-z0-9_.])\$?(-?\d{1,3}(?:,\d{3})+|-?\d+)(\.\d+)?(?![\d.]*[A-Za-z_\d]|-[A-Za-z])/g)) {
    const raw = `${m[1]}${m[2] ?? ''}`
    const value = Math.abs(Number(raw.replace(/,/g, '')))
    if (!Number.isFinite(value)) continue
    if (!m[2] && value <= 10) continue
    const decimals = m[2] ? m[2].length - 1 : 0
    out.push({ text: raw, value, halfUnit: 0.5 * 10 ** -decimals })
  }
  return out
}

/** A cited number matches the data when it is a rounding of a value there (or within 0.15 % of it). */
export function matchesData(c: CitedNumber, data: readonly number[]): boolean {
  return data.some((x) => Math.abs(c.value - x) <= Math.max(0.0015 * x, c.halfUnit + 1e-12))
}

// ------------------------------------------------------------- validation

export interface V3Validation {
  value: Record<string, unknown>
  issues: string[]
  /** true: not executed (an "open" without a usable plan). */
  rejected: boolean
  numbers: { cited: number; verified: number; unverified: string[] }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function validateDecisionV3(value: Record<string, unknown>, ctx: Pick<V3Context, 'prices'>, promptText: string): V3Validation {
  const issues: string[] = []
  const blocking: string[] = []
  const op = typeof value.operation === 'string' ? value.operation.toLowerCase() : ''
  const symbol = typeof value.symbol === 'string' ? value.symbol.toUpperCase() : null
  const direction = typeof value.direction === 'string' ? value.direction.toLowerCase() : null
  if (!['open', 'close', 'hold'].includes(op)) issues.push(`operation ${JSON.stringify(value.operation)} is not open/close/hold`)
  if ((op === 'open' || op === 'close') && (!symbol || !COINS.includes(symbol))) issues.push(`symbol ${JSON.stringify(value.symbol)} is not one of the six coins`)
  if ((op === 'open' || op === 'close') && direction !== 'long' && direction !== 'short') issues.push(`direction ${JSON.stringify(value.direction)} is not long/short`)
  if (op === 'open') {
    const price = symbol ? ctx.prices[symbol] ?? null : null
    const inv = value.invalidation_price, tgt = value.target_price, hz = value.time_horizon_hours
    if (typeof value.thesis !== 'string' || !value.thesis.trim()) blocking.push('open without a thesis')
    if (!isNum(inv) || inv <= 0) blocking.push('open without an invalidation_price')
    if (!isNum(tgt) || tgt <= 0) blocking.push('open without a target_price')
    if (!isNum(hz) || hz <= 0 || hz > 24 * 30) blocking.push('open without a time_horizon_hours in (0, 720]')
    if (price === null) blocking.push(`no current price of ${symbol} to check the levels against`)
    else if (isNum(inv) && isNum(tgt) && (direction === 'long' || direction === 'short')) {
      const long = direction === 'long'
      if (long ? !(inv < price) : !(inv > price)) blocking.push(`invalidation_price ${inv} is on the wrong side of the price ${price} for a ${direction}`)
      if (long ? !(tgt > price) : !(tgt < price)) blocking.push(`target_price ${tgt} is on the wrong side of the price ${price} for a ${direction}`)
    }
  }
  if (value.confidence !== undefined && !['low', 'medium', 'high'].includes(String(value.confidence))) issues.push(`confidence ${JSON.stringify(value.confidence)} is not low/medium/high`)
  if (value.confidence === undefined) issues.push('no confidence')
  const kf = value.key_factors
  if (!Array.isArray(kf) || !kf.every((k) => typeof k === 'string')) issues.push('key_factors is not a list of strings')
  else if (kf.length > 5) issues.push(`key_factors has ${kf.length} items (at most 5 asked)`)
  if (typeof value.changed_since_last !== 'string' || !value.changed_since_last.trim()) issues.push('no changed_since_last')
  if (typeof value.reason !== 'string' || !value.reason.trim()) issues.push('no reason')
  // numbers cited in the text against the data given (the decision's own levels and size are its choices, not citations)
  const own = [value.invalidation_price, value.target_price, value.time_horizon_hours, value.leverage, value.target_portion_of_balance]
    .filter(isNum).flatMap((x) => [Math.abs(x), Math.abs(x * 100)])
  const data = [...dataNumbers(promptText), ...own]
  const texts = [...TEXT_FIELDS.map((f) => value[f]), ...(Array.isArray(kf) ? kf : [])].filter((t): t is string => typeof t === 'string')
  const cited = texts.flatMap(citedNumbers)
  const unverified = [...new Set(cited.filter((c) => !matchesData(c, data)).map((c) => c.text))]
  if (unverified.length) issues.push(`numbers not found in the data given: ${unverified.slice(0, 10).join(', ')}`)
  return {
    value, issues: [...blocking, ...issues], rejected: blocking.length > 0,
    numbers: { cited: cited.length, verified: cited.length - cited.filter((c) => !matchesData(c, data)).length, unverified },
  }
}

// ------------------------------------------------------------- record

/** Records one v3 answer (valid or not) with the context snapshot of its coin; returns the row id. */
export function recordDecisionV3(
  account: Pick<Account, 'id'>, cycleId: string | undefined, now: number,
  answer: { value: Record<string, unknown>; validation: V3Validation } | { error: string; raw: string },
  ctx: Pick<V3Context, 'snapshots' | 'prices'>, extra: Record<string, unknown> = {},
): number {
  const value = 'value' in answer ? answer.value : {}
  const symbol = typeof value.symbol === 'string' && COINS.includes(value.symbol.toUpperCase()) ? value.symbol.toUpperCase() : null
  const row = db.insert(aiDecisionsV3).values({
    accountId: account.id, at: now, cycleId: cycleId ?? null,
    operation: typeof value.operation === 'string' ? value.operation.toLowerCase().slice(0, 10) : null,
    symbol, direction: typeof value.direction === 'string' ? value.direction.toLowerCase().slice(0, 5) : null,
    valid: 'value' in answer && answer.validation.issues.length === 0 ? 1 : 0,
    issues: JSON.stringify('value' in answer ? answer.validation.issues : [answer.error]),
    decision: JSON.stringify('value' in answer ? value : { raw: answer.raw.slice(0, 500) }),
    context: JSON.stringify({
      snapshot: symbol ? ctx.snapshots[symbol] ?? null : null, prices: ctx.prices,
      numbers: 'value' in answer ? answer.validation.numbers : null, ...extra,
    }),
    executed: null, outcome: null,
  }).returning({ id: aiDecisionsV3.id }).get()
  return row.id
}

/** What the engine did with a recorded decision. */
export function markDecisionV3Outcome(id: number, status: string, detail: string): void {
  db.update(aiDecisionsV3).set({ executed: status === 'executed' ? 1 : 0, outcome: `${status}: ${detail}`.slice(0, 500) })
    .where(eq(aiDecisionsV3.id, id)).run()
}
