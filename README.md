# The Hexagon

A six-agent prediction-market trading desk that prices the same events across **Polymarket** and **Kalshi**, trades the disagreements, and streams everything to a live dashboard. Zero npm dependencies; Node 20+.

```bash
cd hexagon
node server.js            # paper account on live market data  →  http://localhost:8787
DEMO=1 DATA_DIR=./data-demo node server.js   # synthetic Kalshi noise so you can watch fills/settles (separate account file)
```

Copy `.env.example` to `.env` to change anything. State persists in `data/state.json`; `npm run reset` wipes the paper account.

## What it actually does

Every 15 seconds the engine pulls the top 300 Polymarket markets by volume and every open market in 11 Kalshi series (Fed decisions, ATP/WTA, MLB, NFL, NBA, NCAAF, MLS, EPL, UCL, La Liga), then runs the desks in order:

| # | Agent | Desk | Job |
|---|-------|------|-----|
| 05 | **HOLT** | Scanner | Matches the same outcome on both venues (Fed brackets by month/code; games and matches by team/player name plus US/Eastern date). Rejects any match where the venues disagree by 30c+, which means the match is wrong. |
| 06 | **ILSA** | Sentiment | Tracks each pair's price drift and whether the venue gap is narrowing or widening. Execution skips trades ILSA reads as diverging and sizes up ones it reads as converging. |
| 04 | **TESS** | Ops | Health and risk: halts new risk on stale quotes, API error storms, or a daily drawdown past the limit. Sets the per-trade budget. |
| 03 | **RIGO** | Settlement | Marks positions, exits convergence trades (gap closed, stop, max hold, or event going in-play), settles resolved markets at $1/$0, realizes P&L, scores wins/losses. |
| 01 | **BRAM** | Pricing | Two signal types. **Locked arb**: YES on one venue + NO on the other costs under $1 after fees, so it pays $1 at resolution regardless of outcome. **Convergence**: venues disagree by ≥ `MIN_GAP` (3c) on a pre-game or macro market. Fair value is the volume-weighted mid (the thin book is usually the wrong one), and the trade is whichever side of the off-fair venue is cheap relative to fair, YES or NO. The signal fires only if the **round trip** clears `MIN_EDGE` — see below. Exits when the venues agree again. |
| 02 | **KETT** | Execution | Pulls the real order books on both venues, re-verifies the gap from live books (listings lag), sizes to depth and budget, fills, and unwinds the first leg if the second leg fails. |

Fees are modeled: Kalshi's `ceil(0.07 × contracts × P × (1−P))` and a configurable Polymarket taker fee (0 by default). Fills walk the ask ladder, so size is limited by real depth.

### The gap is not the edge

A venue gap of *G* does not hand you *G*. Fair value sits **between** the two venues, so the cheap
venue is only part of the way from it; you buy the ask and later sell the bid, so the spread is a
cost; and Kalshi charges a taker fee on the way in **and** the way out. Per contract:

```
edge = (fair − spread/2) − ask − fee(entry) − fee(exit)
```

Kalshi's fee is `0.07 × P × (1−P)` per contract — **1.75c each way at P=0.50**, so a 3.5c round trip
at mid prices, falling to 0.6c each way at P=0.90. That is why `MIN_GAP` (the disagreement that makes
a pair *interesting*) and `MIN_EDGE` (the profit that makes it *worth trading*) are separate knobs.
Testing the edge against `MIN_GAP`, as this code originally did, demanded a 6–10c gap to clear a
nominal "3c" bar and meant the convergence book never opened a position.

Practical consequence: on Kalshi legs at mid prices this strategy needs a genuinely wide gap (~8c) to
pay. It gets much cheaper near the tails, and cheapest of all on Polymarket legs, where
`PM_TAKER_FEE` is 0. **Live mode is Kalshi-only**, so live has the least favourable fee profile of
the three — read that section before funding anything.

### Guardrails baked in
- Game pairs become untradeable 2 minutes before start. In-play prices move faster than any listing refresh, and the biggest "gaps" you'll see are exactly those.
- Convergence trades are never opened on markets priced under 3c or over 97c (tick noise), or where the cheap venue's spread is over 5c.
- Max 2% of equity per position, 12 open positions, 3% daily drawdown halt, 90-second stale-data halt. All in `.env`.
- The daily drawdown window rolls at midnight **US/Eastern**, matching the dates the matcher pairs games on (a UTC roll would reset the limit at 8pm ET, mid-slate).

## The tick tape

Every cycle the desk appends one JSON line per priced pair to `DATA_DIR/ticks-YYYY-MM-DD.jsonl`
(Eastern day, the same day boundary TESS rolls the drawdown limit on). `E.history` keeps 240 mids
per pair in memory and dies with the process; this file is the durable version, and the only way to
answer whether a tradeable gap ever actually existed.

