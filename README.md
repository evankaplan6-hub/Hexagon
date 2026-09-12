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
| 01 | **BRAM** | Pricing | Two signal types, at most one per pair per cycle, arb first. **Locked arb**: YES on one venue + NO on the other costs under $1 after fees, so it pays $1 at resolution regardless of outcome. **Convergence**: venues disagree by ≥ `MIN_GAP` (3c) on a pre-game or macro market. Fair value is the volume-weighted mid (the thin book is usually the wrong one), and the trade is whichever side of the off-fair venue is cheap relative to fair, YES or NO. The signal fires only if the **round trip** clears `MIN_EDGE` — see below. Exits when the venues agree again. |
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
- **A locked arb always outranks a convergence signal, and a pair emits at most one of them.** They
  are not the same asset — one is hedged and pays $1 whatever happens, the other is an unhedged bet
  that two venues will re-agree — so ranking them together by `edge` let a marginal directional bet
  jump the queue ahead of a risk-free one. On the same pair the arb is also nearly always the bigger
  number: gridded over 158k synthetic books it was available alongside a valid convergence candidate
  95,877 times and was the larger edge in all but 319, where convergence won by at most 0.43c.
- **The 2% position cap is a hard ceiling, and conviction scales inside it.** ILSA's read is a
  *fraction of* the cap, never a multiplier on top: a locked arb is hedged and takes the full 2%, a
  neutral convergence signal takes `BASE_SIZE_MULT` of it (0.8 → 1.6% of equity), and a converging
  read earns its way back up to the cap. So "sized up on ILSA flow" is still a real 25% more
  contracts, and `MAX_POSITION_PCT` is a number nothing can lift. The old path applied `budget ×
  1.25` on top of a budget that already *was* the cap, putting a high-conviction position at 2.5%
  of equity against a documented 2%.
- A crossed or non-finite book is rejected, not priced. `convEdge` subtracts `spread/2`, so a
  negative spread does not fail loudly — it *manufactures* edge and ranks first. Zero of the 30,817
  recorded ticks contain one, which is the argument for the check being cheap, not for omitting it.

## The tick tape

Every cycle the desk appends one JSON line per priced pair to `DATA_DIR/ticks-YYYY-MM-DD.jsonl`
(Eastern day, the same day boundary TESS rolls the drawdown limit on). `E.history` keeps 240 mids
per pair in memory and dies with the process; this file is the durable version, and the only way to
answer whether a tradeable gap ever actually existed.

Each line also carries `veto` — the single gate that stopped that pair this cycle (`gap under
minGap`, `edge under minEdge`, `mid outside band`, `spread over maxSpread`, `crossed book`) — so a
tape line explains itself without re-running the gates. BRAM narrates the same thing in aggregate
every five minutes as a *gate ledger*:

```
BRAM RESEARCH  gate ledger over 19 pairs · 8 gap under minGap · 6 mid outside band · 1 in-play · 1 edge under minEdge
```

"Nothing traded" is this desk's ordinary output, so the useful question is never *did it trade* but
*which rail stopped it* — and before the ledger that took a debugger to answer.

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

**`PROBE_GAP` was 0.10 and it never fired once.** Replaying the probe's own selection over the
recorded tape, the threshold is a cliff — 10c, 5c and 4c all take **zero** probes, because the
widest pre-game gap in 17,649 non-in-play ticks is 3.00c. Every probe currently on disk predates
the in-play filter. The instrument was dark for its entire life, and nothing said so.

It is now `MIN_GAP` (3c), which is not a tuned number: a gap under `MIN_GAP` cannot produce a
trade, so probing it validates nothing, and a gap over it is exactly the case the probe exists
for. Measured cost at that bar is ~6 probes/day — 13 API calls. The step down to 2c is a 20×
jump to 136 probes/day, all of it on gaps the desk would refuse anyway.

And because a probe that never fires looks identical to a probe that keeps finding nothing, TESS
now reports the difference:

```
TESS OPS  probe has taken nothing in 1h · widest pre-game gap seen 0.8c against PROBE_GAP 3.0c
```

One caveat on the calibration: the tape behind it is 7.6 **overnight** hours. NCAAF — the source of
the unresolved 20c cases — is a Saturday-daytime market, so 3.00c may be a property of that window
rather than of the book. The darkness line is what will say so, rather than another silent year.

The in-play exclusion was learned the hard way. The first four probes ever taken all landed on live
MLB games showing 13–22c gaps — and the books said both venues agreed. Kalshi's *listing* quote was
lagging its own order book: listing 0.425 against a book of 0.63/0.65. Since probes are ranked by
gap size and capped per cycle, that noise crowded out the pre-game cases the probe exists for.

