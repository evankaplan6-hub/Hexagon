#!/bin/bash
# Stop recording the anytime-touchdown board (ops/install-td-tape.sh).
#
# This removes the LaunchAgent only. The tape already in data/td/ is left exactly where it is: a
# Sunday cannot be re-collected, so nothing here deletes it.
#
#   bash ops/uninstall-td-tape.sh
set -euo pipefail
LABEL="com.hexagon.tdtape"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"

if launchctl list | awk -v l="$LABEL" '$3 == l { found = 1 } END { exit !found }'; then
  echo "STILL LOADED: launchctl still lists $LABEL" >&2
  exit 1
fi
echo "removed. the tape in data/td/ was left alone -- it cannot be re-collected."
