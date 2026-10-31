/**
 * Chronological replay of the exit rules C1 / C2 / C3 on a recorded pilot
 * (Task 007C). Pure: the CLI (pilot/replay-exits.mjs) reads pilot.db, the
 * trace and the candles; nothing here touches a file, the clock or the
 * network.
 *
 * For every position of the run: the ATR comes from 1 h bars that ENDED
 * before its first fill (what the live module would have used), the plan is
 * built on the real entry price, and the rules run over the 15 m bars that
 * follow, up to the recorded close (or the end of the run). What happened
 * before the hypothetical exit is the record; after it nothing is
 * applicable, because Gemini would have seen another portfolio.
 *
 * The recorded result counts all funding of the hours the position was held
 * (by funding hour, also when the row was written after the close: Task 007B
 * finding A8). The hypothetical result uses the real entry and its fee, the
 * taker fee at every exit, an estimated exit half spread and stop slippage,
 * and the recorded funding of the hours it would still have been open.
 */
import { atrAt, createPlan, foldLifecycle, type Bar, type ExitConfig, type ExitMode, type Side } from './exitRules.js'
import { simulatePath, type PathLeg } from './exitPathSim.js'

export interface ReplayFill {
  symbol: string
  side: string
  price: number
  quantity: number
  commission: number
  ms: number
  leverage?: number
}

export interface ReplayFunding {
  symbol: string
  fundingTime: number
  status: string
  amount: number
  rate: number | null
  oraclePrice: number | null
}

export interface ReplayInput {
  feeRate: number
  fills: ReplayFill[]
  funding: ReplayFunding[]
  /** 15 m bars by coin (trade prices). */
  bars15: Record<string, Bar[]>
  /** End of the recorded run (ms). */
  runEnd: number
  /** Prompt prices of each cycle (mids), only to check the candles against the record. */
  samples: { ms: number; prices: Record<string, number> }[]
  modes: ExitMode[]
  config: ExitConfig
  halfSpread: Record<string, number>
  stopSlippage: number
}

export interface ReplayModeResult {
  plan: { entry: number; atr: number; atrAsOf: string; stop: number; takeProfit: number | null; partialAt: number | null }
  legs: (Omit<PathLeg, 'time'> & { time: string })[]
  /** Net result of the position under the rules, USDC. HYPOTHETICAL. */
  netUsdc: number
  deltaVsRecordedUsdc: number
  exitedByRules: boolean
  note: string
}

export interface ReplayPosition {
  symbol: string
  side: Side
  openedAt: string
  quantity: number
  entry: number
  recorded: { status: 'closed' | 'open_at_end'; closedAt: string | null; netUsdc: number; basis: string }
  atr: { value: number; asOf: string } | { error: string }
  modes: Partial<Record<ExitMode, ReplayModeResult>>
  barsUsed: number
  promptCheck: { samples: number; outsideBarRange: number }
}

export interface ReplayResult {
  positions: ReplayPosition[]
  verifiable: boolean
  limits: string[]
}

const QUARTER = 900_000

interface Life { symbol: string; side: Side; openedAt: number; closedAt: number | null; fills: ReplayFill[] }

