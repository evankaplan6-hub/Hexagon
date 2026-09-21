#!/bin/bash
# Stop recording option chains (ops/install-chains.sh).
#
# This removes the LaunchAgent only. The tape already in data/chains/ is left exactly where it is:
# it cannot be re-collected, so nothing here deletes it.
#
#   bash ops/uninstall-chains.sh
set -euo pipefail
LABEL="com.hexagon.chains"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "STILL LOADED: launchctl still lists $LABEL" >&2
  exit 1
fi
echo "removed. the chain tape in data/chains/ was left alone -- it cannot be re-collected."
