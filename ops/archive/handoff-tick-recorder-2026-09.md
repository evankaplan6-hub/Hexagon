# Hexagon — current task prompt (tick recorder)

Paste everything below the divider into Claude Code in `~/Hexagon`, in plan mode.

---

Add a tick recorder to The Hexagon. That is the whole job — do not fix anything else.

## Context

Six-agent prediction-market paper trading desk. Node 20+, zero npm dependencies. Read `README.md`
first. Every 15 seconds it matches Polymarket markets against Kalshi markets into "pairs" and prices
them. It has run since Sep 6 and taken **zero trades**, and it keeps no record of the prices it saw —
so there is currently no way to tell whether a tradeable gap ever existed. The recorder fixes that,
and it is the only thing that turns this project from guessing into evidence.

## What to build

- Every cycle, append one JSON line per priced pair to a file under `DATA_DIR`, rotated daily
  (e.g. `ticks-YYYY-MM-DD.jsonl`).
- Per line: wall-clock timestamp, cycle number, pair id, label, kind, series, `inPlay` flag,
  Polymarket bid/ask/vol24, Kalshi bid/ask/vol24, and — when BRAM computed them that cycle — the
  fair value and the best net edge it found, with which venue and side.
- `E.history` currently holds 240 points per pair in memory and dies with the process
  (`src/engine.js`, `recordHistory`). The file is the durable version of that.
- Append-only, never rewrite. A failed write must log and continue — it must never crash the
  process or halt the trading cycle.
- On by default, with `RECORD=0` to disable. Document it in `.env.example`.

## Constraints

- Node stdlib only. No npm packages — the zero-dependency design is deliberate.
- Do not change `MODE`, `DEMO`, or `LIVE_CONFIRM` in `.env` or in config defaults. Do not touch
  live-mode code or `src/broker.js`.
- Do not fix other bugs you notice. If you spot something, list it at the end; do not act on it.
- Match the existing code style: terse, with comments only where a non-obvious choice needs a "why".
- Update `README.md` and `.env.example` for the new setting.
- The repo is under git with a clean baseline commit. Commit your work when done.

Done means: `node server.js` boots and writes tick lines; `DEMO=1 DATA_DIR=./data-demo node
server.js` also writes them; and you show me a few real recorded lines.

## How to work

I cannot read code. When you present the plan, explain in plain English what each change does and
what could go wrong — not just file and function names.

Deliver exactly this scope. If you think the approach is wrong or there is a better one, say so in a
sentence and continue with the task as asked rather than quietly narrowing, widening, or
transforming it.

Say in one sentence what you are about to do before your first tool call. While working, give a
brief update only when you find something important or change direction. Lead your final message
with what changed and whether the desk still runs, with detail after that.

Keep responses concise and spend them on substance rather than caveats. Do not use subagents — this
is a small change and is faster done directly.
