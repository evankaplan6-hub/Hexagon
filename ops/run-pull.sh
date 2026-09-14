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
# emergency brake starts deleting tapes that never reached the Mac. That is why every way this
# can fail before node runs also leaves a PROBLEM line in data/fly/archive/pull.log, the same file
# fly-pull.js writes one line to per run: a gap or a PROBLEM there is the sign to look.
#
# Extra arguments pass straight through, which is how install-pull.sh proves the job works from
# launchd's bare environment before installing it, without changing anything:
#   bash ops/run-pull.sh --dry-run
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$HEXDIR/data/fly/archive"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

# Say it in launchd's log AND in pull.log -- except on a dry run, which changes nothing anywhere.
problem() {
  echo "$(ts) FATAL: $1 The Fly box was NOT pulled or trimmed." >&2
  if [ "$DRY" = 0 ]; then
    if mkdir -p "$ARCHIVE" 2>/dev/null; then
      printf '%sZ PROBLEM hexagon-desk run-pull.sh: %s nothing was copied or deleted\n' "$(date -u '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$ARCHIVE/pull.log" ||
        echo "  (and pull.log could not be written either)" >&2
    else
      echo "  (and $ARCHIVE could not be created for pull.log either)" >&2
    fi
  fi
}

# A linked git worktree (.claude/worktrees/*) is deleted with everything in it, its data/ included.
# The job belongs to the main checkout; install-pull.sh refuses to install from a worktree too.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "$(ts) FATAL: $HEXDIR is a git worktree, not the main checkout. The Fly box was NOT pulled or trimmed." >&2
  echo "  fix: run ops/run-pull.sh from the main checkout (~/Hexagon)" >&2
  exit 1
fi

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
  problem "node not found (launchd's PATH is minimal and nvm had none)."
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
  problem "fly not found at ~/.fly/bin/fly."
  echo "  fix: install it (curl -L https://fly.io/install.sh | sh), then re-run ops/install-pull.sh" >&2
  exit 1
fi

# `fly auth whoami` needs the network, and launchd runs a slot the Mac slept through the moment it
# wakes -- usually before Wi-Fi is back. So "logged out" (retrying will not help) is told apart
# from "cannot reach Fly" (wait for the network, up to ten minutes). A dry run is someone at the
# keyboard wanting an answer now, so it does not wait.
TRIES="${PULL_NET_TRIES:-20}"
GAP="${PULL_NET_GAP_SECS:-30}"
[ "$DRY" = 1 ] && TRIES=1
try=1
while :; do
  if why="$("$FLY" auth whoami 2>&1 >/dev/null)"; then break; fi
  last="$(printf '%s\n' "$why" | grep -v '^Warning' | grep . | tail -1 || true)"
  if printf '%s\n' "$why" | grep -qiE 'no access token|not logged in|unauthori[sz]ed|token (has )?expired|invalid token'; then
    problem "fly is not logged in (${last:-no detail})."
    echo "  fix: fly auth login" >&2
    exit 1
  fi
  if [ "$try" -ge "$TRIES" ]; then
    if [ "$TRIES" -gt 1 ]; then waited=" for $(( (TRIES - 1) * GAP / 60 )) minutes"; else waited=""; fi
    problem "could not reach Fly$waited (${last:-no detail}); the next scheduled run tries again."
    exit 1
  fi
  [ "$try" = 1 ] && echo "$(ts) cannot reach Fly yet, waiting for the network: ${last:-no detail}" >&2
  try=$((try + 1))
  sleep "$GAP"
done
export FLY_BIN="$FLY"

echo "$(ts) pulling from the Fly box with $(command -v node) $(node -v) and $FLY"
cd "$HEXDIR"
# caffeinate -i keeps the Mac from idling to sleep halfway through a 60MB download
if [ -x /usr/bin/caffeinate ]; then
  exec /usr/bin/caffeinate -i node tools/fly-pull.js --trim "$@"
fi
exec node tools/fly-pull.js --trim "$@"
