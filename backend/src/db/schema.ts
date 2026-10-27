/**
 * Drizzle table definitions.
 *
 * These mirror the SQLite schema originally produced by SQLAlchemy
 * (see `ensureSchema()` in ./client.ts, which owns the actual DDL).
 * Drizzle is used here purely for typed queries — we never emit DDL from it,
 * so the on-disk schema stays byte-identical to what the Python app created.
 *
 * Type mapping notes:
 *  - DECIMAL(p,s) / FLOAT -> real(). SQLite has no true DECIMAL, and the
 *    Python code converted every read through float(), so this is equivalent.
 *  - TIMESTAMP / DATETIME / DATE -> text(). Existing rows hold naive-UTC
 *    strings ('YYYY-MM-DD HH:MM:SS[.ffffff]'); keeping them as text preserves
 *    round-tripping with the data already in data.db.
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const createdAt = () =>
  text('created_at').default(sql`CURRENT_TIMESTAMP`)
const updatedAt = () =>
  text('updated_at').default(sql`CURRENT_TIMESTAMP`)

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    email: text('email'),
    passwordHash: text('password_hash'),
    isActive: text('is_active').notNull().default('true'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_users_id').on(t.id),
  }),
)

export const accounts = sqliteTable(
  'accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    version: text('version').notNull().default('v1'),
    name: text('name').notNull(),
    accountType: text('account_type').notNull().default('AI'),
    isActive: text('is_active').notNull().default('true'),
    model: text('model').default('gpt-4'),
    baseUrl: text('base_url').default('https://api.openai.com/v1'),
    apiKey: text('api_key'),
    initialCapital: real('initial_capital').notNull().default(10000),
    currentCash: real('current_cash').notNull().default(10000),
    frozenCash: real('frozen_cash').notNull().default(0),
    marginUsed: real('margin_used').notNull().default(0),
    maintenanceMarginRatio: real('maintenance_margin_ratio')
      .notNull()
      .default(0.5),
    /**
     * Economic rules of the simulation, fixed when the account is created
     * (a database trigger refuses any change): 'original' (the author's) or
     * 'hyperliquid' (only the perpetual taker fee so far). See COST_MODELS.
     */
    costModel: text('cost_model').notNull().default('original'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_accounts_id').on(t.id),
  }),
)

export const userAuthSessions = sqliteTable(
  'user_auth_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    sessionToken: text('session_token').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    tokenIdx: uniqueIndex('ix_user_auth_sessions_session_token').on(
      t.sessionToken,
    ),
    idIdx: index('ix_user_auth_sessions_id').on(t.id),
  }),
)

export const positions = sqliteTable(
  'positions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    version: text('version').notNull().default('v1'),
    accountId: integer('account_id').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull(),
    quantity: real('quantity').notNull().default(0),
    availableQuantity: real('available_quantity').notNull().default(0),
    avgCost: real('avg_cost').notNull().default(0),
    /** Weighted-average leverage across the fills that built this position. */
    leverage: integer('leverage').notNull().default(1),
    /**
     * Margin actually posted for the open quantity (USDC). NULL for spot rows
     * and for rows written before it existed (see positionMargin).
     */
    margin: real('margin'),
    /** 'LONG' | 'SHORT' for leveraged positions. */
    side: text('side'),
    accumulatedInterest: real('accumulated_interest').notNull().default(0),
    lastInterestTime: text('last_interest_time'),
    updateTime: text('update_time'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_positions_id').on(t.id),
  }),
)

export const orders = sqliteTable(
  'orders',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    version: text('version').notNull().default('v1'),
    accountId: integer('account_id').notNull(),
    orderNo: text('order_no').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull().default('CRYPTO'),
    side: text('side').notNull(),
    orderType: text('order_type').notNull(),
    price: real('price'),
    quantity: real('quantity').notNull(),
    /** 1 for spot, >1 for leverage. */
    leverage: integer('leverage').notNull().default(1),
    filledQuantity: real('filled_quantity').notNull().default(0),
    status: text('status').notNull(),
    orderTime: text('order_time'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_orders_id').on(t.id),
  }),
)

export const trades = sqliteTable(
  'trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orderId: integer('order_id').notNull(),
    accountId: integer('account_id').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    market: text('market').notNull().default('CRYPTO'),
    side: text('side').notNull(),
    price: real('price').notNull(),
    quantity: real('quantity').notNull(),
    commission: real('commission').notNull().default(0),
    /** Open/close taker fee. */
    takerFee: real('taker_fee').notNull().default(0),
    /** Interest realised by this particular fill. */
    interestCharged: real('interest_charged').notNull().default(0),
    /** Fee rate the engine applied to this fill; NULL for older or manual fills. */
    feeRate: real('fee_rate'),
    tradeTime: text('trade_time').default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    idIdx: index('ix_trades_id').on(t.id),
  }),
)

