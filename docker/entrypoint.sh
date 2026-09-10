#!/bin/sh
# Align the runtime user with the host's PUID/PGID (default 1000:1000), give
# it the writable volumes, then drop privileges. Library mounts stay
# read-only and untouched.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  CURRENT_GID="$(getent group tandemleaf | cut -d: -f3)"
  CURRENT_UID="$(getent passwd tandemleaf | cut -d: -f3)"
  # -o allows a PUID/PGID that collides with an existing system UID/GID.
  if [ "$CURRENT_GID" != "$PGID" ]; then
    groupmod -o -g "$PGID" tandemleaf
  fi
  if [ "$CURRENT_UID" != "$PUID" ] || [ "$CURRENT_GID" != "$PGID" ]; then
    usermod -o -u "$PUID" -g "$PGID" tandemleaf
  fi
  for d in "${TL_DATA_DIR:-/data}" "${TL_CACHE_DIR:-/cache}" "${TL_MODELS_DIR:-/models}"; do
    if [ -d "$d" ]; then
      chown "$PUID:$PGID" "$d" 2>/dev/null || true
      # Only fix ownership of TandemLeaf's own files, never a library mount.
      find "$d" -maxdepth 2 ! -user "$PUID" -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
    fi
  done
  exec gosu "$PUID:$PGID" "$@"
fi

exec "$@"
