#!/bin/bash
# Launcher for the pull LaunchAgent (ops/com.hexagon.pull.plist), and the Mac's one backup.
#
# Copies every closed day from the Fly box into data/fly/archive, then deletes box tick tapes and
# probe files older than three Eastern days -- each only once its Mac copy has the box's sha256
# (tools/fly-pull.js --trim). The box's /data is 1GB and fills in about a week without this.
# Then, pulled or not, it copies data/chains, data/options and data/fly/archive into iCloud Drive
# (below: the backup).
#
# launchd starts it every hour at :30, and the first thing it does is look at whether today's work
# is already done: when pull.log's last pull line is "ok" and dated today (Eastern) and backup.log's
# last line is too, it exits at once and writes nothing. Before 2026-09-24 there were two slots,
# 09:30 and 13:30, and 9 of the 21 runs from 09-15 failed: launchd started most of those in a
# two-second battery DarkWake, the Mac went back to sleep mid-run, and the frozen run timed out
# hours later (09-22: started 13:32 ET, "timed out after 600s" logged at 17:04 ET). ticks-09-21 took
# three tries over two days. With a slot every hour, a run that freezes is followed by a good one
# within about an hour of the Mac being properly awake, and a good day costs one run.
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
#   bash ops/run-pull.sh --dry-run        the pull's plan, and what the backup would copy
#   bash ops/run-pull.sh --backup-only    only the backup, done now whatever backup.log says
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="$HEXDIR/data/fly/archive"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
utc() { date -u '+%Y-%m-%dT%H:%M:%S'; }

DRY=0; BACKUP_ONLY=0
PASS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1; PASS+=("$a") ;;
    --backup-only) BACKUP_ONLY=1 ;;
    *) PASS+=("$a") ;;
  esac
done

# Say it in launchd's log AND in pull.log -- except on a dry run, which changes nothing anywhere.
problem() {
  echo "$(ts) FATAL: $1 The Fly box was NOT pulled or trimmed." >&2
  if [ "$DRY" = 0 ]; then
    if mkdir -p "$ARCHIVE" 2>/dev/null; then
      printf '%sZ PROBLEM hexagon-desk run-pull.sh: %s nothing was copied or deleted\n' "$(utc)" "$1" >> "$ARCHIVE/pull.log" ||
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

# --- is today's work already done? ---------------------------------------------------------------
# pull.log and backup.log stamp each line in UTC; "today" is the Eastern day, the one fly-pull closes.
# PULL_TODAY_ET only exists so tools/disk-test.js can fix the date.
TODAY_ET="${PULL_TODAY_ET:-$(TZ=America/New_York date +%F)}"
et_day() {
  local ep
  # BSD date on the Mac; GNU date where the tests run on Linux
  ep="$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${1%Z}" +%s 2>/dev/null || date -u -d "$1" +%s 2>/dev/null)" || return 0
  TZ=America/New_York date -r "$ep" +%F 2>/dev/null || TZ=America/New_York date -d "@$ep" +%F
}
# $1 the log, $2 an awk condition picking the lines that count: is the last of them ok and today's?
ok_today() {
  [ -f "$1" ] || return 1
  local stamp status rest
  read -r stamp status rest <<<"$(awk "$2 { l = \$0 } END { print l }" "$1")" || true
  [ "${status:-}" = ok ] && [ "$(et_day "${stamp:-}")" = "$TODAY_ET" ]
}
# a pull line is any line not written by the backup ("<stamp> <ok|PROBLEM> backup ...")
pulled_today() { ok_today "$ARCHIVE/pull.log" '$3 != "backup"'; }
backed_up_today() { ok_today "$ARCHIVE/backup.log" '1'; }

if [ "$DRY" = 0 ] && [ "$BACKUP_ONLY" = 0 ] && pulled_today && backed_up_today; then exit 0; fi

