#!/bin/sh
# Align the runtime user with the host's PUID/PGID (default 1000:1000), give
# it the writable volumes, then drop privileges. Library mounts stay
# read-only and untouched.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  CURRENT_GID="$(getent group readport | cut -d: -f3)"
  CURRENT_UID="$(getent passwd readport | cut -d: -f3)"
  # -o allows a PUID/PGID that collides with an existing system UID/GID.
  if [ "$CURRENT_GID" != "$PGID" ]; then
    groupmod -o -g "$PGID" readport
  fi
  if [ "$CURRENT_UID" != "$PUID" ] || [ "$CURRENT_GID" != "$PGID" ]; then
    usermod -o -u "$PUID" -g "$PGID" readport
  fi
  for d in "${RP_DATA_DIR:-/data}" "${RP_CACHE_DIR:-/cache}" "${RP_MODELS_DIR:-/models}"; do
    if [ -d "$d" ]; then
      chown -h "$PUID:$PGID" "$d" 2>/dev/null || true
      # Only fix ownership of ReadPort's own files, never a library mount,
      # and never follow a symlink out of the volume.
      find "$d" -maxdepth 2 ! -type l ! -user "$PUID" -exec chown -h "$PUID:$PGID" {} + 2>/dev/null || true
    fi
  done
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
