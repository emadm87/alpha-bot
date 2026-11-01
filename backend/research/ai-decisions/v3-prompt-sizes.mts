// ALPHA BOT 007F — size of real v3 prompts in three scenarios (minimum, medium, maximum), built OFFLINE with the app's
// own code: throwaway SQLite database, the test stand-in of the exchange (no network), the committed Hyperliquid 1 h
// candles and funding (SHA-256 verified) shifted in time so that their last bar has just closed. No AI call.
//
//   npx tsx research/ai-decisions/v3-prompt-sizes.mts --out <new empty folder>
//
// Writes <scenario>.system.txt, <scenario>.user.txt and <scenario>.answer.txt (a constructed answer of that size) per
// scenario, and sizes.json. Count the tokens with count_tokens.py (Gemma 3 vocabulary, calibrated on recorded Gemini
// usage). Prices and indicators are real market values; positions, decisions and news are CONSTRUCTED, of realistic
// form and at the stated lengths, to measure size only: nothing here is a decision or a result.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const args = process.argv.slice(2)
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]!) : null
if (!out) { console.error('usage: npx tsx research/ai-decisions/v3-prompt-sizes.mts --out <new empty folder>'); process.exit(64) }
if (fs.existsSync(out) && fs.readdirSync(out).length) { console.error(`${out} is not empty: nothing written`); process.exit(73) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v3-sizes-'))
process.env.DATABASE_PATH = path.join(tmp, 'sizes.db')
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => { throw new Error('network disabled') }) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../../src/db/client.ts')
const S = await import('../../src/db/schema.ts')
const { eq } = await import('drizzle-orm')
const { placeAndExecuteCrypto } = await import('../../src/services/orderExecutorLeverage.ts')
const P = await import('../../src/services/positionProtection.ts')
const { loadExitConfig, atrFromHourBars } = await import('../../src/services/exitRules.ts')
const { getPortfolioData } = await import('../../src/services/aiDecision.ts')
const H = await import('../../src/services/marketHistory.ts')
const V = await import('../../src/services/v3Context.ts')
const PR = await import('../../src/services/promptV3.ts')
const N = await import('../../src/services/newsFeed.ts')
const { installHyperliquidStub, quote } = await import('../../src/services/__fixtures__/hyperliquidStub.ts')
const { COINS, DATA_DIR, verifiedManifest } = await import('../exit-rules/lib.mts')

verifiedManifest()
ensureSchema()
installHyperliquidStub()
const HOUR = 3_600_000
const now = Date.now()
const csv = (f: string) => zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, f))).toString('utf8').trim().split('\n').slice(1).map((l) => l.split(','))
const raw = csv('oos-candles-1h.csv.gz')
const lastCommitted = Math.max(...raw.map((r) => Number(r[1])))
const shift = H.lastClosedOpen(now) - lastCommitted
const rowsBy: Record<string, unknown[]> = {}
for (const [c, t, o, h, l, cl, v] of raw) {
  const tt = Number(t) + shift
  ;(rowsBy[c!] ??= []).push({ t: tt, T: tt + HOUR - 1, s: c, i: '1h', o, h, l, c: cl, v, n: 1 })
}
const funding: Record<string, number> = {}
for (const [c, , rate] of csv('oos-funding-1h.csv.gz')) funding[c!] = Number(rate)
const last = (c: string) => Number((rowsBy[c]!.at(-1) as { c: string }).c)
const bars = (c: string) => (rowsBy[c] as { t: number; h: string; l: string; c: string; v: string }[])
const deps = (news: import('../../src/services/newsFeed.ts').NewsItem[]) => ({
  fetchCandles: async (coin: string) => rowsBy[coin]!,
  fetchNews: async () => ({ items: news }),
  live: (c: string) => {
    const p = last(c), b = bars(c).slice(-24)
    // for size only: impact prices at +-1 bp, 24 h notional from the candles (live: Hyperliquid's asset context)
    return { markPx: p, midPx: p, funding: funding[c] ?? null, premium: 0, openInterest: null, dayNtlVlm: b.reduce((s, x) => s + Number(x.c) * Number(x.v), 0),
      impactPxs: [p * 0.9999, p * 1.0001] as [number, number], receivedAt: Date.now() }
  },
})
const user = db.insert(S.users).values({ username: 'sizes', isActive: 'true' }).returning().get()
let seq = 0
const newAccount = () => db.insert(S.accounts).values({ userId: user.id, name: `s-${++seq}`, accountType: 'AI', isActive: 'false', apiKey: 'default',
  initialCapital: 1000, currentCash: 1000, maintenanceMarginRatio: 0.5, costModel: 'hyperliquid' }).returning().get().id