# --- the pull --------------------------------------------------------------------------------------
# Everything that can go wrong here is a PROBLEM line and a non-zero return, never an exit: the
# backup below runs either way, because the chain tape and the older archive need it whether or
# not the box answered today.
pull() {
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
    local latest
    latest="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
    [ -n "$latest" ] && export PATH="$latest:$PATH"
  fi

  if ! command -v node >/dev/null 2>&1; then
    problem "node not found (launchd's PATH is minimal and nvm had none)."
    echo "  fix: edit ops/run-pull.sh, then re-run ops/install-pull.sh" >&2
    return 1
  fi

  # fly installs itself to ~/.fly/bin; a Homebrew flyctl lands in /opt/homebrew/bin, also off launchd's PATH
  local FLY="${FLY_BIN:-$HOME/.fly/bin/fly}" c
  if [ ! -x "$FLY" ]; then
    for c in /opt/homebrew/bin/fly /usr/local/bin/fly; do
      if [ -x "$c" ]; then FLY="$c"; break; fi
    done
  fi
  if [ ! -x "$FLY" ]; then
    problem "fly not found at ~/.fly/bin/fly."
    echo "  fix: install it (curl -L https://fly.io/install.sh | sh), then re-run ops/install-pull.sh" >&2
    return 1
  fi

  # `fly auth whoami` needs the network, and launchd runs a slot the Mac slept through the moment it
  # wakes -- usually before Wi-Fi is back. So "logged out" (retrying will not help) is told apart
  # from "cannot reach Fly" (wait for the network, up to ten minutes). A dry run is someone at the
  # keyboard wanting an answer now, so it does not wait.
  local TRIES="${PULL_NET_TRIES:-20}" GAP="${PULL_NET_GAP_SECS:-30}" try=1 why last waited
  [ "$DRY" = 1 ] && TRIES=1
  while :; do
    if why="$("$FLY" auth whoami 2>&1 >/dev/null)"; then break; fi
    last="$(printf '%s\n' "$why" | grep -v '^Warning' | grep . | tail -1 || true)"
    if printf '%s\n' "$why" | grep -qiE 'no access token|not logged in|unauthori[sz]ed|token (has )?expired|invalid token'; then
      problem "fly is not logged in (${last:-no detail})."
      echo "  fix: fly auth login" >&2
      return 1
    fi
    if [ "$try" -ge "$TRIES" ]; then
      if [ "$TRIES" -gt 1 ]; then waited=" for $(( (TRIES - 1) * GAP / 60 )) minutes"; else waited=""; fi
      problem "could not reach Fly$waited (${last:-no detail}); the next scheduled run tries again."
      return 1
    fi
    [ "$try" = 1 ] && echo "$(ts) cannot reach Fly yet, waiting for the network: ${last:-no detail}" >&2
    try=$((try + 1))
    sleep "$GAP"
  done
  export FLY_BIN="$FLY"

  echo "$(ts) pulling from the Fly box with $(command -v node) $(node -v) and $FLY"
  cd "$HEXDIR"
  # caffeinate -i keeps the Mac from idling to sleep halfway through a 60MB download. Not exec'd:
  # the backup still has to run after it (2026-09-24).
  if [ -x /usr/bin/caffeinate ]; then
    /usr/bin/caffeinate -i node tools/fly-pull.js --trim ${PASS[@]+"${PASS[@]}"}
  else
    node tools/fly-pull.js --trim ${PASS[@]+"${PASS[@]}"}
  fi
}

# --- the backup ------------------------------------------------------------------------------------
# Until 2026-09-24 nothing on this Mac was backed up anywhere: no Time Machine disk, no iCloud copy.
# The chain tape (nobody sells historical chains), the one ChartExchange expiry (the key is dead)
# and every tick tape the box has since trimmed (09-10 to 09-21 on 09-24) existed only here. So after
# every pull these three folders are copied into iCloud Drive, which syncs them off the Mac.
#   - no --delete: a file lost or deleted here never takes its backup with it;
#   - fly-pull's half-downloaded ".<name>.<pid>.part" files are left out;
#   - .env and the Kalshi key are never in these folders, and are excluded anyway: a secret does not
#     go to iCloud. They need their own backup (Time Machine on an external disk covers them).
# Only into an iCloud Drive that exists: creating ~/Library/Mobile Documents/com~apple~CloudDocs by
# hand would make a folder that looks like a backup and syncs nowhere.
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
BACKUP="$ICLOUD/Hexagon-backup"
BACKED=(data/chains data/options data/fly/archive)

