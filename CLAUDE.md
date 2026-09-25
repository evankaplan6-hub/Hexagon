# Hexagon — project home

`~/Hexagon` is the main folder for all Hexagon work. The repo lived at `~/claude/hexagon`
until 2026-09-10; it was moved here with its full git history. There is no other Hexagon
checkout — if you find a reference to `~/claude/hexagon` anywhere, it is stale.

**The Hexagon** is a six-agent prediction-market trading desk that prices the same events on
Polymarket and Kalshi, trades the disagreements, and streams to a live dashboard.
Node 20+, **zero npm dependencies** — that is deliberate, do not add packages. (The one file of
third-party code is the dashboard's chart library, TradingView Lightweight Charts, vendored as a single
file in `public/vendor/` on 2026-09-19 at Evan's request; see `public/vendor/README.md`. It is not a
package and nothing installs it. Do not add others without asking.)

Read `README.md` before changing anything; it explains the strategy, the fee math, and why
the venue gap is not the edge. `ops/DEPLOY.md` covers cloud deployment (Fly app `hexagon-desk`). Merging to `main` auto-deploys
to Fly once tests pass (paper only; see ops/DEPLOY.md → Auto-deploy).

## Running it

```bash
npm test                                      # every suite in tools/test.js's SUITES, no network, no clock
node server.js                                # paper account, live market data → localhost:8787
DEMO=1 DATA_DIR=./data-demo node server.js    # synthetic fills/settles, separate account
npm run reset                                 # wipe the paper account
```

## Safety invariants — do not cross these without being asked explicitly

- `.env` is currently `MODE=paper`, `DEMO=0`, `LIVE_CONFIRM=` (empty). **Never** flip `MODE`,
  `DEMO`, or `LIVE_CONFIRM` on your own. Live mode risks real money and the server is designed
  to refuse to start without an explicit `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`.
- Live mode is Kalshi-only and has never been exercised with a funded account. Treat
  `src/broker.js` live paths as untested.
- Secrets live in `.env` and `kalshi-private-key.pem`. Both are gitignored. Never commit them,
  print their values, or send them anywhere. The one sanctioned copy is `ops/backup-secrets.sh`
  (run by Evan in a terminal): an AES-256 encrypted image in iCloud Drive, under a passphrase only
  he types. Never supply, store or generate that passphrase.
- The server binds `127.0.0.1` because `/api/positions` and the activity log are unauthenticated.
  Do not bind it to `0.0.0.0` casually.
- The desk trading rarely — or not at all — is correct behavior, not a bug. Real cross-venue
  gaps on liquid markets are usually 0–1c.
- Since 2026-09-25 the box opens **no new trades** (fly.toml: `CONVERGE=0`, `ARBS=0`, `MAKER_QUOTE=0`,
  `SNIPE=0`), Evan's call after every book lost on paper. Open arbs and maker inventory run to
  settlement. Do not turn a book back on unasked; the one pending check is the snipe on Sunday
  09-27's tape (`node tools/settle-lag.js --day 2026-09-27`, README → the settlement snipe).
- **No TradingView data in Hexagon.** Evan's TradingView account (the official MCP connector, tools
  `mcp-tv-*`/`mcp-watchlist-*`, added 2026-09-25, and his chart in Chrome) is for him to read in chat,
  under the `tradingview-web-master` skill (repo `~/Downloads/stack`). TradingView's Terms §3 allow
  display only, with no redistribution, and its ban policy covers scripts and bots on his paid account.
  So no TradingView value goes into `data/`, a tape or lab, a committed file, the dashboard, the Ask
  panel or a loop, and no Hexagon code calls a TradingView server. The vendored Lightweight Charts
  library is unrelated: it draws the desk's own numbers, makes no requests, and keeps its logo.

## Layout

```
server.js         HTTP + SSE server, .env loader, live-mode gate; journals START/STOP/CRASH
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
src/watchdog.js   stall watchdog: exits the desk when the taker or maker loop finishes no round (WATCHDOG_SEC)
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
                  fly-pull (copies the box's finished days to data/fly/archive, verifies, then trims old box tapes and probe files)
                  tests: test.js (npm test) runs the suites in its SUITES list, one tools/<name>-test.js each; a *-test.js
                  file missing from that list fails the run, so add every new suite there
data/fly/         gitignored: journals, state and tick tapes copied down from the Fly box, plus
                  kstrades.jsonl (the trade history maker-replay scores against) and
                  rank-listing.json + rank-trades.jsonl (the 440-market pool maker-rank scores).
                  That snapshot is frozen at 2026-09-12; new copies from the box go in data/fly/archive/
data/fly/box-now/ gitignored: the latest state.json + unarchived journals, copied by ledger-check --box (the daily check);
                  replaced each run, not an archive
ops/              Fly deploy, launchd desk autostart (not installed), the tape pull (ops/install-pull.sh: hourly at :30 since 2026-09-24,
                  skipped once the day's pull and backup are ok; the same job backs up data/chains, data/options and data/fly/archive
                  to iCloud Drive/Hexagon-backup, no --delete, no secrets). .env and the .pem: ops/backup-secrets.sh, by hand (encrypted image, Evan's passphrase).
                  The option-history job (ops/install-history.sh) was removed 2026-09-24 with ops/uninstall-history.sh: the key had expired.
                  ops/daily-check.sh is the daily trust routine (read-only on the box): pull alive, ledger-check --box --venues, pnl-report
                  + fillcheck, restarts (tools/restarts.js), CPU steal/pressure + disk + probe files, the chain tape (chain-record --check),
                  and whether the encrypted secrets image is older than .env or the key.
                  The box also has a disk brake (TAPE_MIN_FREE_MB) that trims its oldest tapes if the pull stops
data/             gitignored: state.json, journal-*.jsonl, ticks-*.jsonl, desk.log
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