Measured across the tradeable book, listing and order book agree to **0.00c median, 0.00c max**.
That is why there is no Kalshi equivalent of `refreshPairPrices()` — it would spend an API call per
pair per cycle to correct an error of zero. The lag is real, but only where the desk already
refuses to trade.

## The MAKER desk (07)

Everything above this line TAKES liquidity: buy the ask, sell the bid, pay a taker fee both ways.
That is roughly a 4c round trip against venues that disagree by about half a cent, which is why
seven days of measurement and a full threshold sweep found nothing. There is no 4c mispricing to
find in a book quoted one tick wide.

The seventh desk does the opposite. It **rests** quotes and is paid the spread, on the **13,774 of
Kalshi's 13,951 series whose `fee_type` is plain `quadratic`** and therefore charge makers nothing.
That filter is hard, not a preference: on series that do charge makers, the fee is ~73% of the
profit (the same twelve game markets score +$94 with real maker fees and +$354 at zero).

### The headline number was wrong by an order of magnitude

Backtested over ~68 days of real Kalshi trade tape across 34 fee-free markets, this reported
**+$2187 on ~$1350 of peak capital**, positive in 27 of 34 markets and robust to every stress
applied to it. That number is wrong, and the reason is worth more than the number was.

The simulation filled us whenever a taker crossed our price. Live, a resting order joins the **back
of the queue** at that price and fills only after everything already sitting there. So the actual
resting depth was measured, market by market, at the top of book:

```
queue ahead of a fresh order, across the 24 markets the desk was quoting
  min 9    p25 396    median 15705    p75 45491    max 231474  contracts
```

The median quoted market had **15,700 contracts already ahead of us**. Re-scoring every backtested
market against its own measured depth:

```
                        as backtested        with the real queue
development (34)      +$2187 / 105k fills    +$210 / 15k fills
out of sample (48)     +$679 /  57k fills    +$144 / 11k fills
```

**A 90% haircut**, and the largest correction this project has made. The edge is real — both sets
stay positive, out of sample included — but it is roughly **$150–250 per 68 days on under $1,000 of
working capital**, not two thousand dollars. Everything below is written against the corrected
numbers.

### Where the surviving edge actually lives

Split the same markets by how long the queue in front of us takes to trade through:

```
queue clears in < 1 day      +$357    29/49 positive
queue clears in 1-7 days      -$11    11/28 positive
queue clears in > 7 days       +$7     2/5  positive
```

All of it is in one bucket. That is now the desk's primary filter *and* its primary ranking, ahead
of spread, volume and trade rate alike: quote the markets where the queue clears fastest. Scored
with real depth it returns **+$240 development / +$160 out of sample**, against **+$199 / +$109**
for ranking on trade rate alone. Live, it moved the book from markets queued 15,700 deep to markets
queued 9, 29 and 30 deep — clearing in minutes rather than weeks.

### How much of this depends on the 10% guess

Participation — the share of a crossing trade we win once the queue ahead of us is exhausted — was
a flat 10% assumption. Scored with real queues under the live selection rule:

```
 participation   cap      development       out of sample     oos capital
      5%         100          +$173             +$111            $1076
     10%         100          +$240             +$160            $1073
     25%         100          +$371             +$230            $1019
     50%         100          +$517             +$322             $999
     10%         300          +$371             +$179            $3019
     25%         300          +$675             +$475            $3229
     50%         300         +$1040             +$583            $3305
```

Roughly linear, and positive in sign at every setting with 14–15 of 21 held-out markets positive
throughout. So the conclusion does not hinge on the guess — only the magnitude does. The desk runs
the most conservative cell (10%, cap 100), which is also the one the live paper book is testing.

### Replaying the maker

`tools/replay.js` scores the taker desks against the tick tape, and the tick tape carries no maker
rows: the maker fills off Kalshi's exchange-wide trade feed, which nothing recorded. So until
2026-09-12 a change to the maker could only be scored by deploying it. `tools/maker-replay.js`
closes that: `--fetch` pulls the full trade history for every market the desk has held over the
window the journal says it ran, and the replay runs the same `desiredQuotes` / `fillsFrom` /
`applyFill` on the same two-second cadence with the wall clock replaced by the tape.

```bash
node tools/maker-replay.js --fetch data/fly/kstrades.jsonl data/fly/journal-*.jsonl
node tools/maker-replay.js data/fly/kstrades.jsonl data/fly/journal-*.jsonl --markets
node tools/maker-replay.js data/fly/kstrades.jsonl data/fly/journal-*.jsonl --makerSoftCap 1 --queue 2000
```