function lifecycles(fills: ReplayFill[]): Life[] {
  const out: Life[] = []
  const bySymbol = new Map<string, ReplayFill[]>()
  for (const f of [...fills].sort((a, b) => a.ms - b.ms)) (bySymbol.get(f.symbol) ?? bySymbol.set(f.symbol, []).get(f.symbol)!).push(f)
  for (const [symbol, list] of bySymbol) {
    let cur: Life | null = null
    const seen: ReplayFill[] = []
    for (const f of list) {
      seen.push(f)
      const life = foldLifecycle(seen)
      if (!cur && life.openedAt !== null) cur = { symbol, side: life.side!, openedAt: life.openedAt, closedAt: null, fills: [f] }
      else if (cur) {
        cur.fills.push(f)
        if (life.openedAt === null) { cur.closedAt = f.ms; out.push(cur); cur = null; seen.length = 0 }
      }
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.openedAt - b.openedAt)
}

export function replayExits(input: ReplayInput): ReplayResult {
  const limits = [
    'path: 15 m Hyperliquid candles (trade prices), not the mark price the live module checks every 5 s; inside a bar the order of high and low is unknown, a bar touching both an exit and a target counts as the exit',
    'execution: the order book at a hypothetical exit is not recorded; the exit fills at the level (or the bar open after a gap) with the taker fee, an estimated half spread and stop slippage; the real fill could be worse in a fast market',
    'decisions: nothing after a hypothetical exit is simulated: Gemini would have seen another portfolio (and a cooldown); the result is the position\'s own, never an account result and never a realized profit',
    'funding after a hypothetical exit is not paid; before it, the recorded funding rows of the run are used (hours with no settled row count as zero and are listed)',
  ]
  const positions: ReplayPosition[] = []
  let verifiable = true
  for (const life of lifecycles(input.fills)) {
    const s = life.side === 'LONG' ? 1 : -1
    const opens = life.fills.filter((f) => f.side === 'LONG' || f.side === 'SHORT')
    const first = opens[0]!
    const qty = opens.reduce((x, f) => x + f.quantity, 0)
    const entry = opens.reduce((x, f) => x + f.price * f.quantity, 0) / qty
    const entryFee = opens.reduce((x, f) => x + f.commission, 0)
    if (opens.length > 1) limits.push(`${life.symbol}: the recorded position was added to (${opens.length} opening fills): the replay uses the average entry from the start`)
    const end = life.closedAt ?? input.runEnd
    const bars = input.bars15[life.symbol] ?? []
    const firstBar = Math.ceil(life.openedAt / QUARTER) * QUARTER
    const path = bars.filter((b) => b.openTime >= firstBar && b.endTime <= end)
    const lastBarEnd = bars.at(-1)?.endTime ?? 0
    if (lastBarEnd < end) {
      limits.push(`${life.symbol}: candles end ${new Date(lastBarEnd).toISOString()}, before the end of the position ${new Date(end).toISOString()}: fetch newer candles (research/exit-rules/fetch-data.mjs recent)`)
      verifiable = false
    }
    // recorded result: fills of the position, all its funding hours (A8: by funding hour)
    const closes = life.fills.filter((f) => f.side === 'SELL' || f.side === 'BUY')
    const realized = closes.reduce((x, f) => x + s * (f.price - entry) * f.quantity, 0)
    const fees = life.fills.reduce((x, f) => x + f.commission, 0)
    const fundingRows = input.funding.filter((f) => f.symbol === life.symbol && f.fundingTime > life.openedAt && f.fundingTime <= end)
    const settled = fundingRows.filter((f) => f.status === 'settled')
    const fundingRecorded = settled.reduce((x, f) => x + f.amount, 0)
    if (fundingRows.length > settled.length) limits.push(`${life.symbol}: ${fundingRows.length - settled.length} funding hour(s) not settled in the run (counted as zero)`)
    let recorded: ReplayPosition['recorded']
    if (life.closedAt !== null) {
      recorded = { status: 'closed', closedAt: new Date(life.closedAt).toISOString(), netUsdc: realized - fees + fundingRecorded, basis: 'realized: recorded fills, fees and funding' }
    } else {
      const last = path.at(-1)
      const px = last?.close ?? entry
      const exitFee = qty * px * input.feeRate
      recorded = {
        status: 'open_at_end', closedAt: null, netUsdc: s * (px - entry) * qty - fees - exitFee + fundingRecorded,
        basis: `estimate if closed at the last 15 m close before the end of the run (${last ? new Date(last.endTime).toISOString() : 'no bar'}), taker fee included, spread not; NOT realized`,
      }
    }
    const atr = atrAt(bars.map((b) => ({ openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close })), life.openedAt, input.config.atrPeriod)
    // prompt prices against the candles: a prompt mid outside the bar's range means the two sources disagree
    const inWindow = input.samples.filter((x) => x.ms > life.openedAt && x.ms <= end && x.prices[life.symbol] !== undefined)
    let outside = 0
    for (const x of inWindow) {
      const b = bars.find((y) => y.openTime <= x.ms && x.ms < y.endTime)
      if (b && (x.prices[life.symbol]! < b.low * 0.9995 || x.prices[life.symbol]! > b.high * 1.0005)) outside++
    }
    const pos: ReplayPosition = {
      symbol: life.symbol, side: life.side, openedAt: new Date(life.openedAt).toISOString(), quantity: qty, entry, recorded,
      atr: 'error' in atr ? { error: atr.error } : { value: atr.atr, asOf: new Date(atr.asOf).toISOString() }, modes: {}, barsUsed: path.length,
      promptCheck: { samples: inWindow.length, outsideBarRange: outside },
    }
    if ('error' in atr || path.length === 0) {
      verifiable = false
      limits.push(`${life.symbol} opened ${pos.openedAt}: not replayable (${'error' in atr ? atr.error : 'no 15 m bar while it was open'})`)
      positions.push(pos)
      continue
    }
    const fundingByHour = new Map(settled.map((f) => [f.fundingTime, f]))
    for (const mode of input.modes) {
      const plan = createPlan(mode, life.side, entry, atr.atr, atr.asOf, { ...input.config, mode })
      const r = simulatePath(plan, path, life.openedAt, {
        entryFeeFraction: 0, exitFeeRate: 0, halfSpread: 0, stopSlippage: 0, fundingRate: () => 0,
      })
      const ruleLegs = r.legs.filter((l) => l.kind !== 'time_exit')
      const exitedByRules = r.legs.length > 0 && r.legs.at(-1)!.kind !== 'time_exit'
      const hs = input.halfSpread[life.symbol] ?? 0
      let gross = 0, cost = entryFee, remaining = 1
      for (const l of ruleLegs) {
        gross += l.fraction * qty * s * (l.price - entry)
        cost += l.fraction * qty * l.price * (input.feeRate + hs)
        if (l.kind === 'exit_stop' || l.kind === 'exit_breakeven' || l.kind === 'exit_trailing') cost += l.fraction * qty * l.price * input.stopSlippage
        remaining -= l.fraction
      }
      // what the rules did not close follows the record: the recorded close, or the end-of-run estimate
      if (remaining > 1e-12) {
        if (life.closedAt !== null) {
          const closeQty = closes.reduce((x, f) => x + f.quantity, 0)
          const avgClose = closes.reduce((x, f) => x + f.price * f.quantity, 0) / closeQty
          gross += remaining * qty * s * (avgClose - entry)
          cost += remaining * closes.reduce((x, f) => x + f.commission, 0)
        } else {
          const px = path.at(-1)!.close
          gross += remaining * qty * s * (px - entry)
          cost += remaining * qty * px * input.feeRate
        }
      }
      // recorded funding of the hours still (partly) open under the rules
      let funding = 0
      // share open at hour h: the rule legs closed after h, plus what the rules never closed (held to the recorded end)
      for (const [h, f] of fundingByHour) {
        funding += f.amount * (ruleLegs.filter((l) => l.time > h).reduce((x, l) => x + l.fraction, 0) + Math.max(0, remaining))
      }
      const net = gross - cost + funding
      pos.modes[mode] = {
        plan: { entry, atr: atr.atr, atrAsOf: new Date(atr.asOf).toISOString(), stop: plan.stopPrice, takeProfit: plan.takeProfitPrice, partialAt: plan.partialPrice },
        legs: r.legs.map((l) => ({ ...l, time: new Date(l.time).toISOString() })),
        netUsdc: net, deltaVsRecordedUsdc: net - recorded.netUsdc, exitedByRules,
        note: exitedByRules || ruleLegs.length
          ? 'HYPOTHETICAL: the position as the rules would have managed it; nothing after the exit is applicable'
          : 'the rules would not have acted: same as recorded',
      }
    }
    positions.push(pos)
  }
  if (!positions.length) { verifiable = false; limits.push('no position in the run: nothing to replay') }
  return { positions, verifiable, limits: [...new Set(limits)] }
}

export { type Bar }
