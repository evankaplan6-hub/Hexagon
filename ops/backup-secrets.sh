#!/bin/bash
# The desk's secrets -- .env (every API key, and the settings around them) and the Kalshi private
# key -- sealed in an AES-256 encrypted disk image in iCloud Drive, under a passphrase you type.
#
# ops/run-pull.sh copies the chain tape, the option history and the archive into iCloud Drive every
# day, and leaves these two out on purpose: a secret does not go to anyone's cloud in the clear.
# Until 2026-09-24 that meant they had no backup at all (no Time Machine disk either). This puts them
# there encrypted. The passphrase is typed at hdiutil's own prompt; nothing here reads, stores or
# logs it, which is also why this cannot be scheduled: run it by hand, and again whenever .env or the
# key changes (ops/daily-check.sh step 7 says when the newest image is older than either file).
#
#   bash ops/backup-secrets.sh
#
# It asks for the passphrase three times: twice to seal the image, once more to open it and check
# that both files came back byte for byte -- a backup nobody can open is not a backup. Keep the
# passphrase in the Passwords app (anywhere but this Mac alone).
#
# To restore: double-click the newest hexagon-secrets-*.dmg in iCloud Drive/Hexagon-backup/secrets (not
# an unchecked-… one), type the passphrase, copy both files back into ~/Hexagon, and chmod 600 them.
#
# Every one of these can also be reissued at its source (Kalshi, Polymarket, Anthropic, ChartExchange;
# the box's own DASH_PASS and FLATTEN_TOKEN live in Fly's secrets), so losing them costs an afternoon
# of re-keying, not money. This saves the afternoon. Old images are kept; nothing here deletes one.
set -euo pipefail
HEXDIR="$(cd "$(dirname "$0")/.." && pwd)"
ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DEST="$ICLOUD/Hexagon-backup/secrets"

# The files live in the main checkout; a worktree (.claude/worktrees/*) has neither.
if [ -f "$HEXDIR/.git" ] || case "$HEXDIR" in */.claude/worktrees/*) true ;; *) false ;; esac; then
  echo "refusing: $HEXDIR is a git worktree. run: bash ~/Hexagon/ops/backup-secrets.sh" >&2
  exit 1
fi
if [ ! -t 0 ]; then
  echo "refusing: run this in a terminal. hdiutil asks for the passphrase itself, and nothing else may supply it." >&2
  exit 1
fi
# Only into an iCloud Drive that exists: making the folder by hand would sync nowhere.
if [ ! -d "$ICLOUD" ]; then
  echo "refusing: iCloud Drive is not at $ICLOUD (System Settings > Apple Account > iCloud)." >&2
  exit 1
fi

# .env, and the key wherever .env points (KALSHI_PRIVATE_KEY_PATH, read the way src/env.js reads it:
# `export ` and spaces around = allowed, a trailing ` # comment` dropped, ~ and paths relative to the
# checkout resolved). Only that one line of .env is read, for the path; no value from it is printed.
# ops/daily-check.sh step 7 resolves it the same way, so keep the two in step.
ENV="$HEXDIR/.env"
[ -f "$ENV" ] || { echo "refusing: no $ENV" >&2; exit 1; }
KEY="$( { grep -E '^[[:space:]]*(export[[:space:]]+)?KALSHI_PRIVATE_KEY_PATH[[:space:]]*=' "$ENV" || true; } | tail -1 | cut -d= -f2- |
  sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]"'"'"']*//' -e 's/[[:space:]"'"'"']*$//' -e "s#^~#$HOME#")"
KEY="${KEY:-kalshi-private-key.pem}"
case "$KEY" in /*) ;; *) KEY="$HEXDIR/$KEY" ;; esac
[ -f "$KEY" ] || { echo "refusing: the Kalshi key is not at the path .env gives ($(basename "$KEY"))" >&2; exit 1; }

# Staged in a private folder of this user's temp space, and removed however the script ends.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/hexagon-secrets.XXXXXX")"
MNT="$(mktemp -d "${TMPDIR:-/tmp}/hexagon-secrets-check.XXXXXX")"
chmod 700 "$STAGE" "$MNT"
cleanup() { hdiutil detach -quiet "$MNT" 2>/dev/null || true; rm -rf "$STAGE" "$MNT"; }
trap cleanup EXIT
cp -p "$ENV" "$STAGE/.env"
cp -p "$KEY" "$STAGE/$(basename "$KEY")"
chmod 600 "$STAGE"/.env "$STAGE/$(basename "$KEY")"

mkdir -p "$DEST"
# Written as unchecked-…, and given the name daily-check step 7 counts (hexagon-secrets-…) only once the
# check below has passed. So a run cut off anywhere (a closed window, a kill, a power cut) can never
# leave an image that looks like a good backup.
NAME="hexagon-secrets-$(date +%Y-%m-%d-%H%M%S).dmg"
OUT="$DEST/unchecked-$NAME"
echo "sealing .env and $(basename "$KEY") into $DEST/$NAME"
echo "choose a passphrase you will keep in the Passwords app; hdiutil asks for it twice:"
if ! hdiutil create -quiet -encryption AES-256 -srcfolder "$STAGE" -volname "Hexagon secrets" -format UDZO "$OUT"; then
  rm -f "$OUT"
  echo "FAILED: hdiutil made no image (the two passphrases may not have matched, or it was cancelled). nothing was backed up." >&2
  exit 1
fi

if ! hdiutil isencrypted "$OUT" 2>&1 | grep -q '^encrypted: YES'; then
  rm -f "$OUT"
  echo "FAILED: the image did not come out encrypted, so it was deleted. nothing was backed up." >&2
  exit 1
fi

echo
echo "now type the same passphrase once more, to check the image opens and holds both files:"
# An image that does not pass this check keeps its unchecked- name, so daily-check step 7 never counts
# it. It is kept: a mistyped check does not mean a bad image, and nothing here deletes a copy of a
# secret it could not verify.
unchecked() {
  echo "FAILED: $1. the image is kept as $(basename "$OUT"), but the secrets are NOT backed up: run this again." >&2
  exit 1
}
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$OUT" || unchecked "the image did not open with that passphrase"
bad=""
for f in .env "$(basename "$KEY")"; do
  cmp -s "$STAGE/$f" "$MNT/$f" || bad="$bad $f"
done
hdiutil detach -quiet "$MNT" || true
[ -z "$bad" ] || unchecked "in the image,$bad did not match the original"
mv "$OUT" "$DEST/$NAME"
OUT="$DEST/$NAME"

echo
echo "backed up and checked: $OUT"
echo "  encrypted (AES-256), opens with your passphrase, and both files match byte for byte."
echo "  keep the passphrase in the Passwords app: without it this image cannot be opened."
echo "  run this again whenever .env or the key changes (daily-check step 7 says when)."
