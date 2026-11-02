# AI decisions — diagnosis and proposed "v3" decision context (Task 007E)

Research only. **The active prompt, entries, leverage and sizing are unchanged**; nothing here is wired into the
app. No result here says what Gemini would decide with another prompt: that needs a real, authorized test.

## Tools (read-only, no network, no AI)

| Tool | Where it runs | What it does |
|---|---|---|
| `pilot/export-diagnostics.mjs <run> --out <file>` | the computer that has the run (e.g. the notebook) | Derived data of every cycle: time, prices of the prompt, portfolio, news statistics (count, age, coins, titles unless `--no-news-titles`), Gemini's decision and reason, where each number of the reason comes from (news text / prompt price / near a price / neither), tokens, latency, outcome; fills, funding, exit events, report summary. No prompt text, no news text, no API key (the column is not read), no endpoint, no local path; a key-pattern scan blocks the write. Never overwrites, never writes inside the run folder. |
| `npx tsx research/ai-decisions/analyze.mts <export...>` | anywhere | Operations, HOLD streaks, how much the input changes between cycles, reason tags, number sources, open-position handling, and market context from the committed candles (moves of 2 ATR in 4 h). Descriptive: a HOLD is never labelled an error. |
| `npx tsx research/ai-decisions/context-v3.mts --at <ISO>` / `--export <file>` | anywhere | The proposed market brief of the six coins at a time, from bars closed by then only, and its size. |

Tests: `src/services/aiDecisionsResearch.test.ts` (export privacy and safety, analysis, no look-ahead of the brief).

## What Gemini receives today (verified in code and in three recorded 12-cycle runs)

One user message per cycle (no system message, temperature 0.7, up to 1000 output tokens):

- **cash, total assets, positions** (v1: `current_value` = quantity × avg_cost, i.e. the value at entry, constant);
- **one mid price per coin**, no history, no time series, **no current date or time**;
- **about 4000 characters of CoinJournal RSS** (titles + summaries, any subject);
- rules: one operation per cycle (`open` / `close` / `hold`), `target_portion_of_balance`, `leverage` described as
  "higher = more risk/reward".

It does not receive:
- indicators, structure, levels or volatility;
- fees, spread, funding, the risk per trade, or any memory of its previous decisions and their outcome.

## Proposed v3 context (one call per cycle, same cadence)

Per coin, from closed bars only (`context-v3.mts`):

| Area | Content |
|---|---|
| Trend | 1 h EMA20 / EMA50 and the EMA20 slope in ATR; 4 h EMA20 vs EMA50 |
| Structure | last two 1 h swing highs and lows (labelled higher/lower), 24 h and 7 d ranges, each with its distance in ATR |
| Momentum | RSI14, MACD histogram (in ATR), 4 h and 24 h returns, 4 h move in ATR |
| Volume | relative volume of the last hour vs 20 h |
| Volatility | ATR(14, 1 h), its % and its 30-day percentile |
| Costs | taker fee, half spread, last and 24 h funding (sign explained), round-trip cost |
| Risk budget | 2 ATR stop %, loss at the stop per 100 USDC, maximum notional for 0.5 / 1 / 2 % of the account, and that leverage changes the margin, not the P&L |

Plus, account-level:
- the current UTC time;
- the v2 positions with their exit plan and cooldowns (already implemented, off by default);
- the last decisions with their reasons and what happened since;
- the news filtered to the six coins and to the last 24 h, each with its age.

**Output** keeps `open` / `close` / `hold`. It adds:
- `thesis`;
- `invalidation_price`, `target_price`, `time_horizon_hours`;
- `confidence` (low / medium / high);
- `key_factors`;
- `risk_reward`;
- for every open position, `position_review` (keep / reduce / close, and why).

Nothing has to be aligned for a trade: the prompt asks the model to weigh the whole picture and to say why. The
engine keeps only safety controls (exit plan C1/C2/C3, cooldown, account emergency, and later the risk cap).

## Architectures and estimated API cost

Measured today: about 1,800 input + 97 output tokens per cycle, 288 cycles per day.

