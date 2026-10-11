#!/bin/bash
# Record Kalshi's anytime-touchdown board before every NFL kickoff into data/td/, so that in a season
# there is a measurement of what the board costs (tools/td-tape.js says why; README "Anytime
# touchdown tape"). Log-only research: no bet, no broker, no key.
#
# This installs a LaunchAgent: a per-user job macOS runs every 15 minutes. It runs
# tools/td-tape.js --record, which reads Kalshi's public market list and appends the 1+ touchdown
# markets of any game kicking off in the next three hours to data/td/td-YYYY-MM-DD.jsonl. A run with
# no game near writes nothing. It reads nothing from .env and cannot place an order.
#
# It costs one Kalshi request every 15 minutes and about 200 KB of tape a Sunday.
#
# Run it yourself; nothing installs this for you.
#   bash ops/install-td-tape.sh
#
# To undo:
#   bash ops/uninstall-td-tape.sh
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.hexagon.tdtape"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Only from the main checkout: the plist hard-codes this folder, and a linked git worktree
# (.claude/worktrees/*) is deleted with everything in it, the tape included.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "refusing: $HEXDIR is a git worktree, not the main checkout." >&2
  echo "merge this branch, then run: bash ~/Hexagon/ops/install-td-tape.sh" >&2
  exit 1
fi

# Prove the whole job works from launchd's bare environment BEFORE installing: if node cannot be
# found from a minimal PATH, or Kalshi cannot be reached, this is where it should show. --dry-run
# fetches and reports and writes nothing.
echo "checking the job from a bare launchd environment (a dry run: it fetches, writes nothing)..."
echo
if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HEXDIR/ops/run-td-tape.sh" --dry-run; then
  echo >&2
  echo "refusing: the recorder does not work from launchd's environment (see above). nothing was installed." >&2
  exit 1
fi
echo

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HEXDIR/data/td"
chmod +x "$HEXDIR/ops/run-td-tape.sh"
sed -e "s|__HEXDIR__|$HEXDIR|g" -e "s|__HOME__|$HOME|g" "$HEXDIR/ops/$LABEL.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "installed. it runs every 15 minutes and records the board of any game kicking off in the next three hours."
  echo "grade a day once its games have settled:  node tools/td-tape.js --grade --day $(date '+%Y-%m-%d')"
else
  echo "INSTALLED BUT NOT LOADED: launchctl does not list $LABEL" >&2
  exit 1
fi
