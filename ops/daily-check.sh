#!/bin/bash
# The daily trust routine: six questions about the Fly box and the Mac's tapes, one screen, nothing changed on the box.
#
#   bash ops/daily-check.sh
#
#   1. did the pull run?                  the last line of data/fly/archive/pull.log, and how old it is (hourly at :30
#                                         since 2026-09-24, until the day's pull and backup are both ok)
#   2. does the ledger add up?            tools/ledger-check.js --box --venues: the journal rebuilds the
#                                         state line by line, and every settlement agrees with the venues
#   3. what has each book made?           tools/pnl-report.js, from the pulled journals; and tools/fillcheck.js on the
#                                         newest pulled day: does the maker fill the way its own tape says
#   4. how often was the desk restarted,  tools/restarts.js on the journals step 2 just brought down,
#      and did each have a reason?        yesterday and today (ET): START, STOP (a deploy), WATCHDOG
#                                         and CRASH lines, and every START whose previous lifecycle
#                                         line is none of STOP, WATCHDOG or CRASH -- an OOM kill or a
#                                         heap abort, which run no handler. Before 2026-09-24 this
#                                         counted WATCHDOG lines only, so a crash Fly quietly restarted
#                                         read as a clean day. WATCHDOG: 29 on 2026-09-20, 5 on 09-21;
#                                         a restart is a cancel-and-repost, so a day with many is a day
#                                         the maker's fills (tools/fillcheck.js) cannot be compared with its model
#   5. is the box starved?                /proc/stat since boot: the desk's share of the CPU, and "steal",
#                                         the time Fly held it back for being over its cap (5ms per 80ms per
#                                         shared vCPU). Steal is the number to read: ~50% on shared-cpu-1x on
#                                         2026-09-22, the day of 5 restarts. Then /proc/pressure/cpu, which
#                                         counts that same throttling as waiting, the commit it runs, /data
#                                         free, and the probe files' total (the pull trims them since
#                                         2026-09-24; a total that keeps growing means it has stopped)
#   6. is the option-chain tape alive?    tools/chain-record.js --check on this Mac: the last chains.log
#                                         line, the newest Cboe stamp per symbol, the last finished weekday
#
# Nothing on the box is changed. What it writes on the Mac: step 2 copies the box's state.json and
# the journals the archive lacks into data/fly/box-now, replacing the copies from the previous run
# (ledger-check --box), and step 3b appends one line to data/fly/archive/fillcheck.jsonl. Steps 3
# and 4 read data/fly/box-now next to the archive, so "today" is today's journal and not the tail
# of yesterday's. It reads no secret and cannot place an order. The pull itself stays with its own
# job (ops/install-pull.sh); this only says whether that job is alive.
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

say "1. the pull"
LOG="$HEXDIR/data/fly/archive/pull.log"
if [ -f "$LOG" ]; then
  tail -1 "$LOG"
  age=$(( ( $(date +%s) - $(stat -f %m "$LOG") ) / 3600 ))
  if [ "$age" -ge 26 ]; then echo "PROBLEM: pull.log was last written ${age}h ago; the job runs every hour at :30 until the day is done (launchctl list | grep hexagon)"; bad=$((bad + 1)); fi
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

say "4. restarts, yesterday and today (ET), and whether each had a reason"
node tools/restarts.js || bad=$((bad + 1))

say "5. the box: CPU pressure, commit, disk, probe files"
# one ssh session for all of it, and nothing heavier than du: the box has one shared CPU.
"$FLY" ssh console -a "$APP" -C "sh -c 'echo commit \$GIT_SHA; set -- \$(head -1 /proc/stat); t=\$((\$2+\$3+\$4+\$5+\$6+\$7+\$8+\$9)); echo \"cpu since boot: desk \$(((\$2+\$4)*100/t))%, held back by Fly (steal) \$((\$9*100/t))%\"; cat /proc/pressure/cpu; df -m /data | tail -1; echo \"probe files on the box: \$(ls /data/probes-*.jsonl 2>/dev/null | wc -l) files, \$(du -cm /data/probes-*.jsonl 2>/dev/null | tail -1 | cut -f1) MB\"'" 2>&1 | grep -v '^Connecting to' || bad=$((bad + 1))

say "6. the option-chain tape on this Mac: the last run, the newest Cboe stamp per symbol, the last finished weekday"
# Read-only (tools/chain-record.js --check). Added 2026-09-24: Cboe's feed froze from the 09-22
# evening, 09-23 has no session quotes at all, and nothing here said so for a day and a half.
node tools/chain-record.js --check || bad=$((bad + 1))

printf '\n%s\n' "$([ "$bad" = 0 ] && echo 'every step answered, nothing flagged' || echo "$bad step(s) flagged a problem: read up")"
exit "$bad"
