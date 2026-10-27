/**
 * Database connection + schema bootstrap.
 *
 * Replaces `database/connection.py`. Exposes a single synchronous Drizzle
 * handle (`db`) which plays the role SessionLocal did in the Python code —
 * better-sqlite3 is synchronous, so repositories and services stay sync.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Mirrors the Python `sqlite:///./data.db` living next to the app root. */
export const DATABASE_PATH =
  process.env.DATABASE_PATH ?? path.resolve(here, '../../data.db')

const sqlite = new Database(DATABASE_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export const rawDb = sqlite

/**
 * Creates any missing tables/indexes.
 *
 * This DDL is a verbatim copy of what SQLAlchemy's `Base.metadata.create_all`
 * emitted, so a fresh database is byte-identical to one created by the old
 * Python app and an existing data.db is left completely untouched.
 */
export function ensureSchema(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
	id INTEGER NOT NULL,
	username VARCHAR(50) NOT NULL,
	email VARCHAR(100),
	password_hash VARCHAR(255),
	is_active VARCHAR(10) NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE (username),
	UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS ix_users_id ON users (id);

CREATE TABLE IF NOT EXISTS trading_configs (
	id INTEGER NOT NULL,
	version VARCHAR(100) NOT NULL,
	market VARCHAR(10) NOT NULL,
	min_commission FLOAT NOT NULL,
	commission_rate FLOAT NOT NULL,
	exchange_rate FLOAT NOT NULL,
	min_order_quantity INTEGER NOT NULL,
	lot_size INTEGER NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE (market, version)
);
CREATE INDEX IF NOT EXISTS ix_trading_configs_id ON trading_configs (id);

CREATE TABLE IF NOT EXISTS system_configs (
	id INTEGER NOT NULL,
	"key" VARCHAR(100) NOT NULL,
	value VARCHAR(5000),
	description VARCHAR(500),
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE ("key")
);
CREATE INDEX IF NOT EXISTS ix_system_configs_id ON system_configs (id);

CREATE TABLE IF NOT EXISTS crypto_prices (
	id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	market VARCHAR(10) NOT NULL,
	price DECIMAL(18, 6) NOT NULL,
	price_date DATE NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE (symbol, market, price_date)
);
CREATE INDEX IF NOT EXISTS ix_crypto_prices_symbol ON crypto_prices (symbol);
CREATE INDEX IF NOT EXISTS ix_crypto_prices_price_date ON crypto_prices (price_date);
CREATE INDEX IF NOT EXISTS ix_crypto_prices_id ON crypto_prices (id);

CREATE TABLE IF NOT EXISTS crypto_klines (
	id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	market VARCHAR(10) NOT NULL,
	period VARCHAR(10) NOT NULL,
	timestamp INTEGER NOT NULL,
	datetime_str VARCHAR(50) NOT NULL,
	open_price DECIMAL(18, 6),
	high_price DECIMAL(18, 6),
	low_price DECIMAL(18, 6),
	close_price DECIMAL(18, 6),
	volume DECIMAL(18, 2),
	amount DECIMAL(18, 2),
	change DECIMAL(18, 6),
	percent DECIMAL(10, 4),
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	UNIQUE (symbol, market, period, timestamp)
);
CREATE INDEX IF NOT EXISTS ix_crypto_klines_timestamp ON crypto_klines (timestamp);
CREATE INDEX IF NOT EXISTS ix_crypto_klines_symbol ON crypto_klines (symbol);
CREATE INDEX IF NOT EXISTS ix_crypto_klines_id ON crypto_klines (id);

CREATE TABLE IF NOT EXISTS accounts (
	id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	version VARCHAR(100) NOT NULL,
	name VARCHAR(100) NOT NULL,
	account_type VARCHAR(20) NOT NULL,
	is_active VARCHAR(10) NOT NULL,
	model VARCHAR(100),
	base_url VARCHAR(500),
	api_key VARCHAR(500),
	initial_capital DECIMAL(18, 2) NOT NULL,
	current_cash DECIMAL(18, 2) NOT NULL,
	frozen_cash DECIMAL(18, 2) NOT NULL,
	margin_used DECIMAL(18, 2) NOT NULL,
	maintenance_margin_ratio FLOAT NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE INDEX IF NOT EXISTS ix_accounts_id ON accounts (id);

CREATE TABLE IF NOT EXISTS user_auth_sessions (
	id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	session_token VARCHAR(64) NOT NULL,
	expires_at DATETIME NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_user_auth_sessions_session_token ON user_auth_sessions (session_token);
CREATE INDEX IF NOT EXISTS ix_user_auth_sessions_id ON user_auth_sessions (id);

CREATE TABLE IF NOT EXISTS positions (
	id INTEGER NOT NULL,
	version VARCHAR(100) NOT NULL,
	account_id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	name VARCHAR(100) NOT NULL,
	market VARCHAR(10) NOT NULL,
	quantity DECIMAL(18, 8) NOT NULL,
	available_quantity DECIMAL(18, 8) NOT NULL,
	avg_cost DECIMAL(18, 6) NOT NULL,
	leverage INTEGER NOT NULL,
	side VARCHAR(10),
	accumulated_interest DECIMAL(18, 6) NOT NULL,
	last_interest_time DATETIME,
	update_time DATETIME,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX IF NOT EXISTS ix_positions_id ON positions (id);

CREATE TABLE IF NOT EXISTS orders (
	id INTEGER NOT NULL,
	version VARCHAR(100) NOT NULL,
	account_id INTEGER NOT NULL,
	order_no VARCHAR(32) NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	name VARCHAR(100) NOT NULL,
	market VARCHAR(10) NOT NULL,
	side VARCHAR(10) NOT NULL,
	order_type VARCHAR(20) NOT NULL,
	price FLOAT,
	quantity FLOAT NOT NULL,
	leverage INTEGER NOT NULL,
	filled_quantity FLOAT NOT NULL,
	status VARCHAR(20) NOT NULL,
	order_time DATETIME,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(account_id) REFERENCES accounts (id),
	UNIQUE (order_no)
);
CREATE INDEX IF NOT EXISTS ix_orders_id ON orders (id);

CREATE TABLE IF NOT EXISTS trades (
	id INTEGER NOT NULL,
	order_id INTEGER NOT NULL,
	account_id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	name VARCHAR(100) NOT NULL,
	market VARCHAR(10) NOT NULL,
	side VARCHAR(10) NOT NULL,
	price DECIMAL(18, 6) NOT NULL,
	quantity DECIMAL(18, 8) NOT NULL,
	commission DECIMAL(18, 6) NOT NULL,
	taker_fee DECIMAL(18, 6) NOT NULL,
	interest_charged DECIMAL(18, 6) NOT NULL,
	trade_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(order_id) REFERENCES orders (id),
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX IF NOT EXISTS ix_trades_id ON trades (id);

CREATE TABLE IF NOT EXISTS ai_decision_logs (
	id INTEGER NOT NULL,
	account_id INTEGER NOT NULL,
	decision_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	reason VARCHAR(1000) NOT NULL,
	operation VARCHAR(10) NOT NULL,
	symbol VARCHAR(20),
	prev_portion DECIMAL(10, 6) NOT NULL,
	target_portion DECIMAL(10, 6) NOT NULL,
	total_balance DECIMAL(18, 2) NOT NULL,
	executed VARCHAR(10) NOT NULL,
	order_id INTEGER,
	leverage INTEGER NOT NULL,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(account_id) REFERENCES accounts (id),
	FOREIGN KEY(order_id) REFERENCES orders (id)
);
CREATE INDEX IF NOT EXISTS ix_ai_decision_logs_id ON ai_decision_logs (id);
CREATE INDEX IF NOT EXISTS ix_ai_decision_logs_decision_time ON ai_decision_logs (decision_time);
`)

  // Posted margin per position, added after the original schema: databases
  // created before it get the nullable column, existing rows keep NULL.
  const positionColumns = sqlite.prepare('PRAGMA table_info(positions)').all() as { name: string }[]
  if (!positionColumns.some((c) => c.name === 'margin')) {
    sqlite.exec('ALTER TABLE positions ADD COLUMN margin REAL')
  }

  // Cost model per account (Task 006I-1): existing accounts become
  // 'original'; once set it cannot change, so a run never mixes two models.
  const accountColumns = sqlite.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]
  if (!accountColumns.some((c) => c.name === 'cost_model')) {
    sqlite.exec(
      "ALTER TABLE accounts ADD COLUMN cost_model VARCHAR(20) NOT NULL DEFAULT 'original' " +
        "CHECK (cost_model IN ('original', 'hyperliquid'))",
    )
  }
  sqlite.exec(`
CREATE TRIGGER IF NOT EXISTS accounts_cost_model_immutable
BEFORE UPDATE OF cost_model ON accounts
WHEN NEW.cost_model IS NOT OLD.cost_model
BEGIN
  SELECT RAISE(ABORT, 'cost_model cannot be changed after the account is created');
END;
`)

  // Hourly funding of the 'hyperliquid' cost model (Task 006I-2): at most one
  // row per account, coin and funding hour, so a payment is never made twice.
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS funding_payments (
	id INTEGER NOT NULL,
	account_id INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	funding_time INTEGER NOT NULL,
	status VARCHAR(20) NOT NULL CHECK (status IN ('settled', 'missing_oracle', 'missing_rate')),
	side VARCHAR(10) NOT NULL,
	quantity FLOAT NOT NULL,
	oracle_price FLOAT,
	oracle_received_at INTEGER,
	funding_rate FLOAT,
	rate_time INTEGER,
	amount FLOAT NOT NULL DEFAULT 0,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (id),
	FOREIGN KEY(account_id) REFERENCES accounts (id),
	UNIQUE (account_id, symbol, funding_time)
);
CREATE INDEX IF NOT EXISTS ix_funding_payments_id ON funding_payments (id);
CREATE TABLE IF NOT EXISTS funding_oracle_prices (
	funding_time INTEGER NOT NULL,
	symbol VARCHAR(20) NOT NULL,
	oracle_price FLOAT NOT NULL,
	received_at INTEGER NOT NULL,
	PRIMARY KEY (funding_time, symbol)
);
`)

  // Fee rate the engine applied to each fill; older and manual fills keep NULL.
  const tradeColumns = sqlite.prepare('PRAGMA table_info(trades)').all() as { name: string }[]
  if (!tradeColumns.some((c) => c.name === 'fee_rate')) {
    sqlite.exec('ALTER TABLE trades ADD COLUMN fee_rate REAL')
  }
}
