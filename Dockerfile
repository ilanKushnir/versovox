# Versovox production image
# Multi-stage: build workspaces with dev deps, then a slim non-root runtime
# with ffmpeg/ffprobe. No native Node modules (SQLite is node:sqlite).
# Debian (glibc) base: package-lock.json was generated on glibc, and npm's
# optional-dependency bug (npm/cli#4828) leaves the platform-native Rollup
# binary (@rollup/rollup-linux-*-musl) uninstalled when `npm ci` runs on
# musl from that lockfile. Do not hard-code a platform Rollup package.

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build --workspace @versovox/shared \
 && npm run build --workspace @versovox/server \
 && npm run build --workspace @versovox/web

# Production node_modules only (server runtime deps).
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg gosu tini wget \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    VX_DATA_DIR=/data \
    VX_CACHE_DIR=/cache \
    VX_MODELS_DIR=/models \
    VX_HOST=0.0.0.0 \
    VX_PORT=8383

COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/dist web/dist
COPY package.json LICENSE ./
COPY docker/entrypoint.sh /entrypoint.sh
# The node base image ships a `node` user at 1000:1000; remove it so
# `versovox` can take that UID/GID.
RUN chmod +x /entrypoint.sh \
 && userdel -r node \
 && if getent group node >/dev/null; then groupdel node; fi \
 && groupadd -g 1000 versovox \
 && useradd -m -u 1000 -g versovox -s /usr/sbin/nologin versovox \
 && mkdir -p /data /cache /models \
 && chown -R versovox:versovox /data /cache /models

EXPOSE 8383
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${VX_PORT}/api/health || exit 1

# Entrypoint runs as root only to align UID/GID with PUID/PGID and chown the
# writable volumes, then drops privileges with gosu. No Docker socket, no
# privileged operations.
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
