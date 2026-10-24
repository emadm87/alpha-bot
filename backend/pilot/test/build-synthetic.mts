// SOLO TEST: database e traccia SINTETICI per validare report.mjs.
// Motore reale (placeAndExecuteCrypto) con prezzi iniettati nella cache; nessuna rete, nessuna AI.
// Uso (da backend/): node node_modules/tsx/dist/cli.mjs pilot/test/build-synthetic.mts <out.db>
import fs from 'node:fs'
const out = process.argv[2]
if (!out) throw new Error('missing output path')
for (const f of [out, `${out}-wal`, `${out}-shm`]) fs.rmSync(f, { force: true })
process.env.DATABASE_PATH = out
process.env.LOG_LEVEL = 'error'
globalThis.fetch = (() => {
  throw new Error('network disabled')
}) as typeof fetch

const { db, ensureSchema, rawDb } = await import('../../src/db/client.js')
const { seedDatabase } = await import('../../src/db/seed.js')
const { accounts, aiDecisionLogs } = await import('../../src/db/schema.js')
const { eq } = await import('drizzle-orm')
const { cachePrice } = await import('../../src/services/priceCache.js')
const { placeAndExecuteCrypto } = await import('../../src/services/orderExecutorLeverage.js')
const { utcNow } = await import('../../src/utils/datetime.js')

ensureSchema()
seedDatabase()
const user = rawDb.prepare("SELECT id FROM users WHERE username='default'").get() as { id: number }
const id = db.insert(accounts).values({
  userId: user.id, version: 'v1', name: 'SYNTH', accountType: 'AI', model: 'gemini-3.5-flash-lite',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'network-secret-placeholder',
  initialCapital: 1000, currentCash: 1000, frozenCash: 0, isActive: 'true',
}).returning().get().id

async function go(symbol: string, side: string, quantity: number, leverage: number, price: number, orderNo?: string) {
  cachePrice(symbol, 'CRYPTO', price)
  const account = db.select().from(accounts).where(eq(accounts.id, id)).get()!
  await placeAndExecuteCrypto({ account, symbol, name: symbol, side, orderType: 'MARKET', price: null, quantity, leverage, orderNo })
}
const back = (symbol: string, hours: number) =>
  rawDb.prepare('UPDATE positions SET last_interest_time=? WHERE account_id=? AND symbol=?')
    .run(utcNow(new Date(Date.now() - hours * 3_600_000)), id, symbol)

// Valori attesi calcolati a mano (selftest.mjs): realizzato +2, non realizzato +6 a BTC 120,
// commissioni 0,3164, interessi ~0,0079, una liquidazione, finale ~1.007,6757.
await go('BTC', 'LONG', 0.5, 3, 100) //   margine 16,6667, commissione 0,035
await go('ETH', 'SHORT', 2, 2, 50) //     margine 50, commissione 0,07
back('ETH', 10)
await go('ETH', 'BUY', 2, 2, 45) //       +10, commissione 0,063, interessi 50*0,0000125*10
back('BTC', 4)
await go('BTC', 'SELL', 0.2, 3, 110) //   +2, commissione 0,0154, interessi 33,33*0,0000125*4
await go('SOL', 'LONG', 1, 5, 100) //     margine 20, commissione 0,07
await go('SOL', 'SELL', 1, 5, 90, 'LIQ-SYNTHETIC0001') // -10, commissione 0,063

for (const op of ['open', 'open', 'close', 'close', 'open', 'hold']) {
  db.insert(aiDecisionLogs).values({
    accountId: id, reason: 'synthetic', operation: op, symbol: op === 'hold' ? null : 'BTC',
    prevPortion: 0, targetPortion: 0.1, totalBalance: 1000, executed: 'true', leverage: 1,
  }).run()
}
const prompt = (total: number, btc: number) =>
  `Portfolio Data:\n- Cash Available: $1.00\n- Frozen Cash: $0.00\n- Total Assets: $${total.toFixed(2)}\n` +
  `- Current Positions (each shows quantity, avg_cost, current_value, side: LONG/SHORT, leverage):\n{}\n\n` +
  `Current Market Prices:\n${JSON.stringify({ BTC: btc, ETH: 45, SOL: 90 }, null, 2)}\n\nLatest Crypto News`
const trace: Record<string, unknown>[] = [[1000, 100], [1003, 105], [990, 98], [1001, 110], [1007.68, 120]].map(([t, p], i) => ({
  ts: `2026-10-25T0${i}:00:00.000Z`, cycle_id: `c${i}`, event: 'request', account_id: id, model: 'gemini-3.5-flash-lite',
  payload: { messages: [{ role: 'user', content: prompt(t!, p!) }] },
}))
trace.push({ ts: '2026-10-25T00:00:01.000Z', cycle_id: 'c0', event: 'response', response: { choices: [], usage: { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280 } } })
fs.writeFileSync(out.replace(/\.db$/, '.jsonl'), trace.map((x) => JSON.stringify(x)).join('\n') + '\n')
rawDb.close()
