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

# Prove node is reachable from launchd's environment BEFORE installing. The first version of this
# installed happily and then failed every 30 seconds with exit 127, because launchd's PATH does not
# include nvm -- and a broken auto-start job looks exactly like a working one until you go looking
# for a week of data that was never collected.
#
# This reproduces the launcher's search in a bare environment. It deliberately does NOT invoke
# run-desk.sh, which would start a real server rather than check anything.
found=$(env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use
  command -v nvm >/dev/null 2>&1 && { nvm use --lts >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true; }
  if ! command -v node >/dev/null 2>&1; then
    latest="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
    [ -n "$latest" ] && export PATH="$latest:$PATH"
  fi
  command -v node || true' 2>/dev/null)
if [ -z "$found" ]; then
  echo "warning: node is not reachable from a bare launchd environment." >&2
  echo "installing anyway, but check $HEXDIR/data/desk.log says 'starting desk'." >&2
else
  echo "launchd will find node at: $found"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HEXDIR/data"
chmod +x "$HEXDIR/ops/run-desk.sh"
sed "s|__HEXDIR__|$HEXDIR|g" "$HEXDIR/ops/com.hexagon.desk.plist" > "$DEST"

# Anything started by hand would fight the LaunchAgent for port 8787; stand it down first.
if lsof -t -i:8787 >/dev/null 2>&1; then
  echo "stopping the desk currently on port 8787 so the LaunchAgent can take over"
  kill "$(lsof -t -i:8787 | head -1)" 2>/dev/null || true
  for _ in $(seq 1 20); do lsof -t -i:8787 >/dev/null 2>&1 || break; sleep 1; done
fi

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
sleep 4

status=$(launchctl list | awk '$3 == "com.hexagon.desk" {print $2}')
if [ "${status:-}" = "0" ] || lsof -t -i:8787 >/dev/null 2>&1; then
  echo "installed and running."
else
  echo "INSTALLED BUT NOT RUNNING (last exit status: ${status:-unknown})" >&2
  echo "see $HEXDIR/data/desk.log" >&2
fi
echo "logs:      $HEXDIR/data/desk.log"
echo "dashboard: http://localhost:8787"
echo "check on it later with:  node tools/maker-report.js"
