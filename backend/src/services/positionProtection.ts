/**
 * Runtime of the exit module (Tasks 007A/007C, experimental): applies the
 * rules of exitRules.ts (C1 / C2 / C3) to the open perpetuals of a
 * 'hyperliquid' account at fresh, valid mark prices, executes exits through
 * the normal engine close path (orders PRT-…: same taker fee, l2Book fill,
 * lot and minimum rules, reconciliation) and records every plan, level and
 * intervention in exit_plans / exit_events. Also: the account emergency
 * control, the cooldown on AI reopens, and the corrected position
 * information sent to the AI.
 *
 * Off unless ALPHA_PROTECTION is C1, C2 or C3; ALPHA_POSITION_INFO=v2 switches
 * the AI's position information. With both at their defaults nothing here
 * runs and the original behaviour is intact.
 */
import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  exitEvents,
  exitPlans,
  fundingPayments,
  positions as positionsTable,
  takerFeeRate,
  trades,
  type Account,
  type Position,
} from '../db/schema.js'
import { dbDateMs } from '../utils/datetime.js'
import { getLogger } from '../utils/logger.js'
import { positionMargin } from './assetCalculator.js'
import {
  activeLevel,
  assessRisk,
  atrAt,
  createPlan,
  decide,
  foldLifecycle,
  loadExitConfig,
  MIN_ORDER_NOTIONAL,
  netResult,
  positionInfoVersion,
  retryDelay,
  updateBest,
  type AtrResult,
  type Bar15,
  type ExitConfig,
  type ExitDecision,
  type ExitMode,
  type ExitPlan,
  type ExitState,
  type Lifecycle,
  type PartialState,
  type Side,
} from './exitRules.js'
import { marksFromAssetContexts } from './hyperliquidMarginData.js'
import { promptVersion } from './promptV3.js'
import { getLastPrice } from './marketData.js'
import { TICKER_MAX_AGE_MS } from './quantData.js'

const logger = getLogger('services.positionProtection')

export { foldLifecycle, type FillRow, type Lifecycle } from './exitRules.js'

// ---------------------------------------------------------------- lifecycle

export function positionLifecycle(accountId: number, symbol: string): Lifecycle & { fundingNet: number } {
  const rows = db.select().from(trades)
    .where(and(eq(trades.accountId, accountId), eq(trades.symbol, symbol)))
    .orderBy(asc(trades.tradeTime), asc(trades.id)).all()
  const life = foldLifecycle(rows.map((t) => ({
    side: t.side, price: t.price, quantity: t.quantity, commission: t.commission, ms: dbDateMs(t.tradeTime),
  })))
  let fundingNet = 0
  if (life.openedAt !== null) {
    for (const f of db.select().from(fundingPayments)
      .where(and(eq(fundingPayments.accountId, accountId), eq(fundingPayments.symbol, symbol))).all()) {
      if (f.status === 'settled' && f.fundingTime >= life.openedAt) fundingNet += f.amount
    }
  }
  return { ...life, fundingNet }
}

// ---------------------------------------------------------------- dependencies (replaced in tests)

export interface ExitDeps {
  /** ATR(14, 1 h) from 1 h bars closed at or before `asOfMs`. */
  atr: (symbol: string, asOfMs: number, period: number) => Promise<AtrResult>
  /** szDecimals of a perpetual, or why unknown. */
  sizeDecimals: (symbol: string) => Promise<{ szDecimals: number } | { error: string }>
}

export const defaultExitDeps: ExitDeps = {
  atr: async (symbol, asOfMs, period) => {
    try {
      const { cachedCandles15m } = await import('./quantData.js')
      const candles = await cachedCandles15m(symbol)
      return atrAt(candles as Bar15[], asOfMs, period)
    } catch (e) {
      return { error: `candles unavailable: ${e}` }
    }
  },
  sizeDecimals: async (symbol) => (await import('./hyperliquidMarket.js')).hyperliquidSizeDecimals(symbol),
}

// ---------------------------------------------------------------- records

/** Counters since start (pilot report, tests). */
export const protectionStats = { passes: 0, evaluations: 0, exits: 0, partials: 0, failedExits: 0, emergencies: 0, cooldownBlocks: 0 }

