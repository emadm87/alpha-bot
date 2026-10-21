/**
 * Deterministic tests for calcAccountEquity and the equity reported to the
 * AI (getPortfolioData) and to the REST overviews.
 *
 * Run: npx tsx --test src/services/accountEquity.test.ts
 *
 * Throwaway SQLite file, prices injected into the real price cache, network
 * blocked. Expected values come from closed-form formulas written here, not
 * from other fork functions:
 *   fee      = 0.0007 * quantity * entry
 *   margin   = quantity * entry / leverage
 *   pnl      = LONG quantity * (price - entry), SHORT quantity * (entry - price)
 *   equity   = capital - fee + pnl
 *   exposure = quantity * price
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'equity-test-'))
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db')
process.env.LOG_LEVEL ??= 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, users } = await import('../db/schema.js')
const { eq, ne } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const { calcAccountEquity, calcPositionsValue } = await import(
  './assetCalculator.js'
)
const { getPortfolioData } = await import('./aiDecision.js')
const { accountRoutes } = await import('../api/account.js')

ensureSchema()
const user = db
  .insert(users)
  .values({ username: 'default', isActive: 'true' })
  .returning()
  .get()

after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const CAPITAL = 1000
const FEE_RATE = 0.0007
const EPS = 1e-9

let seq = 0
function newAccount() {
  return db
    .insert(accounts)
    .values({
      userId: user.id,
      name: `equity-${++seq}`,
      accountType: 'AI',
      apiKey: 'test-placeholder',
      initialCapital: CAPITAL,
      currentCash: CAPITAL,
    })
    .returning()
    .get()
}

const reload = (id: number) =>
  db.select().from(accounts).where(eq(accounts.id, id)).get()!

function close(actual: number, expected: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) < EPS,
    `${what}: actual=${actual} expected=${expected}`,
  )
}

async function openPosition(
  side: 'LONG' | 'SHORT',
  leverage: number,
  quantity: number,
  entry: number,
) {
  const account = newAccount()
  const symbol = `T${seq}`
  cachePrice(symbol, 'CRYPTO', entry)
  await placeAndExecuteCrypto({
    account: reload(account.id),
    symbol,
    name: symbol,
    side,
    orderType: 'MARKET',
    price: null,
    quantity,
    leverage,
  })
  return { id: account.id, symbol }
}

async function restOverview(id: number) {
  const res = await accountRoutes.request(`/${id}/overview`)
  assert.equal(res.status, 200)
  return (await res.json()) as {
    total_assets: number
    positions_value: number
    account: { current_cash: number }
  }
}

for (const side of ['LONG', 'SHORT'] as const) {
  for (const leverage of [1, 3, 5]) {
    test(`${side} ${leverage}x, 5 units @100: equity, margin, exposure`, async (t) => {
      const quantity = 5
      const entry = 100
      const { id, symbol } = await openPosition(side, leverage, quantity, entry)

      const fee = FEE_RATE * quantity * entry
      const margin = (quantity * entry) / leverage
      close(reload(id).currentCash, CAPITAL - margin - fee, 'cash after open')
      // The engine only tracks margin_used for leverage > 1
      close(reload(id).marginUsed, leverage > 1 ? margin : 0, 'engine margin_used')

      for (const price of [100, 110, 90]) {
        cachePrice(symbol, 'CRYPTO', price)
        const pnl =
          side === 'LONG'
            ? quantity * (price - entry)
            : quantity * (entry - price)
        const equity = CAPITAL - fee + pnl
        const exposure = quantity * price

        const account = reload(id)
        const result = await calcAccountEquity(account)
        close(result.equity, equity, `equity @${price}`)
        close(result.postedMargin, margin, `margin @${price}`)
        close(result.unrealizedPnl, pnl, `unrealized P&L @${price}`)
        close(result.exposure, exposure, `exposure @${price}`)
        close(result.positionsEquity, margin + pnl, `positions equity @${price}`)

        const portfolio = await getPortfolioData(account)
        close(portfolio.total_assets, equity, `AI total_assets @${price}`)

        const overview = await restOverview(id)
        close(overview.total_assets, equity, `REST total_assets @${price}`)
        close(
          overview.positions_value,
          equity - account.currentCash,
          `REST positions_value @${price}`,
        )

        const before = account.currentCash + (await calcPositionsValue(id))
        t.diagnostic(
          `price=${price} equity=${equity.toFixed(4)} margin=${margin.toFixed(4)} ` +
            `exposure=${exposure.toFixed(4)} before(cash+qty*price*lev)=${before.toFixed(4)}`,
        )
      }
    })
  }
}

test('equity, margin and exposure are distinct with leverage > 1', async () => {
  const { id, symbol } = await openPosition('LONG', 3, 5, 100)
  cachePrice(symbol, 'CRYPTO', 110)
  const result = await calcAccountEquity(reload(id))
  close(result.equity, CAPITAL - 0.35 + 50, 'equity')
  close(result.postedMargin, 500 / 3, 'margin')
  close(result.exposure, 550, 'exposure')
  assert.notEqual(result.equity, result.exposure)
  assert.notEqual(result.postedMargin, result.exposure)
})

test('Task 004B case: LONG 3x 0.005908 @84621.5, price 84635.5', async () => {
  const quantity = 0.005908
  const entry = 84621.5
  const price = 84635.5
  const { id, symbol } = await openPosition('LONG', 3, quantity, entry)
  cachePrice(symbol, 'CRYPTO', price)

  const equity =
    CAPITAL - FEE_RATE * quantity * entry + quantity * (price - entry)
  const account = reload(id)
  close((await calcAccountEquity(account)).equity, equity, 'equity')
  close((await getPortfolioData(account)).total_assets, equity, 'AI total_assets')
  close((await restOverview(id)).total_assets, equity, 'REST total_assets')
  assert.ok(Math.abs(equity - 999.7327513) < 1e-6, `equity=${equity}`)
})

test('closed rows and leftover margin_used are not counted as equity', async () => {
  // State left by a liquidation through orderMatching: quantity 0, side and
  // leverage kept, margin_used not released.
  const { id, symbol } = await openPosition('LONG', 2, 5, 100)
  db.update(accounts).set({ currentCash: 997 }).where(eq(accounts.id, id)).run()
  rawDb
    .prepare('UPDATE positions SET quantity = 0, available_quantity = 0 WHERE symbol = ?')
    .run(symbol)
  const account = reload(id)
  close(account.marginUsed, 250, 'leftover margin_used')
  const result = await calcAccountEquity(account)
  close(result.equity, 997, 'equity')
  close(result.postedMargin, 0, 'posted margin')
})

test('no positions: equity equals cash', async () => {
  const account = newAccount()
  close((await calcAccountEquity(account)).equity, CAPITAL, 'equity')
  close((await getPortfolioData(account)).total_assets, CAPITAL, 'AI total_assets')
})

test('GET /overview reports the same equity as GET /:id/overview', async () => {
  const { id, symbol } = await openPosition('SHORT', 5, 5, 100)
  cachePrice(symbol, 'CRYPTO', 90)
  db.update(accounts).set({ isActive: 'false' }).where(ne(accounts.id, id)).run()

  const res = await accountRoutes.request('/overview')
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    account: { id: number }
    portfolio: { total_assets: number; positions_value: number }
  }
  assert.equal(body.account.id, id)
  const equity = CAPITAL - 0.35 + 5 * (100 - 90)
  close(body.portfolio.total_assets, equity, 'GET /overview total_assets')
  close((await restOverview(id)).total_assets, equity, 'GET /:id/overview total_assets')
})