Read the **difference** between two runs, not the level. The tape has prints but no book, so the
touch is reconstructed from the last print on each side; and it has no queue, so by default there
is none. Against the journal's first 2.25 days that reproduces the run-over fills within 2%
(2,083 contracts against 2,126 live) and over-counts at-touch fills six-fold, because a sweep
through our level does not care who was ahead of us and an at-touch fill does. No constant
`--queue` reproduces both -- at 5,000 the at-touch count is right and the run-over count has
collapsed to a quarter -- so the default is 0, where the number the desk is losing money on is the
one that matches.

### The ranking, re-scored walk-forward

The clear-time rule above was scored with each market's measured depth on a fixed set of markets.
The rework plan's worry about it was simple: a queue that clears fast is a level that gets swept,
and a sweep through a resting quote is a run-over, which is where this desk's money went (59% of
filled contracts in its first 2.25 days). `tools/maker-rank.js` puts three rankings against each
other **walk-forward**: rank on 21 days of tape, score on the 14 that follow, three folds over
the 66 days of Kalshi history behind the 440 mid-band markets open in the maker's series today.
Only the score window counts.

```bash
node tools/maker-rank.js data/fly/rank-listing.json data/fly/rank-trades.jsonl                 # no queue
node tools/maker-rank.js data/fly/rank-listing.json data/fly/rank-trades.jsonl --queue depth   # each market's own touch size
```

Out of sample, per market picked, 24 picks a fold:

```
                       queue 0            queue = own depth       queue 2000
clear-time (live)   +$4.31   16% run-over   -$0.54   24% run-over   +$1.71   15%
trades per day     +$20.16    8%            +$0.79   20%           +$10.92    4%
own replayed P&L   +$21.58    6%            -$0.69   22%           +$11.14    3%
```

Three things to read off that. **Clear-time is the worst of the three in every setting**, and
its run-over share is the highest in every setting, which is the plan's hypothesis measured: it
picks the levels that get swept. **Trades per day is best or tied in every setting** and beats
clear-time in every one of the three folds at real depth, on total and on run-over cost, with a
third of the run-over. **Ranking on a market's own past P&L is the textbook overfit**: best in
sample everywhere, negative out of sample in all three folds at real depth. And the level: with
each market carrying its own measured queue, the whole 681-pick pool nets **+$0.02 a pick** over
a fortnight at 10% participation. The ranking decides the sign of a small number.

What this instrument cannot see, so the rule is not changed on it alone: the book is reconstructed
from prints; the depth is today's, applied to July; the pool is the markets that are still open,
so every fold is scored on survivors. Shorter windows (14 days ranked, 7 scored, seven folds) and
fewer picks (12) give the same ordering. The live rule stays clear-time until the next tape says
the same thing.

### Three things that were tested and not built

**Inventory skew.** The desk rests at the touch on both sides and only withdraws a side at the cap.
Standard market-making says lean: when short, bid higher and offer higher so the next fill reduces
the position rather than growing it. The original code declined on the grounds that a 1c book has
nowhere to skew to — but many quoted markets are 4–9c wide, so the room exists. Scored with real
queues on the markets the live rule actually picks:

```
max lean          development      out of sample
0 ticks (today)      +$241            +$160
1 tick               +$265             +$85
2 ticks              +$259             +$35
3 ticks              +$263             +$22
```

Better in sample, sharply worse out of it, at every setting — the textbook overfit signature. It
does not even reduce peak inventory, which pins at the cap regardless. Not adopted.

**A per-market stop loss.** One held-out market lost $53: a trending book where the maker kept
buying down to the inventory cap. Measured before being built, and it loses money at every
threshold (−$30 at $40, −$22 at $25, −$52 at $15) while not reliably improving the worst market.
Stopping out a mean-reverting book locks in the loss and forfeits the recovery.

### Rails

Its ledger is separate from the taker book on purpose — one blended equity number makes it
impossible to tell which strategy is working. It carries its own `MAKER_MAX_DRAWDOWN_PCT`, because
TESS's drawdown watches the taker book and would never see this desk bleeding. `POST /api/flatten`
liquidates its inventory too, at the touch, paying the taker fee.