const asSide = (s: string | null): Side | null => (s === 'LONG' || s === 'SHORT' ? s : null)
const EXIT_KINDS = ['exit_stop', 'exit_breakeven', 'exit_trailing', 'exit_take_profit', 'exit_emergency'] as const

type PlanRow = typeof exitPlans.$inferSelect

function planOf(row: PlanRow): ExitPlan {
  return {
    mode: row.mode as ExitMode, side: row.side as Side, entry: row.entry, atr: row.atr, atrAsOf: row.atrAsOf,
    stopPrice: row.stopPrice, riskPrice: row.riskPrice, trailDistance: row.trailDistance,
    takeProfitPrice: row.takeProfitPrice, partialPrice: row.partialPrice, partialFraction: row.partialFraction,
  }
}
const stateOf = (row: PlanRow): ExitState => ({ best: row.best, partial: row.partialState as PartialState })
const planKey = (row: Pick<PlanRow, 'accountId' | 'symbol' | 'openedAt' | 'planSeq'>) => and(
  eq(exitPlans.accountId, row.accountId), eq(exitPlans.symbol, row.symbol),
  eq(exitPlans.openedAt, row.openedAt), eq(exitPlans.planSeq, row.planSeq))

interface EventInput {
  account: Account; symbol: string; side: Side; openedAt?: number | null; planSeq?: number | null; at: number
  kind: string; status: string; mode?: string | null; mark?: number | null; level?: number | null; fraction?: number | null
  quantityRequested?: number | null; quantityFilled?: number | null; fillPrice?: number | null; slippageVsMarkBps?: number | null
  netAtTrigger?: number | null; closedPosition?: boolean; orderNo?: string | null; reason: string; detail?: unknown
}
function recordEvent(e: EventInput): void {
  db.insert(exitEvents).values({
    accountId: e.account.id, symbol: e.symbol, side: e.side, openedAt: e.openedAt ?? null, planSeq: e.planSeq ?? null, at: e.at,
    kind: e.kind, status: e.status, mode: e.mode ?? null, mark: e.mark ?? null, level: e.level ?? null, fraction: e.fraction ?? null,
    quantityRequested: e.quantityRequested ?? null, quantityFilled: e.quantityFilled ?? null, fillPrice: e.fillPrice ?? null,
    slippageVsMarkBps: e.slippageVsMarkBps ?? null, netAtTrigger: e.netAtTrigger ?? null, closedPosition: e.closedPosition ? 1 : 0,
    orderNo: e.orderNo ?? null, reason: e.reason, detail: JSON.stringify(e.detail ?? {}),
  }).run()
}

// ---------------------------------------------------------------- cooldown

/**
 * The AI may not reopen the same coin in the same direction for cooldownMs
 * after the module closed such a position (any full exit, emergency included).
 * Returns the end of the block, or null.
 */
export function cooldownUntil(accountId: number, symbol: string, side: Side, now = Date.now(), config: ExitConfig = loadExitConfig()): number | null {
  if (config.mode === 'off' || config.cooldownMs <= 0) return null
  const last = db.select().from(exitEvents).where(and(
    eq(exitEvents.accountId, accountId), eq(exitEvents.symbol, symbol), eq(exitEvents.side, side),
    eq(exitEvents.closedPosition, 1), gt(exitEvents.at, now - config.cooldownMs))).orderBy(desc(exitEvents.at)).get()
  return last ? last.at + config.cooldownMs : null
}

/** Records an AI open refused by the cooldown (called by the AI order path). */
export function recordCooldownBlock(account: Account, symbol: string, side: Side, until: number, now = Date.now()): void {
  protectionStats.cooldownBlocks++
  recordEvent({
    account, symbol, side, at: now, kind: 'cooldown_block', status: 'blocked', mode: loadExitConfig().mode,
    reason: `AI open ${side} ${symbol} refused: cooldown after a protective exit until ${new Date(until).toISOString()}`,
  })
}

