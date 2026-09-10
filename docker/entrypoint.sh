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
  if [ "$CURRENT_GID" != "$PGID" ]; then
    sed -i "s/^tandemleaf:x:${CURRENT_GID}:/tandemleaf:x:${PGID}:/" /etc/group
  fi
  if [ "$CURRENT_UID" != "$PUID" ] || [ "$CURRENT_GID" != "$PGID" ]; then
    sed -i "s/^tandemleaf:x:[0-9]*:[0-9]*:/tandemleaf:x:${PUID}:${PGID}:/" /etc/passwd
  fi
  for d in "${TL_DATA_DIR:-/data}" "${TL_CACHE_DIR:-/cache}" "${TL_MODELS_DIR:-/models}"; do
    if [ -d "$d" ]; then
      chown "$PUID:$PGID" "$d" 2>/dev/null || true
      # Only fix ownership of TandemLeaf's own files, never a library mount.
      find "$d" -maxdepth 2 ! -user "$PUID" -exec chown "$PUID:$PGID" {} + 2>/dev/null || true
    fi
  done
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
