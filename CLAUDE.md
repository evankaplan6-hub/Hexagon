# Hexagon — project home

`~/Hexagon` is the main folder for all Hexagon work. The repo lived at `~/claude/hexagon`
until 2026-09-10; it was moved here with its full git history. There is no other Hexagon
checkout — if you find a reference to `~/claude/hexagon` anywhere, it is stale.

**The Hexagon** is a paper trading desk for **stocks, crypto and options**, its main scope since
2026-09-25: six bots run six paper books on free public prices -- crypto (BTC, ETH, SOL and, since 2026-09-30,
XRP and DOGE, live from Coinbase), runners (since 2026-09-30: coins popping right now, scanned on Coinbase every
3 minutes, at Robinhood's 0.95% fee), stocks (SPY), options (SPY same-day, trend days) and, since 2026-09-29, scalps (SPY same-day,
held minutes) and dips (Evan's own morning dip under VWAP, as rules), the last four from Cboe about 15
minutes late -- and stream
them to a live trading floor at `/`. The code is `src/desk/`; README's first section explains it.

It began as a six-agent prediction-market desk that priced the same events on Polymarket and Kalshi and
traded the disagreements. That desk still runs in the same process, in paper; since 2026-09-29 its books are on the floor at `/` too
(src/pmfloor.js; its old page at `/pm` still lists every market):
it stopped trading 2026-09-25 to 09-27, and since 09-27 its arbs, maker and snipe trade again in
simulation at Evan's request (not the main focus, but kept running). Everything below that names
Polymarket, Kalshi, the maker, arbs, pairs or the tick tape is that desk.
Node 20+, **zero npm dependencies** — that is deliberate, do not add packages. (The one file of
third-party code is the dashboard's chart library, TradingView Lightweight Charts, vendored as a single
file in `public/vendor/` on 2026-09-19 at Evan's request; see `public/vendor/README.md`. It is not a
package and nothing installs it. Do not add others without asking.)

Read `README.md` before changing anything. Its first section is the stocks, crypto and options desk:
the six books, the lab result behind each rule, the fill model and the 15-minute delay. The rest is
the prediction-market desk's record, including the fee math and why the venue gap was not the edge.
`ops/DEPLOY.md` covers cloud deployment (Fly app `hexagon-desk`, which runs both desks). Merging to `main` auto-deploys
to Fly once tests pass (paper only; see ops/DEPLOY.md → Auto-deploy).

## Running it

```bash
npm test                                      # every suite in tools/test.js's SUITES, no network, no clock
node server.js                                # both desks, paper, live market data → localhost:8787 (both desks' books) and /pm (the old page)
node tools/crypto-lab.js --fetch && node tools/crypto-lab.js   # the evidence for the crypto book's rule
DEMO=1 DATA_DIR=./data-demo node server.js    # the prediction-market desk on synthetic fills/settles, separate account
npm run reset                                 # wipe the prediction-market paper account (the desk's is data/desk/state.json)
```

## Safety invariants — do not cross these without being asked explicitly

- **The stocks, crypto and options desk is paper only and has no broker.** `src/desk/` prices orders
  against public data and writes its own ledger (`data/desk/`); there is no code path to Robinhood,
  Public, Webull, Coinbase or any exchange, whatever `MODE` says. Do not add one unasked. Real orders
  are Evan's to place by hand (the investment stack, `~/Downloads/stack`), and Claude never places one.

- `.env` is currently `MODE=paper`, `DEMO=0`, `LIVE_CONFIRM=` (empty). **Never** flip `MODE`,
  `DEMO`, or `LIVE_CONFIRM` on your own. Live mode risks real money and the server is designed
  to refuse to start without an explicit `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`.
- Live mode is Kalshi-only and has never been exercised with a funded account. Treat
  `src/broker.js` live paths as untested.
- Secrets live in `.env` and `kalshi-private-key.pem`. Both are gitignored. Never commit them,
  print their values, or send them anywhere. `fly deploy` uploads the folder it runs in to Fly's
  builder. `.dockerignore` is an allowlist of what the Dockerfile copies, held to it by
  `tools/dockerignore-test.js`, so the secrets and `data/` stay out; keep it an allowlist. The one
  sanctioned copy is `ops/backup-secrets.sh` (run by Evan in a terminal): an AES-256 encrypted image
  in iCloud Drive, under a passphrase only he types. Never supply, store or generate that passphrase.
- The server binds `127.0.0.1` because `/api/positions` and the activity log are unauthenticated.
  Do not bind it to `0.0.0.0` casually.
- The desk trading rarely — or not at all — is correct behavior, not a bug. Real cross-venue
  gaps on liquid markets are usually 0–1c.
- The **prediction-market** desk keeps trading **in paper** even though it is no longer the main focus
  (Evan, 2026-09-27: "doesn't mean you shouldn't be still running them in simulation"). fly.toml has
  `ARBS=1`, `MAKER_QUOTE=1`, `SNIPE=1`; `CONVERGE=0` stays off (its own verdict, 2026-09-21). Since 2026-09-30 `BETS=1` too: "every game should be bet" (Evan, Wild Card night), one $100
  paper bet on the favourite of every MLB game (`BET_SERIES`), held to the final; README "Every game". All four
  were off 2026-09-25 to 09-27 after every book lost on paper. Do not switch a book off, or
  convergence on, unasked. Kalshi closes a finished game first, every time (median 4.4 minutes after
  Polymarket's 99c reading, 105 of 105 games 09-27 to 09-29), and Polymarket's record says closed a median
  32 minutes after the reading. So since 2026-09-30 the snipe buys once Polymarket's resolver has *proposed*
  the result (about 20 seconds after the final), and `SNIPE_WATCH` follows each game to Polymarket's close
  and journals both venues' close times (`SNIPE_WATCH` lines; `node tools/settle-lag.js --day <date>`, and
  `--venues` for days before that); README "Kalshi closes first, every time".
- **No TradingView data in Hexagon.** Evan's TradingView account (the official MCP connector, tools
  `mcp-tv-*`/`mcp-watchlist-*`, added 2026-09-25, and his chart in Chrome) is for him to read in chat,
  under the `tradingview-web-master` skill (repo `~/Downloads/stack`). TradingView's Terms §3 allow
  display only, with no redistribution, and its ban policy covers scripts and bots on his paid account.
  So no TradingView value goes into `data/`, a tape or lab, a committed file, the dashboard, the Ask
  panel or a loop, and no Hexagon code calls a TradingView server. The vendored Lightweight Charts
  library is unrelated: it draws the desk's own numbers, makes no requests, and keeps its logo.

