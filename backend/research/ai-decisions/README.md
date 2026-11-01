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
(rendered: `examples/prompt-v3-2026-10-28T1837Z-C3.txt`). About 4,500 estimated tokens for a flat account; about 6,900–7,700 with one
position, 6 decisions in memory and 8 news items (characters / 3.2: an estimate, not a measurement of Gemini's tokenizer).