Prices are the **assumption** used by the pilot reports (0.30 USD per 1M input tokens, 2.50 per 1M output), not verified rates. The free tier is limited by requests per day.

| Architecture | Calls/day | Tokens per call (in / out) | Est. USD/day at the assumed prices | Complexity | Notes |
|---|---|---|---|---|---|
| Current v1 | 288 | 1,800 / 97 | 0.23 | — | reference |
| **A. Enriched single call (recommended first)** | 288 | ~4,300 / ~250 | ~0.55 | low: prompt builder + schema | one variable changes (information); brief ≈ 2,450 tokens measured |
| A at 15 min | 96 | ~4,300 / ~250 | ~0.18 | low | fewer calls; changes cadence too (a second variable) |
| B. Event-driven: local triggers + hourly heartbeat, full call on events | ~34–64 | ~4,300 / ~250 | 0.07–0.12 | medium: triggers to design and test | the trigger is a hidden filter; between events only the exit module acts |
| C. Analyst per coin + portfolio manager | 2,016 | 6 × ~1,000 / 150 + 1 × ~3,000 / 250 | ~1.6 | high | likely beyond the free tier; harder to audit |

## Risk and sizing (design only, not in the engine)

- Engine fact: `notional = cash × target_portion_of_balance`; leverage only sets the margin (`notional / leverage`).
  - A single position is therefore at most about the cash.
  - But leverage frees cash for **other** positions, so the total notional of several coins can exceed the account.
