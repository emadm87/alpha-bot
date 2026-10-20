/**
 * Accounting regression tests (Task 003B).
 *
 * Reproduces two defects found in the 003A review, using the production
 * functions as-is:
 *  - E5: unrealised P&L of SHORT positions has the wrong sign
 *        (`calcPositionsMarketValue`).
 *  - E6: total assets reported to the AI are inflated by the leverage
 *        (`getPortfolioData` -> `calcPositionsValue`).
 *
 * Fully offline and deterministic:
 *  - DATABASE_PATH points at a throwaway SQLite file in a fresh temp dir,
 *    set before any module opens the DB; only `ensureSchema()` runs (no seed).
 *  - Prices are injected through the real price cache (`cachePrice`), so
 *    `getLastPrice` returns them without touching Hyperliquid.
 *  - `globalThis.fetch` throws, so any accidental network call fails loudly.
 *
 * Expected values follow the convention the code itself documents in
 * assetCalculator.ts: account cash already had the initial margin deducted on
 * open, so a leveraged position's equity is
 *   margin posted at entry + unrealised P&L
 *   margin = avg_cost * quantity / leverage
 *   P&L    = quantity * (price - avg_cost)   for LONG
 *            quantity * (avg_cost - price)   for SHORT
 *
 * Run with: npx tsx --test src/services/accounting.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-acct-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')

const networkCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  networkCalls.push(String(input))
  throw new Error(`Network access is not allowed in tests: ${String(input)}`)
}) as typeof fetch

// Imported after DATABASE_PATH is set so db/client.ts opens the temp file.
const { db, rawDb, ensureSchema, DATABASE_PATH } = await import('../db/client.js')
const { accounts, positions, users } = await import('../db/schema.js')
const { cachePrice } = await import('./priceCache.js')
const { calcPositionsMarketValue } = await import('./assetCalculator.js')
const { getPortfolioData } = await import('./aiDecision.js')

const EPS = 1e-9

function approxEqual(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${label}: actual=${actual} expected=${expected}`,
  )
}

function createAccount(currentCash: number, marginUsed = 0) {
  const user = db
    .insert(users)
    .values({ username: `test-${Date.now()}-${Math.random()}`, isActive: 'true' })
    .returning()
    .get()
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      version: 'v1',
      name: 'TEST',
      accountType: 'AI',
      isActive: 'true',
      apiKey: null,
      initialCapital: 1000,
      currentCash,
      frozenCash: 0,
      marginUsed,
      maintenanceMarginRatio: 0.5,
    })
    .returning()
    .get()
}

function createPosition(
  accountId: number,
  p: { symbol: string; side: 'LONG' | 'SHORT'; quantity: number; avgCost: number; leverage: number },
): void {
  db.insert(positions)
    .values({
      version: 'v1',
      accountId,
      symbol: p.symbol,
      name: p.symbol,
      market: 'CRYPTO',
      quantity: p.quantity,
      availableQuantity: p.quantity,
      avgCost: p.avgCost,
      leverage: p.leverage,
      side: p.side,
      accumulatedInterest: 0,
    })
    .run()
}

before(() => {
  assert.ok(
    DATABASE_PATH.startsWith(tmpDir),
    `Refusing to run: DATABASE_PATH is not the temp DB (${DATABASE_PATH})`,
  )
  ensureSchema()
})

beforeEach(() => {
  networkCalls.length = 0
})

after(() => {
  assert.deepEqual(networkCalls, [], 'No network calls should have been made')
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('E5 — unrealised P&L of SHORT positions (calcPositionsMarketValue)', () => {
  test('control: LONG 2x, price unchanged -> equity equals posted margin', async () => {
    const acc = createAccount(950)
    createPosition(acc.id, { symbol: 'BTC', side: 'LONG', quantity: 1, avgCost: 100, leverage: 2 })
    cachePrice('BTC', 'CRYPTO', 100)

    approxEqual(await calcPositionsMarketValue(acc.id), 50, 'LONG 2x @100, price 100')
  })

  test('control: SHORT 2x, price unchanged -> equity equals posted margin', async () => {
    const acc = createAccount(950)
    createPosition(acc.id, { symbol: 'ETH', side: 'SHORT', quantity: 1, avgCost: 100, leverage: 2 })
    cachePrice('ETH', 'CRYPTO', 100)

    approxEqual(await calcPositionsMarketValue(acc.id), 50, 'SHORT 2x @100, price 100')
  })

  test('SHORT 2x entry 100, price falls to 90 -> profit +10, equity 50 + 10 = 60', async () => {
    const acc = createAccount(950)
    createPosition(acc.id, { symbol: 'SOL', side: 'SHORT', quantity: 1, avgCost: 100, leverage: 2 })
    cachePrice('SOL', 'CRYPTO', 90)

    approxEqual(await calcPositionsMarketValue(acc.id), 60, 'SHORT 2x @100, price 90')
  })

  test('SHORT 2x entry 100, price rises to 110 -> loss -10, equity 50 - 10 = 40', async () => {
    const acc = createAccount(950)
    createPosition(acc.id, { symbol: 'XRP', side: 'SHORT', quantity: 1, avgCost: 100, leverage: 2 })
    cachePrice('XRP', 'CRYPTO', 110)

    approxEqual(await calcPositionsMarketValue(acc.id), 40, 'SHORT 2x @100, price 110')
  })

  test('LONG 2x entry 100, price rises to 110 -> margin 50 + profit 10 = 60', async () => {
    const acc = createAccount(950)
    createPosition(acc.id, { symbol: 'LTC', side: 'LONG', quantity: 1, avgCost: 100, leverage: 2 })
    cachePrice('LTC', 'CRYPTO', 110)

    approxEqual(await calcPositionsMarketValue(acc.id), 60, 'LONG 2x @100, price 110')
  })

  test('SHORT 1x entry 100, price falls to 90 -> equity 100 + 10 = 110', async () => {
    const acc = createAccount(900)
    createPosition(acc.id, { symbol: 'DOGE', side: 'SHORT', quantity: 1, avgCost: 100, leverage: 1 })
    cachePrice('DOGE', 'CRYPTO', 90)

    approxEqual(await calcPositionsMarketValue(acc.id), 110, 'SHORT 1x @100, price 90')
  })
})

describe('E6 — total assets reported to the AI (getPortfolioData)', () => {
  test('LONG 10x, 1 BNB @1000, price unchanged, cash 900 -> total assets 1000', async () => {
    // Account started with 1000, posted 100 margin for a 1000 notional at 10x.
    const acc = createAccount(900, 100)
    createPosition(acc.id, { symbol: 'BNB', side: 'LONG', quantity: 1, avgCost: 1000, leverage: 10 })
    cachePrice('BNB', 'CRYPTO', 1000)

    const portfolio = await getPortfolioData(acc)
    approxEqual(portfolio.total_assets, 1000, 'portfolio.total_assets')
  })

  test('control: no positions, cash 1000 -> total assets 1000', async () => {
    const acc = createAccount(1000)
    const portfolio = await getPortfolioData(acc)
    approxEqual(portfolio.total_assets, 1000, 'portfolio.total_assets')
  })
})