```json
{"t":"2026-09-09T22:24:56.865Z","qt":"2026-09-09T22:24:56.701Z","cycle":1,
 "pair":"2252244:0|KXFEDDECISION-26SEP-H0","label":"Fed SEP 26 · Fed maintains rate","kind":"fed",
 "series":"KXFEDDECISION","inPlay":false,"pmBid":0.45,"pmAsk":0.46,"pmVol":1289128,
 "ksBid":0.44,"ksAsk":0.45,"ksVol":896841,"fair":0.4509,"edge":-0.0059,"venue":"PM","side":"no"}
```

- `fair`, `edge`, `venue`, `side` are BRAM's fair value and the **best net edge it found on that
  pair**, after the exit spread and a taker fee both ways — recorded whether or not it cleared
  `MIN_GAP`/`MIN_EDGE`, so the near-misses are visible too. A negative `edge` means the round trip
  loses money; that is the normal reading. These four fields are **absent**, not null, on in-play
  pairs, which BRAM does not price at all — treat a missing field as "not priced", not as zero.
- `t` is when the line was written; `qt` is when the quote itself was observed. The engine keeps a
  pair's last good quote when it fails to reprice, so **a line whose `qt` lags `t` by more than the
  cycle's own few hundred milliseconds is a carried-over quote, not a fresh observation** — without
  `qt` a stale price and a flat market look identical.
- Append-only, never rewritten, rotating by filename at Eastern midnight. A failed write logs once
  (rate-limited) and the cycle continues; the tape can never halt the desk.
- Roughly 60–80 MB per day at 19–45 pairs. **Nothing prunes these files.** `data/` is gitignored, so
  they stay local. Set `RECORD=0` in `.env` to turn the recorder off.

## Dashboard
Balance history with settlement bars, activity log with per-agent color and P&L, venue feed (top Polymarket, top Kalshi, matched pairs with live gap), a pixel trading floor whose six agents animate when their desk is running, agent cards, and an open-positions table. It updates over Server-Sent Events every 2 seconds.

## Live mode (read this)
Live mode is **Kalshi only**. In live mode the desk only takes convergence trades whose leg is on Kalshi; locked arbs (which need both venues) are disabled.

To enable it you must set all of these in `.env`:

```
MODE=live
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem
LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY
```

The server refuses to start otherwise. Orders are RSA-PSS signed limit orders, immediate-or-cancel, at the observed ask plus 1c. The live path is written against Kalshi's documented v2 order API but has **not** been exercised with a funded account here; run it with a small balance first and watch the log.

