// ALPHA BOT 007C — download of the public Hyperliquid market data used by the exit-rule research.
// Read-only (POST https://api.hyperliquid.xyz/info), no key, no order, no AI. NOT needed to reproduce the
// committed results: the data is in data/ with its checksums. Use it only to extend or refresh the data set.
//
//   node research/exit-rules/fetch-data.mjs oos   [--out research/exit-rules/data]   1 h candles (latest 5000) + funding
//   node research/exit-rules/fetch-data.mjs recent [--out ...]                       15 m candles (latest 5000) + 20 d funding
// Behind an HTTPS proxy: NODE_USE_ENV_PROXY=1 node research/exit-rules/fetch-data.mjs ...
// Writes deterministic gzip files (same content -> same SHA-256) and updates data/MANIFEST.json.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const what = args[0]
const outDir = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(here, 'data'))
const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function info(body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.status === 429 && attempt < 5) { await sleep(10_000 * (attempt + 1)); continue }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${JSON.stringify(body)}`)
    return res.json()
  }
}
const gz = (file, text) => fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text), { level: 9 }))
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

if (!['oos', 'recent'].includes(what)) {
  console.error('usage: node research/exit-rules/fetch-data.mjs oos|recent [--out DIR]')
  process.exit(64)
}
fs.mkdirSync(outDir, { recursive: true })
const now = Date.now()
const interval = what === 'oos' ? '1h' : '15m'
const ms = what === 'oos' ? 3_600_000 : 900_000
const lines = ['coin,open_time,open,high,low,close,volume']
let first = Infinity, last = -Infinity
for (const c of COINS) {
  const rows = await info({ type: 'candleSnapshot', req: { coin: c, interval, startTime: now - 5000 * ms, endTime: now } })
  for (const r of rows.sort((a, b) => a.t - b.t)) {
    lines.push([c, r.t, r.o, r.h, r.l, r.c, r.v].join(','))
    first = Math.min(first, r.t); last = Math.max(last, r.t)
  }
  console.log(c, interval, rows.length)
  await sleep(8000)
}
const candleFile = path.join(outDir, what === 'oos' ? 'oos-candles-1h.csv.gz' : 'candles-15m.csv.gz')
gz(candleFile, lines.join('\n') + '\n')

// funding: fundingHistory returns at most 500 rows per request, paged forward from startTime
const fundingStart = what === 'oos' ? first : now - 20 * 86_400_000
const fl = ['coin,time,funding_rate,premium']
for (const c of COINS) {
  let start = fundingStart
  const seen = new Set()
  for (;;) {
    const rows = await info({ type: 'fundingHistory', coin: c, startTime: start, endTime: now })
    const fresh = rows.filter((r) => !seen.has(r.time))
    for (const r of fresh) { seen.add(r.time); fl.push([c, r.time, r.fundingRate, r.premium].join(',')) }
    await sleep(4000)
    if (rows.length < 500 || !fresh.length) break
    start = Math.max(...rows.map((r) => r.time)) + 1
  }
  console.log(c, 'funding', seen.size)
}
const fundingFile = path.join(outDir, what === 'oos' ? 'oos-funding-1h.csv.gz' : 'funding-1h.csv.gz')
gz(fundingFile, fl.join('\n') + '\n')

const manifestFile = path.join(outDir, 'MANIFEST.json')
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : { files: {} }
for (const [file, desc] of [[candleFile, `${interval} candles (latest 5000 per coin; Hyperliquid serves no older bars)`], [fundingFile, 'hourly funding (fundingHistory)']]) {
  manifest.files[path.basename(file)] = {
    sha256: sha(file), description: desc, source: 'POST https://api.hyperliquid.xyz/info (public, read-only)',
    fetched_at: new Date(now).toISOString(), first_bar: new Date(first).toISOString(), last_bar: new Date(last).toISOString(),
  }
}
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
console.log('written', candleFile, fundingFile, manifestFile)
