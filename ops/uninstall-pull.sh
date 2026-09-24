#!/bin/bash
# Stop the hourly Fly pull and, with it, the iCloud Drive backup (the same job). Leaves the code,
# data/fly/archive, the copy already in iCloud Drive/Hexagon-backup and everything on the box untouched.
set -euo pipefail
DEST="$HOME/Library/LaunchAgents/com.hexagon.pull.plist"
launchctl unload "$DEST" 2>/dev/null || true
rm -f "$DEST"
echo "removed. the Fly box will no longer be pulled or trimmed on its own, and nothing is backed up to iCloud Drive."
echo "the copy already in iCloud Drive/Hexagon-backup is left in place."
echo "without the pull the box's disk fills in about a week; then its brake deletes the oldest tapes"
echo "whether or not they were copied. pull by hand with: node tools/fly-pull.js --trim"
echo "back up by hand with: bash ops/run-pull.sh --backup-only"