const account = (id: number) => db.select().from(S.accounts).where(eq(S.accounts.id, id)).get()!

// constructed texts of realistic form, cut at the prompt's limits by the app itself
const reason = (c: string) => `${c} holds above the 1h EMA20 at ${last(c)} with RSI 51.39 and relative volume 2.18; the 4h EMA20 is still below the EMA50 and the 24 h high caps the move, so I keep the position and watch the nearest level below for a break that would invalidate the long idea.`
const thesis = (c: string) => `${c} keeps a higher low above the 24 h range low; a move to the 24 h high is likely within 8 hours unless the 4h trend turns down further.`
const HEADLINES = [
  'Spot bitcoin ETFs log their largest weekly inflows since July',
  'Ethereum developers set a date for the next network upgrade',
  'Solana validators approve a fee market change after a long vote',
  'Ripple wins a new bank partnership for XRP cross-border payments',
  'Dogecoin whales move large balances to exchanges overnight',
  'BNB Chain completes its quarterly token burn on schedule',
  'Crypto liquidations top a billion dollars as leverage unwinds',
  'Fed minutes show officials split on the timing of the next rate cut',
]
const LONG_TAIL = ' while analysts debate whether the move can last into the end of the quarter'
const newsItem = (k: number, long: boolean) => ({
  title: long ? `${HEADLINES[k % 8]}${LONG_TAIL}` : HEADLINES[k % 8]!,
  summary: long ? 'Spot bitcoin exchange-traded funds recorded their largest weekly inflows since the summer while ether funds added for a third week; derivatives data show rising open interest and funding turning positive across major venues, and analysts warn that a hawkish surprise at the next FOMC meeting could reverse the move quickly.'
    : 'Prices moved within the recent range while open interest rose slightly; analysts point to the next macro data release as the main risk for the coming days.',
  publishedAt: now - (k + 1) * 1.5 * HOUR, source: N.NEWS_SOURCE,
})

async function scenario(name: string, protection: 'off' | 'C2' | 'C3', positions: { coin: string; side: 'LONG' | 'SHORT' }[], memory: number, longMemory: boolean, news: number, longNews: boolean) {
  process.env.ALPHA_PROTECTION = protection
  H.resetHistoryState(); V.resetV3State()
  const id = newAccount()
  for (const c of COINS) quote(c, last(c))
  for (const p of positions) {
    const price = last(p.coin)
    await placeAndExecuteCrypto({ account: account(id), symbol: p.coin, name: p.coin, side: p.side, orderType: 'MARKET', price: null, quantity: Number((120 / price).toPrecision(3)), leverage: 3 })
    db.insert(S.aiDecisionsV3).values({ accountId: id, at: Date.now(), operation: 'open', symbol: p.coin, direction: p.side.toLowerCase(), valid: 1, issues: '[]',
      decision: JSON.stringify({ reason: reason(p.coin), thesis: thesis(p.coin), invalidation_price: price * (p.side === 'LONG' ? 0.985 : 1.015), target_price: price * (p.side === 'LONG' ? 1.02 : 0.98) }),
      context: JSON.stringify({ snapshot: null, prices: { [p.coin]: price } }), executed: 1, outcome: 'executed: test' }).run()
  }
  if (protection !== 'off') {
    const hourly = (c: string) => bars(c).map((b) => ({ openTime: b.t, endTime: b.t + HOUR, open: 0, high: Number(b.h), low: Number(b.l), close: Number(b.c) }))
    const atrDeps = { atr: async (s: string, asOf: number) => atrFromHourBars(hourly(s), asOf, 14), sizeDecimals: P.defaultExitDeps.sizeDecimals }
    const rows = db.select().from(S.positions).where(eq(S.positions.accountId, id)).all()
    await P.runProtectionPass(account(id), rows, Object.fromEntries(COINS.map((c) => [c, last(c)])), Date.now(), loadExitConfig(), atrDeps)
  }
  for (let k = 0; k < memory; k++) {
    const c = COINS[k % COINS.length]!
    db.insert(S.aiDecisionsV3).values({ accountId: id, at: Date.now() - (k + 1) * 300_000, operation: 'hold', symbol: c, direction: null, valid: 1, issues: '[]',
      decision: JSON.stringify({ reason: longMemory ? reason(c) : `${c} unchanged: price ${last(c)} inside the 24 h range, no new level broken.`, thesis: longMemory ? thesis(c) : '' }),
      context: JSON.stringify({ snapshot: null, prices: { [c]: last(c) * 0.998 } }), executed: 0, outcome: 'hold: No order placed' }).run()
  }
  const acc = account(id)
  const ctx = await V.buildV3Context(acc, await getPortfolioData(acc), Object.fromEntries(COINS.map((c) => [c, last(c)])), Date.now(),
    deps(Array.from({ length: news }, (_, k) => newsItem(k, longNews))))
  const [sys, usr] = PR.buildMessagesV3(ctx)
  fs.writeFileSync(path.join(out!, `${name}.system.txt`), sys!.content)
  fs.writeFileSync(path.join(out!, `${name}.user.txt`), usr!.content)
  return { name, protection, positions: ctx.positions.length, memory: ctx.memory.length, news: ctx.news.items.length, system_chars: sys!.content.length, user_chars: usr!.content.length,
    estimate_tokens: PR.estimateTokens(sys!.content) + PR.estimateTokens(usr!.content) }
}

