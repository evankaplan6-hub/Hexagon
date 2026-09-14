#!/bin/bash
# Pull the Fly box's closed days to this Mac every morning, and trim old tick tapes off the box.
#
# This installs a LaunchAgent: a per-user job macOS runs once a day at 09:30 (or on wake, if the
# Mac was asleep then). It runs tools/fly-pull.js --trim, which copies every finished Eastern day
# into data/fly/archive and deletes a box tick tape only when it is older than three days AND its
# Mac copy has the box's sha256. Journals, whales, probes, state.json and today's tape are never
# deleted. It reads nothing from .env, needs no Kalshi key, and cannot place an order.
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

# fly has to be here and logged in, or the job would fail every morning for as long as nobody looked
FLY="$HOME/.fly/bin/fly"
[ -x "$FLY" ] || FLY="$(command -v fly || true)"
if [ -z "$FLY" ] || [ ! -x "$FLY" ]; then
  echo "refusing: fly is not installed (looked in ~/.fly/bin and on PATH)." >&2
  echo "install it with: curl -L https://fly.io/install.sh | sh" >&2
  exit 1
fi
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  echo "refusing: fly is not logged in. run: fly auth login" >&2
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

mkdir -p "$HOME/Library/LaunchAgents" "$HEXDIR/data/fly/archive"   # launchd will not create the log's folder
chmod +x "$HEXDIR/ops/run-pull.sh"
sed "s|__HEXDIR__|$HEXDIR|g" "$HEXDIR/ops/$LABEL.plist" > "$DEST"
plutil -lint "$DEST" >/dev/null

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "installed. it runs every day at 09:30 (or when the Mac wakes, if it was asleep then)."
else
  echo "INSTALLED BUT NOT LOADED: launchctl does not list $LABEL" >&2
  exit 1
fi
echo "run it now:   launchctl start $LABEL"
echo "one line/run: $HEXDIR/data/fly/archive/pull.log"
echo "full output:  $HEXDIR/data/fly/archive/launchd.log"
