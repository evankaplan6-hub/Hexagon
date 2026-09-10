#!/bin/bash
# Keep the PAPER desk running across sleep, logout and reboot.
#
# This installs a LaunchAgent: a per-user background job macOS starts at login and restarts if it
# dies. It runs server.js exactly as it runs today. It does not touch MODE or LIVE_CONFIRM, and it
# cannot place a real order -- the live locks live in .env and this script only ever reads MODE to
# refuse installing when it says live.
#
# Run it yourself; nothing installs this for you.
#   bash ops/install-autostart.sh
#
# To undo:
#   bash ops/uninstall-autostart.sh
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.hexagon.desk.plist"

mode=$(grep -E '^MODE=' "$HEXDIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true)
if [ "${mode:-paper}" = "live" ]; then
  echo "refusing: MODE=live in .env." >&2
  echo "this installs an always-on job and is for paper measurement only." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HEXDIR/data"
sed "s|__HEXDIR__|$HEXDIR|g" "$HEXDIR/ops/com.hexagon.desk.plist" > "$DEST"
launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "installed: $DEST"
echo "the desk now starts at login and restarts itself if it exits"
echo "logs:      $HEXDIR/data/desk.log"
echo "dashboard: http://localhost:8787"
