# Hexagon — project home

`~/Hexagon` is the main folder for all Hexagon work. The repo lived at `~/claude/hexagon`
until 2026-09-10; it was moved here with its full git history. There is no other Hexagon
checkout — if you find a reference to `~/claude/hexagon` anywhere, it is stale.

**The Hexagon** is a six-agent prediction-market trading desk that prices the same events on
Polymarket and Kalshi, trades the disagreements, and streams to a live dashboard.
Node 20+, **zero npm dependencies** — that is deliberate, do not add packages.

Read `README.md` before changing anything; it explains the strategy, the fee math, and why
the venue gap is not the edge. `ops/DEPLOY.md` covers cloud deployment (Fly app `hexagon-desk`). Merging to `main` auto-deploys
to Fly once tests pass (paper only; see ops/DEPLOY.md → Auto-deploy).

## Running it

```bash
npm test                                      # 446 assertions, no network, no clock
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
src/agents.js     the six desks         src/matcher.js   cross-venue matching
src/broker.js     paper broker + live Kalshi adapter
src/venues/       Polymarket (Gamma + CLOB) and Kalshi public data
src/recorder.js   tick tape writer      public/          dashboard
src/tape.js       maker market data     src/kalshi-ws.js Kalshi trade socket (read-only; needs the key, else the tape polls)
tools/            edge-scan, replay, maker-replay, maker-rank, pm-maker-scan, maker-report, fillcheck,
                  history-scan, golden, api
                  tests: test.js (npm test) + decide/probe/maker/broker/matcher/engine-test.js
data/fly/         gitignored: journals, state and tick tapes copied down from the Fly box, plus
                  kstrades.jsonl (the trade history maker-replay scores against) and
                  rank-listing.json + rank-trades.jsonl (the 440-market pool maker-rank scores)
ops/              Fly deploy + launchd autostart (not currently installed)
data/             gitignored: state.json, journal-*.jsonl, ticks-*.jsonl, desk.log
```

`data/journal-YYYY-MM-DD.jsonl` is the append-only truth; `state.json` trims itself and is only
the fast working copy.

## Repo facts

- Branch `main`. A second branch `worktree-hexagon-research` is checked out as a git worktree at
  `.claude/worktrees/hexagon-research` (locked, gitignored).
- Remote `origin` is `git@github.com:evankaplan6-hub/Hexagon.git` (added 2026-09-12, SSH).
  `data/`, `.env`, and `*.pem` are gitignored, so the working copy is still the only place those
  exist — back them up separately.
