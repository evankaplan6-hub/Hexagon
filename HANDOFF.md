# Hexagon — handoff prompt

Paste the block below into a fresh Claude Code session (Opus 5) started in `~/claude/hexagon`.
To hand off a later stage instead, swap the **Task** section for one of the items in **Backlog**
and move the completed items into **Already done**.

---

You are picking up work on **The Hexagon**, a six-agent prediction-market trading desk at
`~/claude/hexagon`. Node 20+, zero npm dependencies, paper-trading against live Polymarket and
Kalshi market data. Read `README.md` first — it is accurate and current.

## Where the project stands

Architecture (sound, keep it):

```
src/venues/*.js  adapters — normalize wire format, no opinions
src/matcher.js   identity — is PM market X the same event as KS ticker Y?
src/engine.js    the ledger — owns cash, positions, marks, persistence, the 15s cycle
src/agents.js    policy — six desk functions (HOLT ILSA TESS RIGO BRAM KETT)
src/broker.js    fills only — paper and live share one interface
public/          SSE dashboard
```

Two boundaries are load-bearing and must survive any refactor:
- **Brokers only report fills; the engine owns cash and positions.** This is what lets paper and
  live share a code path instead of forking.
- **Matching is separate from pricing.** Cross-venue identity is the hardest correctness problem
  here and it stays isolated in `matcher.js`.

Reality check as of 2026-09-09: the desk has run since Sep 6 and taken **zero trades**
(`data/state.json`: cash 10000, closed 0). The only end-to-end exercise of the fill path is DEMO
mode, which filled to 12/12 open positions and closed 2 trades for −$7.44. The pipeline has never
been proven on real prices, and there is no recorded data to explain why it never fires.

**The core problem is not strategy, it is the missing feedback loop.** Today the only way to learn
anything is to wait, and waiting produces nothing to analyze.

## Task

Two items, in this order:

**1. Tick recorder.** Append every cycle's pair quotes to a JSONL file under `DATA_DIR` (rotate
daily). One line per pair per cycle: timestamp, pair id, label, kind, series, pm/ks bid+ask+vol24,
inPlay flag, and BRAM's computed `fair` and best `edge` when it produced them. `E.history` currently
holds 240 in-memory points per pair and dies with the process — that is the data you need and are
throwing away. This unblocks everything downstream, so do it first.

**2. Three S1 defects.** All three are cases where a risk control silently stops working:

- **Positions in markets that fall out of the universe become permanently unmanaged.**
  `refreshQuotes` replaces the whole PM map each cycle (`src/engine.js:201`) and the universe is
  top-300-by-24h-volume. When a market's volume decays below rank 300, HOLT stops building the
  pair, and RIGO's `E.pairs.find(...)` returns undefined → `if (!q) continue`
  (`src/agents.js:145-147`). From then on the position is never marked, never stopped out, never
  max-held, and never flattened at kickoff. `resolution()` does re-insert the market into
  `quotes.pm`, but the next `refreshQuotes` wipes it before HOLT runs, so the pair never returns.
  `MAX_HOLD_MIN` is 240, so this fires inside a normal hold. Fix both halves: pin every market with
  an open position into the quote refresh regardless of volume rank, **and** move time-based exits
  (max hold, in-play flatten) out of the `if (!q)` guard. A clock-driven exit must never depend on
  a price arriving.

- **Staleness is checked globally, never per instrument.** `p.q = this.quote(p) || p.q || null`
  (`src/engine.js:269`) retains the last good quote forever, and TESS only checks `E.lastQuoteAt`,
  which refreshes if *any* venue call succeeds. One pair with a broken feed can be traded on
  arbitrarily old prices while the dashboard reads `data age 0s`. You already carry `q.t` per pair —
  reject pairs older than `maxDataAgeSec` in BRAM and surface per-pair age in `snapshot()`.

- **Corrupt state silently resets the account.** `load()` catches everything and returns a fresh
  $10,000 book (`src/engine.js:53`); `save()` writes straight over the target with no
  temp-and-rename (`src/engine.js:63`). Write to `state.json.tmp` then `fs.renameSync`, and on parse
  failure exit with a clear error rather than resetting the ledger.

Done means: `node server.js` boots clean, and `DEMO=1 DATA_DIR=./data-demo node server.js` still
reaches fills with the recorder writing lines.

## Constraints

- **Zero npm dependencies.** Node stdlib only. This is deliberate — it keeps the whole system
  auditable in an afternoon.
- **Paper only.** Do not touch live-mode credentials, do not place real orders, do not suggest
  funding anything.
- Match the existing code's voice: terse, comment-only-where-it-earns-it, and comments that explain
  *why* a non-obvious choice was made (see the `inPlay` comment at `src/agents.js:56` for the
  house style).
- Update `README.md` if behavior changes. Keep its honest tone — the "gap is not the edge" and
  "paper results are not predictive" sections are the best engineering in the repo.

## Backlog (out of scope for this session — do not start these)

3. **Agents return intents.** Every agent currently reads and writes shared mutable `E.*` fields;
   nothing declares what it consumes or produces, and the cycle order in `step()` is load-bearing
   but enforced by nothing. Refactor so each agent takes explicit inputs and returns intents, with
   the engine as the only mutator of cash and positions. This is a precondition for item 4.
4. **Replay harness.** Run BRAM/KETT/RIGO against recorded JSONL on a synthetic clock, so
   "would this have traded, and at what P&L?" is a 10-second question. Then tune `MIN_GAP` and
   `MIN_EDGE` against data instead of a hypothesis.
5. **Live-safety layer** (before any real money): startup reconciliation against
   `/portfolio/positions`; deterministic `client_order_id` derived from group+leg instead of a fresh
   UUID per attempt (`src/broker.js:88`); orphaned-leg flatten loop for failed unwinds
   (`src/agents.js:293-297`); bind the server to 127.0.0.1 (`server.js:71`) — it currently exposes
   `/api/positions` on all interfaces with no auth; an authenticated flatten-all endpoint; append-only
   trade journal to replace the ring buffers that truncate `state.log` at 500 and `state.closed` at
   2000; single shared fee function (BRAM's arb path uses ceiled `ks.fee(1, px)` while `convEdge`
   uses marginal `feePerContract`, so the arb book is ~0.25c/leg harder to trigger than intended);
   make the PM NO-leg `ref` fallback throw instead of silently using the YES token
   (`src/engine.js:171-173`); cycle-duration metric, since the `stepping` guard drops overrunning
   cycles silently.

## How to work

Deliver what is asked at the scope intended. Make routine judgment calls yourself and check in only
where different readings would lead to materially different work. If you think one of these fixes is
wrong or there is a better approach, say so in a sentence and continue with the task as asked rather
than quietly narrowing, widening, or transforming it. Finish both items completely; stop short of
the backlog.

Say in one sentence what you are about to do before your first tool call. While working, give a
brief update only when you find something important or change direction. When you finish, lead with
the outcome — the first sentence should say what changed and whether the desk still runs — with
supporting detail after it.

Keep responses focused and concise, and spend most of the response on substance rather than
caveats. Match any written document to what the task needs; do not pad with filler sections or
redundant summaries.

Only correct an earlier statement of yours when the error would change my code, conclusions, or
decisions. State such corrections plainly and briefly, then continue. For slips that change
nothing, make the fix and move on.

Do not delegate to a subagent. This is a four-file change in one small repo and is faster done
directly.