/** Active cooldowns of an account, for the AI prompt (v2). */
export function activeCooldowns(accountId: number, now = Date.now(), config: ExitConfig = loadExitConfig()): { symbol: string; side: Side; until: string }[] {
  if (config.mode === 'off' || config.cooldownMs <= 0) return []
  const rows = db.select().from(exitEvents).where(and(eq(exitEvents.accountId, accountId), eq(exitEvents.closedPosition, 1),
    gt(exitEvents.at, now - config.cooldownMs))).all()
  const last = new Map<string, number>()
  for (const r of rows) last.set(`${r.symbol}:${r.side}`, Math.max(last.get(`${r.symbol}:${r.side}`) ?? 0, r.at))
  return [...last].map(([k, at]) => ({ symbol: k.split(':')[0]!, side: k.split(':')[1] as Side, until: new Date(at + config.cooldownMs).toISOString() }))
}

// ---------------------------------------------------------------- the pass

export interface ProtectionSummary {
  evaluated: number
  exits: number
  partials: number
  failed: number
  emergency: boolean
  skipped: string[]
}

/**
 * One pass for an account at the marks given (valid and fresh: the margin
 * monitor calls this only when it could evaluate every position, and never
 * when the account is liquidatable). Never throws.
 */
export async function runProtectionPass(
  account: Account,
  rows: Position[],
  marks: Record<string, number | null | undefined>,
  now = Date.now(),
  config: ExitConfig = loadExitConfig(),
  deps: ExitDeps = defaultExitDeps,
): Promise<ProtectionSummary> {
  const summary: ProtectionSummary = { evaluated: 0, exits: 0, partials: 0, failed: 0, emergency: false, skipped: [] }
  if (config.mode === 'off' || account.costModel !== 'hyperliquid') return summary
  protectionStats.passes++
  try {
    const open = rows.filter((r) => r.quantity > 0 && asSide(r.side))
    const equityBase = account.currentCash + rows.filter((r) => r.quantity > 0).reduce((s, r) => s + positionMargin(r), 0)
    const feeRate = takerFeeRate(account.costModel)
    const markOf = (symbol: string) => {
      const m = marks[symbol]
      return typeof m === 'number' && m > 0 ? m : 0
    }
    const lives = new Map(open.map((p) => [p.symbol, positionLifecycle(account.id, p.symbol)]))
    const netOf = (p: Position, mark: number) => {
      const life = lives.get(p.symbol)!
      return netResult({ side: asSide(p.side)!, quantity: p.quantity, avgCost: p.avgCost, price: mark, realizedGross: life.realizedGross,
        feesPaid: life.feesPaid, fundingNet: life.fundingNet, exitFeeRate: feeRate }).net
    }

    // 1. account emergency: the open positions together lose emergencyLossPctOfEquity of the account value
    if (open.length && open.every((p) => markOf(p.symbol) > 0)) {
      const total = open.reduce((s, p) => s + netOf(p, markOf(p.symbol)), 0)
      if (total <= -config.emergencyLossPctOfEquity * equityBase) {
        summary.emergency = true
        protectionStats.emergencies++
        const reason = `account emergency: open positions net ${total.toFixed(4)} USDC <= -${config.emergencyLossPctOfEquity * 100}% of the account value ${equityBase.toFixed(2)}`
        logger.warning(`🛑 ${reason} (${account.name}): closing every position`)
        for (const p of open) {
          const life = lives.get(p.symbol)!
          const plan = activePlanRow(account.id, p.symbol, life.openedAt)
          const r = await executeClose(account, p.symbol, asSide(p.side)!, 1, 'exit_emergency', reason, markOf(p.symbol), now, life.openedAt,
            plan, netOf(p, markOf(p.symbol)), config)
          if (r.ok) summary.exits++
          else summary.failed++
        }
        return summary
      }
    }

    const openKeys = new Set<string>()
    for (const pos of open) {
      const side = asSide(pos.side)!
      const life = lives.get(pos.symbol)!
      if (life.openedAt === null) { summary.skipped.push(`${pos.symbol}: no fills found for the open position`); continue }
      openKeys.add(`${pos.symbol}:${life.openedAt}`)
      const mark = markOf(pos.symbol)
      if (!mark) { summary.skipped.push(`${pos.symbol}: no valid mark price`); continue }

      // 2. the plan: made once from information before the first fill; a new one when the AI added to the position
      let row = activePlanRow(account.id, pos.symbol, life.openedAt)
      if (row && pos.quantity > row.plannedQty + 1e-9) {
        db.update(exitPlans).set({ status: 'superseded', updatedAt: now, closedAt: now }).where(planKey(row)).run()
        recordEvent({ account, symbol: pos.symbol, side, openedAt: life.openedAt, planSeq: row.planSeq, at: now, kind: 'plan_reset', status: 'info',
          mode: row.mode, mark, reason: `position grew from ${row.plannedQty} to ${pos.quantity}: new plan from the new average entry ${pos.avgCost}` })
        row = await makePlan(account, pos, life, side, equityBase, now, row.planSeq + 1, now, config, deps, feeRate)
      } else if (!row) {
        row = await makePlan(account, pos, life, side, equityBase, now, nextSeq(account.id, pos.symbol, life.openedAt), life.openedAt, config, deps, feeRate)
      } else if (pos.quantity < row.plannedQty - 1e-9) {
        // closed in part by the AI (or by a book that filled only part): the levels stay, the quantity follows
        db.update(exitPlans).set({ plannedQty: pos.quantity, updatedAt: now }).where(planKey(row)).run()
        row = { ...row, plannedQty: pos.quantity }
      }
      if (!row) { summary.skipped.push(`${pos.symbol}: no exit plan (ATR unavailable)`); continue }

      // 3. the decision at the mark, with the best price known before it
      const plan = planOf(row)
      const decision = decide(plan, stateOf(row), mark)
      const state = updateBest(plan, stateOf(row), mark)
      const lvl = activeLevel(plan, state)
      summary.evaluated++
      protectionStats.evaluations++
      db.update(exitPlans).set({ best: state.best, lastMark: mark, lastLevel: lvl.price, lastLevelKind: lvl.kind, updatedAt: now }).where(planKey(row)).run()
      if (decision.action === 'hold') continue
      if (row.nextAttemptAt && now < row.nextAttemptAt) continue

      const net = netOf(pos, mark)
      if (decision.action === 'partial') {
        const r = await executePartial(account, pos, side, decision, mark, now, life.openedAt, row, net, config, deps)
        if (r === 'done') { summary.partials++; protectionStats.partials++ } else if (r === 'failed') summary.failed++
        continue
      }
      const r = await executeClose(account, pos.symbol, side, 1, decision.kind!, decision.reason, mark, now, life.openedAt, row, net, config, decision)
      if (r.ok) summary.exits++
      else summary.failed++
    }

    // plans of positions no longer open
    for (const p of db.select().from(exitPlans).where(and(eq(exitPlans.accountId, account.id), eq(exitPlans.status, 'active'))).all()) {
      if (!openKeys.has(`${p.symbol}:${p.openedAt}`)) db.update(exitPlans).set({ status: 'closed', closedAt: now, updatedAt: now }).where(planKey(p)).run()
    }
  } catch (e) {
    logger.error(`Exit management pass failed for account ${account.name}: ${e}`)
  }
  return summary
}

