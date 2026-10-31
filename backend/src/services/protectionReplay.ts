/**
 * Chronological replay of the profit protection rules over a recorded run
 * (Task 007A). Pure: the caller (pilot/replay-protection.mjs) reads the
 * database and the trace; nothing here touches a file, the clock or the
 * network, and the rules are exactly profitProtection.ts, the code the live
 * monitor runs.
 *
 * At each sample the rules see only what existed at that moment: the
 * recorded prices up to it, the fills up to it, the funding rows recorded up
 * to it (by the time the row was written, not the funding hour). The risk
 * base (account value without unrealized P&L) is taken at the first sample
 * of each position, as the live monitor does.
 *
 * What a replay can and cannot say is returned with every result
 * (`limits`, `verifiable`). In short: the recorded prices are the mid
 * prices of the AI prompts, one every cycle (5 minutes), not the mark price
 * and not the 5-second monitor; the order book at the hypothetical exit is
 * not recorded, so an exit fills at the sample price (the real exit fills
 * against the book and costs at least the half spread more); and after a
 * hypothetical exit nothing of the recorded run is applicable (Gemini would
 * have seen another portfolio), so the result is the position's own net
 * result at its hypothetical exit, never an account result.
 */
import {
  afterPartialExit,
  evaluate,
  foldLifecycle,
  initialState,
  netResult,
  type FillRow,
  type ProtectionConfig,
  type ProtectionDecision,
  type ProtectionInput,
  type ProtectionState,
  type Side,
} from './profitProtection.js'

export interface ReplayFill extends FillRow {
  symbol: string
  /** Interest charged by the fill (original model). */
  interest: number
}

export interface ReplayFunding {
  symbol: string
  fundingTime: number
  /** When the row was written: the funding is known only from then on. */
  recordedAt: number
  amount: number
  status: string
}

export interface ReplaySample {
  ms: number
  /** Prices in the prompt of that cycle, by coin. */
  prices: Record<string, number>
}

export interface ReplayInput {
  costModel: 'original' | 'hyperliquid'
  initialCapital: number
  /** Taker fee rate of the cost model, for the estimated exit fee and the hypothetical exit. */
  feeRate: number
  fills: ReplayFill[]
  funding: ReplayFunding[]
  samples: ReplaySample[]
  config: ProtectionConfig
}

export interface ReplayStep {
  ms: number
  price: number
  net: number
  stage: 0 | 1 | 2
  peakNet: number
  floor: number
  action: 'hold' | 'exit'
}

export interface HypotheticalExit {
  ms: number
  kind: 'risk' | 'profit_protection'
  fraction: number
  price: number
  quantity: number
  netAtExit: number
  reason: string
}

export interface ReplayPosition {
  symbol: string
  side: Side
  openedAt: number
  /** When the recorded run closed it; null = still open at the end of the data. */
  closedAtRecorded: number | null
  samplesUsed: number
  riskUsdc: number
  /** Recorded outcome of the position: 'closed' = realized net; 'open_at_end' = estimate at the last sample (not realized). */
  recorded: { status: 'closed' | 'open_at_end'; net: number; basis: string }
  /** The same position under the rules. HYPOTHETICAL: never a result of the run. */
  hypothetical: {
    exits: HypotheticalExit[]
    /** Net result of the position at the end of the replay under the rules (closed by the rules, or as recorded). */
    net: number
    closedByRules: boolean
    deltaVsRecorded: number
    note: string
  }
  peakNet: number
  maxStage: 0 | 1 | 2
  steps: ReplayStep[]
}

export interface ReplayResult {
  config: ProtectionConfig
  positions: ReplayPosition[]
  /** Why the replay is, or is not, a verifiable historical execution. */
  verifiable: boolean
  limits: string[]
}

interface Lifecycle { symbol: string; openedAt: number; closedAt: number | null }