# its own PROBLEM line in pull.log (so the daily check's step 1 sees it), which does not claim the
# box went unpulled, and the same line in backup.log, which is what the next hourly run reads
backup_problem() {
  echo "$(ts) BACKUP FAILED: $1" >&2
  local line
  line="$(printf '%sZ PROBLEM backup run-pull.sh: %s; data/chains, data/options and data/fly/archive were NOT copied to iCloud Drive. The Fly box pull is separate: see its own line.' "$(utc)" "$1")"
  if mkdir -p "$ARCHIVE" 2>/dev/null; then
    printf '%s\n' "$line" >> "$ARCHIVE/pull.log" || echo "  (and pull.log could not be written either)" >&2
    printf '%s\n' "$line" >> "$ARCHIVE/backup.log" || true
  fi
}

backup() {
  local src=() d out
  for d in "${BACKED[@]}"; do [ -d "$HEXDIR/$d" ] && src+=("$d"); done
  if [ "$DRY" = 1 ]; then
    echo "$(ts) dry run: would copy ${src[*]:-nothing} to $BACKUP/ (rsync, nothing deleted there); copied nothing"
    [ -d "$ICLOUD" ] || echo "  but iCloud Drive is not at $ICLOUD, so the real run would fail" >&2
    return 0
  fi
  if [ ! -d "$ICLOUD" ]; then
    backup_problem "iCloud Drive is not at $ICLOUD (is it on, in System Settings > Apple Account > iCloud?)"
    return 1
  fi
  if [ "${#src[@]}" = 0 ]; then
    backup_problem "none of ${BACKED[*]} exists in $HEXDIR"
    return 1
  fi
  if ! out="$(mkdir -p "$BACKUP" 2>&1)"; then
    backup_problem "could not create $BACKUP ($(printf '%s\n' "$out" | tail -1))"
    return 1
  fi
  local caff=()
  [ -x /usr/bin/caffeinate ] && caff=(/usr/bin/caffeinate -i)
  if ! out="$(cd "$HEXDIR" && ${caff[@]+"${caff[@]}"} /usr/bin/rsync -a --exclude '.*.part' --exclude '.env' --exclude '*.pem' "${src[@]}" "$BACKUP/" 2>&1)"; then
    backup_problem "rsync failed ($(printf '%s\n' "$out" | grep . | tail -1))"
    return 1
  fi
  echo "$(ts) backed up ${src[*]} to $BACKUP/"
  mkdir -p "$ARCHIVE"
  # a backup that failed earlier today left the last line of pull.log a PROBLEM; say it is mended
  if [ -f "$ARCHIVE/pull.log" ] && tail -1 "$ARCHIVE/pull.log" | awk '$2 == "PROBLEM" && $3 == "backup" { f = 1 } END { exit !f }'; then
    printf '%sZ ok backup run-pull.sh: the backup that failed above has gone through now\n' "$(utc)" >> "$ARCHIVE/pull.log"
  fi
  printf '%sZ ok backup copied %s to iCloud Drive/Hexagon-backup (nothing deleted there)\n' "$(utc)" "${src[*]}" >> "$ARCHIVE/backup.log"
}

rc=0
if [ "$BACKUP_ONLY" = 1 ]; then
  backup || rc=$?
  exit "$rc"
fi
if [ "$DRY" = 0 ] && pulled_today; then
  echo "$(ts) the box was already pulled today ($TODAY_ET); only the backup is left"
else
  pull || rc=$?
fi
if [ "$DRY" = 1 ] || ! backed_up_today; then backup || true; fi
# the pull's own exit code: a failed backup has its own PROBLEM line and is retried next hour
exit "$rc"
