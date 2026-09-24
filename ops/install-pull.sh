#!/bin/bash
# Pull the Fly box's closed days to this Mac, trim old tick tapes and probe files off the box, and
# back up what exists nowhere else.
#
# This installs a LaunchAgent: a per-user job macOS starts every hour at :30 (or on wake, if the
# Mac was asleep then). It runs ops/run-pull.sh, which does nothing once today's pull and backup
# have both gone through, and otherwise runs tools/fly-pull.js --trim: that copies every finished
# Eastern day into data/fly/archive and deletes a box tick tape or probe file only when it is older
# than three days AND its Mac copy has the box's sha256. Journals, whales, state.json and anything
# of today's are never deleted. Then it copies data/chains, data/options and data/fly/archive into
# iCloud Drive/Hexagon-backup (never deleting anything there). It reads nothing from .env, needs no
# Kalshi key, copies no secret, and cannot place an order.
#
# Run it yourself; nothing installs this for you.
#   bash ops/install-pull.sh
#
# To undo:
#   bash ops/uninstall-pull.sh
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.hexagon.pull"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Only from the main checkout. The plist hard-codes this folder, and a linked git worktree
# (.claude/worktrees/*) is deleted with everything in it: the job would stop without a word, and
# the archive it verified against -- the reason a box tape was deleted -- would go with it.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "refusing: $HEXDIR is a git worktree, not the main checkout." >&2
  echo "merge this branch, then run: bash ~/Hexagon/ops/install-pull.sh" >&2
  exit 1
fi

# fly has to be here and logged in, or the job would fail every morning for as long as nobody looked
FLY="$HOME/.fly/bin/fly"
[ -x "$FLY" ] || FLY="$(command -v fly || true)"
if [ -z "$FLY" ] || [ ! -x "$FLY" ]; then
  echo "refusing: fly is not installed (looked in ~/.fly/bin and on PATH)." >&2
  echo "install it with: curl -L https://fly.io/install.sh | sh" >&2
  exit 1
fi
if ! why="$("$FLY" auth whoami 2>&1 >/dev/null)"; then
  echo "refusing: fly auth whoami failed: $(printf '%s\n' "$why" | grep -v '^Warning' | grep . | tail -1 || true)" >&2
  echo "if that says no access token, run: fly auth login. if it cannot connect, try again once online." >&2
  exit 1
fi

# Prove the whole job works from launchd's bare environment BEFORE installing. The desk installer
# cannot do this (running its launcher starts a real server), but this one can: with --dry-run the
# pull lists the box and prints its plan, and changes nothing on either side. If node or fly
# cannot be found from a minimal PATH, or the box cannot be reached, this is where it shows --
# not three weeks from now, when the box's brake starts deleting tapes on its own.
echo "checking the job from a bare launchd environment (a dry run: it reads the box, changes nothing)..."
echo
if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HEXDIR/ops/run-pull.sh" --dry-run; then
  echo >&2
  echo "refusing: the pull does not work from launchd's environment (see above). nothing was installed." >&2
  exit 1
fi
echo

# The backup the same way, and for real: it is the first copy, and a copy is the only proof that
# this Mac lets a background job write to iCloud Drive at all. If it cannot -- iCloud Drive is off,
# or macOS keeps a background bash out of it -- the job would log a backup PROBLEM every hour, so
# say it now. The other way to a backup is Time Machine on an external disk, which also covers
# .env and the Kalshi key that this copy deliberately leaves out.
echo "backing up data/chains, data/options and data/fly/archive to iCloud Drive, from the same bare environment..."
if ! env -i HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-}" PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    /bin/bash "$HEXDIR/ops/run-pull.sh" --backup-only; then
  echo >&2
  echo "refusing: the backup to iCloud Drive does not work from launchd's environment (see above). nothing was installed." >&2
  echo "turn iCloud Drive on (System Settings > Apple Account > iCloud), or back up with Time Machine on an external disk." >&2
  exit 1
fi
echo

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HEXDIR/data/fly/archive"
chmod +x "$HEXDIR/ops/run-pull.sh"
sed -e "s|__HEXDIR__|$HEXDIR|g" -e "s|__HOME__|$HOME|g" "$HEXDIR/ops/$LABEL.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "installed. it runs every hour at :30 (or when the Mac wakes) and does nothing once the day's pull and backup are done."
else
  echo "INSTALLED BUT NOT LOADED: launchctl does not list $LABEL" >&2
  exit 1
fi
echo "run it now:   launchctl start $LABEL"
echo "one line/run: $HEXDIR/data/fly/archive/pull.log   (no new line for a day, or a PROBLEM line: look)"
echo "the backup:   $HOME/Library/Mobile Documents/com~apple~CloudDocs/Hexagon-backup   (one line/run in data/fly/archive/backup.log)"
echo "full output:  $HOME/Library/Logs/hexagon-pull.log"