- Proposed cap (configurable 0.5 / 1 / 2 %, reference 1 %):
  - `max notional = cap × account value / (2 ATR + fees + spread + slippage, per unit)`;
  - executed = min(Gemini's, cap), rounded to the lot; under 10 USD the open is refused with a reason;
  - plus a portfolio cap on the sum of the risks at the stops (proposal: 3 %, consistent with the emergency control).
- **Where:** in the engine's open path (`placeAndExecuteCrypto` for opens of an account in experimental mode), not only in the AI command layer, so no path bypasses it. Additions count with the existing position.
- **No ATR available:** default `block` (no measurable risk, no new risk), with a recorded event. Option `fallback`: a conservative stop per coin (its out-of-sample p90 of the 2 ATR stop). Never a silent pass.
- Gemini is told the risk budget in the v3 brief, so it can size itself; the engine still enforces the cap.

## Validation plan (metrics fixed before any test)

**Offline, now:**
- information audit of v1 vs v3 (fields present, age of the data);
- fact-check of v1 reasons: the numbers cited vs the market at decision time, from the committed candles;
- size and availability of the v3 brief for every cycle of the recorded runs.

**Live, later, authorized, with sizing unchanged and the same exit configuration in both arms:** v1 vs v3 in parallel on the same period.

| Category | Metrics |
|---|---|
| Process | valid JSON; share of reason numbers present in the prompt (target ≥ 90 % for v3); decisions with an invalidation price |
| Activity | entries per day, holding time, exposure |
| Outcome (hypothetical paper) | net USDC and % after costs, maximum drawdown, R per trade, MAE/MFE |
| Risk | risk at the stop vs 1 %, oversized opens |
| Calibration | confidence vs realized R; stated vs realized risk/reward |
| Cost | tokens per day, API errors, latency |

**Decision rule:** no winner before ≥ 30 closed trades per arm or ≥ 14 days, with day-block bootstrap intervals.

## Limits

- Only three 12-cycle runs are on the development machine. The two 288-cycle runs are on the notebook: export them with the tool above.
- Reason tags are keyword-based: they describe wording, not intent.
- The market context uses trade candles (not the mark price), and covers 9 Sep – 31 Oct 2026.
- The cost figures depend on the assumed token prices.

## Task 007F: v3 implemented, off by default (`ALPHA_PROMPT=v3`)

Architecture A: one call per cycle, same cadence, same temperature (0.7) and output limit (1000). With `ALPHA_PROMPT` unset or `v1` the
original prompt is sent byte for byte (test 9 of `src/services/aiV3.test.ts`: SHA-256 `9062562e…`, and the real order path sends one user
message equal to `buildPrompt`). The startup line says `prompt=v1|v3`; the launcher takes `--prompt v1|v3` and stops before any AI call if
the app does not confirm it.

| File | Role |
|---|---|
| `src/services/marketHistory.ts` | closed 1 h bars of the six coins in the run's database (`market_bars`): 45-day backfill once, then only the missing hours; validated bars; restart-safe; failures reported, not hidden |
| `src/services/marketContext.ts` | per coin brief: trend 1h/4h, structure and levels, momentum, volume, volatility and its percentile, costs, risk budget; data quality and what is missing |
| `src/services/newsFeed.ts` (`fetchNewsItems`, `selectNews`) | news dated, ≤ 24 h, not future, about the six coins or the market, no duplicates, ≤ 8, marked when already shown; `fetchLatestNews` (v1) unchanged |
| `src/services/v3Context.ts` | account, positions (net P&L, % of the account, holding time, highest/lowest since entry, exit plan and R, risk on the account, entry reason, market changes since entry), last 6 decisions with what happened since, cooldowns |
| `src/services/promptV3.ts` | system + user messages, `promptVersion`, token and cost estimates |
| `src/services/aiDecisionV3.ts` | parse (JSON object only), validate, record (`ai_decisions_v3`) and outcome |

Validation policy: not JSON → no decision; an `open` without thesis, horizon, and invalidation/target on the right side of the price → not
executed, recorded as rejected; numbers in the text that are not in the data → flagged and counted, not blocking. Size and leverage are
passed to the engine unchanged; the engine's checks, the exit module and the cooldown apply as before.

Example and size, offline from the committed data: `npx tsx research/ai-decisions/prompt-v3-example.mts --protection C3 --out <file>`
(rendered: `examples/prompt-v3-2026-10-28T1837Z-C3.txt`).

## Task 007F-BACKUP: measured size of the v3 prompt (no API call)

Token counts are exact for the Gemini vocabulary: `count_tokens.py` reimplements the BPE of a Gemma 3 `tokenizer.json`
(Gemma 3 uses the Gemini tokenizer; the file is not in the repository). On the 36 recorded gemini-3.5-flash-lite calls the
reported `prompt_tokens` = count + 1 for every prompt and `completion_tokens` = count for every answer. The same calls reported
no hidden reasoning tokens (`total_tokens` = prompt + completion).

Prompts built by `v3-prompt-sizes.mts` with the app's code and real committed prices; positions, decisions and news are
constructed at realistic lengths (`examples/sizes/`):

| Scenario | Content | Input tokens (system + user) | Answer tokens |
|---|---|---|---|
| minimum | flat, exit module off, no memory, no news | 823 + 5,262 = 6,085 | 169 (hold) |
| medium | 1 position with C3 plan, 4 decisions, 4 news | 885 + 6,926 = 7,811 | 275 (open) |
| maximum | 6 positions with C2 plans, 6 decisions, 8 long news | 908 + 12,137 = 13,045 | 482 (close, 5 factors) |
| original v1 (recorded) | | 1,751–1,826 | 45–116 |

The digits cost one token each, so the market JSON costs about 2 characters per token (prose: 3.4). The 007F estimate
(characters / 3.2) was 30–40 % low; `estimateTokens` now counts digits apart (within 6 % of the exact counts, test 10b).

Possible reductions, measured on the same prompts (`compact_study.py`, study only, the prompt is unchanged):

| Change (tokens of the user message) | minimum | medium | maximum |
|---|---|---|---|
| A: drop repeated fields (mid = price, fee per coin, quality when ok, swing distances) | −16.8 % | −12.6 % | −7.2 % |
| A + B: 5 significant digits | −19.4 % | −14.7 % | −8.4 % |
| A + B + C: the six markets as one table (header once) | −50.0 % | −37.9 % | −21.6 % |

C keeps every value but a wide table is harder to read for a model: it would need its own offline and paper check.

## Task 008: v4 (experimental, opt-in `ALPHA_PROMPT=v4`)

### What is proven and what is only a hypothesis

| Finding | Status | Evidence |
|---|---|---|
| v3 MARKETS header says distances are "level minus price", while `price_vs_ema20_atr`, `price_vs_ema50_atr` (1h) and `price_vs_ema50_atr` (4h) are price minus EMA: two opposite conventions under one header | **proven** (code) | `marketContext.ts`, `promptV3.ts`; on the October data 1,111 of 5,580 v3 distance values contradict the header (`examples/v4/compare.json`); test 3 of `src/services/aiV4.test.ts` |
| v3 memory repeats the model's earlier reason (220 chars) and thesis (160) for up to 6 decisions | **proven** (code) | `v3Context.decisionMemory` |
| A v3 HOLD with no symbol carries no price change in the memory (`price_then` null) | **proven** (code) | same |
| v3 asks for one decision, not for an explicit comparison of LONG, SHORT and HOLD; "holding is a valid decision" is the only explicit guidance on the outcome | **proven** (prompt text) | `promptV3.ts` |
| 22 consecutive HOLDs, bearish reasons centred on the 4 h EMAs, shorts not argued | **reported** (2 Nov pilot and the one before; traces on the notebook, not in this repository) | pilot reports |
| The HOLDs were wrong, or caused by the sign ambiguity or by anchoring on earlier reasons | **hypothesis**, not shown | a HOLD may be right; in October 75 % of coin-hours had the 4 h EMA20 below the EMA50 (`compare.json`), so bearish 4 h readings were common in the data |

### What v4 changes (v1 and v3 byte-identical, test 1)

- `marketContextV4.ts`: every distance is `price_minus_<x>_atr` = (price − x) / ATR(14, 1h), positive = price above x (0 contradictions on the October data); adds the 4 h price–EMA20 distance, EMA20–EMA50 gaps, position in the 24 h / 7 d range, the round-trip cost and the costs in R; `if_opened_now` for LONG and for SHORT with the exit module's stop (and C3 take profit / C2 partial), the levels in the way (at most 3) and the funding for that side. Same rules for both sides: mirrored prices swap them exactly (test 4).
- `promptV4.ts`: every cycle, the best LONG candidate, the best SHORT candidate and HOLD are argued to the same standard; none is the default; nothing has to be aligned; a downtrend is a reason to examine a SHORT as much as to avoid a LONG; earlier decisions are not evidence. `max_tokens` 1500 (v3: 1000) because the answer carries the three alternatives (636 tokens measured on a constructed answer) and Gemini's thinking counts in the same limit. Temperature 0.7 as before.
- `v4Context.ts`: memory lists earlier decisions without their reasoning text; what changed since the last decision is computed for all six coins (v4 stores every coin's snapshot with each decision; a v3 row gives the price change only). An open position still shows its entry thesis (needed to manage it).
- `aiDecisionV4.ts`: the v3 validation unchanged (same blocking rule for an `open`); the alternatives are checked (present, symbols, levels on the right side, the open matches its side, numbers from the data) and **flagged, never blocking**.
- Unchanged: orders, fees, sizing, leverage, C1/C2/C3, cooldown, the 007G attempt limit, the cadence.

### Offline comparison on the same data (`compare-v3-v4.mts`, October 2026, 62 times x 6 coins)

| | v3 | v4 |
|---|---|---|
| Distance values contradicting the stated convention | 1,111 / 5,580 | 0 / 8,301 (more values: re-signed v3 ones plus the references) |
| Keys per coin | 88 | 125 |
| Null values (missing data) | 744 | 744 (the same: impact prices and 24 h volume are not in the offline data) |
| LONG / SHORT references | none | both, same rules; levels in the way 1,020 long / 921 short; funding paid by long 325 / short 47 (October data) |
| Input tokens, exact, sample 28 Oct 12:00 (flat, C3, no memory/news) | 6,086 | 8,700 (+43 %) |

Not measurable offline: what Gemini would decide with v4, how often it would trade, any P&L.

### Tokens and cost (no API call; paid prices are the assumption used so far, $0.30 / $2.50 per 1M, not verified)

| Prompt | Input tokens | Output tokens | USD per call | 288 / day | 96 / day | 48 / day |
|---|---|---|---|---|---|---|
| v3 medium (measured, 007F-BACKUP) | 7,812 | 275 | 0.0030 | 0.87 | 0.29 | 0.15 |
| v4 flat (measured) | 8,700 | ~640 | 0.0042 | 1.21 | 0.40 | 0.20 |
| v4 medium (estimate: v4 flat + the 1,726 tokens the v3 position/memory/news blocks measured) | ~10,400 | ~640 | 0.0047 | 1.36 | 0.45 | 0.23 |
| v4 maximum (estimate: v4 flat + the 6,960 tokens of the v3 maximum blocks: 6 positions, 6 decisions, 8 news) | ~15,700 | ~800 | 0.0067 | 1.93 | 0.64 | 0.32 |

A 12-cycle paper test with v4 costs about $0.05 at paid prices, $0 within the free tier. Requests per day are the same as
v3 (one per cycle); tokens per minute stay under ~16k. The free-tier limits of the user's project must be checked in
AI Studio (see 007F-BACKUP); nothing here assumes they are sufficient.

### Residual risks

- Bigger prompt (+43 %) and longer answers: more latency, so more 30 s client timeouts are possible (the 2 Nov v3 pilot had none, an earlier one had 2); the 007G limit stops the run if attempts run out. The client timeout is not changed.
- `max_tokens` 1500 lowers but does not remove truncation if Gemini thinks more; watch `finish_reason` and `completion_tokens`.
- Asking for LONG and SHORT candidates every cycle may change how often the model trades; v4 is not built to trade more and HOLD stays an equal option, but only the paper test will show the effect.
- The alternatives are validated but not enforced (flags only); the number check is a heuristic.
- `if_opened_now` is a reference with the exit module's rules (2 ATR stop, C3 +2R); offline the costs in R lack the spread.
- The first v4 cycle has no "changes since" (no earlier v4 decision); a v3 row gives price changes only.

### Future paper test (not started; needs your authorization)

```
git fetch origin claude/exp-008-ai-v4 && git checkout claude/exp-008-ai-v4
cd backend && npm ci && npx tsx --test src/services/aiV4.test.ts && node pilot/test/selftest.mjs
node pilot/run-pilot.mjs --run-dir pilot/runs/<new folder> --cost-model hyperliquid --position-info v2 --protection C3 --prompt v4 --cycles 12 --max-attempts <N> --key-mode env --key-env GEMINI_API_KEY
# without --authorized: plan only; then the same command with --authorized; the log must confirm
# "Experiment config: position_info=v2 protection=C3 prompt=v4" and "[ai-budget] attivo: max <N> ..."
```

Optional, same period: a second launcher with `--prompt v3` on another `--port` and `--run-dir` (doubles the calls).

### Evaluation criteria (fixed before the test)

| Area | Measure | Pass for a first test |
|---|---|---|
| Process | valid JSON; `alternatives` complete (long, short, hold); open consistent with its alternative | ≥ 11 / 12 valid, 0 blocked by format |
| Balance | cycles naming a LONG and a SHORT candidate (or arguing "none" with data); share of SHORT cases argued when the 4 h EMA20 < EMA50 | both sides argued in ≥ 10 / 12 |
| Grounding | share of numbers found in the data (`numbers.verified / cited`); sign errors in the text (e.g. "price below EMA20" when `price_minus_ema20_atr` > 0), checked by hand on the trace | ≥ 90 %; 0 sign errors |
| Anchoring | `changed_since_last` cites computed changes rather than repeating the earlier verdict | read on the trace |
| Cost and reliability | `prompt_tokens` vs 8.7–10.4k, `completion_tokens`, `finish_reason`, latency, timeouts, attempts (007G log) | no truncation; attempts within the limit |
| Outcome | trades, R, net P&L (hypothetical paper) | **not judged on 12 cycles**: needs ≥ 30 trades or ≥ 14 days, as for v3 |

No target number of trades: a v4 that keeps holding with well-argued alternatives passes the process criteria.