function activePlanRow(accountId: number, symbol: string, openedAt: number | null): PlanRow | null {
  if (openedAt === null) return null
  return db.select().from(exitPlans).where(and(eq(exitPlans.accountId, accountId), eq(exitPlans.symbol, symbol),
    eq(exitPlans.openedAt, openedAt), eq(exitPlans.status, 'active'))).orderBy(desc(exitPlans.planSeq)).get() ?? null
}

function nextSeq(accountId: number, symbol: string, openedAt: number): number {
  const last = db.select().from(exitPlans).where(and(eq(exitPlans.accountId, accountId), eq(exitPlans.symbol, symbol),
    eq(exitPlans.openedAt, openedAt))).orderBy(desc(exitPlans.planSeq)).get()
  return last ? last.planSeq + 1 : 1
}

/** Last 'plan_unavailable' event per position, so a missing ATR is reported once per 15 minutes, not every 5 s. */
const unavailableReported = new Map<string, number>()

async function makePlan(
  account: Account, pos: Position, life: Lifecycle & { fundingNet: number }, side: Side, equityBase: number, now: number,
  planSeq: number, atrAsOf: number, config: ExitConfig, deps: ExitDeps, feeRate: number,
): Promise<PlanRow | null> {
  const mode = config.mode as ExitMode
  const atr = await deps.atr(pos.symbol, atrAsOf, config.atrPeriod)
  if ('error' in atr) {
    const key = `${account.id}:${pos.symbol}:${life.openedAt}:${planSeq}`
    if (now - (unavailableReported.get(key) ?? -Infinity) >= 15 * 60_000) {
      unavailableReported.set(key, now)
      recordEvent({ account, symbol: pos.symbol, side, openedAt: life.openedAt, planSeq, at: now, kind: 'plan_unavailable', status: 'info', mode,
        reason: `no exit plan for ${pos.symbol}: ${atr.error}; only the account emergency control applies until the ATR is available` })
      logger.warning(`Exit plan unavailable for ${account.name} ${pos.symbol}: ${atr.error}`)
    }
    return null
  }
  const plan = createPlan(mode, side, pos.avgCost, atr.atr, atr.asOf, config)
  const risk = assessRisk({ plan, quantity: pos.quantity, feesPaid: life.feesPaid, exitFeeRate: feeRate, equityBase, config })
  const row: PlanRow = {
    accountId: account.id, symbol: pos.symbol, openedAt: life.openedAt!, planSeq, mode, side, entry: plan.entry, atr: plan.atr,
    atrAsOf: plan.atrAsOf, stopPrice: plan.stopPrice, riskPrice: plan.riskPrice, trailDistance: plan.trailDistance,
    takeProfitPrice: plan.takeProfitPrice, partialPrice: plan.partialPrice, partialFraction: plan.partialFraction,
    partialState: plan.mode === 'C2' ? 'pending' : 'n/a', best: plan.entry, plannedQty: pos.quantity, equityBase,
    riskUsdc: risk.riskUsdc, riskPct: risk.riskPct, oversized: risk.oversized ? 1 : 0, status: 'active', failures: 0,
    nextAttemptAt: null, lastMark: null, lastLevel: plan.stopPrice, lastLevelKind: 'stop', createdAt: now, updatedAt: now, closedAt: null,
  }
  db.insert(exitPlans).values(row).run()
  recordEvent({ account, symbol: pos.symbol, side, openedAt: life.openedAt, planSeq, at: now, kind: 'plan_created', status: 'info', mode,
    level: plan.stopPrice, reason: `${mode} plan: entry ${plan.entry}, ATR(${config.atrPeriod}, 1h) ${plan.atr} as of ${new Date(plan.atrAsOf).toISOString()}, ` +
      `stop ${plan.stopPrice}${plan.takeProfitPrice !== null ? `, take profit ${plan.takeProfitPrice}` : ''}${plan.partialPrice !== null ? `, partial ${plan.partialFraction * 100}% at ${plan.partialPrice}` : ''}; ${risk.note}`,
    detail: { plan, risk, quantity: pos.quantity, equityBase } })
  if (risk.oversized) logger.warning(`⚠️ Oversized position ${account.name} ${side} ${pos.symbol}: ${risk.note}`)
  return row
}

