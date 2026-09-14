#!/bin/bash
# Launcher for the daily pull LaunchAgent (ops/com.hexagon.pull.plist).
#
# Copies every closed day from the Fly box into data/fly/archive, then deletes box tick tapes
# older than three Eastern days -- each only once its Mac copy has the box's sha256
# (tools/fly-pull.js --trim). The box's /data is 1GB and fills in about two weeks without this.
#
# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else: no nvm, so no node,
# and no ~/.fly/bin, so no fly. So find both the way a login shell would (the node search is the
# one ops/run-desk.sh uses), and say so loudly when either is missing. A daily job that has
# quietly stopped working looks exactly like one that is working, right up until the box's own
# emergency brake starts deleting tapes that never reached the Mac.
#
# Extra arguments pass straight through, which is how install-pull.sh proves the job works from
# launchd's bare environment before installing it, without changing anything:
#   bash ops/run-pull.sh --dry-run
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

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
  echo "$(ts) FATAL: node not found. The Fly box was NOT pulled or trimmed." >&2
  echo "  launchd PATH is minimal and node was not located via nvm either." >&2
  echo "  fix: edit ops/run-pull.sh, then re-run ops/install-pull.sh" >&2
  exit 1
fi

# fly installs itself to ~/.fly/bin; a Homebrew flyctl lands in /opt/homebrew/bin, also off launchd's PATH
FLY="${FLY_BIN:-$HOME/.fly/bin/fly}"
if [ ! -x "$FLY" ]; then
  for c in /opt/homebrew/bin/fly /usr/local/bin/fly; do
    if [ -x "$c" ]; then FLY="$c"; break; fi
  done
fi
if [ ! -x "$FLY" ]; then
  echo "$(ts) FATAL: fly not found at ~/.fly/bin/fly. The Fly box was NOT pulled or trimmed." >&2
  echo "  fix: install it (curl -L https://fly.io/install.sh | sh), then re-run ops/install-pull.sh" >&2
  exit 1
fi
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  echo "$(ts) FATAL: fly is not logged in. The Fly box was NOT pulled or trimmed." >&2
  echo "  fix: fly auth login" >&2
  exit 1
fi
export FLY_BIN="$FLY"

echo "$(ts) pulling from the Fly box with $(command -v node) $(node -v) and $FLY"
cd "$HEXDIR"
exec node tools/fly-pull.js --trim "$@"
