# Rework plan — 2026-09-12

Written after two and a quarter days of the cloud paper desk (Fly app `hexagon-desk`, deployed
2026-09-10 21:14Z). Read `README.md` and `CLAUDE.md` first. This document says what was measured,
what is wrong, and what to build, in order. Do the phases in order; each one is scored before the
next starts.

## Baseline (measured 2026-09-12 12:13Z on the Fly box)

| Desk | Number |
|---|---|
| Taker desks gross on closed trades | +$21.43 |
| Taker desks Kalshi fees paid | −$24.02 |
| Taker desks net realized | −$2.59 |
| Single worst taker trade (converge, Fed SEP maintains, 1175 @ 17c → 16c) | −$11.75 |
| Maker fills / contracts | 474 / 3,590 |
| Maker run-over fills / contracts | 206 (43%) / 2,126 (59%) |
| Maker run-over cost vs tape | −$55.57 |
| Maker spread captured on 1,123 round-trip contracts | −$1.72 |
| Maker net one-sided inventory | 1,344 contracts |
| Maker realized | −$5.93 |
| Maker inventory marked at mid | −$84.84 |
| Worst maker market (KXPRIMARYTURNOUT-NH1D26-80000, short 38 @ 65c avg, mid 91c, no longer quotable) | −$10.32 |
| Tape gaps counted (fills missed) | 145 |
| `tools/fillcheck.js 24` live/model fill ratio | 55% |

How these were computed: `MAKER_FILL` journal rows on the box (`/data/journal-*.jsonl`), matching
average sell price against average buy price per ticker; `runOver` is the journal flag written by
`src/maker.js fillsFrom`. Reproduce before changing anything so you have a before/after.

## Diagnosis, one line each

1. Run-over fills are the maker loss. 59% of filled contracts were the tape trading through a
   stale quote. Cadence went 30s → 2s and run-over only fell 69% → 59%, so latency is not the
   main cause; the markets being selected are ones whose touch gets swept.
2. Inventory that drifts into the tails can never be worked off: `desiredQuotes` returns null on
   both sides for `price in the tails` BEFORE the reduce-only logic in `makerdesk.js` runs.
3. `src/tape.js since()` fetches one page of 1000 exchange-wide trades per poll and counts a gap
   when it falls behind. 145 gaps means the fill model and `fillcheck` both undercount.
4. Taker desks earn less than the Kalshi taker fee. The one large loss was a convergence trade
   on a pair with near-equal venue volume, so fair sat in the middle and the capture was inside
   the 1c slip allowance.
5. Arb early-unwind (`agents.js` RIGO, `bidSum > 1.005`) does not net the Kalshi exit fee;
   the three unwinds netted $1–3 where holding would have netted $2–6.

## Phase 1 — stop the maker leak (small, unit-testable, replayable)

All in `src/maker.js` / `src/makerdesk.js` / `src/tape.js`, tests in `tools/maker-test.js`.

- 1a. **Paginate the tape.** In `tape.since`, when the oldest trade in the page is newer than
  `lastNewest`, fetch the next page (Kalshi `cursor`) until the pages overlap or a hard cap
  (say 5 pages). Keep the gap counter for the cap case only.
- 1b. **Reduce in the tails.** `desiredQuotes` must return the reducing side for a market with
  inventory even when mid is outside `[makerMinMid, makerMaxMid]`. Add a test: short 38 at mid
  0.91 yields `bid` set, `ask` null.
- 1c. **Run-over toxicity gate.** Track a rolling run-over rate per market in the ledger
  (`m.tox`, last N=30 fills). If it exceeds `MAKER_MAX_RUNOVER` (start 0.40), withdraw both
  quotes and mark the market cooled for `MAKER_TOX_COOLDOWN_MIN` (start 60). Reduce-only still
  applies to pinned inventory. Log the withdrawal once per market. Both knobs in `src/config.js`
  with a comment in the house style (what was measured, why the number).
- 1d. **Withdraw the growing side at half cap.** Change the `inv < cfg.makerCap` / `inv >
  -cfg.makerCap` checks to a `MAKER_SOFT_CAP` fraction (start 0.5). README already rejected
  price skew as overfit; this is withdrawal, not skew, and has not been scored.

