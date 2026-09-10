# Hexagon — project home

`~/Hexagon` is the main folder for all Hexagon work. The repo lived at `~/claude/hexagon`
until 2026-09-10; it was moved here with its full git history. There is no other Hexagon
checkout — if you find a reference to `~/claude/hexagon` anywhere, it is stale.

**The Hexagon** is a six-agent prediction-market trading desk that prices the same events on
Polymarket and Kalshi, trades the disagreements, and streams to a live dashboard.
Node 20+, **zero npm dependencies** — that is deliberate, do not add packages.

Read `README.md` before changing anything; it explains the strategy, the fee math, and why
the venue gap is not the edge. `ops/DEPLOY.md` covers cloud deployment (Fly app `hexagon-desk`).

## Running it

```bash
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
tools/            edge-scan, replay, maker-report, fillcheck, history-scan, golden, decide-test,
                  probe-test, api
ops/              Fly deploy + launchd autostart (not currently installed)
data/             gitignored: state.json, journal-*.jsonl, ticks-*.jsonl, desk.log
```

`data/journal-YYYY-MM-DD.jsonl` is the append-only truth; `state.json` trims itself and is only
the fast working copy.

## Repo facts

- Branch `main`. A second branch `worktree-hexagon-research` is checked out as a git worktree at
  `.claude/worktrees/hexagon-research` (locked, gitignored).
- **There is no git remote.** The local `.git` is the only copy of the history — take that into
  account before any destructive git operation.
