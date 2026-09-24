#!/bin/bash
# Launcher for the daily chain-tape LaunchAgent (ops/com.hexagon.chains.plist).
#
# Records one snapshot of the option chains into data/chains/ (tools/chain-record.js). Read-only
# public market data from Cboe's delayed feed: no broker, no account, no key, no order path.
#
# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else -- no nvm, so no
# node. So find it the way a login shell would (the same search ops/run-desk.sh and
# ops/run-pull.sh use) and say so loudly when it is missing. A daily job that has quietly stopped
# working looks exactly like one that is working, and here the cost of not noticing is permanent:
# an unrecorded day cannot be bought back, from anyone, at any price. That is why every way this
# can fail before node runs also leaves a PROBLEM line in data/chains/chains.log. Once node runs,
# tools/chain-record.js writes that file's line itself -- ok or PROBLEM, one per run -- and exits 1
# on a PROBLEM, which the exec below hands straight to launchd (2026-09-24).
#
# Extra arguments pass straight through, which is how install-chains.sh proves the job works from
# launchd's bare environment before installing it, without writing anything:
#   bash ops/run-chains.sh --dry-run
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
CHAINS="$HEXDIR/data/chains"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

problem() {
  echo "$(ts) FATAL: $1 No chain snapshot was recorded." >&2
  if [ "$DRY" = 0 ]; then
    if mkdir -p "$CHAINS" 2>/dev/null; then
      printf '%sZ PROBLEM chain-record: %s nothing was recorded\n' "$(date -u '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$CHAINS/chains.log" ||
        echo "  (and chains.log could not be written either)" >&2
    else
      echo "  (and $CHAINS could not be created for chains.log either)" >&2
    fi
  fi
}

# A linked git worktree (.claude/worktrees/*) is deleted with everything in it, its data/ included
# -- and with it every day of tape recorded there. The job belongs to the main checkout;
# install-chains.sh refuses to install from a worktree too.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "$(ts) FATAL: $HEXDIR is a git worktree, not the main checkout. No chain snapshot was recorded." >&2
  echo "  fix: run ops/run-chains.sh from the main checkout (~/Hexagon)" >&2
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
  echo "  fix: edit ops/run-chains.sh, then re-run ops/install-chains.sh" >&2
  exit 1
fi

echo "$(ts) recording option chains with $(command -v node) $(node -v)"
cd "$HEXDIR"
# The snapshot is a few MB over six requests; caffeinate -i keeps an idle Mac from sleeping
# through it once it has started.
if [ -x /usr/bin/caffeinate ]; then
  exec /usr/bin/caffeinate -i node tools/chain-record.js "$@"
fi
exec node tools/chain-record.js "$@"