/**
 * Hourly funding of the 'hyperliquid' cost model (Task 006I-2): one row per
 * account, coin and funding hour in which the account held a perpetual.
 * `amount` is the cash change (+ received, - paid); rows that could not be
 * settled keep amount 0 and say why in `status`.
 */
export const fundingPayments = sqliteTable(
  'funding_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    symbol: text('symbol').notNull(),
    /** Funding hour, ms since epoch (a multiple of one hour). */
    fundingTime: integer('funding_time').notNull(),
    /** 'settled' | 'missing_oracle' | 'missing_rate' */
    status: text('status').notNull(),
    side: text('side').notNull(),
    /** Position size held at the funding hour. */
    quantity: real('quantity').notNull(),
    oraclePrice: real('oracle_price'),
    /** When the oracle price was received, ms since epoch. */
    oracleReceivedAt: integer('oracle_received_at'),
    /** Hourly funding rate from Hyperliquid's fundingHistory. */
    fundingRate: real('funding_rate'),
    /** `time` of that fundingHistory entry, ms since epoch. */
    rateTime: integer('rate_time'),
    amount: real('amount').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => ({
    idIdx: index('ix_funding_payments_id').on(t.id),
  }),
)

/**
 * Liquidations decided by the Hyperliquid cross margin rule (Task 006I-3):
 * the account value and maintenance margin at mark that triggered them and
 * the orders that closed the positions. The 'original' monitor writes none.
 */
export const liquidationEvents = sqliteTable('liquidation_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull(),
  /** ms since epoch */
  triggeredAt: integer('triggered_at').notNull(),
  collateral: real('collateral').notNull(),
  accountValue: real('account_value').notNull(),
  maintenanceMargin: real('maintenance_margin').notNull(),
  /** 1 when account value < 2/3 of maintenance (Hyperliquid's backstop level). */
  belowBackstop: integer('below_backstop').notNull(),
  /** JSON: { coin: mark price } used for the decision. */
  marks: text('marks').notNull(),
  /** JSON: positions at mark with their maintenance margin. */
  positions: text('positions').notNull(),
  /** JSON: order numbers of the LIQ- closes. */
  orders: text('orders').notNull(),
  /** How the positions were closed, with its approximation. */
  execution: text('execution').notNull(),
})

/**
 * Fills of the 'hyperliquid' cost model against an `l2Book` snapshot
 * (Task 006I-5): one row per order, with the snapshot it used.
 */
export const bookFills = sqliteTable('book_fills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: integer('order_id').notNull(),
  accountId: integer('account_id').notNull(),
  symbol: text('symbol').notNull(),
  /** 'buy' (fills on the asks) or 'sell' (on the bids). */
  bookSide: text('book_side').notNull(),
  /** Size sent to the book (after lot rounding). */
  requestedQuantity: real('requested_quantity').notNull(),
  filledQuantity: real('filled_quantity').notNull(),
  /** Volume-weighted average fill price. */
  avgPrice: real('avg_price').notNull(),
  notional: real('notional').notNull(),
  bestBid: real('best_bid').notNull(),
  bestAsk: real('best_ask').notNull(),
  mid: real('mid').notNull(),
  /** IOC limit price (market order slippage bound); null for liquidations. */
  limitPrice: real('limit_price'),
  /** Snapshot time from Hyperliquid and local receipt time, ms since epoch. */
  bookTime: integer('book_time').notNull(),
  receivedAt: integer('received_at').notNull(),
  /** JSON [{ px, sz }] of the levels taken. */
  levels: text('levels').notNull(),
  /** 'filled' or 'partial' (IOC: the rest is cancelled). */
  status: text('status').notNull(),
})

/** Oracle prices captured live right after each funding hour (Task 006I-2). */
export const fundingOraclePrices = sqliteTable('funding_oracle_prices', {
  fundingTime: integer('funding_time').notNull(),
  symbol: text('symbol').notNull(),
  oraclePrice: real('oracle_price').notNull(),
  receivedAt: integer('received_at').notNull(),
})

export const tradingConfigs = sqliteTable(
  'trading_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    version: text('version').notNull().default('v1'),
    market: text('market').notNull(),
    minCommission: real('min_commission').notNull(),
    commissionRate: real('commission_rate').notNull(),
    exchangeRate: real('exchange_rate').notNull().default(1),
    minOrderQuantity: integer('min_order_quantity').notNull().default(1),
    lotSize: integer('lot_size').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_trading_configs_id').on(t.id),
  }),
)

