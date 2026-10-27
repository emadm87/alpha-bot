/**
 * Databases created before Task 006I-1: accounts without `cost_model`,
 * trades without `fee_rate`. ensureSchema adds both without touching rows:
 * every existing account becomes 'original' (and stays so), older fills keep
 * fee_rate NULL, and the pilot report reads the database before and after.
 *
 * Run: npx tsx --test src/services/costModelMigration.test.ts
 *
 * Throwaway SQLite file with the accounts, trades, orders, positions and
 * ai_decision_logs tables as in the original schema (main 15d47c1), one open BTC LONG 2x of 500 USDC booked as
 * the original engine books it; prices injected into the price cache.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-model-migration-test-'))
const dbFile = path.join(tmpDir, 'test.db')
const beforeCopy = path.join(tmpDir, 'before.db')
{
  const old = new Database(dbFile)
  old.exec(`
CREATE TABLE accounts (
	id INTEGER NOT NULL, user_id INTEGER NOT NULL, version VARCHAR(100) NOT NULL, name VARCHAR(100) NOT NULL,
	account_type VARCHAR(20) NOT NULL, is_active VARCHAR(10) NOT NULL, model VARCHAR(100), base_url VARCHAR(500),
	api_key VARCHAR(500), initial_capital DECIMAL(18, 2) NOT NULL, current_cash DECIMAL(18, 2) NOT NULL,
	frozen_cash DECIMAL(18, 2) NOT NULL, margin_used DECIMAL(18, 2) NOT NULL, maintenance_margin_ratio FLOAT NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id)
);
CREATE TABLE trades (
	id INTEGER NOT NULL, order_id INTEGER NOT NULL, account_id INTEGER NOT NULL, symbol VARCHAR(20) NOT NULL,
	name VARCHAR(100) NOT NULL, market VARCHAR(10) NOT NULL, side VARCHAR(10) NOT NULL, price DECIMAL(18, 6) NOT NULL,
	quantity DECIMAL(18, 8) NOT NULL, commission DECIMAL(18, 6) NOT NULL, taker_fee DECIMAL(18, 6) NOT NULL,
	interest_charged DECIMAL(18, 6) NOT NULL, trade_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id)
);
CREATE TABLE orders (
	id INTEGER NOT NULL, version VARCHAR(100) NOT NULL, account_id INTEGER NOT NULL, order_no VARCHAR(32) NOT NULL,
	symbol VARCHAR(20) NOT NULL, name VARCHAR(100) NOT NULL, market VARCHAR(10) NOT NULL, side VARCHAR(10) NOT NULL,
	order_type VARCHAR(20) NOT NULL, price FLOAT, quantity FLOAT NOT NULL, leverage INTEGER NOT NULL,
	filled_quantity FLOAT NOT NULL, status VARCHAR(20) NOT NULL, order_time DATETIME,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id), UNIQUE (order_no)
);
CREATE TABLE positions (
	id INTEGER NOT NULL, version VARCHAR(100) NOT NULL, account_id INTEGER NOT NULL, symbol VARCHAR(20) NOT NULL,
	name VARCHAR(100) NOT NULL, market VARCHAR(10) NOT NULL, quantity DECIMAL(18, 8) NOT NULL,
	available_quantity DECIMAL(18, 8) NOT NULL, avg_cost DECIMAL(18, 6) NOT NULL, leverage INTEGER NOT NULL,
	side VARCHAR(10), accumulated_interest DECIMAL(18, 6) NOT NULL, last_interest_time DATETIME, update_time DATETIME,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id)
);
CREATE TABLE ai_decision_logs (
	id INTEGER NOT NULL, account_id INTEGER NOT NULL, decision_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	reason VARCHAR(1000) NOT NULL, operation VARCHAR(10) NOT NULL, symbol VARCHAR(20), prev_portion DECIMAL(10, 6) NOT NULL,
	target_portion DECIMAL(10, 6) NOT NULL, total_balance DECIMAL(18, 2) NOT NULL, executed VARCHAR(10) NOT NULL,
	order_id INTEGER, leverage INTEGER NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id)
);
INSERT INTO accounts VALUES (1, 1, 'v1', 'old', 'AI', 'false', 'm', 'u', 'default', 1000, 749.65, 0, 250, 0.5, NULL, NULL);
INSERT INTO orders VALUES (1, 'v1', 1, 'OLD0000000000001', 'BTC', 'BTC', 'CRYPTO', 'LONG', 'MARKET', 80000, 0.00625, 2, 0.00625, 'FILLED', NULL, NULL, NULL);
INSERT INTO trades VALUES (1, 1, 1, 'BTC', 'BTC', 'CRYPTO', 'LONG', 80000, 0.00625, 0.35, 0.35, 0, CURRENT_TIMESTAMP);
INSERT INTO positions VALUES (1, 'v1', 1, 'BTC', 'BTC', 'CRYPTO', 0.00625, 0.00625, 80000, 2, 'LONG', 0, NULL, NULL, NULL, NULL);
`)
  old.close()
  fs.copyFileSync(dbFile, beforeCopy)
}
process.env.DATABASE_PATH = dbFile
process.env.LOG_LEVEL = 'error'
delete process.env.ALPHA_COST_MODEL
console.error = () => {}
globalThis.fetch = (() => {
  throw new Error('network disabled in tests')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../db/client.js')
const { accounts, trades } = await import('../db/schema.js')
const { eq } = await import('drizzle-orm')
const { cachePrice } = await import('./priceCache.js')
const { placeAndExecuteCrypto } = await import('./orderExecutorLeverage.js')
const reportModule = new URL('../../pilot/report.mjs', import.meta.url).href
const { buildReport } = (await import(reportModule)) as { buildReport: (o: Record<string, unknown>) => any }

after(() => {
  rawDb.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('1. the report reads a database written before the cost model', () => {
  const rep = buildReport({ dbFile: beforeCopy, accountId: 1, prices: { BTC: 80000 } })
  assert.deepEqual(rep.issues, [])
  assert.equal(rep.reconciliation.ok, true)
  assert.equal(rep.cost_model.model, 'original')
  assert.deepEqual(rep.cost_model.fee_rates_applied, [0.0007])
  assert.ok(Math.abs(rep.if_closed.closing_fees_estimated - 0.35) < 1e-9)
})

test('2. migration: old account becomes original, old fill keeps fee_rate NULL, idempotent', () => {
  ensureSchema()
  ensureSchema()
  const acc = db.select().from(accounts).where(eq(accounts.id, 1)).get()!
  assert.equal(acc.costModel, 'original')
  assert.deepEqual([acc.currentCash, acc.marginUsed], [749.65, 250], 'balances untouched')
  assert.equal(db.select().from(trades).where(eq(trades.id, 1)).get()!.feeRate, null)
  assert.throws(() => rawDb.prepare("UPDATE accounts SET cost_model = 'hyperliquid' WHERE id = 1").run(), /cannot be changed/)
  assert.throws(() => rawDb.prepare("INSERT INTO accounts (user_id, version, name, account_type, is_active, initial_capital, current_cash, frozen_cash, margin_used, maintenance_margin_ratio, cost_model) VALUES (1, 'v1', 'x', 'AI', 'false', 1, 1, 0, 0, 0.5, 'binance')").run(), /CHECK/)
})

test('3. the old position closes under the original rules; the report reconciles', async () => {
  cachePrice('BTC', 'CRYPTO', 80000)
  await placeAndExecuteCrypto({
    account: db.select().from(accounts).where(eq(accounts.id, 1)).get()!,
    symbol: 'BTC', name: 'BTC', side: 'SELL', orderType: 'MARKET', price: null, quantity: 0.00625, leverage: 2,
  })
  const close = db.select().from(trades).where(eq(trades.id, 2)).get()!
  assert.equal(close.feeRate, 0.0007)
  assert.ok(Math.abs(close.commission - 0.35) < 1e-12)
  const acc = db.select().from(accounts).where(eq(accounts.id, 1)).get()!
  assert.ok(Math.abs(acc.currentCash - (1000 - 0.7)) < 1e-9, `cash ${acc.currentCash}`)
  assert.equal(acc.marginUsed, 0)
  const rep = buildReport({ dbFile, accountId: 1, prices: { BTC: 80000 } })
  assert.deepEqual(rep.issues, [])
  assert.equal(rep.reconciliation.ok, true)
  assert.ok(Math.abs(rep.pnl.fees - 0.7) < 1e-9)
})
