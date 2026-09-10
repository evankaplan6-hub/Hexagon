#!/bin/bash
# Launcher for the LaunchAgent.
#
# launchd starts jobs with a minimal PATH -- /usr/bin:/bin:/usr/sbin:/sbin -- and nothing else.
# Node here is installed under nvm, which is not on that PATH, so `/usr/bin/env node` failed with
# exit 127 ("command not found") every 30 seconds and the desk never started. Baking the absolute
# nvm path into the plist instead would work until the next `nvm install`, and then break silently,
# which is worse: an auto-start job that has quietly not been running is indistinguishable from one
# that has, right up until you go looking for a week of data that was never collected.
#
# So: find node the same way a login shell would, and say so loudly if it cannot be found.
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use
  if command -v nvm >/dev/null 2>&1; then
    nvm use --lts >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
  fi
fi

# still nothing: fall back to the newest node nvm has on disk
if ! command -v node >/dev/null 2>&1; then
  latest="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$latest" ] && export PATH="$latest:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') FATAL: node not found. The desk is NOT running." >&2
  echo "  launchd PATH is minimal and node was not located via nvm either." >&2
  echo "  fix: edit ops/run-desk.sh, or reinstall with ops/install-autostart.sh" >&2
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') starting desk with $(command -v node) $(node -v)"
cd "$HEXDIR"
exec node server.js