// constructed answers of the three sizes (format of the v3 schema)
const answers: Record<string, unknown> = {
  minimum: { operation: 'hold', symbol: null, direction: null, target_portion_of_balance: 0, leverage: 1, thesis: 'No clear edge: all six coins trade inside their 24 h ranges.', invalidation_price: null,
    target_price: null, time_horizon_hours: null, confidence: 'low', key_factors: ['BTC RSI 51.39', 'relative volume 2.18'], changed_since_last: 'first decision', reason: 'Nothing aligned enough to pay the costs.' },
  medium: { operation: 'open', symbol: 'BTC', direction: 'long', target_portion_of_balance: 0.3, leverage: 3, thesis: thesis('BTC'), invalidation_price: 80404, target_price: 81804,
    time_horizon_hours: 8, confidence: 'medium', key_factors: ['1h EMA20 above EMA50', 'RSI 51.39', 'relative volume 2.18', '24 h high 81804'], changed_since_last: 'price moved back above the 1h EMA20 (80826.9) since the last cycle',
    reason: 'Momentum recovered on rising volume with a defined invalidation below the last swing low and a target at the 24 h high.' },
  maximum: { operation: 'close', symbol: 'ETH', direction: 'short', target_portion_of_balance: 1, leverage: 3, thesis: `${thesis('ETH')} ${thesis('SOL')}`, invalidation_price: 2386.6, target_price: 2322.7,
    time_horizon_hours: 6, confidence: 'high', key_factors: ['ETH RSI 49.36 vs 44.86 on 4h', '4h EMA20 2344.45 below EMA50 2369.14', 'price 0.23 ATR from the nearest level above 2350.3', 'funding 0.00125% per hour paid by longs', 'net P&L +0.42% of entry value'],
    changed_since_last: 'ETH moved from 2347 to 2322.7, the 24 h low, and the structure changed from higher low to lower low; BTC and SOL unchanged; the exit plan of ETH is now 1.1 ATR from its stop.',
    reason: `${reason('ETH')} Closing the short locks the move to the 24 h low before the funding and the spread erode it.` },
}

fs.mkdirSync(out, { recursive: true })
const sizes = [
  await scenario('minimum', 'off', [], 0, false, 0, false),
  await scenario('medium', 'C3', [{ coin: 'BTC', side: 'LONG' }], 3, false, 4, false),
  await scenario('maximum', 'C2', COINS.map((c, k) => ({ coin: c, side: k % 2 ? 'SHORT' as const : 'LONG' as const })), 6, true, 8, true),
]
for (const [k, a] of Object.entries(answers)) fs.writeFileSync(path.join(out, `${k}.answer.txt`), JSON.stringify(a, null, 2))
fs.writeFileSync(path.join(out, 'sizes.json'), JSON.stringify({ built_at: new Date(now).toISOString(), data_shifted_by_hours: Math.round(shift / HOUR), scenarios: sizes }, null, 2) + '\n')
console.log(JSON.stringify(sizes, null, 2))
rawDb.close()
fs.rmSync(tmp, { recursive: true, force: true })
