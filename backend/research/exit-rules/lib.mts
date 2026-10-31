// ALPHA BOT 007C — loading of the research data set, with integrity checks. Read-only.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import type { Bar, Bar15 } from '../../src/services/exitRules.ts'

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
export const COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'] as const

export interface Manifest { files: Record<string, { sha256: string; fetched_at: string; first_bar?: string; last_bar?: string }> }

/** Reads data/MANIFEST.json and checks the SHA-256 of every file: a changed or missing file stops the run. */
export function verifiedManifest(dir = DATA_DIR): Manifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')) as Manifest
  for (const [name, f] of Object.entries(manifest.files)) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) throw new Error(`data file missing: ${name}`)
    const bytes = fs.readFileSync(file)
    const got = crypto.createHash('sha256').update(bytes).digest('hex')
    if (got !== f.sha256) {
      // the most common cause on Windows: a checkout that converted LF to CRLF (the checksum stays mandatory)
      const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
      const crlf = bytes.includes(13) && crypto.createHash('sha256').update(lf).digest('hex') === f.sha256
      throw new Error(`integrity check failed for ${name}: sha256 ${got}, manifest ${f.sha256}` + (crlf
        ? '. The file has Windows line endings (CRLF) and matches the manifest with LF: it was converted at checkout. ' +
          'Restore it as committed: git checkout -- backend/research/exit-rules/data (the repository .gitattributes prevents the conversion)'
        : ''))
    }
  }
  return manifest
}

function csvRows(file: string): string[][] {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
  return text.trim().split('\n').slice(1).map((l) => l.split(','))
}

/**
 * Bars of a candle file, by coin, ascending. Bars that had not ended when the
 * file was fetched (still forming) are dropped.
 */
export function loadBars(file: string, intervalMs: number, fetchedAt: number): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = {}
  for (const [coin, t, o, h, l, c] of csvRows(file)) {
    const openTime = Number(t)
    if (openTime + intervalMs > fetchedAt) continue
    ;(out[coin!] ??= []).push({ openTime, endTime: openTime + intervalMs, open: +o!, high: +h!, low: +l!, close: +c! })
  }
  for (const k of Object.keys(out)) out[k]!.sort((a, b) => a.openTime - b.openTime)
  return out
}

export const asBar15 = (bars: Bar[]): Bar15[] => bars.map((b) => ({ openTime: b.openTime, open: b.open, high: b.high, low: b.low, close: b.close }))

/** Hourly funding rate by coin and hour (ms). */
export function loadFunding(file: string): Record<string, Map<number, number>> {
  const out: Record<string, Map<number, number>> = {}
  for (const [coin, time, rate] of csvRows(file)) (out[coin!] ??= new Map()).set(Math.floor(Number(time) / 3_600_000) * 3_600_000, Number(rate))
  return out
}

/** Median half spread (fraction of the mid) per coin from the l2Book snapshots. */
export function halfSpreads(dir = DATA_DIR): Record<string, number> {
  const books = JSON.parse(fs.readFileSync(path.join(dir, 'books.json'), 'utf8')) as Record<string, { bids: { px: string }[]; asks: { px: string }[] }[]>
  const out: Record<string, number> = {}
  for (const [coin, snaps] of Object.entries(books)) {
    const s = snaps.map((b) => { const bid = +b.bids[0]!.px; const ask = +b.asks[0]!.px; return (ask - bid) / ((ask + bid) / 2) }).sort((a, b) => a - b)
    out[coin] = s[Math.floor(s.length / 2)]! / 2
  }
  return out
}

/** Deterministic PRNG (mulberry32) for the bootstrap. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
