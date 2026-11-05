/**
 * The hybrid prompt (Task 009D, ALPHA_PROMPT=hybrid): the ORIGINAL prompt
 * (aiDecision.buildPrompt, same market prices, news, output format and rules)
 * with what it lacked to manage open positions:
 * - the corrected position view of Task 007A (ALPHA_POSITION_INFO=v2, required):
 *   entry and current price, P&L, fees, funding, net if closed now, holding time,
 *   and the exit plan in force when the exit module is on;
 * - the memory of each open position (hybridContext.positionMemory);
 * - the costs of trading, measured on the account, and the rates in force;
 * - an explicit review of each open position, with HOLD and CLOSE both allowed;
 * - two optional output fields: "invalidation" (for an open) and "position_review".
 * Nothing is added about entries: the sections are placed at fixed anchors of the
 * original text, which is otherwise unchanged (tests compare them line by line).
 */
import type { ExitConfig } from './exitRules.js'
import type { AccountCosts, HybridPositionExtra } from './hybridContext.js'
import { exitModuleText } from './promptV3.js'

/** Where the sections go in the original text (each must occur exactly once). */
export const HYBRID_ANCHORS = {
  beforePrices: '\n\nCurrent Market Prices:\n',
  reasonField: '  "reason": "Brief explanation of your decision"\n}',
  rulesEnd: '- Only choose symbols you have price data for',
} as const

function insertOnce(text: string, anchor: string, replacement: string): string {
  const n = text.split(anchor).length - 1
  if (n !== 1) throw new Error(`hybrid prompt: anchor found ${n} times (expected 1): ${JSON.stringify(anchor.slice(0, 40))}`)
  return text.replace(anchor, () => replacement)
}

export interface HybridSections {
  positions: HybridPositionExtra[]
  costs: AccountCosts
  exitModule: ExitConfig
}

export function buildPromptHybrid(original: string, s: HybridSections): string {
  const memory = s.positions.length
    ? `\n- Position memory (per open position: the decision that opened it and the data of that moment, the invalidation you stated if any, your decisions since; earlier reasons are context, not evidence: judge with the current data):\n${JSON.stringify(Object.fromEntries(s.positions.map((p) => [p.symbol, { ...p.memory, costs: p.costs }])), null, 2)}`
    : '\n- Position memory: no open position.'
  const c = s.costs
  const costs = `\n- Trading costs (paper engine, ${c.taker_fee_pct_each_side}% taker fee of the notional on each side, open and close; fills against the order book, so the spread is paid too; funding every hour on open perpetual positions):
  - paid so far on this account: fees ${c.fees_paid_usdc} USDC, spread/slippage ${c.slippage_paid_usdc ?? 'not measured'} USDC, funding net ${c.funding_net_usdc} USDC (negative = paid), ${c.opens} opens and ${c.closes} closes
  - funding per hour now, % of notional (positive: LONG pays SHORT; negative: SHORT pays LONG): ${JSON.stringify(Object.fromEntries(Object.entries(c.per_coin).map(([k, v]) => [k, v.funding_hourly_pct])))}
  - a round trip costs at least twice the fee plus the spread; closing and reopening pays it again`
  let text = insertOnce(original, HYBRID_ANCHORS.beforePrices, `${memory}${costs}${HYBRID_ANCHORS.beforePrices}`)
  text = insertOnce(text, HYBRID_ANCHORS.reasonField, `  "invalidation": "for open: the price level or condition that would prove this trade wrong, or null if you cannot state one",
  "position_review": "for each open position: hold or close, and why, from its current net result, its memory and the current data; empty when there is none",
  "reason": "Brief explanation of your decision"
}`)
  text = insertOnce(text, HYBRID_ANCHORS.rulesEnd, `${HYBRID_ANCHORS.rulesEnd}
- Review every open position each cycle. HOLD it when your reasons still apply to the current data; CLOSE it when they no longer apply, when the invalidation you stated has happened, or when what you still expect to gain no longer covers the costs and the risk. Neither is required: say which and why in "position_review".
- estimated_net_pnl_if_closed_now already includes the fees paid, the exit fee and the funding; the exit spread is not included (its estimate is in the position memory costs).
- Exit module: ${exitModuleText(s.exitModule)}`)
  return text
}