export const systemConfigs = sqliteTable(
  'system_configs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    value: text('value'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    idIdx: index('ix_system_configs_id').on(t.id),
  }),
)

export const cryptoPrices = sqliteTable(
  'crypto_prices',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    market: text('market').notNull().default('CRYPTO'),
    price: real('price').notNull(),
    /** 'YYYY-MM-DD' */
    priceDate: text('price_date').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    symbolIdx: index('ix_crypto_prices_symbol').on(t.symbol),
    dateIdx: index('ix_crypto_prices_price_date').on(t.priceDate),
    idIdx: index('ix_crypto_prices_id').on(t.id),
  }),
)

export const cryptoKlines = sqliteTable(
  'crypto_klines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    symbol: text('symbol').notNull(),
    market: text('market').notNull().default('CRYPTO'),
    /** 1m, 5m, 15m, 30m, 1h, 1d */
    period: text('period').notNull(),
    timestamp: integer('timestamp').notNull(),
    datetimeStr: text('datetime_str').notNull(),
    openPrice: real('open_price'),
    highPrice: real('high_price'),
    lowPrice: real('low_price'),
    closePrice: real('close_price'),
    volume: real('volume'),
    amount: real('amount'),
    change: real('change'),
    percent: real('percent'),
    createdAt: createdAt(),
  },
  (t) => ({
    timestampIdx: index('ix_crypto_klines_timestamp').on(t.timestamp),
    symbolIdx: index('ix_crypto_klines_symbol').on(t.symbol),
    idIdx: index('ix_crypto_klines_id').on(t.id),
  }),
)

export const aiDecisionLogs = sqliteTable(
  'ai_decision_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull(),
    decisionTime: text('decision_time').default(sql`CURRENT_TIMESTAMP`),
    reason: text('reason').notNull(),
    /** open | close | hold */
    operation: text('operation').notNull(),
    symbol: text('symbol'),
    prevPortion: real('prev_portion').notNull().default(0),
    targetPortion: real('target_portion').notNull(),
    totalBalance: real('total_balance').notNull(),
    executed: text('executed').notNull().default('false'),
    orderId: integer('order_id'),
    leverage: integer('leverage').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => ({
    idIdx: index('ix_ai_decision_logs_id').on(t.id),
    decisionTimeIdx: index('ix_ai_decision_logs_decision_time').on(
      t.decisionTime,
    ),
  }),
)

export type User = typeof users.$inferSelect
export type Account = typeof accounts.$inferSelect
export type Position = typeof positions.$inferSelect
export type Order = typeof orders.$inferSelect
export type Trade = typeof trades.$inferSelect
export type TradingConfig = typeof tradingConfigs.$inferSelect
export type SystemConfig = typeof systemConfigs.$inferSelect
export type CryptoPrice = typeof cryptoPrices.$inferSelect
export type CryptoKline = typeof cryptoKlines.$inferSelect
export type AIDecisionLog = typeof aiDecisionLogs.$inferSelect

/** CRYPTO market trading configuration constants */
export const CRYPTO_MIN_COMMISSION = 0.1
export const CRYPTO_COMMISSION_RATE = 0.001
export const CRYPTO_MIN_ORDER_QUANTITY = 0.0001
export const CRYPTO_LOT_SIZE = 0.0001

/** Leverage trading constants (Hyperliquid-style) */
export const CRYPTO_TAKER_FEE_RATE = 0.0007
/**
 * Hyperliquid perpetual taker fee at the base tier (14-day volume below 5M
 * USD, no staking or referral discount):
 * https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 * An explicit assumption, not every user's rate.
 */
export const HL_PERP_TAKER_FEE_RATE = 0.00045
export const CRYPTO_INTEREST_RATE_HOURLY = 0.0000125
export const CRYPTO_MAX_LEVERAGE = 50
export const CRYPTO_MAINTENANCE_MARGIN_RATIO = 0.5

/** Economic rules an account can be created with. */
export const COST_MODELS = ['original', 'hyperliquid'] as const
export type CostModel = (typeof COST_MODELS)[number]
export const DEFAULT_COST_MODEL: CostModel = 'original'

/** Taker fee rate of the perpetual engine under a cost model. */
export function takerFeeRate(costModel: string): number {
  if (costModel === 'hyperliquid') return HL_PERP_TAKER_FEE_RATE
  if (costModel === 'original') return CRYPTO_TAKER_FEE_RATE
  throw new Error(`Unknown cost model: ${costModel}`)
}
