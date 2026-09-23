#!/bin/bash
# Stop the daily option-history pull (ops/install-history.sh). The files already in
# data/options/history/ are left where they are: once the trial key is gone they cannot be re-pulled.
#
#   bash ops/uninstall-history.sh
set -euo pipefail
LABEL="com.hexagon.history"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "STILL LOADED: launchctl still lists $LABEL" >&2
  exit 1
fi
echo "removed. the option history in data/options/history/ was left alone."
