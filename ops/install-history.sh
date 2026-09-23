#!/bin/bash
# Pull the ChartExchange option history a little every day, for as long as the trial key answers.
#
# This installs a LaunchAgent: a per-user job macOS runs four times a day (00:40, 06:40, 12:40,
# 18:40 local, or on wake). It runs tools/option-history.js through ops/run-history.sh: newest
# expiries first, strikes within 5% of the 70-day range, and it stops the moment the key's daily
# cap refuses it, resuming from disk next time. Read-only: a data key, no broker, no order path.
# It reads CHARTEXCHANGE_API_KEY from .env and nothing else.
#
# Run it yourself; nothing installs this for you.
#   bash ops/install-history.sh
#
# To undo (the trial ends 2026-10-07; after that every run is one refused call and one log line):
#   bash ops/uninstall-history.sh
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.hexagon.history"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "refusing: $HEXDIR is a git worktree, not the main checkout." >&2
  echo "merge this branch, then run: bash ~/Hexagon/ops/install-history.sh" >&2
  exit 1
fi

# Prove the job from launchd's bare environment BEFORE installing, without spending the key: a dry
# run over one expiry that is already on disk finds node, reads .env, and fetches nothing.
echo "checking the job from a bare launchd environment (a dry run over what is already on disk)..."
echo
if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HEXDIR/ops/run-history.sh" --dry-run --only SPY --from 2021-07 --to 2021-07; then
  echo >&2
  echo "refusing: the pull does not work from launchd's environment (see above). nothing was installed." >&2
  exit 1
fi
echo

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HEXDIR/data/options/history"
chmod +x "$HEXDIR/ops/run-history.sh"
sed -e "s|__HEXDIR__|$HEXDIR|g" -e "s|__HOME__|$HOME|g" "$HEXDIR/ops/$LABEL.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "installed. it runs at 00:40, 06:40, 12:40 and 18:40 (or when the Mac wakes, if it was asleep then)."
else
  echo "INSTALLED BUT NOT LOADED: launchctl does not list $LABEL" >&2
  exit 1
fi
echo "run it now:   launchctl start $LABEL"
echo "one line/run: $HEXDIR/data/options/history/history.log   (STOPPED after 0 pulled every run for a day: the cap did not reset)"
echo "the files:    $HEXDIR/data/options/history/<SYM>/<SYM>-<EXPIRY>.json"
echo "full output:  $HOME/Library/Logs/hexagon-history.log"
