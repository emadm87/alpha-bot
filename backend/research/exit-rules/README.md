# Exit rules C1 / C2 / C3 — reproducible research (Tasks 007B / 007C)

Paired comparison of the three exit configurations of the ALPHA BOT paper pilot, and of BASE (no exit
rule: the position is held, as the original leaves it to Gemini), on recorded Hyperliquid prices.
**Every number here is HYPOTHETICAL**: simulated exits on recorded prices, never a profit that was made.

## Reproduce (from `backend/`, no network, about 1 minute)

```bash
npx tsx research/exit-rules/simulate.mts                  # writes results/results.json and results/summary.md
python3 research/exit-rules/independent/compare.py        # independent Python implementation (needs numpy): exit 0 = agree
```

`simulate.mts` uses the code the app runs (`src/services/exitRules.ts`, `src/services/exitPathSim.ts`), so
the validation is of the rules as implemented, not of a copy. `independent/sim007b.py` is the separate
Python simulator of Task 007B (written independently of the TypeScript rules), now reading the committed
data; `compare.py` checks that C1 and C3 agree within 0.5 bps (C2 differs by construction, see the script).
The bootstrap uses a fixed seed: the same data give the same numbers.

## Data (`data/`, public Hyperliquid market data, no credentials)

| File | Content | Used for |
|---|---|---|
| `candles-15m.csv.gz` | 15 m candles, 2026-09-09 18:45 to 2026-10-31 20:45 UTC, six markets | in-sample (entries to 2026-10-25) and hold-out (from 2026-10-28) |
| `funding-1h.csv.gz` | hourly funding, 2026-10-11 to 2026-10-31 | funding of the 15 m sets (earlier hours: the coin mean) |
| `oos-candles-1h.csv.gz` | 1 h candles, 2026-04-06 to 2026-10-31 | out-of-sample: entries before 2026-09-09 only |
| `oos-funding-1h.csv.gz` | hourly funding of the same period | funding of the out-of-sample set |
| `books.json` | three `l2Book` snapshots per market (top 5 levels), 2026-10-31 | half spread per market |
| `meta.json` | `szDecimals`, `maxLeverage` | order precision |

`data/MANIFEST.json` gives, for every file, its SHA-256, the request, the fetch time and the period.
`lib.mts` checks every checksum before a run: a changed or missing file stops it. Bars still forming at
the fetch time are dropped. `fetch-data.mjs` re-downloads (network; not needed to reproduce).

## Sets and what they can show

| Set | Period | Role |
|---|---|---|
| `in_sample_15m` | entries 2026-09-11 to 2026-10-25 | the window Task 007B used to choose C1/C2/C3: **not** a test of them |
| `out_of_sample_1h` | entries 2026-04-09 to 2026-09-07 | never seen when the parameters were chosen; 1 h bars (coarser path: more bars touch two levels) |
| `holdout_15m` | entries from 2026-10-28 | contains the 30 Oct pilot day; 3 days: anecdotal |

Entries are generated (every 4 h, LONG and SHORT, every market, held at most 24 h) because entries are
Gemini's decision: this measures how an exit rule behaves on the price path and what it costs, not
whether a strategy earns. With mirrored LONG/SHORT entries, BASE's mean is just its cost (the gross
results cancel), so the comparisons that matter are the **paired differences** C − BASE and C − C.

**Statistical units.** Simulated entries are not independent: LONG and SHORT of one entry are mirror
images, windows overlap (24 h held, one entry every 4 h) and the six markets move together. The
intervals come from a bootstrap that resamples whole calendar days, so their width reflects the number of
days (45 in-sample, 153 out-of-sample, 3 hold-out), not the number of entries.

**Costs.** Taker fee 0.045% each side (Hyperliquid base tier), half spread of each market (recent books,
not historical), 2 bps of slippage beyond the level on stop-type exits (5 bps sensitivity column), hourly
funding (LONG pays a positive rate). Gaps fill at the bar open; a bar touching an exit and a target
counts as the exit.

## Limits

- Candles are trade prices; the live module checks the mark price every 5 s. Inside a bar the order of
  high and low is unknown (conservative rule: the exit first).
- Spreads are those of 31 Oct; historical books are not available. Slippage is assumed, not measured.
- No market regime is covered beyond April - October 2026.
- Nothing here says how Gemini would trade: one position was opened in the 288-cycle pilot.