### Polymarket US (`polymarket.us`)
This is the separate, CFTC-regulated Polymarket product for US persons — not the international site the rest of this project reads from (`polymarket.com`'s Gamma/CLOB APIs), and not reachable at all without geofencing/KYC. It has its own market catalog, its own slugs, and its own Ed25519-signed REST API.

`src/venues/polymarket-us.js` is a verified, standalone client for it — the signing scheme (`X-PM-Access-Key` / `X-PM-Timestamp` / `X-PM-Signature`, Ed25519 over `timestamp+method+pathname`) was confirmed against six real authenticated calls on a live account, not copied blind from docs. **It is not wired into the trading engine.** As of 2026-09-09 Polymarket US's entire open catalog is season-long futures (championship winners, election winners) — no daily games, no Fed-decision brackets — so it carries none of the markets this desk's 45 pairs already match against Kalshi. There is nothing for KETT to execute there yet. Order creation (`createOrder`) matches the published schema but has never been exercised — build and test that separately, on a funded account, before trusting it with size.

Credentials for it live in `.env` as `POLYMARKET_US_KEY_ID` / `POLYMARKET_US_SECRET_KEY`, unused by the running app.

## Does the trade actually exist?

Short answer, measured rather than assumed: **on liquid pairs, no.**

`tools/history-scan.js` pulls ~7 days of hourly prices for every matched pair from both venues and
computes what a Kalshi leg would have netted after spread and round-trip fees. Over 1,846 pair-hours
on properly-priced markets it found a **median venue gap of 0.50c against a median net edge of
-3.99c**, and **zero** hours where a trade cleared `MIN_EDGE`. Costs run about 4c round trip; the
venues disagree by about half a cent. That is not a threshold that needs tuning, it is an eight-fold
shortfall — which is why the desk correctly declines to trade, and why lowering `MIN_GAP` would only
buy the same answer with real money.

```bash
node tools/history-scan.js            # pairs from the running desk
node tools/history-scan.js data/ticks-2026-09-09.jsonl
```

`tools/replay.js` runs the same question against the recorded tape, using the *same* decision
functions the live desk uses (`src/decide.js` takes `now` as an argument and does no I/O, so a
file and a synthetic clock substitute for the network and the wall clock):

```bash
node tools/replay.js data/ticks-*.jsonl                      # what would it have traded?
node tools/replay.js data/ticks-*.jsonl --minEdge 0.002      # ...at a different bar
node tools/replay.js data/ticks-*.jsonl --sweep              # any bar at all?
```

The sweep is the one that settles it. Over a 1.1h tape the only grid cells that trade are the ones
where `MIN_EDGE` is **negative** — where you have agreed in advance to lose money: 5 trades, 0 wins,
-$18.63. Every other combination of `MIN_GAP` and `MIN_EDGE` takes zero trades. Loosening a
threshold buys more trades, not more edge.

Replay fills assume the whole order at top of book, because the tape records no depth. Every P&L it
prints is therefore an **upper bound**. A losing replay is conclusive; a winning one is a hypothesis
that still has to survive `data/probes-*.jsonl`.

The one unresolved case: three thin NCAAF markets where Polymarket sat near 50c while Kalshi priced
the same outcome at 1-2c, **for 51 to 89 hours**. Nominally a 20c+ edge. A real 20c edge on a binary
market is gone in seconds, so the overwhelmingly likely explanation is that there was no resting
size behind the Polymarket price. Neither venue publishes historical order books, so that cannot be
settled after the fact — the scanner flags such pairs `!` as **suspect** and reports totals with and
without them rather than pretending to know. `src/probe.js` settles it going forward: any live **pre-game**
gap over `PROBE_GAP` dumps both full ladders to `data/probes-*.jsonl`. Real depth means a strategy
(a different one than this desk trades). An empty book closes the thread.

The in-play exclusion was learned the hard way. The first four probes ever taken all landed on live
MLB games showing 13–22c gaps — and the books said both venues agreed. Kalshi's *listing* quote was
lagging its own order book: listing 0.425 against a book of 0.63/0.65. Since probes are ranked by
gap size and capped per cycle, that noise crowded out the pre-game cases the probe exists for.

Measured across the tradeable book, listing and order book agree to **0.00c median, 0.00c max**.
That is why there is no Kalshi equivalent of `refreshPairPrices()` — it would spend an API call per
pair per cycle to correct an error of zero. The lag is real, but only where the desk already
refuses to trade.

## What else was tried

Before building anything new, three other locked-arbitrage structures were measured live.
`tools/edge-scan.js` re-runs all of them in one command:

| structure | risk | result |
|---|---|---|
| Kalshi NO-basket across a mutually-exclusive event (pays ≥ N−1 whatever happens) | single venue | **0 of 190 profitable**, best −$0.024/basket |
| Polymarket ask(YES)+ask(NO) < $1 — the structure the IMDEA paper measured | venue-internal | **0 of 551** |
| Polymarket bid(YES)+bid(NO) > $1 (sell side) | needs inventory | **0 of 551** |

The shape of the Polymarket answer is the informative part: the modal book is
`askSum 1.0010 / bidSum 0.9990` — **one tick wide on each side, the tightest quote the venue
permits.** The arbitrage is not slightly too small here, it is structurally absent.

That is not a contradiction of the $40M finding. That paper measured profit *already extracted*,
across 86 million bets over a year, in windows that closed in seconds. It is evidence the
opportunity existed and was taken by faster infrastructure — not that it is sitting there waiting.

## Operating it

The dashboard is read-only. Two control endpoints exist, both POST, both requiring `FLATTEN_TOKEN`
from `.env` (unset = disabled; there is no default token):

```bash
curl -XPOST -H "x-flatten-token: $TOKEN" http://127.0.0.1:8787/api/flatten?reason=whatever
curl -XPOST -H "x-flatten-token: $TOKEN" http://127.0.0.1:8787/api/resume
```

`flatten` closes every open position at the mark and **latches an operator halt** that survives
TESS's own risk checks — a drawdown halt stops new risk while leaving existing positions running,
which is not the same as being flat. Only `resume` clears it. The server binds `127.0.0.1` by
default because `/api/positions` and the activity log are unauthenticated.

`data/journal-YYYY-MM-DD.jsonl` is the append-only record: every open, close, settle, failed exit,
flatten and resume, never rewritten. `state.json` stays the fast working copy, but it trims
`log` at 500 entries and `closed` at 2000 — oldest first — so the journal is the real history.

## Honest notes
- Paper results are not predictive. Cross-venue gaps on liquid pre-game and macro markets are usually 0 to 1c, so expect the desk to spend most of its time researching and to trade rarely. That is correct behavior, not a bug.
- The viral desk this is modeled on made most of its money trading a memecoin overnight, with prediction-market books as the smaller line. This project is the books side only. It does not trade tokens.
- Resolution rules differ subtly between venues on some events. A locked arb is only locked if both venues resolve the same way; the matcher is conservative but read both rulebooks before trusting a large one.

## Layout
```
server.js              HTTP + SSE server, .env loader, live-mode gate
src/config.js          all tunables
src/engine.js          state, cash, positions, cycle loop, snapshot
src/agents.js          the six desks
src/matcher.js         cross-venue matching
src/broker.js          paper broker + live Kalshi adapter
src/venues/            Polymarket (Gamma + CLOB) and Kalshi public data
public/                dashboard (index.html, style.css, app.js)
data/state.json        persisted account (created on first run)
data/ticks-*.jsonl     tick tape, one line per priced pair per cycle (RECORD=1)
```