## Layout

```
                  THE STOCKS, CRYPTO AND OPTIONS DESK (the main scope since 2026-09-25; paper only, no broker)
src/desk/engine.js  the desk: six books' ledgers, the six bots' jobs (HOLT prices, ILSA volatility, TESS risk,
                  RIGO marks and option exits, BRAM signals, KETT fills; PRED is the prediction-market desk,
                  trading in paper beside it), data/desk/state.json + journal-YYYY-MM-DD.jsonl, the page's snapshot
src/desk/books.js   the rules, pure: volatility targeting (crypto 40%/30 days, SPY 15%/20 sessions, 10-point band)
                  and the SPY same-day options rules ported from the stack's trend_day_check.py, on ONE-MINUTE bars since
                  2026-09-29 (the stack's move; five-minute before), plus chainSync:
                  an option is bought only off a chain within DESK_CHAIN_SKEW_SEC of the trigger bar's close;
                  SCALP (2026-09-29): the stack's 0DTE scalp method (options §5) on a 30-minute breakout, one
                  contract near 0.40 delta, out at 1.5x / SPY back in the range / 15 min flat / 30 min / 3:15;
                  its FED list of 2 PM decisions ends 2026 (add 2027's when the stack has them);
                  DIP (2026-09-29), on ONE-MINUTE bars (he trades a 45-second chart; Cboe's finest is one
                  minute): Evan's own hand-traded pattern as rules: a turn up off a morning low
                  0.25 ATR under the open, under VWAP, 10:05-noon; two calls 2-3 pts out; one sells on the VWAP
                  reclaim, the runner on a fade to its SPY price / half its gain back once doubled / 3:15;
                  RUNNER (2026-09-30, Evan's QNT): every 3 min, a coin Robinhood sells (RUNNER_COINS, a dated list)
                  up 8%+ in 24h, $2M+ traded, within 3% of its high and still climbing; 4 at once, a quarter each;
                  out 10% off its best or 48h not above cost; a coin sold waits 12h
src/desk/feeds.js   Coinbase (live; /products/stats is every coin's 24h in one call) and Cboe (15 min late) parsers + fetches; Cboe's one-minute bars (options, dips), five-minute
                  bars (scalps), VWAP, ATR14
src/desk/broker.js  paper fills: crypto walks Coinbase's book + 0.40%, SPY at the touch, options at the touch + $0.03
src/desk/clock.js   NYSE sessions, holidays and 1 PM closes through 2027 (TESS warns when the list runs out)
public/desk.*     the floor at /: since 2026-10-02 four views, each a link (#overview, #desk, #pm, #activity; #desk/crypto
                  for one book's card): the overview (each desk's figure with every book on a line saying what it is doing,
                  the P&L chart, the latest trades), Stocks & crypto (headline vs holding, the desk, one card per book with
                  the markets it trades, in two groups), Predictions (since 2026-09-29 the prediction-market desk's board and
                  five books (arbs, maker, snipe, convergence, the game bets), fed by src/pmfloor.js; Evan: "Merge the desk to the new screen. It's data, not its look")
                  and Activity (both desks' lines, each tagged with its book); a tab bar on a phone; tools/floor-test.js holds
                  the views to the page. Laid out for reading, 12px and up; no pixel room or bots drawn since 2026-09-25 (Evan's
                  call). desk.css is its own sheet on public/tokens.css, colours named by job; tools/tokens-test.js holds
                  every text colour to 4.5:1. desk.js patches boards in place (morph) so focus survives the 2s stream.
                  Since 2026-09-29 drawn as Apple draws its apps (Evan: "making the website iOS and macOS and Apple beautiful"):
                  the system font (no web fonts on the floor; the old /pm and lookout pages still load Google Fonts), Apple's colours as light-dark() pairs, light or dark as the device is set,
                  a translucent bar, a phone's large title, the large chart as a sheet; addable to an iPhone's Home Screen
                  or a Mac's Dock (manifest.webmanifest; tools/icons.js draws the icons; server.js OPEN_FILES serves those
                  five files, and only those, before the login). Checked in the iOS Simulator (Xcode 27, iPhone 18 Pro Max)
tools/crypto-lab.js the evidence for the crypto book (Coinbase daily candles → data/crypto/bars/; XRP from its 2023-07-13
                  return to Coinbase, DOGE from 2021-06-03)
tools/headline-lab.js would the investment stack's X feed trade a coin? (Coinbase one-minute candles → data/crypto/minutes/;
                  reads the feed's log on the Mac in place, copies no post, calls no X server). 2026-09-30, three days: no, so the
                  feed is not wired in; README, "Headlines: tested, not wired in"
tools/desk-check.js step 8 of the daily check: the desk's loop alive, each book's check done today, its journal
                  rebuilding state.json to the penny, each book against holding (--box copies /data/desk first);
                  tests: tools/desk-test.js, tools/crypto-lab-test.js, tools/headline-lab-test.js, tools/desk-check-test.js (tools/desk-fixture.js
                  is their shared fake market, not a suite)
                  THE PREDICTION-MARKET DESK (paper, not the main focus: arbs, maker and snipe on since 2026-09-27; its books on / since 2026-09-29, old page /pm)
server.js         HTTP + SSE server for both desks, .env loader, live-mode gate; journals START/STOP/CRASH
src/sse.js        the dashboard stream's per-tab gzip, flushed per frame (the frames leave out the P&L histories via engine.snapshot; GET /api/history serves them)
src/config.js     all tunables          src/engine.js    state, cash, positions, cycle loop
src/decide.js     pure decision core: gates, ranking, sizing, exits, the settlement snipe (no I/O, no clock)
src/agents.js     the six desks         src/matcher.js   cross-venue matching (Fed + games, every cycle)
src/anymarket.js  any-market scanner: src/discovery.js crawls both venues (sports included since 2026-09-19), src/match-any.js pairs any
                  category, src/rules.js decides which pairs' resolution rules match (only those trade)
src/broker.js     paper broker + live Kalshi adapter
src/makerdesk.js  the maker's loop: universe from MAKER_SERIES (38 listed series; MAKER_WIDEN=1 adds the crawl's
                  fee-free markets, off on the box since 2026-09-23), trade-rate probe, run-over gate, the fair rail
                  (MAKER_FAIR_RAIL), reduce-only quotes that stop at flat, a hold round while halted, the event
                  dates (MAKER_EVENT_DATES: midterm series crossed out 2026-11-02; update the map after 11-03) and the
                  event loss limit (MAKER_EVENT_MAX_LOSS); src/maker.js holds the pure decisions
src/venues/       Polymarket (Gamma + CLOB) and Kalshi public data; cboe.js (delayed option quotes for the chain tape);
                  chartexchange.js (read-only market data behind CHARTEXCHANGE_API_KEY; the trial key has answered "401 Expired" since the evening
                  of 2026-09-23, so nothing answers until a paid key is set: quotes, short volume, dark pool, max pain, the historical
                  option bars; only the Ask panel and tools/ read it, never the trading loop)
src/watchdog.js   stall watchdog: exits the process when the taker or maker loop, or (since 2026-09-26) the stocks,
                  crypto and options desk's loop, finishes no round (WATCHDOG_SEC); Fly restarts it
src/volume.js     the desk's own trading volume by the minute (fed by the journal, rebuilt from it; /api/volume) for the chart's bars
src/recorder.js   tick tape writer      public/          dashboard (lookout.html: the same desk as one painted room, read-only)
                                         public/vendor/   TradingView Lightweight Charts, one vendored file: draws the P&L chart (candles or line)
                                                          (large chart: momentum + maker not-yet-banked panes, describe only)
src/tape.js       maker market data     src/kalshi-ws.js Kalshi trade socket (read-only; needs the key, else the tape polls)
src/makertape.js  records the maker's book, prints and quotes into the ticks-*.jsonl tape (RECORD_MAKER=0 off)
src/whales.js     whale watch: top wallets' big bets on Polymarket's sports/politics/economics/crypto/culture/tech/finance boards (advisory, never trades;
                  WHALE_WATCH=0 off; a bet at WHALE_MAX_PX 0.95+ is recorded but not called)
src/ask.js        the dashboard Ask panel: read-only Claude tool loop (src/ask-tools.js), ASK_DAILY_USD ceiling; needs ANTHROPIC_API_KEY
tools/            edge-scan, replay, maker-replay, maker-rank, pm-maker-scan, maker-report, fillcheck (files only: replays the maker's own tape against its journal, and says what each missed fill was),
                  maker-slice (the same replay cut by market/side/run-over/price/hour, plus a stand-aside rail scored on it; the four-day verdict is in its header),
                  settle-lag (when Polymarket settles a game, what Kalshi still offers the winner at: the study behind the settlement snipe), ufc-scan (prices a
                  fight card on both venues, cross-venue and within Kalshi, net of fees; read-only),
                  history-scan, golden, api, lab-fetch + lab (strategy tournament on settled markets),
                  whale-fetch + whale-lab (does copying top sports wallets pay? no, out of sample),
                  stock-fetch + stock-lab (ETF strategy tournament on Yahoo daily bars, walk-forward vs SPY;
                  research only, no broker code -- nothing beat buy-and-hold),
                  dolt-fetch + option-lab (covered calls and put-writing on SPY vs owning SPY, sold at the real bid, from
                  DoltHub's free chains 2020-2026; research only -- 0 of 24 settings beat SPY, every one trailed it in 2024-26),
                  chain-record (writes the option-chain tape to data/chains/ from Cboe's free delayed feed;
                  read-only, no broker -- full historical chains are sold, not free (Alpha Vantage premium from $49.99/mo;
                  DoltHub's free set has only SPY and DIA, thinly; checked 2026-09-24), so the history is collected daily;
                  ops/install-chains.sh schedules it on the Mac; on the box src/chainsched.js runs it inside the desk
                  (CHAINS=1 in fly.toml) and keeps only the newest 14 days there -- the Mac's tape is the archive),
                  option-history (daily bars + open interest of EXPIRED option contracts from ChartExchange, the six chain-tape ETFs, monthly
                  expiries from 2021-07, strikes ±10% of the 70-day close range → data/options/history/<SYM>/; resumable, --repair for
                  contracts the source refused; one SPY expiry on disk, irreplaceable now that the key is gone, backed up with the pull),
                  weather-fetch + weather-lab (Kalshi daily-high-temperature markets vs the public forecast; no edge, out of sample),
                  favorites-check (one preset rule on older settled markets from lab-fetch --historical; the non-Sports favourite lead did not replicate),
                  pnl-report (one-screen realised P&L per book from data/fly/archive + data/fly/box-now, every arb leg counted;
                  --marks prices held maker inventory), restarts (START/STOP/WATCHDOG/CRASH per ET day, and restarts nothing explains),
                  ledger-check (does the ledger add up: rebuilds both books from the journals and compares them with
                  state.json line by line; --box checks the Fly box, --venues checks every settlement against the venues),
                  fly-pull (copies the box's finished days to data/fly/archive, verifies, then trims old box tapes and probe files;
                  the desk's journals in /data/desk go to data/fly/archive/desk/ and, like every journal, are never trimmed)
                  tests: test.js (npm test) runs the suites in its SUITES list, one tools/<name>-test.js each; a *-test.js
                  file missing from that list fails the run, so add every new suite there
data/fly/         gitignored: journals, state and tick tapes copied down from the Fly box, plus
                  kstrades.jsonl (the trade history maker-replay scores against) and
                  rank-listing.json + rank-trades.jsonl (the 440-market pool maker-rank scores).
                  That snapshot is frozen at 2026-09-12; new copies from the box go in data/fly/archive/
data/fly/box-now/ gitignored: the latest state.json + unarchived journals, copied by ledger-check --box (the daily check);
                  replaced each run, not an archive
data/fly/desk-now/ gitignored: the box's /data/desk (the new desk's state.json + every journal), copied by
                  desk-check --box (daily check step 8); replaced each run, not an archive
ops/              Fly deploy, launchd desk autostart (not installed), the tape pull (ops/install-pull.sh: hourly at :30 since 2026-09-24,
                  skipped once the day's pull and backup are ok; the same job backs up data/chains, data/options and data/fly/archive
                  to iCloud Drive/Hexagon-backup, no --delete, no secrets). .env and the .pem: ops/backup-secrets.sh, by hand (encrypted image, Evan's passphrase).
                  The option-history job was removed from launchd 2026-09-24 (ops/uninstall-history.sh): the key had expired. Its scripts (ops/install-history.sh, run-history.sh, the plist) stay for a paid key; README says how to put it back.
                  ops/daily-check.sh is the daily trust routine (read-only on the box): pull alive, ledger-check --box --venues, pnl-report
                  + fillcheck, restarts (tools/restarts.js), CPU steal/pressure + disk + probe files, the chain tape (chain-record --check),
                  whether the encrypted secrets image is older than .env or the key, and (step 8) the stocks, crypto and
                  options desk (tools/desk-check.js --box).
                  The box also has a disk brake (TAPE_MIN_FREE_MB) that trims its oldest tapes if the pull stops
data/             gitignored: state.json, journal-*.jsonl, ticks-*.jsonl, desk.log (the prediction-market desk)
data/desk/        gitignored: the stocks, crypto and options desk's state.json and journal-*.jsonl. From the box's
                  /data/desk the hourly pull copies each finished Eastern day's journal to data/fly/archive/desk/ (since
                  2026-09-25; sha256-verified, never deleted from the box, backed up to iCloud with the archive); its
                  state.json reaches the Mac only in data/fly/desk-now/, desk-check --box's copy, replaced each run
data/crypto/bars/ gitignored: Coinbase daily candles for tools/crypto-lab.js; re-fetchable
data/crypto/minutes/ gitignored: Coinbase one-minute candles for tools/headline-lab.js; re-fetchable
data/lab/         gitignored: series-busy.json + universe.json (cached listings) and markets.jsonl (hourly bars)
                  for tools/lab.js; markets-volume-picked.jsonl is the biased first sample, kept as the counterexample
data/lab/whales/  gitignored: pool, fills, conditions, markets for tools/whale-lab.js
data/stocks/bars/ gitignored: one Yahoo daily-bar file per ETF/index (tools/stock-fetch.js) for tools/stock-lab.js
data/chains/      gitignored: the option-chain tape, chains-YYYY-MM-DD.jsonl + .seen.json (tools/chain-record.js).
                  IRREPLACEABLE for free: a lost day can only be bought back, never re-fetched (backed up hourly with the pull).
                  09-23 has no session quotes; the 09-24 09:45 ET lines are copies of 09-22 after-hours prices: filter on qt.
                  Each run leaves an ok/PROBLEM line in data/chains/chains.log and exits 1 on a PROBLEM
data/options/history/  gitignored: the ChartExchange option history (tools/option-history.js), one JSON per underlying per expiry
data/options/dolt/     gitignored: DoltHub's free SPY chains, one JSON per weekday (tools/dolt-fetch.js); re-fetchable, 18 MB, rides along in the data/options backup
data/whales-*.jsonl  gitignored: every bet whale watch saw (near-settled ones, WHALE_MAX_PX, are not announced), for scoring once they settle
```

`data/journal-YYYY-MM-DD.jsonl` is the append-only truth; `state.json` trims itself and is only
the fast working copy.

## Repo facts

- Branch `main`. There is no long-lived second worktree: the `hexagon-research` one this file used
  to describe is gone, and its branch was a leftover, fully merged into `main`. Claude Code makes
  its own session worktrees under `.claude/worktrees/` and they come and go with the sessions, so
  `git worktree list` is the only honest record of which exist. `.claude/` is gitignored.
- Remote `origin` is `git@github.com:evankaplan6-hub/Hexagon.git` (added 2026-09-12, SSH).
  `data/`, `.env`, and `*.pem` are gitignored. Since 2026-09-24 the pull job copies `data/chains`,
  `data/options` and `data/fly/archive` to iCloud Drive/Hexagon-backup; `.env` and the `.pem` go
  there only inside `ops/backup-secrets.sh`'s encrypted image; the rest of `data/` exists only here.