**Paper only.** What no simulation here can model: our own size changing other people's behaviour,
and Kalshi's real queue at our price level.

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
src/agents.js          the six desks (I/O and sequencing)
src/decide.js          the decision core: pure gate/rank/size/exit logic, no I/O and no clock
src/matcher.js         cross-venue matching
src/broker.js          paper broker + live Kalshi adapter
src/venues/            Polymarket (Gamma + CLOB) and Kalshi public data
public/                dashboard (index.html, style.css, app.js)
data/state.json        persisted account (created on first run)
data/ticks-*.jsonl     tick tape, one line per priced pair per cycle (RECORD=1)
tools/maker-replay.js  the maker desk against Kalshi's own trade history, same pure functions as live
tools/maker-rank.js    three market rankings for the maker, scored walk-forward on that history
tools/test.js          every suite in one command (npm test)
tools/decide-test.js   assertions for the taker decision core
tools/probe-test.js    assertions for the thin-market probe (stubbed venues, frozen clock)
tools/maker-test.js    assertions for the maker core: quoting, queue, fills, realised P&L
tools/broker-test.js   assertions for fills, incl. the live Kalshi order path (no network)
tools/matcher-test.js  assertions for cross-venue matching
tools/engine-test.js   assertions for the ledger: operator latch, partial exits, and close serialization
tools/golden.js        fixed-fixture output diff, for refactors meant to change nothing
```

`src/decide.js` is separated out so the same functions that decide live can be handed a recorded
tape and a synthetic clock (`tools/replay.js`) instead of a network and a wall clock. Two checks
guard it, and both are worth running after any change to the gates:

```bash
npm test                      # all 361 assertions across six suites
node tools/maker-test.js      # ...or one suite at a time while working on one file
```

Coverage follows the money, which took a while to admit. **The taker desk has never traded** — in
both journal days on disk every fill is a `MAKER_FILL`, 94 of them, and the taker book is empty.
The maker desk is the only code here that has ever moved a contract, and it was the code without
tests. `src/maker.js` is now the maker's `decide.js`: `desiredQuotes`, `fillsFrom` and `applyFill`
are pure, and `makerdesk.js` is the I/O around them.

### The realised-P&L bug those tests found

`applyFill` used to move the cost basis by **cash flow** (`cost -= qty × px`). That retires a closed
slice at the price it was *sold* at rather than the price it was *bought* at, so the basis left
behind belongs to no real position — buy 20 @ 40c then sell 10 @ 50c left $3.00 against ten
contracts genuinely held at 40c, an implied average of **30c**. Every later close then measured its
profit from that wrong mark:

```
buy 20 @ 40c, sell 10 @ 50c, sell 10 @ 50c   →   cash +$2.00, realised reported +$3.00
```

It was right on a *full* close (buy 10, sell 10) and on repeated equal-size round trips, which is
the idealised pattern the desk was reasoned about in — and why it survived. Variable fill sizes
produce partial closes constantly. The invariant that catches it, now asserted over six fill
sequences: **once a market is flat, total realised must equal the total change in cash.**

It had not yet corrupted the live ledger — every one of the 94 fills so far was one-directional
accumulation, so no market had done a closing fill and `realized` was still 0 everywhere. It would
have fired on the first two-sided market.

`makerdesk.flatten()` had the same hole from the other end: it moved cash and then zeroed `inv` and
`cost` without booking a cent of realised profit, so a desk flattened at a gain reported none. It
now closes through `applyFill` and takes the crossing fee off with it.

### The Fed brackets did not mean the same thing

Kalshi lists **`Hike 25bps`** and **`Hike >25bps`** — the second *excludes* 25. Polymarket asks
"by 25+ bps", which *includes* it. The matcher mapped the second to the first, and the recorded
tape confirms the desk was pricing that pair in production. Both legs of a "locked" arb on it would
settle opposite ways at exactly 25bps — the single most likely outcome of a Fed meeting. A question
that spans two brackets now pairs to nothing, which drops the universe from 19 pairs to 15.

The matcher's price-agreement guard could never have caught this: two brackets that overlap on most
outcomes price close together, and the guard only rejects disagreements over 30c.

### Known and not fixed

Named here rather than left in a transcript. None are reachable today; all are real:

- **`nameMatch` accepts a shorter Kalshi name as a longer, different Polymarket team** — "Washington"
  matches "Washington State". Fixing the heuristic blind, without a corpus of real venue names to
  score against, risks silently dropping good pairs to close a hypothetical one. It needs the
  corpus first, and `tools/matcher-test.js` documents the limit in the meantime.
- **`liveBalance` is fetched, streamed to the dashboard, and never constrains sizing.** In live mode
  the desk would size off `state.cash` — the paper-initialised balance — not the money actually at
  the exchange. This is a blocker for funding the account, not a bug in paper.
- **The maker's drawdown rail measures loss from `initialBalance`, not drawdown from peak**, so a
  book that runs +$500 and bleeds back to +$50 never trips it.
- **Same-date bucketing cannot separate the two games of a doubleheader.**
- **A market whose listing reports zero top-of-book size ranks first** (an empty queue looks like a
  queue that clears instantly) and is then modelled with no queue at all.