async function executePartial(
  account: Account, pos: Position, side: Side, d: ExitDecision, mark: number, now: number, openedAt: number | null,
  row: PlanRow, net: number, config: ExitConfig, deps: ExitDeps,
): Promise<'done' | 'skipped' | 'failed'> {
  const lot = await deps.sizeDecimals(pos.symbol)
  const { floorToLot } = await import('./hyperliquidMarket.js')
  const raw = pos.quantity * d.fraction
  const qty = 'error' in lot ? 0 : floorToLot(raw, lot.szDecimals)
  const value = qty * mark
  const skip = 'error' in lot ? `size rules unknown: ${lot.error}`
    : qty <= 0 ? `${raw} ${pos.symbol} rounds to 0 at the lot 10^-${lot.szDecimals}`
      : value < MIN_ORDER_NOTIONAL ? `${qty} ${pos.symbol} x ${mark} = ${value.toFixed(4)} USD, below the Hyperliquid minimum of ${MIN_ORDER_NOTIONAL} USD`
        : null
  if (skip) {
    // the partial cannot be placed: the plan goes on as if it had been taken (break-even + trailing on the whole position)
    db.update(exitPlans).set({ partialState: 'skipped', updatedAt: now }).where(planKey(row)).run()
    recordEvent({ account, symbol: pos.symbol, side, openedAt, planSeq: row.planSeq, at: now, kind: 'partial_take_profit', status: 'skipped', mode: row.mode,
      mark, level: d.level, fraction: d.fraction, quantityRequested: raw, netAtTrigger: net,
      reason: `${d.reason}; not placed: ${skip}; break-even and trailing now apply to the whole position` })
    return 'skipped'
  }
  const r = await executeClose(account, pos.symbol, side, qty / pos.quantity, 'partial_take_profit', d.reason, mark, now, openedAt, row, net, config, d, qty)
  if (r.ok && r.filled > 0) {
    const after = db.select().from(positionsTable).where(eq(positionsTable.id, pos.id)).get()
    db.update(exitPlans).set({ partialState: 'done', plannedQty: after?.quantity ?? 0, updatedAt: now }).where(planKey(row)).run()
    return 'done'
  }
  return 'failed'
}

