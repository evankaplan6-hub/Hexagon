#!/bin/bash
# Stop the desk starting on its own. Leaves the code and every journal untouched.
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.hexagon.desk.plist"
launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "removed. the desk will no longer start on its own."
echo "anything already running keeps running until you stop it or reboot."
