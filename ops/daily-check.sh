#!/bin/bash
# The daily trust routine: five questions about the Fly box, one screen, nothing changed anywhere.
#
#   bash ops/daily-check.sh
#
#   1. did the morning pull run?          the last line of data/fly/archive/pull.log, and how old it is
#   2. does the ledger add up?            tools/ledger-check.js --box --venues: the journal rebuilds the
#                                         state line by line, and every settlement agrees with the venues
#   3. what has each book made?           tools/pnl-report.js, from the pulled journals; and tools/fillcheck.js on the
#                                         newest pulled day: does the maker fill the way its own tape says
#   4. how often was the desk restarted?  WATCHDOG lines in the box's journal, yesterday and today (ET).
#                                         29 on 2026-09-20 and 5 on 2026-09-21; a restart is a
#                                         cancel-and-repost, so a day with many of them is a day the
#                                         maker's fills (tools/fillcheck.js) cannot be compared with its model
#   5. is the box starved?                /proc/pressure/cpu (shared-cpu-1x: `some avg300` over ~20 is
#                                         when the hourly restarts began), the commit it runs, /data free
#
# Nothing on the box is changed and nothing is deleted anywhere. What it writes on the Mac: step 2
# copies the box's state.json and today's journal down into data/fly/archive (ledger-check --box),
# and step 3b appends one line to data/fly/archive/fillcheck.jsonl. It reads no secret and cannot
# place an order. The pull itself stays with its own job (ops/install-pull.sh); this only says
# whether that job is alive.
# Every step runs even if an earlier one fails, and the exit code is how many did.
set -uo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="hexagon-desk"
cd "$HEXDIR"

FLY="$HOME/.fly/bin/fly"
[ -x "$FLY" ] || FLY="$(command -v fly || true)"
if [ -z "$FLY" ] || [ ! -x "$FLY" ]; then echo "fly is not installed (looked in ~/.fly/bin and on PATH)" >&2; exit 1; fi

bad=0
say() { printf '\n== %s\n' "$1"; }

say "1. the morning pull"
LOG="$HEXDIR/data/fly/archive/pull.log"
if [ -f "$LOG" ]; then
  tail -1 "$LOG"
  age=$(( ( $(date +%s) - $(stat -f %m "$LOG") ) / 3600 ))
  if [ "$age" -ge 26 ]; then echo "PROBLEM: pull.log was last written ${age}h ago; the job runs at 09:30 and 13:30 (launchctl list | grep hexagon)"; bad=$((bad + 1)); fi
  if tail -1 "$LOG" | grep -q PROBLEM; then bad=$((bad + 1)); fi
else
  echo "PROBLEM: no $LOG -- the pull has never run here (bash ops/install-pull.sh)"; bad=$((bad + 1))
fi

say "2. the ledger, against the journal and the venues"
node tools/ledger-check.js --box --venues || bad=$((bad + 1))

say "3. realised P&L by book"
node tools/pnl-report.js || bad=$((bad + 1))

say "3b. the maker's fills on the newest pulled day: journal, tape replay, and where the rest went"
node tools/fillcheck.js || bad=$((bad + 1))

say "4 + 5. the box: restarts, CPU pressure, commit, disk"
TODAY="$(TZ=America/New_York date +%F)"
YDAY="$(TZ=America/New_York date -v-1d +%F)"
# one ssh session for all of it, and nothing heavier than grep: the box has one shared CPU.
# (the dots stand for the quotes in "kind":"WATCHDOG", which would not survive three shells)
"$FLY" ssh console -a "$APP" -C "sh -c 'echo commit \$GIT_SHA; for d in $YDAY $TODAY; do echo \"watchdog restarts \$d: \$(n=\$(grep -c kind.:.WATCHDOG., /data/journal-\$d.jsonl 2>/dev/null); echo \${n:-0})\"; done; cat /proc/pressure/cpu; df -m /data | tail -1'" 2>&1 | grep -v '^Connecting to' || bad=$((bad + 1))

printf '\n%s\n' "$([ "$bad" = 0 ] && echo 'all five answered, nothing flagged' || echo "$bad step(s) flagged a problem: read up")"
exit "$bad"