/**
 * Closes `fraction` of the position (1 = all; `fixedQty` when the quantity is
 * already rounded to the lot) through the engine. On a close refused because
 * the position changed meanwhile, the position is read again and the close
 * retried once with its current quantity.
 */
async function executeClose(
  account: Account, symbol: string, side: Side, fraction: number, kind: string, reason: string, mark: number, now: number,
  openedAt: number | null, row: PlanRow | null, net: number, config: ExitConfig, d?: ExitDecision, fixedQty?: number,
): Promise<{ ok: boolean; filled: number }> {
  const readPos = () => db.select().from(positionsTable).where(and(eq(positionsTable.accountId, account.id),
    eq(positionsTable.symbol, symbol), eq(positionsTable.market, 'CRYPTO'))).get()
  const base = { account, symbol, side, openedAt, planSeq: row?.planSeq ?? null, at: now, kind, mode: row?.mode ?? config.mode, mark, level: d?.level ?? null, netAtTrigger: net }
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const orderNo = `PRT-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`
    const current = readPos()
    const latest = db.select().from(accounts).where(eq(accounts.id, account.id)).get()
    if (!current || current.quantity <= 0 || current.side !== side || !latest) {
      recordEvent({ ...base, status: 'failed', fraction, orderNo, reason: `${reason}; not executed: position already closed or changed`, detail: { plan: row && planOf(row) } })
      return { ok: false, filled: 0 }
    }
    const requested = fixedQty !== undefined && attempt === 0 ? fixedQty : fraction >= 1 ? current.quantity : Number((current.quantity * fraction).toFixed(6))
    try {
      const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
      const order = await placeAndExecuteCrypto({
        account: latest, symbol, name: current.name, side: side === 'LONG' ? 'SELL' : 'BUY', orderType: 'MARKET',
        price: null, quantity: requested, leverage: current.leverage, orderNo,
      })
      const after = readPos()
      const left = after?.quantity ?? 0
      const flat = left <= 1e-9
      const fill = order.price ?? 0
      const s = side === 'LONG' ? 1 : -1
      const slippage = fill > 0 ? (s * (mark - fill) / mark) * 1e4 : null // > 0: filled worse than the mark
      const bookPartial = order.filledQuantity + 1e-12 < requested
      recordEvent({ ...base, status: bookPartial ? 'book_partial' : 'executed', fraction, quantityRequested: requested,
        quantityFilled: order.filledQuantity, fillPrice: fill, slippageVsMarkBps: slippage, closedPosition: flat, orderNo,
        reason: reason + (bookPartial ? `; the book filled only ${order.filledQuantity} of ${requested}, ${left} still open` : ''),
        detail: { plan: row && planOf(row), remaining: left } })
      logger.warning(`🛡️ ${kind} ${account.name} ${side === 'LONG' ? 'SELL' : 'BUY'} ${order.filledQuantity} ${symbol} at ${fill} (mark ${mark}). ${reason}`)
      protectionStats.exits += kind === 'partial_take_profit' ? 0 : 1
      if (row) {
        if (flat) {
          db.update(exitPlans).set({ status: 'closed', closedAt: now, failures: 0, nextAttemptAt: null, updatedAt: now }).where(planKey(row)).run()
        } else if (fraction >= 1) {
          const expected = Number((current.quantity - order.filledQuantity).toFixed(6))
          if (left > expected + 1e-9) {
            // more open than this close left: the position grew meanwhile, the next pass makes a new plan
            db.update(exitPlans).set({ plannedQty: expected, updatedAt: now }).where(planKey(row)).run()
          } else {
            // the book was exhausted: the rest is closed at the next attempt
            db.update(exitPlans).set({ plannedQty: left, failures: row.failures + 1, nextAttemptAt: now + retryDelay(1, config), updatedAt: now }).where(planKey(row)).run()
          }
        }
      }
      return { ok: true, filled: order.filledQuantity }
    } catch (e) {
      lastError = String(e)
      if (attempt === 0 && /Cannot close more than position size|No position to close/.test(lastError)) continue // the position changed: read it again once
      break
    }
  }
  const failures = (row?.failures ?? 0) + 1
  const next = now + retryDelay(failures, config)
  if (row) db.update(exitPlans).set({ failures, nextAttemptAt: next, updatedAt: now }).where(planKey(row)).run()
  recordEvent({ ...base, status: 'failed', fraction, reason: `${reason}; not executed: ${lastError}; next attempt after ${new Date(next).toISOString()}`,
    detail: { plan: row && planOf(row), error: lastError, failures } })
  logger.error(`Exit ${kind} failed for ${account.name} ${symbol} (${failures} in a row): ${lastError}`)
  protectionStats.failedExits++
  return { ok: false, filled: 0 }
}