Score each of 1a–1d separately with `node tools/replay.js data/ticks-*.jsonl` and
`tools/maker-verify.js` where applicable, then all four together. Report run-over share of
contracts, spread captured on round trips, and realized, before vs after. The Fly box has
three days of tape at `/data/ticks-*.jsonl` (about 90MB); copy what you need with
`fly ssh console -a hexagon-desk -C "cat /data/ticks-2026-09-11.jsonl" > data/...`.

Ship criterion: run-over share of contracts under 35% in replay with realized not worse.

## Phase 2 — re-score the market ranking

`makerMaxClearDays` ranks on how fast the queue clears. A queue that clears fast is a level
that gets swept, which is a run-over. Re-score the backtest per market with run-over cost
split out, and compare three rankings: clear-time (today), trades-per-day, and net-of-run-over
P&L. Use `tools/maker-verify.js` and `tools/history-scan.js` as the starting points. Do NOT
change the live ranking until this is scored in and out of sample, the way the README did for
every other maker decision.

## Phase 3 — taker desks

- 3a. **Lopsided-venue gate for convergence.** In `src/decide.js scan`, require the thick venue's
  24h volume to be at least `CONV_MIN_VOL_RATIO` (start 3) times the thin venue's before a
  convergence candidate is valid, and compute expected edge on the distance from entry to fair,
  not the gap. Add a `veto` reason so BRAM's gate log names it.
- 3b. **Unwind net of exit fee.** In `agents.js` RIGO, unwind an arb pair only when
  `(bidSum − 1) × qty` exceeds the modelled Kalshi exit fee plus `ARB_UNWIND_MARGIN`.
- 3c. **Prefer the Polymarket leg** for the directional side of a convergence trade when both
  venues are off fair by a similar amount; PM taker fee is 0.

Score with `tools/replay.js --sweep` and `tools/golden.js` (golden output must change only
where these rules bind; explain each diff).

## Phase 4 — Polymarket maker leg (research spike, go/no-go)

Polymarket rebates makers 15–25% of taker fees (2026 fee design). Before building anything:
measure top-of-book queue depth on the PM CLOB for the same kind of markets the Kalshi maker
quotes, the way the README measured Kalshi's. Reference implementation for the mechanics:
`warproxxx/poly-maker` (MIT, Python) — markout EWMAs, regime machine, inventory lean. Port the
ideas, not the code; zero npm dependencies stands. Deliverable is a measurement and a
recommendation, not a desk.

## Phase 5 — optional, separate project: Public.com wheel bot

Evan has a Public.com account with stocks and options. Public's API covers stocks, ETFs,
single and multi-leg options, crypto (https://public.com/api/docs). No sandbox is documented.
The only maintained open-source options bot is `brndnmtthws/thetagang` (AGPL, IBKR, the wheel).
If pursued: new folder outside `~/Hexagon`, read Public's API program terms first
(https://public.com/disclosures/individual-api-program — it is an image PDF, read it in a
browser), reimplement from the strategy description (AGPL), smallest allowed size, and never
place an order without an explicit instruction naming the order. This is selling volatility
with equity exposure, not an edge in the Hexagon sense.

## Success criteria for the whole rework

- `npm test` green, plus new assertions for 1b, 1c, 1d, 3a, 3b.
- Replay: run-over share of contracts < 35%; maker realized ≥ baseline; taker fees paid <
  taker gross over the tape.
- Then deploy (`fly deploy`), let it run 14 days, and judge on `tools/maker-report.js`
  realized and `tools/fillcheck.js 24` ≥ 50%.

## Invariants (from CLAUDE.md, restated because they are easy to break from a plan)

- Paper mode only. Never flip `MODE`, `DEMO`, or `LIVE_CONFIRM`.
- Zero npm dependencies.
- Do not run `node server.js` locally while the Fly desk is up — two desks quote the same
  books and both look better than they are. Use `DATA_DIR=./data-local` or replay instead.
- No git remote; the local `.git` is the only history. Commit each phase separately.
- Commit messages are one plain sentence describing the defect or the change, in the style of
  `git log` (e.g. "A lost order response is not a failed order").
