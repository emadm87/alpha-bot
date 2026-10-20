/**
 * AI Decision Service — handles AI model API calls for trading decisions.
 * Port of `services/ai_decision_service.py`.
 */
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  accounts,
  aiDecisionLogs,
  positions as positionsTable,
  type Account,
} from '../db/schema.js'
import { calcPositionsMarketValue } from './assetCalculator.js'
import { fetchLatestNews } from './newsFeed.js'
import { getLogger } from '../utils/logger.js'

const logger = getLogger('services.aiDecision')

/** Demo-mode API keys that should be skipped. */
const DEMO_API_KEYS = new Set([
  'default-key-please-update-in-settings',
  'default',
  '',
])

export const SUPPORTED_SYMBOLS: Record<string, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  DOGE: 'Dogecoin',
  XRP: 'Ripple',
  BNB: 'Binance Coin',
}

export interface PortfolioPosition {
  quantity: number
  avg_cost: number
  current_value: number
  side: string
  leverage: number
}

export interface Portfolio {
  cash: number
  frozen_cash: number
  positions: Record<string, PortfolioPosition>
  total_assets: number
}

export interface AIDecision {
  operation?: string
  symbol?: string
  direction?: string
  target_portion_of_balance?: number
  leverage?: number
  reason?: string
  [key: string]: unknown
}

/** Check if the API key is a default/placeholder key that should be skipped. */
export function isDefaultApiKey(apiKey: string | null | undefined): boolean {
  return apiKey == null || DEMO_API_KEYS.has(apiKey)
}

/** Get current portfolio positions and values. */
export async function getPortfolioData(account: Account): Promise<Portfolio> {
  const rows = db
    .select()
    .from(positionsTable)
    .where(
      and(
        eq(positionsTable.accountId, account.id),
        eq(positionsTable.market, 'CRYPTO'),
      ),
    )
    .all()

  const portfolio: Record<string, PortfolioPosition> = {}
  for (const pos of rows) {
    if (pos.quantity > 0) {
      portfolio[pos.symbol] = {
        quantity: pos.quantity,
        avg_cost: pos.avgCost,
        current_value: pos.quantity * pos.avgCost,
        side: (pos.side ?? 'LONG').toUpperCase(),
        leverage: pos.leverage,
      }
    }
  }

  return {
    cash: account.currentCash,
    frozen_cash: account.frozenCash,
    positions: portfolio,
    total_assets:
      account.currentCash + (await calcPositionsMarketValue(account.id)),
  }
}

