You are picking up the Hexagon prediction-market desk at ~/Hexagon. Read CLAUDE.md, then README.md
in full, then ops/rework-plan-2026-09-12.md. The plan is the task; this prompt is the framing.

Situation: the paper desk has been running on Fly (app hexagon-desk) since 2026-09-10 and is
roughly flat, which the README predicts. Two days of journal analysis found the specific leaks:
59% of maker-filled contracts were run-over fills costing $55 against the tape, zero spread was
captured on round trips, inventory stuck in the tails cannot be worked off because of an ordering
bug in desiredQuotes, the tape poller drops pages (145 gaps), and the taker desks paid $24 in
Kalshi fees on $21 of gross. All numbers and how they were computed are in the plan's baseline
table. Reproduce the baseline first so you have a before/after.

Do Phase 1 of the plan now: 1a tape pagination, 1b reduce-in-the-tails, 1c run-over toxicity
gate, 1d soft cap withdrawal. Each gets a unit test in tools/maker-test.js, each is scored
separately in replay against the recorded tape, then together. Commit each sub-item on its own
with a one-sentence message in the repo's style. Stop after Phase 1 and report the before/after
table; do not start Phase 2 or deploy without being asked.

Rules that override everything else: paper mode only and never touch MODE, DEMO or LIVE_CONFIRM;
zero npm dependencies; do not run node server.js locally against ./data while the Fly desk is up;
there is no git remote so never do a destructive git operation; npm test must stay green. If a
measurement contradicts the plan, say so and stop rather than building on it.
