#!/bin/bash
# Stop the daily Fly pull. Leaves the code, data/fly/archive and everything on the box untouched.
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.hexagon.pull.plist"
launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "removed. the Fly box will no longer be pulled or trimmed on its own."
echo "without it the box's disk fills in about two weeks; then its brake deletes the oldest tapes"
echo "whether or not they were copied. pull by hand with: node tools/fly-pull.js --trim"
