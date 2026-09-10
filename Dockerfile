# TandemLeaf production image
# Multi-stage: build workspaces with dev deps, then a slim non-root runtime
# with ffmpeg/ffprobe. No native Node modules (SQLite is node:sqlite).

FROM node:26-alpine AS build
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
RUN npm run build --workspace @tandemleaf/shared \
 && npm run build --workspace @tandemleaf/server \
 && npm run build --workspace @tandemleaf/web

# Production node_modules only (server runtime deps).
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine
RUN apk add --no-cache ffmpeg su-exec tini wget
WORKDIR /app
ENV NODE_ENV=production \
    TL_DATA_DIR=/data \
    TL_CACHE_DIR=/cache \
    TL_MODELS_DIR=/models \
    TL_HOST=0.0.0.0 \
    TL_PORT=8383

COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/web/dist web/dist
COPY package.json LICENSE ./
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && addgroup -g 1000 tandemleaf \
 && adduser -D -u 1000 -G tandemleaf tandemleaf \
 && mkdir -p /data /cache /models \
 && chown -R tandemleaf:tandemleaf /data /cache /models

EXPOSE 8383
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:${TL_PORT}/api/health || exit 1

# Entrypoint runs as root only to align UID/GID with PUID/PGID and chown the
# writable volumes, then drops privileges with su-exec. No Docker socket, no
# privileged operations.
ENTRYPOINT ["/sbin/tini", "--", "/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
