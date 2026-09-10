/* TandemLeaf service worker: app-shell offline startup + explicit per-title
   offline packages.

   Strategy (honest about what is and is not offline):
   - App shell: every hashed JS/CSS bundle plus local fonts/icons is
     precached at install from a build-time manifest (injected below by the
     vite build), so the app boots offline after the FIRST online visit even
     though that first load itself was not intercepted.
   - Navigations: network-first, falling back to the precached shell.
   - /api/books/* GETs: offline-cache first (populated only by explicit
     per-title downloads), then network. Audio tracks are stored as
     fixed-size chunks and served back with correct 206/Content-Range
     semantics. Nothing else under /api is ever cached — progress and auth
     always hit the network and queue in IndexedDB when it is unreachable. */

importScripts('/sw-range.js');
importScripts('/sw-auth.js');

/* Both placeholders are replaced by the build (scripts inside web/vite.config.ts). */
const BUILD = /*__TL_BUILD__*/ 'dev';
const PRECACHE = /*__TL_PRECACHE__*/ [
  '/',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/fonts/literata.css',
];

const SHELL_CACHE = `tl-shell-${BUILD}`;
const OFFLINE_CACHE = 'tl-offline-v1'; // written by the app's download manager

/* Revocation gate for cache-first book content: while online, the session
   is revalidated against the server (at most once per TTL) before cached
   per-user content is served; a 401/403 purges the offline cache, notifies
   open pages, and cached serving stops. Offline keeps the last known state
   so deliberate airplane-mode reading continues to work (a device that is
   already offline learns about revocation only on reconnect — documented
   in docs/security.md). */
const authGate = self.tlAuth.createAuthGate({
  fetchFn: () =>
    fetch('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-tl-csrf': '1' },
    }),
  onRevoked: async () => {
    try {
      await caches.delete(OFFLINE_CACHE);
    } catch {
      /* best effort */
    }
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'tl-unauthorized' });
  },
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, OFFLINE_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const TRACK_RE = /^\/api\/books\/[^/]+\/track\/\d+$/;
/* Book detail JSON embeds progress and pairing state: it changes while a
   download's static content does not, so it is served network-first and
   the cached copy only refreshed/used as the offline fallback. */
const DETAIL_RE = /^\/api\/books\/[^/]+$/;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // App navigation: network-first with shell fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only a real app shell may become the offline fallback — never a
          // proxy's 502 page while the container restarts.
          const type = res.headers.get('content-type') || '';
          if (res.ok && type.includes('text/html')) {
            const copy = res.clone();
            caches
              .open(SHELL_CACHE)
              .then((c) => c.put('/', copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match('/', { cacheName: SHELL_CACHE }).then((r) => r ?? offlineFallback()),
        ),
    );
    return;
  }

  // Downloaded audio: chunked storage with real Range (206) semantics.
  if (TRACK_RE.test(url.pathname)) {
    event.respondWith(serveTrack(req, url));
    return;
  }

  // Other book content: only served from cache when explicitly downloaded,
  // and only while the session is not known to be revoked. When the gate
  // refuses, the request falls through to the network — whose 401 lets the
  // open app discover the revocation and purge.
  if (DETAIL_RE.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          if (res.ok) {
            const cache = await caches.open(OFFLINE_CACHE);
            // Refresh only titles that were explicitly downloaded.
            if (await cache.match(req, { ignoreVary: true })) await cache.put(req, res.clone());
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req, { cacheName: OFFLINE_CACHE, ignoreVary: true });
          if (hit && (await authGate.allowCachedPrivate())) return hit;
          return Response.error();
        }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/books/')) {
    event.respondWith(
      caches.match(req, { cacheName: OFFLINE_CACHE, ignoreVary: true }).then(async (hit) => {
        if (!hit) return fetch(req);
        if (!(await authGate.allowCachedPrivate())) return fetch(req);
        return hit;
      }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return; // never cache other API calls

  // Static assets: cache-first. Hashed build assets are precached at
  // install; anything missed is backfilled on use.
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/')
  ) {
    event.respondWith(
      caches.match(req, { cacheName: SHELL_CACHE }).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches
                .open(SHELL_CACHE)
                .then((c) => c.put(req, copy))
                .catch(() => {});
            }
            return res;
          }),
      ),
    );
  }
});

/**
 * Serve a (possibly ranged) audio track request. Prefers the chunked
 * offline copy; falls through to the network when the track has not been
 * downloaded. Never buffers more than one chunk at a time.
 */
async function serveTrack(req, url) {
  const cache = await caches.open(OFFLINE_CACHE);
  const metaRes = await cache.match(self.tlRange.metaKey(url.pathname));
  if (!metaRes) return fetch(req);
  if (!(await authGate.allowCachedPrivate())) return fetch(req);
  const meta = await metaRes.json(); // { size, chunkSize, contentType }

  const rangeHeader = req.headers.get('range');
  let start = 0;
  let end = meta.size - 1;
  let status = 200;
  if (rangeHeader) {
    const parsed = self.tlRange.parseRangeHeader(rangeHeader, meta.size);
    if (parsed === null) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${meta.size}` },
      });
    }
    if (parsed !== undefined) {
      start = parsed.start;
      end = parsed.end;
      status = 206;
    }
  }

  const span = self.tlRange.chunkSpan(start, end, meta.chunkSize);
  let idx = span.first;
  const pathname = url.pathname;
  const chunkSize = meta.chunkSize;
  const body = new ReadableStream({
    async pull(controller) {
      if (idx > span.last) {
        controller.close();
        return;
      }
      const chunkRes = await cache.match(self.tlRange.chunkKey(pathname, idx));
      if (!chunkRes) {
        controller.error(new Error(`missing offline chunk ${idx} for ${pathname}`));
        return;
      }
      const buf = new Uint8Array(await chunkRes.arrayBuffer());
      const bounds = self.tlRange.sliceWithin(idx, chunkSize, buf.length, start, end);
      controller.enqueue(buf.subarray(bounds.from, bounds.to));
      idx += 1;
    },
  });

  const headers = {
    'content-type': meta.contentType || 'application/octet-stream',
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
  return new Response(body, { status, headers });
}

function offlineFallback() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<title>TandemLeaf — offline</title>' +
      '<body style="font-family:system-ui;background:#FAF6EF;color:#1F2620;display:grid;place-items:center;min-height:100dvh;margin:0">' +
      '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">You are offline</h1>' +
      '<p>TandemLeaf could not load. Reconnect once, and the app will work offline afterwards.</p></div>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
