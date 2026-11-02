/**
 * Output of the v4 prompt (Task 008): the v3 validation (unchanged, same
 * blocking policy: an "open" without a usable plan is not executed) plus
 * checks of the three alternatives, which are flagged and recorded but never
 * block or change a decision:
 * - "alternatives" with long / short / hold present, symbols among the six or null;
 * - the levels of the long and short alternatives on the right side of the
 *   price of their coin;
 * - an "open" matches the alternative of its side (same symbol);
 * - numbers in the alternatives' text must come from the data given.
 */
import { citedNumbers, dataNumbers, matchesData, validateDecisionV3, type V3Validation } from './aiDecisionV3.js'
import type { V3Context } from './v3Context.js'

const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

export interface V4Validation extends V3Validation {
  /** Problems of the alternatives only (also included in issues). */
  alternativeIssues: string[]
}

export function validateDecisionV4(value: Record<string, unknown>, ctx: Pick<V3Context, 'prices'>, promptText: string): V4Validation {
  const base = validateDecisionV3(value, ctx, promptText)
  const issues: string[] = []
  const alts = obj(value.alternatives)
  const texts: string[] = []
  const own: number[] = []
  if (!alts) issues.push('no alternatives (long, short, hold)')
  else {
    for (const side of ['long', 'short'] as const) {
      const a = obj(alts[side])
      if (!a) { issues.push(`alternatives.${side} missing`); continue }
      const sym = a.symbol === null || a.symbol === undefined ? null : typeof a.symbol === 'string' ? a.symbol.toUpperCase() : '?'
      if (sym !== null && !COINS.includes(sym)) issues.push(`alternatives.${side}.symbol ${JSON.stringify(a.symbol)} is not one of the six coins or null`)
      for (const k of ['case_for', 'case_against']) {
        if (typeof a[k] !== 'string' || !(a[k] as string).trim()) issues.push(`alternatives.${side}.${k} missing`)
        else texts.push(a[k] as string)
      }
      const inv = a.invalidation_price, tgt = a.target_price
      for (const x of [inv, tgt]) if (isNum(x)) own.push(Math.abs(x))
      const price = sym ? ctx.prices[sym] ?? null : null
      if (price !== null && isNum(inv) && (side === 'long' ? !(inv < price) : !(inv > price))) issues.push(`alternatives.${side}.invalidation_price ${inv} is on the wrong side of the price ${price}`)
      if (price !== null && isNum(tgt) && (side === 'long' ? !(tgt > price) : !(tgt < price))) issues.push(`alternatives.${side}.target_price ${tgt} is on the wrong side of the price ${price}`)
    }
    const h = obj(alts.hold)
    if (!h) issues.push('alternatives.hold missing')
    else for (const k of ['case_for', 'case_against']) {
      if (typeof h[k] !== 'string' || !(h[k] as string).trim()) issues.push(`alternatives.hold.${k} missing`)
      else texts.push(h[k] as string)
    }
    const op = typeof value.operation === 'string' ? value.operation.toLowerCase() : ''
    const dir = typeof value.direction === 'string' ? value.direction.toLowerCase() : ''
    if (op === 'open' && (dir === 'long' || dir === 'short')) {
      const chosen = obj(alts[dir])
      const sym = typeof value.symbol === 'string' ? value.symbol.toUpperCase() : null
      if (chosen && typeof chosen.symbol === 'string' && chosen.symbol.toUpperCase() !== sym) issues.push(`open ${sym} ${dir} does not match alternatives.${dir}.symbol ${chosen.symbol}`)
    }
  }
  // numbers of the alternatives' text, against the data (the alternatives' own levels and the decision's are choices)
  const decisionOwn = [value.invalidation_price, value.target_price, value.time_horizon_hours, value.leverage, value.target_portion_of_balance]
    .filter(isNum).flatMap((x) => [Math.abs(x), Math.abs(x * 100)])
  const data = [...dataNumbers(promptText), ...own, ...decisionOwn]
  const cited = texts.flatMap(citedNumbers)
  const unverified = [...new Set(cited.filter((c) => !matchesData(c, data)).map((c) => c.text))]
  if (unverified.length) issues.push(`numbers in the alternatives not found in the data given: ${unverified.slice(0, 10).join(', ')}`)
  return {
    ...base,
    issues: [...base.issues, ...issues],
    alternativeIssues: issues,
    numbers: {
      cited: base.numbers.cited + cited.length,
      verified: base.numbers.verified + cited.length - cited.filter((c) => !matchesData(c, data)).length,
      unverified: [...new Set([...base.numbers.unverified, ...unverified])],
    },
  }
}