// ---------------------------------------------------------------- AI position information

/**
 * Price of a position for the AI: the same basis as the account equity
 * (calcAccountEquity): the mark price of the 'hyperliquid' model when valid
 * and fresh, otherwise the last (mid) price; an error is reported, not hidden.
 */
export async function currentPriceFor(
  account: Account, symbol: string,
): Promise<{ value: number; basis: 'mark' | 'mid' } | { issue: string }> {
  try {
    let value = await getLastPrice(symbol, 'CRYPTO')
    let basis: 'mark' | 'mid' = 'mid'
    if (account.costModel === 'hyperliquid') {
      const quote = marksFromAssetContexts([symbol])[symbol]!
      const age = quote.receivedAt === null ? Infinity : Date.now() - quote.receivedAt
      if (quote.markPrice !== null && age <= TICKER_MAX_AGE_MS) { value = quote.markPrice; basis = 'mark' }
    }
    return { value, basis }
  } catch (e) {
    return { issue: `price unavailable: ${e}` }
  }
}

const r6 = (x: number) => Number(x.toFixed(6))
const r4 = (x: number) => Number(x.toFixed(4))

export interface PositionView {
  quantity: number
  avg_cost: number
  side: string
  leverage: number
  entry_value: number
  current_price: number | null
  price_basis: 'mark' | 'mid' | null
  current_value: number | null
  unrealized_pnl: number | null
  margin: number
  fees_paid: number
  estimated_exit_fee: number | null
  financing_net: number
  realized_pnl_partial_closes: number
  estimated_net_pnl_if_closed_now: number | null
  return_on_margin_pct: number | null
  opened_at: string | null
  holding_minutes: number | null
  price_issue?: string
  exit_plan?: {
    config: string; stop_price: number; exit_level: number | null; exit_level_kind: string | null
    take_profit_price: number | null; partial_price: number | null; partial: string
    risk_at_stop_usdc: number; risk_at_stop_pct_of_account: number; oversized_vs_1pct: boolean
  }
}

