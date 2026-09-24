# The Hexagon

[![test](https://github.com/evankaplan6-hub/Hexagon/actions/workflows/test.yml/badge.svg)](https://github.com/evankaplan6-hub/Hexagon/actions/workflows/test.yml)

A six-agent prediction-market trading desk that prices the same events across **Polymarket** and **Kalshi**, trades the disagreements, and streams everything to a live dashboard. Zero npm dependencies (the dashboard's chart is one vendored file, TradingView Lightweight Charts); Node 20+.

```bash
cd hexagon
node server.js            # paper account on live market data  →  http://localhost:8787
DEMO=1 DATA_DIR=./data-demo node server.js   # synthetic Kalshi noise so you can watch fills/settles (separate account file)
```

Copy `.env.example` to `.env` to change anything. State persists in `data/state.json`; `npm run reset` wipes the paper account.

## What it actually does

Every 15 seconds the engine prices every matched pair fresh -- Polymarket from the CLOB order book, Kalshi by ticker -- then runs the desks in order below. The two listings pairs are matched from are re-read every two minutes: the top 300 Polymarket markets by volume (`PM_UNIVERSE`, `PM_LIST_EVERY_SEC`) and every open market in 11 Kalshi series (Fed decisions, ATP/WTA, MLB, NFL, NBA, NCAAF, MLS, EPL, UCL, La Liga; `KS_SERIES`, `KS_LIST_EVERY_SEC`). Both were read every cycle until 2026-09-22, when they were half of everything the desk downloaded on a box pinned at its CPU cap.

| # | Agent | Desk | Job |
|---|-------|------|-----|
| 05 | **HOLT** | Scanner | Matches the same outcome on both venues: Fed brackets and games from a fast matcher, every other category from the any-market scanner (see *Any market*). Fast matcher: Fed brackets by month/code; games and matches by team/player name plus US/Eastern date. Rejects any match where a figure in the text — a year, a date, a percentage, a bps count, a dollar amount, a bare number like a doubleheader's game number — differs between the venues, and any match where the venues disagree by 30c+; either means the match is wrong. |
| 06 | **ILSA** | Sentiment | Tracks each pair's price drift and whether the venue gap is narrowing or widening. Execution skips trades ILSA reads as diverging and sizes up ones it reads as converging. Also runs whale watch: calls out big bets by top wallets on Polymarket's sports, politics, economics, crypto, culture, tech and finance leaderboards (advisory only). |
| 04 | **TESS** | Ops | Health and risk: halts new risk on stale quotes, API error storms, or a daily drawdown past the limit. Sets the per-trade budget. |
| 03 | **RIGO** | Settlement | Marks positions, exits convergence trades (gap closed, stop, max hold, event going in-play, or its Kalshi market about to close), settles resolved markets at their settlement price ($1, $0, or 50c when Polymarket resolves a question 50-50), realizes P&L, scores wins/losses. |
| 01 | **BRAM** | Pricing | Two signal types, at most one per pair per cycle, arb first. **Locked arb**: YES on one venue + NO on the other costs under $1 after fees, so it pays $1 at resolution regardless of outcome. **Convergence**: venues disagree by ≥ `MIN_GAP` (3c) on a pre-game or macro market. Fair value is the volume-weighted mid (the thin book is usually the wrong one), and the trade is whichever side of the off-fair venue is cheap relative to fair, YES or NO. The signal fires only if the **round trip** clears `MIN_EDGE` — see below. Exits when the venues agree again. |
| 02 | **KETT** | Execution | Pulls the real order books on both venues, re-verifies the gap from live books (listings lag), sizes to depth and budget, fills, and unwinds the first leg if the second leg fails. |

Fees are modeled on both venues, and both have the same shape. Kalshi: `ceil(0.07 × multiplier × contracts × P × (1−P))`, with the multiplier read for every series from one `GET /series` call at startup (0.5 on MLB, 0 on a few politics and crypto series, 1 almost everywhere else). Polymarket: `shares × rate × P × (1−P)` at each market's own `feeSchedule` rate — 0.07 crypto, 0.05 sports, economics, culture and weather, 0.04 politics, finance, mentions and tech, 0.03 sports futures, 0 on geopolitics. Until 2026-09-15 the desk modelled Polymarket as free; 250 of the top 300 markets by volume, including the Fed pair it traded, are not. A market that publishes no rate is priced at `PM_FEE_FALLBACK` (0.07), so not knowing never makes a trade look cheaper. Fills walk the ask ladder, so size is limited by real depth.

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

Practical consequence: at mid prices this strategy needs a genuinely wide gap (~8c) to pay on either
venue. It gets much cheaper near the tails, and cheapest on the few fee-free markets (Polymarket
geopolitics, Kalshi's zero-multiplier series). **Live mode is Kalshi-only** — read that section
before funding anything.

### Guardrails baked in
- Game pairs become untradeable 2 minutes before start. In-play prices move faster than any listing refresh, and the biggest "gaps" you'll see are exactly those.
- Every pair becomes untradeable `CLOSE_GUARD_MIN` (60) minutes before its Kalshi market closes, and a convergence position on it is flattened then, even if the pair has already gone. Scheduled prints close their Kalshi market just before the number lands — the Fed at 17:59Z for an 18:00Z statement, CPI at 12:25Z for 12:30Z — while Polymarket trades straight through. Before this only games had a rule, so a Fed position could lose its Kalshi quote a minute before the statement and ride it on the Polymarket leg. A convergence trade is also never opened on a market that closes inside max hold plus the guard. Close time is an extra rule for games, never a replacement: Kalshi game markets close days after the game.
- A locked arb whose first venue has settled is `half_settled`, not broken. Kalshi settles the Fed minutes after the statement; Polymarket waits hours for UMA. The open leg is valued at the complement of what the settled leg paid.
- Convergence trades are never opened on markets priced under 3c or over 97c (tick noise), or where the cheap venue's spread is over 5c.
- Paper convergence trades stop at the tighter of a 6c loss per contract (`STOP_LOSS`) or a 20% loss from entry (`PAPER_STOP_LOSS_PCT`). The percentage rail keeps a cheap contract from falling almost to zero before the flat 6c stop can fire. Locked arbs are exempt because their two legs are held as one hedged $1 payout. The percentage rail is paper-only; it does not change live-mode exits.
- Max 2% of equity per position, 12 open convergence bets, 12 locked arbs (counted per arb, not per leg), 3% daily drawdown halt, 90-second stale-data halt. All in `.env`. The two books were one limit over legs until 2026-09-15, when six hedged Fed arbs filled all twelve slots.
- **The convergence book has a switch** (`CONVERGE=0`), and on the Fly box it is off since 2026-09-21. The journals' verdict for 2026-09-10 to 09-21: 72 convergence bets closed, 3 winners, −$637 (−$293 of it fees); the gates added on the 18th and 19th only made it lose more slowly. Off, the scanner opens no new convergence position and a mind's proposal is dropped as `convergence book off`; open positions are still marked and taken to their exits, locked arbs and the maker are untouched, and every pair is still priced, vetoed and written to the tape, so the book can be re-scored from the tape without trading it.
- The daily drawdown window rolls at midnight **US/Eastern**, matching the dates the matcher pairs games on (a UTC roll would reset the limit at 8pm ET, mid-slate).
- **A locked arb always outranks a convergence signal, and a pair emits at most one of them.** They
  are not the same asset — one is hedged and pays $1 whatever happens, the other is an unhedged bet
  that two venues will re-agree — so ranking them together by `edge` let a marginal directional bet
  jump the queue ahead of a risk-free one. On the same pair the arb is also nearly always the bigger
  number: gridded over 158k synthetic books it was available alongside a valid convergence candidate
  95,877 times and was the larger edge in all but 319, where convergence won by at most 0.43c. With
  Polymarket's taker fee priced in (at the 0.07 fallback) the same grid gives 72,341 cells, 9
  exceptions, and at most 0.12c.
- **The 2% position cap is a hard ceiling, and conviction scales inside it.** ILSA's read is a
  *fraction of* the cap, never a multiplier on top: a locked arb is hedged and takes the full 2%, a
  neutral convergence signal takes `BASE_SIZE_MULT` of it (0.8 → 1.6% of equity), and a converging
  read earns its way back up to the cap. So "sized up on ILSA flow" is still a real 25% more
  contracts, and `MAX_POSITION_PCT` is a number nothing can lift. The old path applied `budget ×
  1.25` on top of a budget that already *was* the cap, putting a high-conviction position at 2.5%
  of equity against a documented 2%.
- **A convergence trade needs a thick venue to lean on.** Fair value is volume-weighted, so when
  the two venues carry similar volume it sits in the middle of the gap and the realisable move is
  half of it. The desk's largest taker loss was exactly that: a Fed pair at near-equal volume,
  1,175 contracts, −$11.75. A pair is now vetoed as `venues too even` unless the thick venue has
  `CONV_MIN_VOL_RATIO` (3) times the thin one's 24h volume. On the 54 hours of tape from the
  cloud box it removes every trade the sweep would have taken at a non-negative `MIN_EDGE`,
  including the one winner.
- **A locked arb is unwound early only when it beats holding, net of the exit fee.** Both legs
  sold at their bids pay `bidSum` a pair now against $1 at resolution for free, and the Kalshi
  leg pays a taker fee on the way out. The old `bidSum > 1.005` test ignored that fee and unwound
  three pairs on the cloud box for $1–3 each that would have settled for $2–6. `decide.arbUnwind`
  now requires `(bidSum − 1) × qty − fee` to clear `ARB_UNWIND_MARGIN` (0.5c) a contract.
  **And the marks are only the question; the live books are the answer (2026-09-24).** The Debut arb
  on 09-23 unwound on marks its books could not pay: it made −$8.75 against +$1.52 for holding, with
  180 `EXIT_FAIL`s on a naked Polymarket leg, and the three unwinds since #100 netted −$8.06 against
  holding. Now, once `arbUnwind` says look, RIGO reads both exit ladders (at most once a minute per
  arb) and `decide.arbUnwindLive` walks each down to its mark less `SLIP_LIMIT`, takes the quantity
  both can absorb, charges each leg's fee at its own average fill, and passes (the legs stay whole)
  unless that still clears the margin on at least 5 contracts. RIGO sells the **thinner leg first**
  (Polymarket on a tie); the other leg then sells exactly as many as the first did, and only its own
  shortfall is flagged stuck (`orphanQty`) and retried, never the part that is still hedged.
- **A held Polymarket leg is marked from its order book, even after its pair is gone
  (2026-09-24).** Matched pairs were always repriced from the CLOB, but a leg whose pair had dropped
  out of the matched set fell back to Gamma's listing price, which goes stale (a 0.72/0.73 listing
  against a 0.78/0.80 book); about 13 of 20 open arbs were being marked that way on 09-24. Those legs
  are now priced in the same CLOB call, as the Kalshi half already was.
- **Venues more than 30c apart are two different questions** (`venues disagree 30c+`, 2026-09-24):
  `decide.pairSignals` emits nothing for a pair where one venue's bid is over the other's ask by more
  than 30c. New entries only. The press-ban arb and the US Spotify chart are the cases (*Look-alikes
  the rules judge was shown*).
- On a fee-free Polymarket market, the directional leg of a convergence trade already lands on Polymarket whenever the venues are
  similarly off fair: `convEdge` nets each venue's fees, and Polymarket's is zero, so it wins by
  exactly the Kalshi round trip. Pinned by a test rather than a rule.
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
- **The maker's market data shares the file** (`src/makertape.js`, `RECORD_MAKER=0` turns it off).
  Lines with an `mk` field and no `pair`: `b` is the top of the book with both sizes, written on
  change and once a minute otherwise (`hb:1`); `p` is a print with the exchange's own timestamp;
  `q` is our resting quote and inventory (with `"ro":1` since 2026-09-24 when the quote is
  reduce-only, so a replay clips its fills at flat the way the desk does); `g` marks a hole in what was observed (a stop, a failed
  data round, a skipped poll, a lost write, and the return after one), because a stop withdraws
  every quote and a replay that read only `b`/`p`/`q` would see the last quote rest straight through it. Nothing new is fetched: the maker already reads these
  every two seconds and used to discard them. They exist so `tools/maker-replay.js` can replace
  its reconstructed touch and guessed queue with the real ones. About 25 MB a day (09-23); the disk
  brake and the pull already cover the file. `tools/replay.js` and `tools/history-scan.js` skip
  lines without a `pair`.
- Append-only, never rewritten, rotating by filename at Eastern midnight. A failed write logs once
  (rate-limited) and the cycle continues; the tape can never halt the desk.
- About 90–130 MB a day since 2026-09-19, when sports joined the crawl (several hundred pairs over a
  day, plus ~25 MB of maker lines). On the Mac nothing prunes them; on the box `tools/fly-pull.js
  --trim` keeps the newest three days and the disk brake (`TAPE_MIN_FREE_MB`) trims more if the pull
  stops. `data/` is gitignored, so they stay local. Set `RECORD=0` in `.env` to turn the recorder off.

## Dashboard
Balance history with settlement bars, activity log with per-agent color and P&L, venue feed (top Polymarket, top Kalshi, matched pairs with live gap), a pixel trading floor whose six agents animate when their desk is running, agent cards, and an open-positions table. It updates over Server-Sent Events every 2 seconds.

**The stream is slim and gzipped (2026-09-24).** Every open tab was sent the whole 494 KB desk snapshot
every two seconds, uncompressed (Fly compresses `/api/state` but not an event stream): about 21 GB a
day per tab, and 295 KB of each frame was the maker's 5,000 one-minute equity samples and the
account's balance history, series that gain one point a minute. The stream's frames now leave both
out, and the page fetches them from `GET /api/history` (behind the same login) at start and every 60
seconds, as it does `/api/volume`. `/api/state` still answers everything, for the tools. The stream
goes through one gzip per tab (`src/sse.js`, level 1, flushed after every frame so each arrives
whole): a 248 KB frame comes to about 53 KB. The chart line and the wall's *Today* both end on the
live value from the latest frame, so the history being up to a minute old does not show. A tab left
open across that deploy had no history until it was reloaded.

**Indicator panes.** The large P&L chart has an Indicators switch (on by default, remembered in the browser) that adds two panes under the price, on the same time axis and zoom. *Momentum* is MACD 12/26/9 on the P&L, counted in candles, so it follows the chosen candle size; it answers "is the last stretch running ahead of the last few hours", which the candles alone cannot. *Maker P&L not yet banked* is the maker's whole P&L less its realised P&L (`e - c` in `maker.hist`): the gain or loss on contracts still held, which goes away if the marks move before the desk gets out. (`m` in that history is the marked value of the inventory, not a profit.) The Fly box's realised total still carries a fixed error of about $7 from the bookkeeping bug fixed on 2026-09-12, so the page measures that gap from the live book (each market's mark less its cost) and takes it off every sample. The taker's positions are not in it. Both panes only describe the desk; nothing trades off them. The small floor chart and the phone card have no room for them.

**Ask.** The Ask button opens a chat drawer beside the floor. Type a question ("why hasn't the desk traded today?", "did the Vikings win?") and Claude answers from the desk's own data: positions, trades, the activity log, journals, matched markets, the maker, whale bets, the settings and these docs, a stock or crypto ticker on ChartExchange when that key is set (a quote, short volume, dark-pool prints or max pain, each answer saying how stale it is), plus a couple of web searches when the real world matters. It is read-only: it cannot trade, sell, or change a setting, and says so if asked. It needs `ANTHROPIC_API_KEY`, has its own ceiling (`ASK_DAILY_USD`, $3 per Eastern day, which survives restarts because every charge is journalled as `ASK_SPEND`), and a typical answer costs $0.05–$0.15. On the Fly box only RIGO's mind is on (`BRAIN_AGENTS=RIGO`): it may close a convergence position early, only after the deterministic exits have said hold, and it never opens or sizes anything; it spends at most `BRAIN_DAILY_USD` ($1) a day. ILSA's mind, which can propose trades, is off. Adding the key turns on RIGO, Ask and Research together:

```bash
fly secrets set ANTHROPIC_API_KEY=...   # run it yourself; the box restarts with Ask on
```

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

**Then it fired 5,000 times a day (fixed 2026-09-24).** Once the any-market scanner paired every
category (2026-09-15), the same 3c bar took 5,200 to 8,800 probes a day, two full order books each,
99% of them the same ~150 long-dated event pairs every 600 seconds, and 3,005 of 09-23's 5,206 on
watch-only pairs that cannot trade. Now a watch-only pair is never probed, a pair is probed once per
ET day and again that day only if its gap has moved by `PROBE_MOVE_GAP` (1c) since, never sooner than
`PROBE_EVERY_SEC`, and the cycle no longer waits for the probe before KETT acts. Replayed over the
09-21 to 09-23 probe files that is 190 to 430 probes a day on 66 to 79 pairs. The darkness line below
now speaks only when nothing reached `PROBE_GAP`, since a gap already probed today is the probe
working.

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

## Any market, not just games and the Fed

HOLT's fast matcher pairs eleven Kalshi series (Fed decisions and ten game series) against the top
300 Polymarket markets every cycle. Everything else on both venues — elections, economics, central
banks, Treasury yields, awards, charts, deadlines, world events — comes from the **any-market
scanner** (`src/anymarket.js`), in two speeds:

- **discover**, every `DISCOVER_EVERY_MIN` (20 by default, 90 on the box), off the cycle: crawl every
  open event on both venues, sports included since 2026-09-19 (`src/discovery.js`, Kalshi pages spaced
  `DISCOVER_GAP_MS` apart; on the box ~43,000 Kalshi and ~15,000 Polymarket markets in about two
  minutes on 2026-09-24), match outcomes (`src/match-any.js`), and give each pair a rules verdict (`src/rules.js`).
- **refresh**, every cycle: reprice only the matched markets — one Kalshi call per 100 tickers, one
  Polymarket CLOB call per 200 tokens. A market that fails to reprice keeps its old time, and its
  pair goes stale rather than trading on an old price.

On 2026-09-15 the first live scan crawled 23,261 Kalshi and 9,018 Polymarket markets in 7 seconds
and matched about 400 outcomes, mostly elections, entertainment, politics and economics
(`ANY_MAX_PAIRS` keeps the busiest 300, verified pairs first).

**The matcher** pairs an outcome only when it is the same person, party, deadline or threshold:
"Ashley Hinson (R)" is "Ashley Hinson"; "by September 30" is "Before Oct 1, 2026"; "≥4.0%" is
Kalshi's "Above 3.9%" on a one-decimal statistic; "R Senate, D House" is "D-House, R-Senate". It
rejects, by name, a threshold one tick off ("dip below 4.67%" is not "4.67% or below"), a complement,
a nomination against a win, 4th place against first, Best Actress against Best Supporting Actress,
one lab's best model against any model's, SPD at 31% against AfD at 31%, and a Polymarket "Other"
bucket. `tools/match-any-test.js` pins each of those on the venues' real text.

**Only pairs whose rules are verified the same trade.** A locked arb is only locked if every outcome
settles both legs identically, and look-alikes often do not while trading within a few cents: of 76
politics pairs whose full rules were read side by side, 23 resolved differently. Polymarket's
"Netanyahu out" counts death and Kalshi's does not; Polymarket pays on an announced resignation,
Kalshi on an actual departure; Polymarket's NYC temperature is LaGuardia, Kalshi's is Central Park;
every crypto price pair uses a different oracle. So each pair gets a verdict:

| verdict | from | what happens |
|---|---|---|
| `different` | a denylisted family, or a rule dimension both texts speak on and disagree (death, announcement vs departure, acting holders, de facto vs official, weather station, price or poll source, ties) | dropped |
| `same` | an allowlisted family read by hand (chamber control, party races, nominations, TIME, Billboard, CPI and jobs releases, Treasury yields, Fed and central-bank decisions, ...) with no conflict | tradeable |
| `unclear` | everything else | priced and recorded, never traded (`rules unclear` in the gate ledger) |

An `unclear` pair that shows an edge can be put to Claude once per pair of rules texts
(`RULES_CHECK`, `RULES_DAILY_USD` $1), cached in `DATA_DIR/rules-verdicts.jsonl`. A Claude `same`
never overrides a conflict the deterministic check found, and nothing is asked without
`ANTHROPIC_API_KEY`.

**Long-dated arbs are a different trade.** Outside games most arbs settle months or years out:
J.D. Vance for the 2028 nomination crossed 2.46c after fees on 2026-09-15 and settles in 785 days,
about 1.2% a year. Three rails follow from that:

- a locked arb must return `ARB_MIN_APR` (5%) a year on the money it ties up until expected settlement;
- at most `MAX_LONG_ARB_GROUPS` (3) arbs may settle more than `LONG_DAYS` (30) out;
- an any-market signal must persist `ENTRY_PERSIST_CYCLES` (4, one minute) before KETT acts, and
  every locked arb is re-priced on the order books fetched for it before its first leg.

On the first local paper run the desk took the Nevada governor's race (Lombardo, R): YES on
Polymarket at 47.2c and NO on Kalshi at 47.0c, 3.3c a contract after both venues' fees, settling in
January 2027. Two more long-dated arbs filled the budget and it passed on the next.

Any-market pairs are written to the tick tape when a price or veto changes and on a
`RECORD_HEARTBEAT_MIN` (15) heartbeat; `tools/replay.js` carries them forward between lines.

### Fights, and the wall around sports

The crawl skipped Sports on both venues until 2026-09-19, on the reasoning that the taker's fast
path (`KS_SERIES`) already covered games. It did not cover everything: those eleven series are all
**team-game** series, so fights — UFC and boxing, listed on both venues and settling on one
unambiguous result — were never crawled, never paired, and never seen. UFC 331 was eight fights live
on both venues and the scanner matched nothing.

Two things had to change, and neither was enough alone.

**The wall.** `DISCOVER_EXCLUDE_KS` and `DISCOVER_EXCLUDE_PM` are the lists now, both empty by
default; `src/discovery.js` still defaults to excluding Sports, so only the desk opts in. Measured
the night it shipped, with the keep filter the desk passes: Kalshi roughly doubles (22,232 → 45,051
markets), Polymarket more than **triples** (8,762 → 29,605), because sports floods a listing ranked
by 24h volume and the crawl runs until it drops below `PM_DISCOVER_MIN_VOL`. Heap went from 92 MB to
300 MB on a 512 MB box, which is not a margin worth having. Raising that floor from $500 to $5,000
is what pays for sports: Polymarket comes back to 13,290 markets and 25.6 MB, heap settles at
**148 MB**, and every fight on the card survives — the first floor that drops one is $25,000.

**The shape.** Everything else here pairs one Kalshi market to one Polymarket YES, on token 0. A
fight is not that shape. Polymarket lists the bout as ONE market whose two *outcomes* are the
fighters; Kalshi lists it as TWO markets, "Alexandre Pantoja wins" and "Joshua Van wins". So the
generic path missed it twice over: the Polymarket side has no `groupItemTitle` to match a name
against, and the loser's leg lives on token 1, which no candidate was ever built for. `matchAny` now
recognises two *named* outcomes (Yes/No, Over/Under and Draw/Tie stay on the generic path) and emits
one candidate per Kalshi leg on its own token, and the de-duplication keys on the **token** rather
than the market id — otherwise the second fighter is thrown away as a duplicate of the first.

The gate is narrow on purpose: both Kalshi legs must name a fighter and they must name *different*
ones. That is stronger here than the generic proper-noun check, which would reject the pair outright
for "Flyweight" and "Main Card" — words that describe the bout, not the outcome.

It found 12 fight pairs on the remaining UFC 331 card, both tokens correct, plus 56 more of the same
shape across tennis, NCAAF, MLS, Serie A and League of Legends — 68 pairs that were invisible before.

**None of them trade.** Nothing in the rules allowlist is a sports family, so every one lands
`unclear` and is watch-only. A sports pair can only begin trading if the Claude rules judge upgrades
it, which needs `RULES_CHECK`, a key, and stays under `RULES_DAILY_USD` ($1 a day; `ASK_DAILY_USD` is
the Ask panel's own cap and does not touch this). A pair whose venues sit more than 30c apart is never
put to the judge at all (*Look-alikes* below).

`tools/ufc-scan.js` prices a card on both venues by hand, cross-venue and within Kalshi, and flags a
pair only when it clears both venues' fees. On UFC 331 it found no pre-fight arb at all — six of
eight fights priced *identically* on both venues, against a fee floor of ~3c. What it did catch was
the post-decision lag: Kalshi marked the winner 99/100 within seconds of the finish while Polymarket
still offered him at 93c, worth ~6.7c net, for about 90 seconds. Note that Gamma's `bestBid`/
`bestAsk` go stale during a fast move (83/85 against a real book of 86/91), so that scan reads the
CLOB directly; trading the listing price would have chased an arb that was not there.

### Wrong games: doubleheaders, team names, the sport, tennis (2026-09-24)

The fast matcher pairs a game by the two team names and the US/Eastern date. Four ways that went
wrong, all fixed the same day:

- **A doubleheader paired game 1 with game 2.** On 2026-09-22 Polymarket's Rays-Yankees game 1
  (17:05Z) paired with Kalshi's game 2 (`KXMLBGAME-26SEP221905TBNYYG2`): the matcher took the first
  event whose names matched on the date, and neither venue writes "Game 1/2" where it reads. The desk
  booked a $183.40 "locked" arb across two different games, which both legs lose when the Rays drop
  game 1 and take game 2, as they did; only an early unwind (+$5.17) saved it, and the real game 2
  went unpaired for a day. The matcher now collects every candidate event and, with two or more, takes
  the one whose ticker start time (the HHMM in the Kalshi ticker, read as US/Eastern) is nearest
  Polymarket's `gameStart`, within 120 minutes; with none carrying a time it refuses. A single
  candidate has a looser 150-minute bound, still under a doubleheader's gap (360 minutes that day), so
  Polymarket's game 1 cannot fall back to Kalshi's game 2 once Kalshi's game 1 has closed. Refusals are
  logged as `start time`, and HOLT's scan line counts them apart from 30c disagreements (`N on start
  time`). The cost: a lone pair drops if Polymarket moves `gameStart` by more than 2.5 hours (a long
  rain delay) while Kalshi's ticker keeps the old time. NFL, NCAAF, soccer and tennis tickers carry no
  time, so a single candidate there pairs as before and two on one date are refused.
- **The White Sox and the Athletics never paired.** Kalshi names them "Chicago WS" and "A's"; none of
  the 154 `KXMLBGAME` pairs on the 09-10 to 09-24 tapes was either team's. An alias for Kalshi's MLB
  sides fixes both, and "Chicago WS" still never pairs with the Cubs.
- **The sport was guessed from the names.** Valorant, League of Legends and cricket moneylines were
  filed as college football, which made HOLT's renamed-team alarm fire eight times on 09-24 for "NCAAF
  0 of 6". The league now comes from Polymarket's slug prefix first (`cfb`, `mlb`, `nfl`, `nba`, `atp`,
  `wta`, `epl`, `ucl`, `mls`, `lal`), and a prefix it does not know adds nothing.
- **Tennis stopped pairing after 09-13**, when Polymarket dropped "ATP" from its questions. It is found
  by the `atp-`/`wta-` prefix again, looks one ET day back as well (the overnight Asian swing), and is
  left out of the blind-league alarm, since Polymarket lists only a few matches of each draw and its
  Challengers share the `atp-` prefix. **Tennis pairs are watch-only** (`differ on a walkover`):
  Polymarket pays 50-50 on a walkover and Kalshi "a fair price" (the Davis Cup case in
  `tools/rules-test.js`), so a tennis "locked" arb is not locked. Game pairs skip the rules gate, which
  is why the matcher marks them itself.

### Look-alikes the rules judge was shown (2026-09-24)

- **A 30c gap is a different question, not an arb.** On 2026-09-19 the watch-only press-ban pair
  showed a 61c arb when Kalshi's bid jumped to 0.75 on 40 contracts against Polymarket's 0.06/0.07.
  The scanner put it to the Claude rules judge, which answered `same` fifteen seconds later, and the
  desk booked $67.15 on it a minute after that. Now a pair whose books are more than 30c apart at their
  nearest prices (one venue's bid over the other's ask by more than `MAX_VENUE_DISAGREE`, a constant
  in `src/matcher.js`, not a setting) is not sent to the judge, and `decide.pairSignals` vetoes it
  for every pair as `venues disagree 30c+: likely different questions` (new entries only; exits, marks and settlement are untouched). The test is on
  the books, not the mids: Kalshi's book was 10c wide that minute, and a test gated on narrow books
  would have let it through, while an 80c-wide book that overlaps the other venue does not trip it.
- **The US chart is not the worldwide chart.** "Top US Spotify Artist 2026" paired with Kalshi's
  worldwide `KXTOPARTIST` and was allowlisted `same` (Bad Bunny 0.006 against 0.83, a 62c signal for 25
  minutes on 09-20). The event gate now refuses a Spotify, Netflix, Google or YouTube title where only
  one side names the US (Billboard's charts are the US ones on both venues, so it is left alone), and
  the `KXTOPARTIST` allowlist refuses a Polymarket title with a standalone US, U.S., USA or United
  States.
- **Qualifying is not winning.** `qualify` is an event family now, so Kalshi's "qualify for Euro
  2028" no longer pairs with Polymarket's Euro 2028 winner (94c apart on 09-23).

## The settlement snipe

Polymarket settles a game the moment it ends: its book goes to 99/100 on the winner (bids at 99c,
nothing offered) and the market closes seconds later. Kalshi's book for the same game does not. On
four days of tape (2026-09-19 → 09-22, about 180 game pairs, `tools/settle-lag.js`) Kalshi's fresh
quote was still offering the winner 3c to 13c under par in ten games at the moment Polymarket
settled: Vikings 86c, Saints 87c, Guardians 88c, Nationals 90c, the Royals' opponent at 89c. That
is 13c a contract net of Kalshi's fee on the best of them, on a quote a second old.

The desk never took it, for two reasons that are now fixed. In-play pairs are excluded from every
other rule (`decide.liveWindow`), so nothing looked. And the pair was dropped the cycle Polymarket
closed, because Polymarket's listing only returns open markets, so the tape stopped 15-30 seconds
after the settlement and nobody knows how long Kalshi stayed under par or how deep it was.

Since 2026-09-23 (`SNIPE=1`, paper): when Polymarket has settled a game and Kalshi still offers the
winner, KETT buys it on Kalshi at the ask, up to `SNIPE_MAX_QTY`, if Kalshi already bids at least
`SNIPE_MIN_KS_PRICE` for that winner (a 44c book on a "settled" game is not an edge), the Kalshi quote is under `SNIPE_MAX_KS_AGE_SEC` old, and the live book still
clears `SNIPE_MIN_EDGE` after the fee. HOLT keeps a game pair Polymarket's listing has dropped for
`SNIPE_HOLD_SEC`, flagged `pmGone` on the tape, with its Kalshi side still repricing, and game rows
now carry Kalshi's top-of-book sizes. The position is held to Kalshi's settlement like any other.
It is the only Kalshi-only edge the tape has shown. Two things it is not: an in-play strategy (it
acts after the final whistle), and anything to do with the maker.

**A 99c bid is not a settlement (2026-09-24).** On 09-19 NC State read 0.99/1 on Polymarket for 2m15s
with Kalshi at 94/96, then traded back down to 4c and lost: the first version would have bought 100 at
96c. So a 99c reading is now only the reason to ask. KETT fetches Polymarket's market record and buys
only once it says `closed` or `resolved`, and not when the record says the other side won; a failed
lookup is a pass, logged at most once a minute (`KETT PASS ... has not closed the market`). Every edge
in the study above was measured *before* Polymarket closed the market, so it has to be measured again
after the close, and the snipe may now fire rarely or never: the pair is kept only `SNIPE_HOLD_SEC`
(300s) after Polymarket's listing drops it, and if Polymarket marks the market closed only once it is
formally resolved, later than that window, the two never meet. That fails safe (no trade, never a
wrong one). Judge it on Sunday 2026-09-27, and read a silent Sunday as "the window closes before
Polymarket does", not as "no edge". The "different game" case the Kalshi price floor was written
for turned out to be the Rays-Yankees doubleheader on 09-22 (Polymarket's game 1 paired with Kalshi's game 2, 10c against
45c), which the matcher now refuses by start time (*Wrong games* above); the Yankees v Diamondbacks
row the floor was set on was the same game.

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

### The universe was a hand-written list, and that was the ceiling

The desk chose its markets from `MAKER_SERIES`: 38 series, typed out by hand, one listing call each.
Kalshi runs **13,929 series whose `fee_type` is plain `quadratic`** and therefore charge makers
nothing. The desk was looking at 0.3% of them, and no amount of tuning the ranking changes what is
not in the pool.

The any-market scanner already walked every open non-sports Kalshi event every `DISCOVER_EVERY_MIN`
(measured 2026-09-16, before sports was added: 41,155 markets over 66 pages) and then threw the crawl
away. So the wide
universe costs **no call of its own**: `src/maker.js candidatesFrom` filters that same crawl with the
same cheap filters the series scan used (fee-free series, price in band, spread at least a tick,
`MAKER_MIN_VOL24` traded in 24h, at least `MAKER_MIN_DAYS_TO_CLOSE` to run).

```
2026-09-16, the same filters over the two sources
  MAKER_SERIES, 39 listing calls        39 quotable markets across 38 series
  the crawl, 0 extra calls             123 quotable markets across 73 series
                                        37 of the 38 listed series are in it anyway
```

Three times the pool, and the binding constraint is visible in what it rejects: of the markets the
crawl offers, **29,729 fail on liquidity** and 10,179 on price band, against 1,012 on maker fees. The
list was never selecting for quality — it was just a list.

**Widening the pool is not widening the book.** `MAKER_MARKETS` (24) still caps what is quoted, the
trade-rate probe still picks it, and the run-over gate still benches markets that keep getting swept.
The change is what the probe gets to choose from.

**And on 2026-09-23 the widening went off again on the box.** Four days of the maker's own tape,
marked 30 minutes after each fill (`tools/maker-slice.js`), put the loss in the widened markets:
-0.66c to -1.82c a contract there against -0.34c to -0.64c on the listed series, and two thirds of
the contracts. The same tape gave the maker its one useful signal, Polymarket's price for the same
event: fills placed with it marked flat, fills placed against it lost, every day. That is the fair
rail (`maker.fairSide`, `MAKER_FAIR_RAIL`): a side that would trade against Polymarket is not
rested. It stops the bleeding on the paired book; it does not make the book profitable, and nothing
else tried on that tape (mid velocity, book lean, flow direction, spread, quote age, inventory, fill
size) did either. Since 2026-09-24 the rail ignores a pair whose venues sit more than 30c apart
(the matcher's 30c bar): that is two different questions, not a fair price (90c against 44.5c gives
no fair value).

One thing it is careful about. The crawl excluded Sports until 2026-09-19, so a listed sports series
was missing from it for a reason that was not merit; those few series were still scanned by name,
which kept the pool a superset of the old one. Sports is crawled now (see *Fights, and the wall
around sports* above), so the exception is gone and the maker sees sports like anything else — but
`MAKER_MIN_DAYS_TO_CLOSE` (7) keeps it away from a fight or a game settling that night, which is a
coin flip and not a spread. And if the scanner is off, or
its last crawl is older than two intervals, the desk falls back to the 38-series scan rather than
quoting off stale tickers. `MAKER_WIDEN=0` turns the whole thing off (off on the box since
2026-09-23, `fly.toml`).

### Where the surviving edge actually lives

Split the same markets by how long the queue in front of us takes to trade through:

```
queue clears in < 1 day      +$357    29/49 positive
queue clears in 1-7 days      -$11    11/28 positive
queue clears in > 7 days       +$7     2/5  positive
```

All of it is in one bucket. For two days that was the desk's primary filter *and* its primary
ranking: quote the markets where the queue clears fastest. Scored with real depth on the original
fixed set it returned **+$240 development / +$160 out of sample**, against **+$199 / +$109** for
ranking on trade rate alone, and live it moved the book from markets queued 15,700 deep to markets
queued 9, 29 and 30 deep. Then it was scored walk-forward on 66 days of tape, below, and lost to
trade rate in every setting. **The live rule is trade rate again.**

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

### Reading the tape over a socket

The desk sees its fills by reading the exchange-wide trade tape. It read that tape by polling
`/markets/trades` every two seconds: 1000 prints a page against an exchange running ~160 a second,
so a busy stretch outran a page, and every such poll was a window in which a resting quote could
have filled unseen — 145 of them in the first two days on the cloud box, before the poll learned to
page back by cursor. Since 2026-09-12 the same prints arrive over Kalshi's WebSocket trade channel
as they happen, each with a sequence number, so a missed print is *known* rather than suspected
(`src/kalshi-ws.js`). The poll is the fallback and runs for any round the socket cannot vouch for —
it was down, it reconnected, it skipped a number, its buffer overflowed — and because the poll pages
back to the last print already seen, the hole is filled rather than counted. `tools/stream-test.js`
asserts the framing, the trade shape, and the fallback.

Kalshi signs the socket handshake with the same key that signs live orders (an unsigned upgrade is
refused with a 401, public channel or not), and Node's built-in client cannot send handshake
headers, so the client is hand-rolled — the client side of RFC 6455 is small — rather than an npm
dependency. It is read-only: the key signs the handshake and nothing else. A box with no key polls
exactly as before, which is the cloud box by design (`ops/DEPLOY.md`); the dashboard's status board
says which (`tape: socket` or `tape: polling`). Checked live 2026-09-12: both documented hosts accept
the signed upgrade, and a 12-second sample carried ~1,070 prints with contiguous sequence numbers.

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

### The fill check, rebuilt on the desk's own tape

`tools/fillcheck.js` used to fetch each held market's last 1,000 prints and replay them against the
touch as it stood when the tool ran, as if that quote had rested on both sides of all ~120 markets
for 24 hours with its queue worked off once. It read 41% and then 39% on 2026-09-21, under its own
50% bar, and the number meant nothing: the desk quotes 24 markets at a time, works the rest off
one-sided, and rejoins the back of the queue whenever its price moves. Its "this build" window was
never that either (`startedAt` is the ledger's first day).

It now reads files only. Since 2026-09-19 the maker's tape holds every book it looked at, every
print on those markets and its own quote and inventory (`src/makertape.js`), which is everything the
fill logic reads. Three numbers on the same prints:

```bash
node tools/fillcheck.js                  # the newest closed day in data/fly/archive
node tools/fillcheck.js --days 3 --markets
```

- **JOURNAL** -- what the paper book booked.
- **TAPE** -- the recorded quotes replayed against the recorded prints and depth through
  `maker.fillsFrom`. On 2026-09-20, warmed up on the day before: 1,217 fills and 8,817 contracts
  against the journal's 1,220 and 8,826, 0.1% apart market by market. The ledger fills the way its
  own tape says. (Cold, on the tape's first day, it is 11% apart by market: a quote that had rested
  for days replays as if it had just joined the back. A cold replay is reported, not judged.)
- **ALWAYS** -- both sides at the recorded touch in every market the desk was looking at, never
  down. 29,984 contracts that day against the desk's 8,817, and every fill the desk did not have is
  put down to what its recorded quote was doing at that print: **55% of the always-on contracts were
  in markets cooled by the run-over gate** (16,475, 64% of them run over -- the same share as the
  fills the desk did take), 14% were the growing side pulled on a held market, and **4% was
  operational** (further back in the queue). So the old tool's missing 60% was the rails, not
  restarts and not the fill model, and `MAKER_PARTICIPATION` is not what it measures.

And the question under all of it, **was a fill worth having**: every fill, taken or refused, is
marked against the recorded mid 5, 30 and 120 minutes later, per contract. On 2026-09-20 the desk's
own fills marked **-0.7c a contract** at every horizon (8,645 contracts), the fills the gate refused
-1.0c to -2.4c, and the growing side it withheld -1.9c to -2.5c. So the rails refuse worse fills
than the desk takes, and the desk's own fills still lose: a one-tick spread pays half a cent and the
price moves more than that against the desk after each fill. That is the maker's whole P&L question
in one number, and it is the one to watch before deciding whether the maker stays on.

The tape gained two things for this, from the evening of 2026-09-21: a `start` line when a process
begins (a restart used to be invisible in it) and `qb`/`qa` on each quote line, the contracts the
queue model still has ahead of each side.

### The ranking, re-scored walk-forward

The clear-time rule above was scored with each market's measured depth on a fixed set of markets, once.
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

What this instrument cannot see: the book is reconstructed from prints; the depth is today's,
applied to July; the pool is the markets that are still open, so every fold is scored on
survivors. Shorter windows (14 days ranked, 7 scored, seven folds) and fewer picks (12) give the
same ordering. So the live rule went back to trade rate on 2026-09-12: `MAKER_MAX_CLEAR_DAYS` is
gone, the queue is still measured and shown, and it no longer picks the book.

### A Polymarket maker leg, measured and parked

Measured on 2026-09-12 with `tools/pm-maker-scan.js`: on the 24 busiest political and macro
markets, Polymarket's queue at the touch is a fifth of Kalshi's (median 2,771 against 15,372
contracts) and its flow is twice Kalshi's, so a resting order is reached in hours rather than a
day. Makers pay nothing and are rebated 25% of taker fees, which is 0.19c a contract at the mid;
the real income is the daily liquidity-rewards pool, whose split is undisclosed. Not built: the
CLOB measured is `polymarket.com`'s, which US persons cannot trade on, and `polymarket.us` lists
none of these markets. `ops/pm-maker-2026-09-12.md` has the table and the reasoning.

### Two things that were tested and not built

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
TESS's drawdown watches the taker book and would never see this desk bleeding. That rail measures
the fall from the book's **high-water mark**, not from the opening balance: against a fixed opening
reference it loosened with every dollar earned, so a book that ran to $10,500 and bled back to
$9,050 had given up 13.8% of its high while the test read 9.5% and never fired. A high-water mark
can only ever halt earlier, and the two agree exactly on a book that has never been in profit.
`POST /api/flatten` liquidates its inventory too, at the touch, paying the taker fee.

**Paper only.** What no simulation here can model: our own size changing other people's behaviour,
and Kalshi's real queue at our price level.

### A halted maker still settles and re-marks (2026-09-24)

A drawdown halt, or the taker's halt, used to freeze the book where it stood: no settlement, no new
marks. Now it runs a hold round once a minute: every quote is withdrawn, but the held markets' books
are read, anything finalized is settled (`halted, still settling ...` in the log) and equity is
re-marked. No scan, no quotes. And `POST /api/resume` now actually lifts a maker drawdown halt: it
starts the drawdown over from the equity at that moment, where before it re-tripped at once on the
frozen equity. Only the operator halt (`/api/flatten`) still stops everything at once.

### Reduce-only quotes stop at flat (2026-09-24)

A quote resting only to work a position off (a pinned market, a gain lock, a book in the tails or
under the minimum spread) carries `reduceOnly`, on `m.quotes` and as `"ro":1` on the tape's `q`
line, and `maker.fillsFrom` clips each fill on it to what is still held. Before, a sweep through it
filled whatever it filled: between the `MAKER_WIDEN=0` deploy (09-23 18:50Z) and 18:05Z on 09-24,
3,010 of the 6,203 contracts traded on work-off markets opened new positions instead of closing old
ones (`KXRT-PRI-90` went from short 87 to long 99 in one round), about $58 of loss.
`tools/fillcheck.js` and `tools/maker-replay.js` replay the same clip; a tape written before the
flag replays as it did, and the fill check on 09-22 to 09-23 still matches the journal within 0.5%.
A book under the 1c minimum spread now keeps its reducing side too, as the tails already did (`... ·
reducing only` in the reason); seven held markets (268 contracts, `CONTROLH-2026` at ±100 since
09-19) had had no quote at all. A flat market in either case still quotes nothing.

### Election markets leave before election night (`MAKER_EVENT_DATES`, 2026-09-24)

Some series name no date in their tickers, so the 7-day rail (`MAKER_MIN_DAYS_TO_CLOSE`) could not
see that they settle on 2026-11-03: `SENATE*`, `GOVPARTY*`, `CONTROLS`, `CONTROLH`,
`KXBALANCEPOWERCOMBO`, `KXBLUETSUNAMICOMBO`, `KXHOUSERACE` and `KXRHOUSESEATS` held 1,964 of the
maker's 4,682 contracts on 09-24. The map gives them that date, so they leave the universe on 10-27
and are worked off reduce-only, and whatever is still held `MAKER_EVENT_CROSS_DAYS` (1) before the
date is crossed out at the touch as a `MAKER_FLATTEN` (reason `event Nh away`), paying the taker
fee: at most about $35 on 09-24's contracts, against positions that go to 0 or 1 overnight. It fires
around 23:59Z on 2026-11-02. Three limits: it does not fire while the maker is halted (the hold
round quotes and crosses nothing), so a halt that day carries the inventory into the night; it
crosses the whole position at the top-of-book price whatever size is shown there, so that day's
paper P&L is somewhat kind; and the date is keyed by **series**, so a later-cycle event in one of
them (a `CONTROLS-2028` market) is treated as 2026-11-03 too. **After 2026-11-03 the map has to be
updated**: until it is, every market in those series reads as past, is refused, and is crossed out
if held.

### One loss limit per event (`MAKER_EVENT_MAX_LOSS`, 2026-09-24)

On an event Kalshi marks mutually exclusive (one market wins, or none), the maker could carry two
capped bets on the same outcome: `SENATETX-26` held +100 D and −100 R, −$115.40 if R wins. A side is
now not rested when a fill would take the event's worst settlement past `MAKER_EVENT_MAX_LOSS`
(default one capped market, $100) and make it worse than it already is (`... would deepen <EVENT>
past -$100.00` in the reason); the side that shrinks the market's own position always stays. Where
the crawl does not say whether an event is mutually exclusive, the listed series read `/events` once
every six hours (about 38 calls). Events that are not mutually exclusive are left alone.

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

### The strategy lab: any strategy, on settled markets

Everything above tested one idea at a time on markets still open. `tools/lab.js` runs very different
strategies through one scoring engine on **settled** Kalshi markets, where a held position is paid
what it was actually worth. Parameters are picked on the older 60% of markets by close date and
reported on the newer 40%. Taker fills at the next hour's bid/ask, Kalshi's taker fee both ways,
10 contracts a trade, and no entry into a book wider than 4c or a market that traded under 50
contracts in the day before.

```bash
node tools/lab-fetch.js          # settled markets since 2026-07-15 with hourly bid/ask → data/lab/
node tools/lab.js --by category  # the tournament
node tools/lab.js --detail momentum
```

**The first sample was rigged, and it is the most useful thing the lab found.** It kept markets
that had traded 5,000+ contracts in their life. Contracts priced at 20c then resolved YES 40% of
the time and 93c favourites 72%, because an upset is what makes a market busy — and "buy the
underdog" scored **+10c a contract, t = 7**. Drawing whole events at random from liquid series
instead gives a calibrated sample (6c→6%, 20c→20%, 40c→42%, 58c→58%, 79c→81%, 94c→94%), and the
lab now prints that check on every run and warns when a bucket is more than 10 points off.

On that sample (7,597 markets, 843k hourly bars, 2026-07-15 → 09-13), scored on the newer 3,039:

```
strategy       picked on the older markets      trades  win  ¢/contract  profit    t
favorite       minPx=95 maxHoursLeft=48            170  94%     -0.96c    -$16  -0.6
momentum       lookback=24 move=15 hold=∞          384  69%     -0.57c    -$22  -0.3
longshot       maxPx=5 maxHoursLeft=48             162   4%     -1.45c    -$24  -0.9
volumeSpike    mult=10 move=6 hold=∞ dir=1         319  60%     -1.05c    -$33  -0.5
random         (control: coin flip, hold)          236  50%     -1.62c    -$38  -0.6
tightFavorite  minPx=90 maxSpread=1                418  92%     -1.46c    -$61  -1.1
reversion      lookback=6 move=10 hold=∞           376  36%     -7.30c   -$274  -3.6
```

**0 of 161 parameter settings made money in both halves.** Most rows sit near the random control,
which is what paying the spread and the fee on a calibrated market looks like. The one lead, found
by looking *after* the table above and so not evidence yet: outside Sports (1,347 markets, 239
events), buying a 70–90c favourite inside 48 hours of the scheduled end was positive in both halves
at every threshold (+1.6 to +2.0c dev, +2.0 to +5.3c test), with t under 2 in dev. It is the same
favourite–longshot bias Bürgi, Deng and Whelan measured on Kalshi, and 239 events cannot confirm it.
Kalshi's historical endpoints (markets settled before 2026-07-15) are where more of those events are.

**That lead was tested on older markets and did not replicate (2026-09-19).** `tools/lab-fetch.js
--historical` pulled 1,148 non-Sports markets that closed 2026-04-15 to 07-14, none of which took
part in finding the lead. `tools/favorites-check.js` scored one rule that was written down before
the older data was scored: 70-90c favourite, at most 48 hours to the scheduled end, hold to
resolution. On the older markets it made **-3.88c a contract on 55 events (t -0.9)**, negative in
both halves, and failed all four preset criteria (300+ events, +1.0c, |t| >= 2, both halves
positive). The newer markets the lead came from give +5.1c on 61 events under the same rule, so the
two samples disagree in sign and pooled they are about zero. 55 events cannot rule a small effect
out, but there is no evidence of an edge and no reason to build on it.

### Weather: the public forecast does not beat Kalshi's temperature markets

The desk only ever compared prediction markets with each other. This asks whether a price is worse
than an outside source that is not a market. Kalshi's "Highest temperature in <city>" markets settle
on a published number, and Open-Meteo archives the forecast that was issued a day earlier, so it can
be scored on the past without waiting for data.

```bash
node tools/weather-fetch.js     # ~50 minutes: 10,089 markets, 7 cities, 12 months -> data/lab/weather/
node tools/weather-lab.js       # the preset rule on the later half of the dates
```

The rule, and four pass criteria, were written into `tools/weather-lab.js` before anything was
scored: the real high is Normal(forecast + city bias, city sigma), read as a whole degree the way
Kalshi settles; bias and sigma are fitted per city on the EARLIER half of the dates only; decide at
22:00 local the day before; buy YES or NO when the model beats the price by 8c after the fee; fill
at the next hour's ask through `tools/lab.js` (one hour of latency, a 4c spread limit, the taker
fee); hold to resolution. Scored on the later half (2026-04-05 to 09-17):

| | |
|---|---|
| trades / events | 2,627 / 1,080 |
| win rate | 37% |
| per contract | **-2.77c** (t -3.9) |
| first quarter / second quarter | -2.93c / -2.63c |
| Brier score at the decision hour | model 0.1616, **market 0.1236** |

**NOT CONFIRMED, and negative in both quarters.** The price is better informed than a one-model
forecast with a fitted error: it beats the model on Brier score, and every edge threshold from 3c to
16c loses (-2.8c to -3.6c), which is roughly the fee plus the spread paid for nothing. What this does
not rule out is a better forecast (an ensemble, the NWS forecast, station-level model output) or a
different decision hour. It does say the free, obvious version has no edge.

### Whale watch: copying the best sports bettors does not pay

Paid "insider trackers" (sharpai.us, for one) sell a feed of what Polymarket's top wallets just
bought. That feed is public: Polymarket serves a leaderboard per category and every wallet's fills
with no key. `src/whales.js` reads it. ILSA follows the top 25 sports wallets and the top 10 on each
of the politics, economics, crypto, culture, tech and finance boards (`WHALE_CATEGORIES`) by profit
this month -- 72 wallets on 2026-09-15, since the same wallets top several boards -- polling five
every 15 seconds. When one wallet's net buying on one outcome passes $10K (sports) or $5K (the
other boards, whose best wallets bet smaller) within six hours, it calls the bet out on the floor,
naming the board the wallet ranks best on. Each line has the size, side and price, the wallet's rank, the
Kalshi price of the same outcome where HOLT has matched the market, and whether the game had
already started. Each bet is also appended to `data/whales-YYYY-MM-DD.jsonl`. Both sides of one
market are flagged as a hedge. **It never trades.** Turn it off with `WHALE_WATCH=0`.

**A bet on a decided market is recorded, not called (`WHALE_MAX_PX`, 2026-09-24).** From 09-16 to
09-23, 243 of the 1,652 callouts (15%, about 30 a day) were wallets buying at 95c or more: "No" on a
Fed 50bp move at 99c, a tennis player at 98c mid-match. That is collecting the last cents of a decided
market, not a view, and it buried the real calls. Every bet is still written to `whales-*.jsonl`
first (the lab and the Ask panel read it), so the file is every bet *seen*, not every bet called; the
floor line and the panel skip it when both the price and the wallet's average price are at
`WHALE_MAX_PX` (0.95) or dearer. The average keeps a position built lower and pushed over the bar by
one dear fill on the floor: 47 of the 243, so 196 go quiet. A value above 1 turns the filter off.

Whether it should trade is what `tools/whale-lab.js` answers. The pool is 305 wallets from the
sports leaderboards by profit *and* by volume. The test covers 671k fills from 2026-08-02 → 09-13
and 6,418 bets of $10K+, where a bet is the same event the floor announces. A copy is $100 at the
whale's price + 1c, with a 1% fee, held to settlement. Wallets are ranked on the first three weeks
and scored on the last three:

```
pre-game bets, test half                    bets  games  win  price  return   t
every wallet in the pool                    2219    936  57%   56c   −1.2%  -0.5
top 10 picked on the first half              318    261  64%   64c   −2.8%  -0.6
bottom 10 picked the same way                275    219  54%   53c   −5.2%  -0.9
today's top 25 by month profit (look-ahead)  481    364  57%   51c   +8.2%   1.7
the same top 10, on the half they were picked on:  +12.3%, t 2.0
```

That test covers the **sports** boards only; the other boards are followed but untested.

**Picking wallets on past results does not carry forward.** The ten best wallets returned +12% in
the half that picked them and −2.8% in the next, no better than the bottom ten. The leaderboard
row looks good only because today's leaderboard is ranked on those very bets, and even then t is
under 2. That list is what whale watch follows, and it is what paid trackers show. Other slices:
- Bets placed during the game: +0.6%.
- Every $50K+ bet: +1.1%.
- Every $100K+ bet: +7.6%, t 1.7. Too few games to call, but worth re-checking against the live
  `whales-*.jsonl` record once it has a few weeks of settled bets.

With no fee and no slippage, the top-ten copy is still −0.5%. Whale bets land close to fair
prices; the edge is not there to copy. Caveats: 110 of the 305 wallets trade too often to page back
the full 42 days, so the first half has fewer rankable wallets (20 with 10+ bets). The pool is also
only wallets still active enough to rank.

```bash
node tools/whale-fetch.js    # ~10 minutes, data/lab/whales/
node tools/whale-lab.js      # --minUsd 100000 --slip 0.02 --fee 0 --minBets 5 --top 25
```

## Stocks and ETFs: the same lab, a bigger market

Both brokers this desk's owner uses now let software trade for them: Public has a trading API and
an agent framework, Robinhood opened a separate agent account in 2026. The question that matters
before wiring anything to either is not whether a bot *can* trade stocks, but whether any rule worth
running exists. So the prediction-market lab's method was pointed at equities.

```bash
node tools/stock-fetch.js               # once: 23 ETFs + ^BXM/^PUT/^VIX daily bars → data/stocks/bars/
node tools/stock-lab.js                 # the tournament
node tools/stock-lab.js --detail rotation --bps 10 --cash SHY
```

RESEARCH ONLY. Nothing here talks to a broker, reads a key, or places an order.

**The universe is fixed in `tools/stock-fetch.js`, before any result was seen**: 23 broad ETFs —
the four index funds, the nine sector SPDRs, five bond funds, gold, silver, developed and emerging
markets, REITs — plus Cboe's `^BXM` (buy-write) and `^PUT` (put-write) indexes, which are the only
honest free proxy for an options-income strategy, since no free source has full historical option chains.
Picking single stocks from a 2026 list would have meant backtesting on the survivors.

**The fill model.** A strategy decides on a day's close and trades at the **next day's open**. Every
order pays 5 basis points of what it trades, each side (`--bps`), and US brokers charge no commission
on ETFs. Prices are dividend-adjusted, so holding earns dividends; idle cash earns nothing unless
`--cash SHY`. Parameters are chosen on 2003 → March 2017 and the table reports April 2017 → today,
years the choice never saw. Taxes are ignored, and every timing rule here would pay short-term rates
in a taxable account — a real drag the table does not show.

```
TEST WINDOW 2017-03-20 → 2026-09-15, each strategy with the settings it chose on the older years
strategy        picked on the older years         CAGR  vs SPY   maxDD  Sharpe  orders   beat SPY both halves
buyHold         (no parameters)                  14.8%    +0.0  -33.7%    0.84       1   0/1  · 0/1
vixFilter       below=40                         12.4%    -2.3  -25.8%    0.82      17   0/4  · 0/4
volTarget       target=0.15 lookback=20          12.2%    -2.6  -18.7%    0.93     108   0/6  · 4/6
randomTiming    median of 25 seeds (control)      9.7%    -5.1  -28.5%    0.73      52   0/25 · 1/25
randomRotation  median of 25 seeds (control)      9.1%    -5.6  -28.0%    0.71     643   0/25 · 0/25
putWrite        Cboe PUT index                    8.2%    -6.6  -28.9%    0.67       1   0/1  · 0/1
buyWrite        Cboe BXM index                    7.7%    -7.1  -30.3%    0.62       1   0/1  · 0/1
tsmomSpy        months=6                          6.4%    -8.4  -33.7%    0.49      15   0/4  · 1/4
trendSma        sma=200 band=0 check=month        6.4%    -8.4  -36.4%    0.48      19   0/8  · 6/8
rotation        top=5 months=6                    6.3%    -8.5  -38.0%    0.43     692   0/12 · 0/12
dualMomentum    months=6 bond=IEF intl=false      6.0%    -8.7  -36.2%    0.47      27   0/8  · 0/8
rsi2            below=25 trend=false exit=sma5    5.3%    -9.4  -26.1%    0.44     596   0/12 · 0/12
tsmomMulti      months=6                          3.1%   -11.7  -18.9%    0.47     483   0/3  · 0/3
dropBuy         down=4 hold=5                     3.0%   -11.8  -13.0%    0.41     105   0/6  · 0/6
```

**Nothing beat owning SPY. Not one of the 66 parameter settings, across twelve strategies, beat it on
return in both halves of the calendar** — the last column counts settings that beat SPY on the older
years *and* on the newer ones, and every row reads 0. The two controls are the tell: a coin flip that
holds SPY on random days finished mid-table, above six of the ten real strategies. That is what
"these rules are noise plus costs" looks like. Expanding folds say the same thing — every strategy is
behind SPY in three of the four slices, and the one slice several of them win is 2007-12, the crash,
which is the one thing a timing rule reliably does: it is out of the market when the market falls,
and it is also out when the market rises.

**What survived, honestly.** Nothing on return; two rules on *risk*. Volatility targeting — hold less
SPY when SPY has been swinging — kept a higher Sharpe than SPY in four of its six settings and cut
the worst drawdown from 34% to 19%, at a cost of 2.6 points of return a year. The 200-day moving
average did the same in six of eight settings but not on drawdown. That is the textbook result, and
it is a decision about how much risk to carry, not a way to make more money.

Rerun with cash earning T-bills (`--cash SHY`) or at double the cost (`--bps 10`) and the ordering
does not change: buy-and-hold first, 0 of 66 settings beating it in both halves either way.

**What this cannot see.** Daily bars only, so nothing intraday. ETFs only — no single stocks, and no
real options (the two Cboe indexes are one canned strategy each, and both lost to SPY over this
window). One market, mostly one long bull run: a nine-year test window that contains 2020 and 2022 is
still one sample of one country's decade. And the universe, though fixed before scoring, was written
down in 2026 by someone who knows which ETFs still exist.

**Two data traps worth naming**, both of which produced plausible-looking wrong answers before they
were caught. Yahoo's chart endpoint returns **monthly** bars for `range=max&interval=1d` — SPY comes
back as 405 rows for 1993-2026 instead of 8,464 daily ones, with nothing in the response saying so —
so `tools/stock-fetch.js` asks for an explicit `period1`/`period2` window instead. And it answers 429
to every request on a **reused connection** while serving fresh ones immediately, which looks exactly
like a rate limit and is not; the fetcher sends `connection: close`.

## Options: writing down a history that is not free

The lab above has a hole it names itself: no real options. Free historical option chains do not
exist — not at any useful size — which is why an options-income strategy had to be stood in for
by Cboe's BXM and PUT indexes, two canned rules with one parameter setting each. Live chains, on the
other hand, are free. So the only free way to ever run an honest options backtest is to start writing
the data down, and every day nobody does is a day that can only be bought back later, not re-fetched.

Checked 2026-09-24, so the claim above is not taken on faith. Full chains are sold: Alpha Vantage's
`HISTORICAL_OPTIONS` endpoint returns one end-of-day chain per symbol per date for 15+ years, with
bid/ask and sizes, volume, open interest, IV and greeks, on any premium plan (from $49.99 a month, 75
requests a minute; the free key is refused). One request is one symbol-day, so the six ETFs back 15
years is about 23,000 requests: one month would fetch all of it. The free sources are thin or stale.
DoltHub's `post-no-preference/options` is free and current since 2019 but has only SPY and DIA of the
six, about 210 SPY contracts a day across four expiries (the tape keeps about 5,600 across 17) and
no open interest or volume; Kaggle's SPY set and OptionsDX stop in 2023. None of them has the tape's
several snapshots a day.

```bash
node tools/chain-record.js                  # one snapshot of the six ETFs → data/chains/
node tools/chain-record.js --every 30       # ... and again every 30 minutes
node tools/chain-record.js --only SPY --dte 45 --band 0.2
bash ops/install-chains.sh                  # record it daily, unattended (undo: uninstall-chains.sh)
```

READ-ONLY. No broker, no account, no key, no order path — the same standing as `tools/stock-fetch.js`.
This collects data. It decides nothing and trades nothing.

**The source is Cboe, not Yahoo**, and that was not the first choice. Yahoo's option endpoint now
demands a cookie-and-crumb handshake, and every request for a crumb from Node — `fetch`, `node:https`
and `node:http2` alike, with the cookie or without it, with browser headers or none — comes back 429
`Too Many Requests`, while `curl` from the same machine and IP at the same moment is served normally.
That is a TLS-fingerprint block, not a rate limit, and Node cannot talk its way past one without a
native TLS library, which would mean a dependency. Cboe's delayed feed needs no handshake, comes from
the same CDN this repo already pulls BXM and PUT from, and is better data besides: it is the exchange
rather than a scrape of it, every expiry arrives in **one** request instead of one call per expiry,
and each contract carries bid and ask **size** and the **greeks**, none of which Yahoo gives at all.
The cost is a ~15-minute delay, which matters not at all for testing daily rules.

**The universe is fixed in `tools/chain-record.js`**, before any result was seen, for the same reason
the ETF universe is: SPY, QQQ, IWM, DIA, TLT and GLD — six heavily optioned broad ETFs, each of which
already has daily bars in `data/stocks/bars/`, so a chain and its underlying's history join on the
date with nothing left to reconcile.

**What it keeps.** One JSON line per symbol per expiry per snapshot, after a header line naming the
column order, the filters and the source, so a file read years from now explains itself. Per contract:
strike, bid, bid size, ask, ask size, last, implied vol, delta, gamma, vega, theta, rho, Cboe's
theoretical value, open interest, volume, and the last trade's timestamp. A `null` is Cboe declining
to quote; a `0` bid is a real quote, and collapsing the two would be unrecoverable.

**What it deliberately throws away.** Strikes outside ±30% of spot and expiries beyond 70 days. One
SPY response is 12,312 contracts across 31 expiries and 1.2 MB; filtered it is 5,060 across 15 and
493 KB. Covered calls, put-writing, the wheel — anything BXM-shaped — live near the money inside two
months, and LEAPs five years out would quadruple a year of tape for rows no such rule reads. Both
limits are knobs and both are written into the header, so a reader knows what was filtered rather
than guessing at a gap. The whole universe is ~1.8 MB a snapshot: about 0.5 GB a year, recorded daily.

**Freshness is judged by content, not by a clock.** Cboe's `timestamp` is when it last rebuilt that
file, not when the market last moved — on one Saturday fetch SPY read 21:19 and IWM read the previous
evening, and neither had a live quote behind it. So each symbol's filtered chain is hashed, the hash
is kept in `data/chains/.seen.json`, and an unchanged chain is skipped. A weekend, a holiday, a
stalled feed and a market that genuinely has not moved all collapse to the same honest answer —
nothing new — instead of filling the tape with copies of Friday that a reader would have to detect
and drop later.

**And by Cboe's stamp as well (2026-09-24), because the hash alone let a frozen feed through.** Cboe
stopped rebuilding its files after the evening of 2026-09-22: every stamp read 2026-09-22 23:29 to
09-23 03:56 UTC (the 09-22 after-hours session, ET) for a day and a half. The 09-23 16:25 ET run
failed on all six symbols and still exited 0. The hash is taken after the date filter, so when an
expiry rolled off at midnight the same frozen file hashed differently, and the 09-24 09:45 ET run
wrote 70 lines, every one a copy of a 09-22 after-hours line, as that morning's chains; the box's
recorder wrote the same copy (1,608,644 bytes) and its tabs read "70 lines, 16,096 contracts". Now:

- the chain is compared expiry by expiry as well as whole, so an expiry rolling off (or a new one
  coming inside 70 days) no longer makes an old file look new;
- Cboe's stamp (`qt`) is kept in `.seen.json` beside the hash, and an unchanged symbol whose file
  still carries the stamp the last run saw is skipped as `STALE: Cboe file still stamped <qt>` (the
  box's schedule reports a run where every symbol was stale as `stale`, having written nothing);
- every run appends one `ok` or `PROBLEM` line to `data/chains/chains.log` and exits 1 on a PROBLEM,
  so launchd shows it: a failed symbol or a stamp over 3 hours old on a weekday run from 16:00 ET, or
  a stamp older than the last weekday's close on any other run. A weekday market holiday raises it
  too, by design. A run where every symbol failed is tried twice more a minute apart, and `fetch
  failed` names its cause (`ECONNRESET` and the like);
- `node tools/chain-record.js --check` (read-only; step 6 of `ops/daily-check.sh`) prints the last
  `chains.log` line, the newest stamp per symbol and its age, and whether the last finished weekday
  has quotes stamped that day. It can cry wolf after a Mac that slept through the evening: that
  day's closing chain is then written into the next day's file, and `--check` looks only in the
  day's own file.

**What that leaves on the tape.** 2026-09-23 has no session quotes at all; that day is lost and
cannot be fetched from anyone. The 09-24 09:45 ET lines, on the Mac and on the box, are copies of
the 09-22 after-hours prices. Nothing was deleted, so **filter on `qt`, not on `t` or the file's
date**: a backtest should key each line by (`sym`, `exp`, `qt`) and drop repeats.

**There is nothing to conclude from this yet, and that is the point.** It is a year of patience
before it can answer anything. What it will eventually be able to answer is the question the ETF lab
could only gesture at with two Cboe indexes: whether any rule for selling options beats simply owning
the underlying, after real spreads, on months it never saw.

### The half that turned out to be for sale: ChartExchange

The section above opens with "free historical option chains do not exist", and that stands. But on
2026-09-23 a fortnight's trial of [ChartExchange](https://chartexchange.com)'s API (Tier 3, meant to
run to 2026-10-07 but expired the same evening, see *How it ended*; the key is `CHARTEXCHANGE_API_KEY` in `.env`, read-only, no account behind it) turned up
the other half of the same data: **the daily bar and open interest of every listed option contract,
expired ones included**, from the last week of May 2021. Not chains — no bid, no ask, no greeks, and a
day the contract did not trade has no bar at all — but five years of real prints on the contracts
that matter, which is the difference between waiting a year for the tape and asking the question now.

```bash
node tools/option-history.js                       # the six ETFs, every monthly expiry 2021-07 → the last one expired → data/options/history/
node tools/option-history.js --only SPY --from 2024-01 --to 2024-06
node tools/option-history.js --dry-run             # what would be pulled, and how many calls
node tools/option-history.js --repair              # ask again for the contracts a run could not get
```

READ-ONLY, like everything else in this part of the repo: `src/venues/chartexchange.js` is a data
client with a key, and nothing in the trading loop reads it. The desk runs identically without it.

**What it keeps.** The same six underlyings as the chain tape, so the two join. For each monthly
expiry (the third Friday, or the Thursday before it when that Friday is a holiday — Good Friday 2025
listed nothing), every call and put whose strike sits within ±10% of *where the underlying closed
over the 70 days before expiry* — the whole range, not one day's spot, so a contract that was at the
money at any entry point in that window is in whatever the underlying did afterwards. One file per
underlying per expiry, each with a header naming the source, the window, the strikes it implied and
the column order; each contract under the same OSI name the chain tape uses, its daily bars as
arrays. Beside them, the underlying's own daily closes from the same source: split-adjusted, *not*
dividend-adjusted, which is the right series to compare a strike against. About 200 contracts a
monthly expiry on SPY, ~60,000 fetches for the whole set, one call each, a few hours at the default
pace on a key that allows it; the pull is resumable and skips what is on disk.

**Two ways the source lies, and what is done about each.** A `start` before its history begins is
answered with a server error, not an empty list — for every contract however new — and the same
error comes back now and then for one contract at one start while two days later is served fine;
the same query once answered empty and a minute later with the error. So every request starts at
2021-06-01, a contract that errors is asked for again from a short ladder of later starts, and one
the source still will not serve is **written into the file with `err` and no bars rather than
dropped**: a strike missing from a file would read as "outside the band", and that would be a
different lie. `missing` in the header counts them; `--repair` asks again.

**Why the chain tape still matters.** A daily bar is the trades that happened. A backtest that
"sells the close" on one is dealing at the last print, which was the bid, the ask, or neither, and
on a quiet strike the last print may be days old. The tape's bid/ask sizes are what say how much
that flatters a rule, and they only exist from the day recording started. The history says what
five years of a rule *would roughly* have done; the tape will say what it costs to actually do it.

**The trial caps requests, and the cap is the whole story.** On the first day the key was refused
after roughly 800 calls — one expiry into a pull that needs ~60,000 — with HTTP 406, "maximum number
of requests in trial mode", and every call after it, a single quote included, got the same answer.
The number is not published; whether it resets daily is not either, and the next run will say. The
pull stops the moment it sees the cap, keeps what it has, and resumes from there when the key
answers again. So the history is not on disk. What is on disk is one SPY expiry (July 2021, 216
contracts, 5 of them the source would not serve).

**The fortnight plan.** The decision was to use the free trial and not pay, so the pull became a
daily chore of the Mac's, like the chain tape:

```bash
bash ops/install-history.sh                # was four runs a day; the key expired 09-23 and the job was removed 09-24 (uninstall-history.sh)
tail data/options/history/history.log      # one line per run
```

Each run pulls newest expiries first, strikes within ±5% of the 70-day range (half the contracts
of ±10%, and the half a covered-call or put-write rule reads), and stops the moment the key is
refused. A run on a capped key costs one call, so four a day meet the reset whenever it falls.
If the cap resets daily at ~800 calls, that is five to eight SPY expiries a day and SPY's five
years fit in the fortnight; if it does not reset, `history.log` will say `STOPPED` after 0 pulled
on every run and the trial's whole yield is the one expiry above. Either way the files are the
irreplaceable kind once the key is gone, so `data/options/history/` belongs in the same backup as
`data/chains/`: since 2026-09-24 both go to iCloud Drive with the hourly pull (*The pull and the backup*).

**How it ended (2026-09-23, the same evening).** The cap was not the last word: by 22:40Z every call
answered HTTP 401 "Expired", and it still did the next morning. The trial did not run its fortnight,
and its whole yield is the one expiry above. The first run to meet that spent 67 calls being refused
once per expiry, so a 401 is now flagged `expired` by the client and stops a run on the first call,
the way the cap does; `history.log` says `STOPPED (... HTTP 401: Expired)`. After that the launchd
job was one refused call four times a day, and it was removed on 2026-09-24 with
`ops/uninstall-history.sh` (which leaves `data/options/history/` alone). A paid key, if there is ever
one, resumes from what is on disk: `bash ops/install-history.sh` puts the job back.

**What ChartExchange is not, here.** Its dividend history stops in mid-2021 (SPY's last entry is
June 2021), so its bars cannot be dividend-adjusted and `tools/stock-fetch.js` keeps Yahoo for the
ETF lab's total-return series. Its stock quotes were 30 minutes delayed on that plan. The listing
said the plan renews at $89.65 a month after 2026-10-07, but no card was ever given (Evan, 2026-09-24),
so nothing renews and nothing is charged.

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

### The daily check

```bash
bash ops/daily-check.sh
```

One screen, read-only, six steps, and nothing on the box is changed. The exit code is the number of
steps that flagged something.

1. **Did the pull run?** The last line of `data/fly/archive/pull.log` and its age.
2. **Does the ledger add up?** `tools/ledger-check.js --box --venues`: the journal rebuilds the state
   line by line, and every settlement agrees with the venues. It copies the box's `state.json` and the
   journals the archive lacks into `data/fly/box-now`, replacing its own copies from the last run
   (the only thing the check writes, besides one line of `data/fly/archive/fillcheck.jsonl`).
3. **What has each book realised?** `tools/pnl-report.js`, from the archive plus `box-now` (the
   archive wins a day both have), so today is today's journal and not the tail of yesterday's; the
   newest row says `so far, through HH:MMZ`. Since 2026-09-24 it books every arb leg's `CLOSE`,
   `SETTLE` and `CLOSE_PARTIAL`, a convergence bet's partial sale and the maker's flattens, where it had
   counted arbs only from `ARB_UNWOUND`/`ARB_SETTLED` (which exist since 2026-09-12) and missed three
   Fed groups (+$6.61): 16 groups and −$228.67 became 19 and −$222.06, and the taker total matches
   `state.json`. Then `tools/fillcheck.js` on the newest pulled day (3b).
4. **Was every restart explained?** `tools/restarts.js`, yesterday and today (ET). Since 2026-09-24
   `server.js` journals `START` at boot (with the build sha), `STOP` when a signal ends it (a deploy)
   and `CRASH` with the handler and the first 800 characters of the stack from its last-resort
   handlers; the engine already wrote `WATCHDOG` before exiting on a stall. A `START` whose previous
   lifecycle line (looked for across every journal on hand) is none of those is an unexplained
   restart: an OOM kill or a heap abort, which run no handler. Before this a crash was one console
   line, gone from `fly logs` in about 30 minutes, and the check counted `WATCHDOG` lines only. It
   exits 1 on a crash or an unexplained restart. None of the new kinds moves money.
5. **Is the box starved?** From `/proc/stat` since boot, the desk's share of the CPU and **steal**,
   the time Fly held it back for being over its cap (the number to read: ~50% on shared-cpu-1x on
   2026-09-22); then `/proc/pressure/cpu`, the commit it runs, `/data` free, and the probe files'
   total (the pull trims them since 2026-09-24, so a total that keeps growing means it has stopped).
6. **Is the option-chain tape alive?** `node tools/chain-record.js --check` on the Mac (*Options*
   above).

First run, 2026-09-21: 159 settlements, 159 agree; 29 watchdog restarts on the 20th, 7 on the 21st.

### The pull and the backup

`ops/install-pull.sh` installs a LaunchAgent that runs `ops/run-pull.sh` **every hour at :30**
(since 2026-09-24; it was 09:30 and 13:30). 9 of the 21 runs from 09-15 had failed, most of them
started in a two-second battery DarkWake and frozen when the Mac fell back asleep, with one retry a
day. A run exits at once, writing nothing, when `pull.log`'s last pull line and `backup.log`'s last
line are both `ok` and dated today (Eastern), so a good day costs one run. The pull
(`tools/fly-pull.js --trim`) copies every closed day into `data/fly/archive`, then deletes box tick
tapes **and probe files** older than three Eastern days, each only once its Mac copy has the box's
sha256 (probe files were never deleted before: 14 of them, about 50 MB, on 09-24). A failed download
is tried three times, 30 seconds apart, and now blocks only its own file's delete, not the whole trim.

**The backup (installed and first run 2026-09-24).** Nothing was backed up before: no Time Machine
disk, no iCloud copy, and the chain tape, the one ChartExchange expiry and the box tapes already
trimmed (09-10 to 09-21) existed only on this Mac. After the pull, whether or not it worked,
`run-pull.sh` copies `data/chains`, `data/options` and `data/fly/archive` with `rsync -a` into
`iCloud Drive/Hexagon-backup`: no `--delete`, so a file removed here is kept there; no `.part`
files; never `.env` or a `.pem`; and only into an iCloud Drive that exists. A failed copy writes its
own `PROBLEM backup` line to `pull.log` and `backup.log` and is tried again the next hour; a good one
writes an `ok` line to `backup.log`. `.env` and `kalshi-private-key.pem` are **not** in it and still
need a backup of their own, such as Time Machine on an external disk. `ops/uninstall-pull.sh` stops
the backup along with the pull and leaves the iCloud copy in place.

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
src/matcher.js         cross-venue matching: Fed brackets and games, every cycle
src/anymarket.js       the any-market scanner: discover off the cycle, reprice matched pairs in it
src/discovery.js       crawls every open event on both venues (sports included)
src/match-any.js       the same outcome in any category: names, deadlines, thresholds on their tick
src/rules.js           the rules gate: same / different / unclear, and the cached Claude check
src/broker.js          paper broker + live Kalshi adapter
src/venues/            Polymarket (Gamma + CLOB) and Kalshi public data
src/tape.js            the maker's batched market data: the trade tape (socket first, poll as fallback) and top of book
src/kalshi-ws.js       Kalshi's trade channel over WebSocket, dependency-free and read-only
src/whales.js          whale watch: top wallets' big bets on Polymarket's leaderboards, called out on the floor (never trades)
src/ask.js             the Ask panel: a read-only Claude tool loop over the desk, with its own daily ceiling
src/ask-tools.js       the Ask panel's eleven read-only tools (whitelisted fields, bounded output, secrets scrubbed)
src/sse.js             the dashboard's event stream: one gzip per tab, flushed after every frame
public/                dashboard (index.html, style.css, app.js; vendor/ holds TradingView Lightweight Charts, which draws the P&L chart)
data/state.json        persisted account (created on first run)
data/ticks-*.jsonl     tick tape, one line per priced pair per cycle (RECORD=1)
tools/maker-replay.js  the maker desk against Kalshi's own trade history, same pure functions as live
tools/maker-rank.js    three market rankings for the maker, scored walk-forward on that history
tools/pm-maker-scan.js the same queue and trade-rate yardstick, on Polymarket's CLOB
tools/lab-fetch.js     settled Kalshi markets with hourly bid/ask history, for the lab
tools/lab.js           the strategy lab: many strategies, tuned on older markets, scored on newer
tools/whale-fetch.js   sports-leaderboard wallets' fills and how their markets settled, for the whale lab
tools/whale-lab.js     would copying those wallets pay: picked on the first half, scored on the second
tools/option-history.js  daily bars and open interest of expired option contracts from ChartExchange (needs CHARTEXCHANGE_API_KEY) → data/options/history/
tools/stock-fetch.js   daily bars for a fixed list of 23 ETFs and three Cboe indexes, from Yahoo's public chart endpoint
tools/stock-lab.js     the ETF lab: stock/ETF strategies tuned on older years, scored on newer ones against owning SPY
tools/fly-pull.js      copy the Fly box's finished days to data/fly/archive, verify, then trim old box tapes (ops/DEPLOY.md)
tools/pnl-report.js    realised P&L per book from the pulled journals (archive + data/fly/box-now)
tools/ledger-check.js  rebuilds both books from the journals and compares them with state.json (--box, --venues)
tools/restarts.js      START/STOP/WATCHDOG/CRASH per Eastern day, and every restart nothing explains
tools/chain-record.js  the option-chain tape from Cboe's delayed feed → data/chains/ (--check: is it alive?)
tools/test.js          every suite in one command (npm test): its SUITES list names each tools/<name>-test.js
                       and what it covers, and a *-test.js file missing from that list fails the run
tools/golden.js        fixed-fixture output diff, for refactors meant to change nothing
```

`src/decide.js` is separated out so the same functions that decide live can be handed a recorded
tape and a synthetic clock (`tools/replay.js`) instead of a network and a wall clock. Two checks
guard it, and both are worth running after any change to the gates:

```bash
npm test                      # every suite listed in tools/test.js
node tools/maker-test.js      # ...or one suite at a time while working on one file
```

Coverage follows the money, which took a while to admit. When these tests were written
(2026-09-11) the taker desk had never traded: in both journal days on disk every fill was a
`MAKER_FILL`, 94 of them, and the taker book was empty. The maker desk was the only code here that
had ever moved a contract, and it was the code without tests. (The taker has traded since: 73
convergence bets and 19 locked arbs closed by 2026-09-24, and the maker still does almost all the
volume.) `src/maker.js` is now the maker's `decide.js`: `desiredQuotes`, `fillsFrom` and `applyFill`
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
- **A market whose listing reports zero top-of-book size is logged as a queue that clears
  instantly** — `clear` is depth over contract rate, so no depth reads as `0.0h` in the scan line.
  Cosmetic as of the re-scored ranking: the book is picked by trade rate, which never reads `depth`,
  and the live queue is seeded from the real orderbook at quote time rather than from the listing.

## License

MIT — see [LICENSE](LICENSE). This is research software for paper trading; live mode is
Kalshi-only and has never been run against a funded account. Nothing here is financial advice.
