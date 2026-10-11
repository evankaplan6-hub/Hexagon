#!/bin/bash
# Launcher for the anytime-touchdown tape LaunchAgent (ops/com.hexagon.tdtape.plist).
#
# Records Kalshi's "1+ touchdowns" player markets for the games kicking off in the next three hours
# into data/td/ (tools/td-tape.js --record). Read-only public market data, no key, no account, no
# broker, no order path: a study of what the board costs, not a bet.
#
# launchd starts jobs with PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else -- no nvm, so no
# node. So find it the way a login shell would (the same search ops/run-chains.sh uses) and say so
# loudly when it is missing. A job that has quietly stopped working looks exactly like one that is
# working, and a Sunday nobody recorded cannot be re-collected. Every way this can fail before node
# runs leaves a PROBLEM line in data/td/td.log; once node runs, tools/td-tape.js writes that file's
# line itself -- ok or PROBLEM, one per run -- and exits 1 on a PROBLEM, which the exec below hands
# straight to launchd.
#
# Extra arguments pass straight through, which is how install-td-tape.sh proves the job works from
# launchd's bare environment before installing it, without writing anything:
#   bash ops/run-td-tape.sh --dry-run
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
TD="$HEXDIR/data/td"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

problem() {
  echo "$(ts) FATAL: $1 Nothing was recorded." >&2
  if [ "$DRY" = 0 ]; then
    if mkdir -p "$TD" 2>/dev/null; then
      printf '%sZ PROBLEM td-tape: %s nothing was recorded\n' "$(date -u '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$TD/td.log" ||
        echo "  (and td.log could not be written either)" >&2
    else
      echo "  (and $TD could not be created for td.log either)" >&2
    fi
  fi
}

# A linked git worktree (.claude/worktrees/*) is deleted with everything in it, its data/ included.
# The job belongs to the main checkout; install-td-tape.sh refuses to install from a worktree too.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "$(ts) FATAL: $HEXDIR is a git worktree, not the main checkout. Nothing was recorded." >&2
  echo "  fix: run ops/run-td-tape.sh from the main checkout (~/Hexagon)" >&2
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
  echo "  fix: edit ops/run-td-tape.sh, then re-run ops/install-td-tape.sh" >&2
  exit 1
fi

cd "$HEXDIR"
exec node tools/td-tape.js --record "$@"