function lifecyclesOf(fills: ReplayFill[]): Lifecycle[] {
  const out: Lifecycle[] = []
  const bySymbol = new Map<string, ReplayFill[]>()
  for (const f of fills) (bySymbol.get(f.symbol) ?? bySymbol.set(f.symbol, []).get(f.symbol)!).push(f)
  for (const [symbol, list] of bySymbol) {
    let cur: Lifecycle | null = null
    const seen: ReplayFill[] = []
    for (const f of list) {
      seen.push(f)
      const life = foldLifecycle(seen)
      if (!cur && life.openedAt !== null) cur = { symbol, openedAt: life.openedAt, closedAt: null }
      else if (cur && life.openedAt === null) { cur.closedAt = f.ms; out.push(cur); cur = null }
      else if (cur && life.openedAt !== cur.openedAt) { cur.closedAt = f.ms; out.push(cur); cur = { symbol, openedAt: life.openedAt!, closedAt: null } }
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.openedAt - b.openedAt)
}

/** Account value without unrealized P&L at `ms`: capital + realized - fees - interest + funding (all known by then). */
function ledgerBase(input: ReplayInput, fills: ReplayFill[], ms: number): number {
  const avg = new Map<string, { qty: number; avg: number }>()
  let realized = 0
  let fees = 0
  let interest = 0
  for (const f of fills) {
    if (f.ms > ms) break
    fees += f.commission
    interest += f.interest
    const b = avg.get(f.symbol) ?? { qty: 0, avg: 0 }
    if (f.side === 'LONG' || f.side === 'SHORT') {
      b.avg = (b.avg * b.qty + f.price * f.quantity) / (b.qty + f.quantity)
      b.qty = Number((b.qty + f.quantity).toFixed(6))
    } else if (b.qty > 1e-9) {
      realized += (f.side === 'SELL' ? f.price - b.avg : b.avg - f.price) * f.quantity
      b.qty = Number((b.qty - f.quantity).toFixed(6))
      if (b.qty <= 1e-9) { b.qty = 0; b.avg = 0 }
    }
    avg.set(f.symbol, b)
  }
  const funding = input.funding.filter((x) => x.status === 'settled' && x.recordedAt <= ms).reduce((s, x) => s + x.amount, 0)
  return input.initialCapital + realized - fees - interest + funding
}

export function replayProtection(input: ReplayInput): ReplayResult {
  const fills = [...input.fills].sort((a, b) => a.ms - b.ms)
  const samples = [...input.samples].sort((a, b) => a.ms - b.ms)
  const positions: ReplayPosition[] = []
  const limits: string[] = [
    'prices are the mid prices of the AI prompts (one per cycle, cached up to 30 s), not the mark price: the live module decides at the mark, every 5 s; peaks and troughs between samples are not seen, so a replayed exit can come later than the live one (or be missed), and its price is only a sample',
    'the order book at the hypothetical exit is not recorded: a hypothetical exit fills at the sample price plus the taker fee; the real exit would also pay at least the half spread and any depth impact',
    'nothing after a hypothetical exit is applicable: Gemini would have seen another portfolio and decided differently, so the result is the position\'s own net result, not an account result and not a profit that was made',
  ]
  const gaps = samples.slice(1).map((s, i) => (s.ms - samples[i]!.ms) / 60_000).sort((a, b) => a - b)
  if (gaps.length) limits.push(`sample spacing: median ${gaps[Math.floor(gaps.length / 2)]!.toFixed(1)} min, maximum ${gaps.at(-1)!.toFixed(1)} min over ${samples.length} samples`)
  const missingFunding = input.funding.filter((f) => f.status !== 'settled').length
  if (missingFunding) limits.push(`${missingFunding} funding hour(s) were not settled in the recorded run (no amount); the replay counts none for them`)
  let verifiable = samples.length >= 2

  for (const life of lifecyclesOf(fills)) {
    const symFills = fills.filter((f) => f.symbol === life.symbol)
    const end = life.closedAt ?? Infinity
    const own = samples.filter((s) => s.ms > life.openedAt && s.ms <= end && (s.prices[life.symbol] ?? 0) > 0)
    const first = foldLifecycle(symFills.filter((f) => f.ms <= life.openedAt))
    const side = first.side ?? 'LONG'
    if (own.length === 0) {
      limits.push(`${life.symbol} position opened ${new Date(life.openedAt).toISOString()}: no recorded price while it was open, not replayable`)
      verifiable = false
      continue
    }

    // hypothetical fills the rules add; actual fills after the first exit no longer apply
    const synthetic: ReplayFill[] = []
    let cutoff = Infinity
    let state: ProtectionState | null = null
    let equityBase = 0
    const steps: ReplayStep[] = []
    const exits: HypotheticalExit[] = []
    let closedByRules = false
    let maxStage: 0 | 1 | 2 = 0

    for (const s of own) {
      const known = [...symFills.filter((f) => f.ms <= Math.min(s.ms, cutoff)), ...synthetic].sort((a, b) => a.ms - b.ms)
      const life2 = foldLifecycle(known)
      if (life2.openedAt === null) break
      const funding = input.funding.filter((f) => f.symbol === life.symbol && f.status === 'settled' && f.recordedAt <= s.ms && f.fundingTime >= life.openedAt)
        .reduce((sum, f) => sum + f.amount, 0)
      const price = s.prices[life.symbol]!
      const pin: ProtectionInput = {
        side: life2.side ?? side, quantity: life2.quantity, avgCost: life2.avgCost, price,
        margin: Number.isFinite(life2.margin) ? life2.margin : Number.POSITIVE_INFINITY,
        equityBase: state ? equityBase : (equityBase = ledgerBase(input, [...fills.filter((f) => f.ms <= s.ms)], s.ms)),
        realizedGross: life2.realizedGross, feesPaid: life2.feesPaid, fundingNet: funding, exitFeeRate: input.feeRate,
      }
      if (!Number.isFinite(pin.margin)) {
        // margin unknown (an opening fill without leverage): only the account limit applies
        pin.margin = Number.MAX_SAFE_INTEGER
        limits.push(`${life.symbol}: leverage of an opening fill unknown, risk unit from the account limit only`)
      }
      state ??= initialState(pin, input.config)
      const r = evaluate(state, pin, input.config)
      state = r.state
      maxStage = Math.max(maxStage, state.stage) as 0 | 1 | 2
      const d: ProtectionDecision = r.decision
      steps.push({ ms: s.ms, price, net: d.net, stage: d.stage, peakNet: d.peakNet, floor: d.floor, action: d.action })
      if (d.action !== 'exit') continue
      const fraction = d.fraction ?? 1
      const quantity = fraction >= 1 ? life2.quantity : Number((life2.quantity * fraction).toFixed(6))
      exits.push({ ms: s.ms, kind: d.kind!, fraction, price, quantity, netAtExit: d.net, reason: d.reason })
      synthetic.push({
        symbol: life.symbol, side: (life2.side ?? side) === 'LONG' ? 'SELL' : 'BUY', price, quantity,
        commission: quantity * price * input.feeRate, interest: 0, ms: s.ms,
      })
      cutoff = s.ms
      if (fraction >= 1) { closedByRules = true; break }
      state = afterPartialExit(state, d.net)
    }

    // recorded outcome
    const all = foldLifecycle(symFills.filter((f) => f.ms <= end))
    const lastSample = own.at(-1)!
    const recordedFundingNet = input.funding.filter((f) => f.symbol === life.symbol && f.status === 'settled' && f.recordedAt <= Math.min(end, lastSample.ms) && f.fundingTime >= life.openedAt)
      .reduce((s, f) => s + f.amount, 0)
    let recorded: ReplayPosition['recorded']
    if (life.closedAt !== null) {
      let q = 0, avg = 0, realized = 0, fees = 0
      for (const f of symFills.filter((x) => x.ms >= life.openedAt && x.ms <= end)) {
        fees += f.commission
        if (f.side === 'LONG' || f.side === 'SHORT') { avg = (avg * q + f.price * f.quantity) / (q + f.quantity); q += f.quantity }
        else { realized += (f.side === 'SELL' ? f.price - avg : avg - f.price) * f.quantity; q -= f.quantity }
      }
      recorded = { status: 'closed', net: realized - fees + recordedFundingNet, basis: 'realized: fills of the run, fees and funding settled while open' }
    } else {
      const n = netResult({
        side: all.side ?? side, quantity: all.quantity, avgCost: all.avgCost, price: lastSample.prices[life.symbol]!, margin: 1,
        equityBase: 0, realizedGross: all.realizedGross, feesPaid: all.feesPaid, fundingNet: recordedFundingNet, exitFeeRate: input.feeRate,
      })
      recorded = { status: 'open_at_end', net: n.net, basis: `estimate at the last recorded price (${new Date(lastSample.ms).toISOString()}), NOT realized: the position was still open` }
    }

    let hypNet = recorded.net
    if (exits.length) {
      const known = [...symFills.filter((f) => f.ms <= cutoff), ...synthetic].sort((a, b) => a.ms - b.ms)
      const l = foldLifecycle(known)
      const fundingAtCut = input.funding.filter((f) => f.symbol === life.symbol && f.status === 'settled' && f.recordedAt <= cutoff && f.fundingTime >= life.openedAt).reduce((s, f) => s + f.amount, 0)
      if (closedByRules) {
        let q = 0, avg = 0, realized = 0, fees = 0
        for (const f of known.filter((x) => x.ms >= life.openedAt)) {
          fees += f.commission
          if (f.side === 'LONG' || f.side === 'SHORT') { avg = (avg * q + f.price * f.quantity) / (q + f.quantity); q += f.quantity }
          else { realized += (f.side === 'SELL' ? f.price - avg : avg - f.price) * f.quantity; q -= f.quantity }
        }
        hypNet = realized - fees + fundingAtCut
      } else {
        hypNet = netResult({
          side: l.side ?? side, quantity: l.quantity, avgCost: l.avgCost, price: lastSample.prices[life.symbol]!, margin: 1, equityBase: 0,
          realizedGross: l.realizedGross, feesPaid: l.feesPaid, fundingNet: fundingAtCut, exitFeeRate: input.feeRate,
        }).net
      }
    }
    positions.push({
      symbol: life.symbol, side, openedAt: life.openedAt, closedAtRecorded: life.closedAt, samplesUsed: own.length,
      riskUsdc: state?.riskUsdc ?? 0, recorded,
      hypothetical: {
        exits, net: hypNet, closedByRules, deltaVsRecorded: hypNet - recorded.net,
        note: exits.length
          ? 'HYPOTHETICAL: the position as the rules would have closed it at sample prices; actual fills after the first exit ignored'
          : 'the rules never fired: same as recorded',
      },
      peakNet: Math.max(0, ...steps.map((x) => x.peakNet)), maxStage, steps,
    })
  }
  if (positions.length === 0) verifiable = false
  return { config: input.config, positions, verifiable, limits: [...new Set(limits)] }
}
