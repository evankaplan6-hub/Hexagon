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
npm test                                      # 1931 assertions, no network, no clock
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
  print their values, or send them anywhere.
- The server binds `127.0.0.1` because `/api/positions` and the activity log are unauthenticated.
  Do not bind it to `0.0.0.0` casually.
- The desk trading rarely — or not at all — is correct behavior, not a bug. Real cross-venue
  gaps on liquid markets are usually 0–1c.

## Layout

```
server.js         HTTP + SSE server, .env loader, live-mode gate
src/config.js     all tunables          src/engine.js    state, cash, positions, cycle loop
src/decide.js     pure decision core: gates, ranking, sizing, exits (no I/O, no clock)
src/agents.js     the six desks         src/matcher.js   cross-venue matching (Fed + games, every cycle)
src/anymarket.js  any-market scanner: src/discovery.js crawls both venues, src/match-any.js pairs any
                  category, src/rules.js decides which pairs' resolution rules match (only those trade)
src/broker.js     paper broker + live Kalshi adapter
src/makerdesk.js  the maker's loop: universe from the any-market crawl (MAKER_WIDEN, no extra calls),
                  trade-rate probe, run-over gate; src/maker.js holds the pure decisions
src/venues/       Polymarket (Gamma + CLOB) and Kalshi public data
src/watchdog.js   stall watchdog: exits the desk when the taker or maker loop finishes no round (WATCHDOG_SEC)
src/recorder.js   tick tape writer      public/          dashboard (lookout.html: the same desk as one painted room, read-only)
                                         public/vendor/   TradingView Lightweight Charts, one vendored file: draws the P&L chart (candles or line)
src/tape.js       maker market data     src/kalshi-ws.js Kalshi trade socket (read-only; needs the key, else the tape polls)
src/makertape.js  records the maker's book, prints and quotes into the ticks-*.jsonl tape (RECORD_MAKER=0 off)
src/whales.js     whale watch: top wallets' big bets on Polymarket's sports/politics/economics/crypto/culture/tech/finance boards (advisory, never trades; WHALE_WATCH=0 off)
src/ask.js        the dashboard Ask panel: read-only Claude tool loop (src/ask-tools.js), ASK_DAILY_USD ceiling; needs ANTHROPIC_API_KEY
tools/            edge-scan, replay, maker-replay, maker-rank, pm-maker-scan, maker-report, fillcheck,
                  history-scan, golden, api, lab-fetch + lab (strategy tournament on settled markets),
                  whale-fetch + whale-lab (does copying top sports wallets pay? no, out of sample),
                  stock-fetch + stock-lab (ETF strategy tournament on Yahoo daily bars, walk-forward vs SPY;
                  research only, no broker code -- nothing beat buy-and-hold),
                  weather-fetch + weather-lab (Kalshi daily-high-temperature markets vs the public forecast; no edge, out of sample),
                  favorites-check (one preset rule on older settled markets from lab-fetch --historical; the non-Sports favourite lead did not replicate),
                  pnl-report (one-screen realised P&L per book from data/fly/archive journals; --marks prices held maker inventory),
                  fly-pull (copies the box's finished days to data/fly/archive, verifies, then trims old box tapes)
                  tests: test.js (npm test) + decide/probe/watchdog/maker/broker/fees/matcher/match-any/rules/discovery/anymarket/stream/engine/brain/lab/stock-lab/whale/http/disk/ask/askui-test.js
data/fly/         gitignored: journals, state and tick tapes copied down from the Fly box, plus
                  kstrades.jsonl (the trade history maker-replay scores against) and
                  rank-listing.json + rank-trades.jsonl (the 440-market pool maker-rank scores).
                  That snapshot is frozen at 2026-09-12; new copies from the box go in data/fly/archive/
ops/              Fly deploy, launchd desk autostart (not installed), and the daily tape pull (ops/install-pull.sh; installed on the Mac 2026-09-14).
                  The box also has a disk brake (TAPE_MIN_FREE_MB) that trims its oldest tapes if the pull stops
data/             gitignored: state.json, journal-*.jsonl, ticks-*.jsonl, desk.log
data/lab/         gitignored: series-busy.json + universe.json (cached listings) and markets.jsonl (hourly bars)
                  for tools/lab.js; markets-volume-picked.jsonl is the biased first sample, kept as the counterexample
data/lab/whales/  gitignored: pool, fills, conditions, markets for tools/whale-lab.js
data/stocks/bars/ gitignored: one Yahoo daily-bar file per ETF/index (tools/stock-fetch.js) for tools/stock-lab.js
data/whales-*.jsonl  gitignored: every bet whale watch announced, for scoring once they settle
```

`data/journal-YYYY-MM-DD.jsonl` is the append-only truth; `state.json` trims itself and is only
the fast working copy.

## Repo facts

- Branch `main`. There is no long-lived second worktree: the `hexagon-research` one this file used
  to describe is gone, and its branch was a leftover, fully merged into `main`. Claude Code makes
  its own session worktrees under `.claude/worktrees/` and they come and go with the sessions, so
  `git worktree list` is the only honest record of which exist. `.claude/` is gitignored.
- Remote `origin` is `git@github.com:evankaplan6-hub/Hexagon.git` (added 2026-09-12, SSH).
  `data/`, `.env`, and `*.pem` are gitignored, so the working copy is still the only place those
  exist — back them up separately.
