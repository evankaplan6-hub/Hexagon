#!/bin/bash
# Record the option chains into data/chains/ every weekday, so that in a year there is an options
# history to test against. There is no way to buy one later: free historical chains do not exist,
# and a day nobody recorded is gone.
#
# This installs a LaunchAgent: a per-user job macOS runs at 16:25, 20:00 and 09:45 local (or on
# wake, if the Mac was asleep then). It runs tools/chain-record.js, which reads Cboe's free delayed
# quotes and appends to data/chains/chains-YYYY-MM-DD.jsonl. It reads nothing from .env, needs no
# key, touches no broker and cannot place an order. An unchanged chain is skipped, so weekends and
# holidays write nothing.
#
# It costs about 1.8 MB a snapshot across the six ETFs -- roughly 0.5 GB a year.
#
# Run it yourself; nothing installs this for you.
#   bash ops/install-chains.sh
#
# To undo:
#   bash ops/uninstall-chains.sh
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.hexagon.chains"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Only from the main checkout. The plist hard-codes this folder, and a linked git worktree
# (.claude/worktrees/*) is deleted with everything in it -- which here would mean deleting the
# tape itself, the one thing in this repo that cannot be regenerated.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "refusing: $HEXDIR is a git worktree, not the main checkout." >&2
  echo "merge this branch, then run: bash ~/Hexagon/ops/install-chains.sh" >&2
  exit 1
fi

# Prove the whole job works from launchd's bare environment BEFORE installing: if node cannot be
# found from a minimal PATH, or Cboe cannot be reached, this is where it should show -- not in six
# months, when the tape is wanted and turns out to have three days in it. --dry-run fetches and
# reports, and writes neither the tape nor the seen file, so it cannot make the first real run
# skip a snapshot as already seen.
echo "checking the job from a bare launchd environment (a dry run: it fetches, writes nothing)..."
echo
if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HEXDIR/ops/run-chains.sh" --dry-run; then
  echo >&2
  echo "refusing: the recorder does not work from launchd's environment (see above). nothing was installed." >&2
  exit 1
fi
echo

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HEXDIR/data/chains"
chmod +x "$HEXDIR/ops/run-chains.sh"
sed -e "s|__HEXDIR__|$HEXDIR|g" -e "s|__HOME__|$HOME|g" "$HEXDIR/ops/$LABEL.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "installed. it records at 16:25, 20:00 and 09:45 (or when the Mac wakes, if it was asleep then)."
else
  echo "INSTALLED BUT NOT LOADED: launchctl does not list $LABEL" >&2
  exit 1
fi
echo "run it now:   launchctl start $LABEL"
echo "the tape:     $HEXDIR/data/chains/chains-YYYY-MM-DD.jsonl"
echo "full output:  $HOME/Library/Logs/hexagon-chains.log   (a PROBLEM line, or no new file for days: look)"
