#!/bin/bash
# Launcher for the option-history LaunchAgent (ops/com.hexagon.history.plist).
#
# Pulls expired option contracts' daily bars from ChartExchange into data/options/history/
# (tools/option-history.js). Read-only market data behind a key that can only read: no broker, no
# account, no order path. Needs CHARTEXCHANGE_API_KEY in .env, which the tool itself loads.
#
# WHY SEVERAL TIMES A DAY. The trial key answers a few hundred calls and then refuses everything
# with HTTP 406 until its cap resets, and nobody has published when that is. The tool stops the
# moment it is refused (exit 3) and resumes from what is on disk next time, so an extra run on a
# capped key costs one call and one line in history.log. Four runs a day means the reset, whenever
# it falls, is met within six hours and the day's allowance is used. Newest expiries first, strikes
# within 5% of the 70-day range: the allowance is small, so it goes on the years and the strikes a
# backtest reads first.
#
# launchd starts jobs with a minimal PATH and no nvm, so node is found the way ops/run-chains.sh
# finds it, and every way this can fail before node runs leaves a PROBLEM line in history.log.
#
# Extra arguments pass through, which is how install-history.sh proves the job from launchd's
# bare environment without spending the key:
#   bash ops/run-history.sh --dry-run --only SPY --to 2021-07
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
HIST="$HEXDIR/data/options/history"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

problem() {
  echo "$(ts) FATAL: $1 Nothing was pulled." >&2
  if [ "$DRY" = 0 ]; then
    if mkdir -p "$HIST" 2>/dev/null; then
      printf '%sZ PROBLEM option-history: %s nothing was pulled\n' "$(date -u '+%Y-%m-%dT%H:%M:%S')" "$1" >> "$HIST/history.log" ||
        echo "  (and history.log could not be written either)" >&2
    else
      echo "  (and $HIST could not be created for history.log either)" >&2
    fi
  fi
}

# A linked git worktree (.claude/worktrees/*) is deleted with everything in it, its data/ included.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "$(ts) FATAL: $HEXDIR is a git worktree, not the main checkout. Nothing was pulled." >&2
  echo "  fix: run ops/run-history.sh from the main checkout (~/Hexagon)" >&2
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
if ! command -v node >/dev/null 2>&1; then
  latest="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "$latest" ] && export PATH="$latest:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  problem "node not found (launchd's PATH is minimal and nvm had none)."
  echo "  fix: edit ops/run-history.sh, then re-run ops/install-history.sh" >&2
  exit 1
fi
if ! grep -q '^CHARTEXCHANGE_API_KEY=.' "$HEXDIR/.env" 2>/dev/null; then
  problem "CHARTEXCHANGE_API_KEY is not set in .env (the trial key may have been removed)."
  echo "  fix: put the key in .env, or run ops/uninstall-history.sh once the trial is over" >&2
  exit 1
fi

echo "$(ts) pulling option history with $(command -v node) $(node -v)"
cd "$HEXDIR"
# The defaults of the daily job, in front so an explicit argument still wins. A pull at the
# allowance's pace runs for an hour or two; caffeinate -i keeps an idle Mac from sleeping through it.
set -- --band 0.05 --newest-first --pace 250 "$@"
if [ -x /usr/bin/caffeinate ]; then
  exec /usr/bin/caffeinate -i node tools/option-history.js "$@"
fi
exec node tools/option-history.js "$@"