/**
 * The position as the AI is shown it with ALPHA_POSITION_INFO=v2. The
 * original `current_value` was quantity * avg_cost, i.e. the value at ENTRY
 * whatever the price did; here `entry_value` is that and `current_value` is
 * quantity * current price. Without a valid price the price-based fields are
 * null and the reason is given: nothing is invented. With the exit module on,
 * the plan in force is included (information only: Gemini still decides).
 */
export function buildPositionView(
  account: Account, pos: Position, price: { value: number; basis: 'mark' | 'mid' } | { issue: string },
  accruedInterest: number, now = Date.now(),
): PositionView {
  const side = asSide(pos.side) ?? 'LONG'
  const life = positionLifecycle(account.id, pos.symbol)
  const margin = positionMargin(pos)
  const financing = account.costModel === 'hyperliquid' ? life.fundingNet : -(pos.accumulatedInterest + accruedInterest)
  const view: PositionView = {
    quantity: pos.quantity, avg_cost: pos.avgCost, side, leverage: pos.leverage,
    entry_value: r4(pos.quantity * pos.avgCost),
    current_price: null, price_basis: null, current_value: null, unrealized_pnl: null, margin: r4(margin),
    fees_paid: r6(life.feesPaid), estimated_exit_fee: null, financing_net: r6(financing),
    realized_pnl_partial_closes: r6(life.realizedGross),
    estimated_net_pnl_if_closed_now: null, return_on_margin_pct: null,
    opened_at: life.openedAt === null ? null : new Date(life.openedAt).toISOString(),
    holding_minutes: life.openedAt === null ? null : Math.max(0, Math.round((now - life.openedAt) / 60_000)),
  }
  const row = activePlanRow(account.id, pos.symbol, life.openedAt)
  if (row) {
    view.exit_plan = {
      config: row.mode, stop_price: row.stopPrice, exit_level: row.lastLevel, exit_level_kind: row.lastLevelKind,
      take_profit_price: row.takeProfitPrice, partial_price: row.partialPrice, partial: row.partialState,
      risk_at_stop_usdc: r4(row.riskUsdc), risk_at_stop_pct_of_account: r4(row.riskPct * 100), oversized_vs_1pct: row.oversized === 1,
    }
  }
  if ('issue' in price) {
    view.price_issue = price.issue
    return view
  }
  const net = netResult({
    side, quantity: pos.quantity, avgCost: pos.avgCost, price: price.value,
    realizedGross: life.realizedGross, feesPaid: life.feesPaid, fundingNet: financing, exitFeeRate: takerFeeRate(account.costModel),
  })
  view.current_price = price.value
  view.price_basis = price.basis
  view.current_value = r4(pos.quantity * price.value)
  view.unrealized_pnl = r4(net.unrealized)
  view.estimated_exit_fee = r6(net.exitFee)
  view.estimated_net_pnl_if_closed_now = r4(net.net)
  view.return_on_margin_pct = margin > 0 ? r4((net.net / margin) * 100) : null
  return view
}

/** The experiment configuration, validated (throws on an invalid value) and written to the log at startup. */
export function describeExperiment(env: Record<string, string | undefined> = process.env): string {
  const cfg = loadExitConfig(env)
  const info = positionInfoVersion(env)
  const prompt = promptVersion(env)
  // the hybrid prompt shows the state of each position: it is built on the corrected position view (007A v2)
  if (prompt === 'hybrid' && info !== 'v2') throw new Error('ALPHA_PROMPT=hybrid needs ALPHA_POSITION_INFO=v2 (the position state it shows)')
  return `Experiment config: position_info=${info} protection=${cfg.mode} prompt=${prompt}${cfg.mode !== 'off' ? ` config=${JSON.stringify(cfg)}` : ''}`
}

/** Events of a set of kinds since a time (report, tests). */
export function exitEventsSince(accountId: number, kinds: readonly string[], since = 0) {
  return db.select().from(exitEvents).where(and(eq(exitEvents.accountId, accountId), inArray(exitEvents.kind, [...kinds]), gt(exitEvents.at, since - 1))).all()
}

export { EXIT_KINDS }