function buildPrompt(
  portfolio: Portfolio,
  prices: Record<string, number>,
  newsSection: string,
): string {
  return `You are a cryptocurrency trading AI. Based on the following portfolio and market data, decide on a trading action.

Portfolio Data:
- Cash Available: $${portfolio.cash.toFixed(2)}
- Frozen Cash: $${portfolio.frozen_cash.toFixed(2)}
- Total Assets: $${portfolio.total_assets.toFixed(2)}
- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):
${JSON.stringify(portfolio.positions, null, 2)}

Current Market Prices:
${JSON.stringify(prices, null, 2)}

Latest Crypto News (CoinJournal):
${newsSection}

Analyze the market and portfolio, then respond with ONLY a JSON object in this exact format:
{
  "operation": "open" or "close" or "hold",
  "symbol": "BTC" or "ETH" or "SOL" or "BNB" or "XRP" or "DOGE",
  "direction": "long" or "short",
  "target_portion_of_balance": 0.2,
  "leverage": 3,
  "reason": "Brief explanation of your decision"
}

Rules:
- Only ONE position per coin allowed.
- operation must be "open", "close", or "hold"
- direction must be "long" or "short"
- For "open": Open a new position. You can open LONG (betting price goes up) or SHORT (betting price goes down)
  - symbol: which coin to trade
  - direction: "long" or "short"
  - target_portion_of_balance: % of available cash to use (0.0-1.0)
  - leverage: leverage multiplier (1-10, higher = more risk/reward)
- For "close": Close an existing position
  - symbol: which coin position to close
  - direction: must match the position side you want to close ("long" or "short")
  - target_portion_of_balance: % of position to close (0.0-1.0, use 1.0 to close entire position)
- For "hold": no action taken, direction can be omitted
- IMPORTANT: You can only hold ONE position per coin at a time (either long OR short, not both)
- Before opening a new position, check Current Positions to see if you already have a position on that coin
- You can only close positions that you currently hold (check Current Positions for side: "LONG" or "SHORT")
- leverage is typically 1-10x; only use high leverage (>5x) if you're very confident
- Only choose symbols you have price data for`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Strips markdown code fences the model may have wrapped the JSON in. */
function unwrapCodeFence(text: string): string {
  let content = text.trim()
  if (content.includes('```json')) {
    content = content.split('```json')[1]!.split('```')[0]!.trim()
  } else if (content.includes('```')) {
    const parts = content.split('```')
    if (parts.length > 1) content = parts[1]!.split('```')[0]!.trim()
  }
  return content
}

/**
 * Best-effort recovery from malformed model JSON: normalise smart quotes and
 * whitespace, then fall back to regex extraction of the required fields.
 */
function parseDecisionText(textContent: string): AIDecision {
  try {
    return JSON.parse(textContent) as AIDecision
  } catch (parseErr) {
    logger.warning(`Initial JSON parse failed: ${parseErr}`)
    logger.warning(`Problematic content: ${textContent.slice(0, 200)}...`)

    const cleaned = textContent
      .replace(/[\n\r\t]/g, ' ')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/[–—‑]/g, '-')

    try {
      const decision = JSON.parse(cleaned) as AIDecision
      logger.info('Successfully parsed JSON after cleanup')
      return decision
    } catch {
      logger.error(
        'JSON parsing failed even after cleanup, attempting manual extraction',
      )
      const operation = /"operation":\s*"([^"]+)"/.exec(textContent)
      const symbol = /"symbol":\s*"([^"]+)"/.exec(textContent)
      const direction = /"direction":\s*"([^"]+)"/.exec(textContent)
      const portion = /"target_portion_of_balance":\s*([0-9.]+)/.exec(textContent)
      const leverage = /"leverage":\s*([0-9]+)/.exec(textContent)
      const reason = /"reason":\s*"([^"]*)/.exec(textContent)

      if (operation && symbol && portion) {
        logger.info(
          'Successfully extracted AI decision with direction and leverage manually',
        )
        return {
          operation: operation[1],
          symbol: symbol[1],
          direction: direction ? direction[1]!.toLowerCase() : 'long',
          target_portion_of_balance: Number(portion[1]),
          leverage: leverage ? parseInt(leverage[1]!, 10) : 1,
          reason: reason ? reason[1] : 'AI response parsing issue',
        }
      }
      throw parseErr
    }
  }
}

