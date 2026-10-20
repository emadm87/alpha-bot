/**
 * REST overview regression tests (Task 003D).
 *
 * Calls the real Hono routes in-process (`accountRoutes.request`), so no
 * server is started and no port is opened. Same offline setup as
 * services/accounting.test.ts:
 *  - DATABASE_PATH points at a throwaway SQLite file in a fresh temp dir,
 *    set before any module opens the DB; only `ensureSchema()` runs (no seed).
 *  - Prices are injected through the real price cache (`cachePrice`).
 *  - `globalThis.fetch` throws, so any accidental network call fails loudly.
 *
 * Scenario: the account started with 1000, posted 100 margin for a LONG 10x
 * of 1 BNB @1000; price unchanged. Equity = 900 cash + 100 margin + 0 P&L.
 *
 * Run with: npx tsx --test src/api/account.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-bot-api-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')

const networkCalls: string[] = []
globalThis.fetch = (async (input: unknown) => {
  networkCalls.push(String(input))
  throw new Error(`Network access is not allowed in tests: ${String(input)}`)
}) as typeof fetch

// Imported after DATABASE_PATH is set so db/client.ts opens the temp file.
const { db, rawDb, ensureSchema, DATABASE_PATH } = await import('../db/client.js')
const { accounts, positions, users } = await import('../db/schema.js')
const { cachePrice } = await import('../services/priceCache.js')
const { accountRoutes } = await import('./account.js')

const EPS = 1e-9

function approxEqual(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${label}: actual=${actual} expected=${expected}`,
  )
}

let accountId: number

before(() => {
  assert.ok(
    DATABASE_PATH.startsWith(tmpDir),
    `Refusing to run: DATABASE_PATH is not the temp DB (${DATABASE_PATH})`,
  )
  ensureSchema()

  const user = db
    .insert(users)
    .values({ username: 'test-rest', isActive: 'true' })
    .returning()
    .get()
  // The only active account, so `/overview` (first active account) picks it.
  const account = db
    .insert(accounts)
    .values({
      userId: user.id,
      version: 'v1',
      name: 'TEST',
      accountType: 'AI',
      isActive: 'true',
      apiKey: null,
      initialCapital: 1000,
      currentCash: 900,
      frozenCash: 0,
      marginUsed: 100,
      maintenanceMarginRatio: 0.5,
    })
    .returning()
    .get()
  accountId = account.id

  db.insert(positions)
    .values({
      version: 'v1',
      accountId,
      symbol: 'BNB',
      name: 'BNB',
      market: 'CRYPTO',
      quantity: 1,
      availableQuantity: 1,
      avgCost: 1000,
      leverage: 10,
      side: 'LONG',
      accumulatedInterest: 0,
    })
    .run()
  cachePrice('BNB', 'CRYPTO', 1000)
})

after(() => {
  assert.deepEqual(networkCalls, [], 'No network calls should have been made')
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('REST overview — total assets (cash 900, LONG 10x with 100 margin)', () => {
  test('GET /overview -> total_assets 1000, positions_value 100', async () => {
    const res = await accountRoutes.request('/overview')
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      account: { id: number }
      portfolio: { total_assets: number; positions_value: number }
    }

    assert.equal(body.account.id, accountId)
    approxEqual(body.portfolio.total_assets, 1000, 'portfolio.total_assets')
    approxEqual(body.portfolio.positions_value, 100, 'portfolio.positions_value')
  })

  test('GET /:accountId/overview -> total_assets 1000, positions_value 100', async () => {
    const res = await accountRoutes.request(`/${accountId}/overview`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      total_assets: number
      positions_value: number
    }

    approxEqual(body.total_assets, 1000, 'total_assets')
    approxEqual(body.positions_value, 100, 'positions_value')
  })
})
