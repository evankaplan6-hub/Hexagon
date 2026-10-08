#!/bin/sh
# The image's entrypoint: hand the data folder to the ordinary `node` user, then run the desk as that
# user instead of root (2026-10-07 audit). The desk needs root for nothing: it listens on 8787 and
# writes only under DATA_DIR. But Fly mounts the volume at /data owned by root, and every file the
# desk wrote there before this was root's, so the one step that needs root is giving them back. The
# find touches only what `node` does not already own, so after the first boot it changes nothing
# (and also catches a file a root `fly ssh console` session left there).
#
# Plain busybox su, which the base image already has: nothing is installed for this. Without -l, su
# keeps the environment (MODE, DATA_DIR, the Fly secrets) and changes only HOME, SHELL, USER and
# LOGNAME. Run as anything but root (a hand `docker run --user`), it just runs the command.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" ! -user node -exec chown -h node:node {} +
  exec su node -s /bin/sh -c 'exec "$0" "$@"' "$@"
fi
exec "$@"