/** Call the AI model API to get a trading decision. */
export async function callAIForDecision(
  account: Account,
  portfolio: Portfolio,
  prices: Record<string, number>,
): Promise<AIDecision | null> {
  if (isDefaultApiKey(account.apiKey)) {
    logger.info(
      `Skipping AI trading for account ${account.name} - using default API key`,
    )
    return null
  }

  try {
    const newsSummary = await fetchLatestNews()
    const newsSection = newsSummary || 'No recent CoinJournal news available.'
    const prompt = buildPrompt(portfolio, prices, newsSection)

    // Use OpenAI-compatible chat completions format
    const payload = {
      model: account.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1000,
    }

    const baseUrl = (account.baseUrl ?? '').replace(/\/+$/, '')
    const apiEndpoint = `${baseUrl}/chat/completions`

    const maxRetries = 3
    let response: Response | null = null

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${account.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(30_000),
        })

        if (response.status === 200) break

        if (response.status === 429) {
          // Rate limited: exponential backoff with jitter
          const waitTime = 2 ** attempt + Math.random()
          logger.warning(
            `AI API rate limited (attempt ${attempt + 1}/${maxRetries}), waiting ${waitTime.toFixed(1)}s...`,
          )
          if (attempt < maxRetries - 1) {
            await sleep(waitTime * 1000)
            continue
          }
          logger.error(
            `AI API rate limited after ${maxRetries} attempts: ${await response.text()}`,
          )
          return null
        }

        logger.error(
          `AI API returned status ${response.status}: ${await response.text()}`,
        )
        return null
      } catch (reqErr) {
        if (attempt < maxRetries - 1) {
          const waitTime = 2 ** attempt + Math.random()
          logger.warning(
            `AI API request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${waitTime.toFixed(1)}s: ${reqErr}`,
          )
          await sleep(waitTime * 1000)
          continue
        }
        logger.error(
          `AI API request failed after ${maxRetries} attempts: ${reqErr}`,
        )
        return null
      }
    }

    if (!response || response.status !== 200) return null

    const result = (await response.json()) as Record<string, any>

    const choices = result.choices
    if (!Array.isArray(choices) || choices.length === 0) {
      logger.error(`Unexpected AI response format: ${JSON.stringify(result)}`)
      return null
    }

    const choice = choices[0]
    const message = choice?.message ?? {}
    const finishReason = choice?.finish_reason ?? ''

    // Some models put partial content in `reasoning` when truncated.
    let textContent: string
    if (finishReason === 'length') {
      logger.warning(
        'AI response was truncated due to token limit. Consider increasing max_tokens.',
      )
      textContent = message.reasoning || message.content || ''
    } else {
      textContent = message.content || ''
    }

    if (!textContent) {
      logger.error(`Empty content in AI response: ${JSON.stringify(result)}`)
      return null
    }

    const decision = parseDecisionText(unwrapCodeFence(textContent))

    if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
      logger.error(`AI response is not an object: ${typeof decision}`)
      return null
    }

    logger.info(
      `AI decision for ${account.name}: ${JSON.stringify(decision)}`,
    )

    // Normalise leverage / direction, filling defaults when absent.
    if (!decision.leverage) decision.leverage = 1
    decision.direction = decision.direction
      ? String(decision.direction).toLowerCase()
      : 'long'

    return decision
  } catch (err) {
    logger.error(`Unexpected error calling AI: ${err}`)
    return null
  }
}

/** Save AI decision to the decision log. */
export function saveAIDecision(
  account: Account,
  decision: AIDecision,
  portfolio: Portfolio,
  executed = false,
  orderId?: number | null,
): void {
  try {
    const operation = decision.operation
      ? String(decision.operation).toLowerCase()
      : ''
    const symbol = decision.symbol ? String(decision.symbol).toUpperCase() : null
    const targetPortion =
      decision.target_portion_of_balance != null
        ? Number(decision.target_portion_of_balance)
        : 0.0
    const reason = decision.reason ?? 'No reason provided'

    // Calculate previous portion for the symbol
    let prevPortion = 0.0
    if ((operation === 'close' || operation === 'hold') && symbol) {
      const pos = portfolio.positions[symbol]
      if (pos && portfolio.total_assets > 0) {
        prevPortion = pos.current_value / portfolio.total_assets
      }
    }

    let leverageVal = Number.parseInt(String(decision.leverage ?? 1), 10)
    if (!Number.isFinite(leverageVal) || leverageVal < 1) leverageVal = 1

    db.insert(aiDecisionLogs)
      .values({
        accountId: account.id,
        reason: String(reason),
        operation,
        symbol: operation !== 'hold' ? symbol : null,
        prevPortion,
        targetPortion,
        totalBalance: portfolio.total_assets,
        executed: executed ? 'true' : 'false',
        orderId: orderId ?? null,
        leverage: leverageVal,
      })
      .run()

    logger.info(
      `Saved AI decision log for account ${account.name}: ${operation} ${symbol ?? 'N/A'} ` +
        `prev_portion=${prevPortion.toFixed(4)} target_portion=${targetPortion.toFixed(4)} ` +
        `leverage=${leverageVal} executed=${executed}`,
    )
  } catch (err) {
    logger.error(`Failed to save AI decision log: ${err}`)
  }
}

/** Get all active AI accounts that are not using a default API key. */
export function getActiveAIAccounts(): Account[] {
  const rows = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.isActive, 'true'), eq(accounts.accountType, 'AI')))
    .all()

  const valid = rows.filter((acc) => !isDefaultApiKey(acc.apiKey))
  if (valid.length === 0) {
    logger.debug('No valid AI accounts found (all using default keys)')
  }
  return valid
}
