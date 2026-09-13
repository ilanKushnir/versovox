/* ReadPort service worker: app-shell offline startup + explicit per-title
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
const BUILD = /*__RP_BUILD__*/ 'dev';
const PRECACHE = /*__RP_PRECACHE__*/ [
  '/',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/fonts/literata.css',
];

const SHELL_CACHE = `rp-shell-${BUILD}`;
const OFFLINE_CACHE = 'rp-offline-v1'; // written by the app's download manager

/* Names the account whose downloads the offline cache holds. Kept inside
   that cache so the stamp can never outlive the content it describes. */
const OWNER_KEY = '/__vx/offline-owner';

/* Does the offline cache belong to the account that is signed in right now?
   Starts true so a cold start with no network still opens downloaded books;
   a reachable server settles it on the first check. */
let cacheOwnedByViewer = true;

/* Revocation gate for cache-first book content: while online, the session
   is revalidated against the server (at most once per TTL) before cached
   per-user content is served; a 401/403 purges the offline cache, notifies
   open pages, and cached serving stops. Offline keeps the last known state
   so deliberate airplane-mode reading continues to work (a device that is
   already offline learns about revocation only on reconnect — documented
   in docs/security.md). */
const authGate = self.rpAuth.createAuthGate({
  fetchFn: async () => {
    const res = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-rp-csrf': '1' },
    });
    // WHO is signed in decides this, not merely THAT someone is.
    if (res.ok) {
      try {
        cacheOwnedByViewer = await reconcileCacheOwner(res.clone());
      } catch {
        cacheOwnedByViewer = false; // ownership unproven: serve nothing private
      }
    }
    return res;
  },
  onRevoked: async () => {
    try {
      await caches.delete(OFFLINE_CACHE);
    } catch {
      /* best effort */
    }
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'rp-unauthorized' });
  },
});

/**
 * Bind the offline cache to the signed-in account, and report whether its
 * contents may be served to them.
 *
 * A shared device (a family tablet, a kiosk) can move from one account to
 * the next without a single request ever failing — reverse-proxy SSO has no
 * cookie and no logout, so nothing ever answers 401 — and the downloaded
 * books of whoever used it last carry that person's reading progress and
 * bookmarks. Content that cannot be shown to belong to the current account
 * is therefore removed from the device rather than served, and the emptied
 * cache is handed to them.
 */
async function reconcileCacheOwner(meRes) {
  let viewer = null;
  try {
    const body = await meRes.json();
    viewer = body && body.user && body.user.id ? String(body.user.id) : null;
  } catch {
    /* unreadable body: the identity stays unknown */
  }
  if (!viewer) return false; // fail closed rather than guess who is reading

  const cache = await caches.open(OFFLINE_CACHE);
  const stamp = await cache.match(OWNER_KEY);
  if (stamp) {
    let owner = null;
    try {
      owner = (await stamp.json()).userId ?? null;
    } catch {
      /* corrupt stamp: treat the cache as unowned */
    }
    if (owner === viewer) return true;
  } else if (!(await hasOfflineContent(cache))) {
    await stampOwner(viewer);
    return true;
  }

  // Another account's downloads, or content from before this stamp existed
  // and so of unprovable ownership.
  await caches.delete(OFFLINE_CACHE);
  await stampOwner(viewer);
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: 'rp-offline-purged', reason: 'account-changed' });
  // The cache is this account's now, but the caller is holding a response
  // read before the purge: refuse this one request.
  return false;
}

async function hasOfflineContent(cache) {
  const keys = await cache.keys();
  return keys.some((r) => new URL(r.url).pathname !== OWNER_KEY);
}

async function stampOwner(userId) {
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(
    OWNER_KEY,
    new Response(JSON.stringify({ userId }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/** May cached private (per-user) content be served right now? */
async function allowCachedPrivate() {
  const sessionOk = await authGate.allowCachedPrivate();
  return sessionOk && cacheOwnedByViewer;
}

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
          const type = res.headers.get('content-type') || '';
          if (res.ok && type.includes('text/html')) {
            const copy = res.clone();
            event.waitUntil(cacheShell(copy).catch(() => {}));
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
            const type = res.headers.get('content-type') || '';
            const cache = await caches.open(OFFLINE_CACHE);
            // Refresh only titles that were explicitly downloaded, and only
            // from real book JSON: a proxy's 200 maintenance page would
            // otherwise overwrite a downloaded title's one offline copy,
            // and nothing short of re-downloading would repair it.
            if (
              type.includes('json') &&
              (await cache.match(req, { ignoreVary: true })) &&
              (await allowCachedPrivate())
            ) {
              await cache.put(req, res.clone());
            }
            return res;
          }
          // The server answered, badly — a container restart, a failing
          // proxy. A downloaded title stays readable through it. A 401/403
          // or 404 is a real answer and is passed through, so the app can
          // purge or show the title as gone.
          if (res.status >= 500) {
            const hit = await caches.match(req, { cacheName: OFFLINE_CACHE, ignoreVary: true });
            if (hit && (await allowCachedPrivate())) return hit;
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req, { cacheName: OFFLINE_CACHE, ignoreVary: true });
          if (hit && (await allowCachedPrivate())) return hit;
          return Response.error();
        }),
    );
    return;
  }
  if (url.pathname.startsWith('/api/books/')) {
    event.respondWith(
      caches.match(req, { cacheName: OFFLINE_CACHE, ignoreVary: true }).then(async (hit) => {
        // Consulted even on a miss: the first request of a download claims
        // the still-empty cache for the account making it, so its own
        // content is never later mistaken for someone else's.
        const allowed = await allowCachedPrivate();
        if (!hit || !allowed) return fetch(req);
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
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  ) {
    event.respondWith(
      caches.match(req, { cacheName: SHELL_CACHE }).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            // A hashed bundle answered with the app's index.html is the
            // server's catch-all route, not the file: storing that HTML
            // under the file's URL would serve it forever, since these
            // entries are never revalidated.
            if (res.ok && !isCatchAllHtml(url, res)) {
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
 * Store an app shell as the offline navigation fallback — but only a real
 * shell for THIS build. A newer deploy's index.html points at hashed
 * bundles that this build's cache does not hold and never will, so keeping
 * it would turn the next offline cold start into a blank page.
 */
async function cacheShell(res) {
  const html = await res.text();
  const refs = html.match(/\/assets\/[A-Za-z0-9._~-]+/g);
  if (refs && !refs.every((u) => PRECACHE.includes(u))) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(
    '/',
    new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  );
}

/** A non-HTML file answered with HTML: the SPA catch-all, not the file. */
function isCatchAllHtml(url, res) {
  const type = res.headers.get('content-type') || '';
  return type.includes('text/html') && !url.pathname.endsWith('.html');
}

/**
 * Serve a (possibly ranged) audio track request. Prefers the chunked
 * offline copy; falls through to the network when the track has not been
 * downloaded. Never buffers more than one chunk at a time.
 */
async function serveTrack(req, url) {
  const cache = await caches.open(OFFLINE_CACHE);
  const metaRes = await cache.match(self.rpRange.metaKey(url.pathname));
  if (!metaRes) return fetch(req);
  if (!(await allowCachedPrivate())) return fetch(req);
  const meta = await metaRes.json(); // { size, chunkSize, contentType }

  const rangeHeader = req.headers.get('range');
  let start = 0;
  let end = meta.size - 1;
  let status = 200;
  if (rangeHeader) {
    const parsed = self.rpRange.parseRangeHeader(rangeHeader, meta.size);
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

  const span = self.rpRange.chunkSpan(start, end, meta.chunkSize);
  // Prove every chunk this response promises is present before promising
  // it. A damaged package (an interrupted download, a chunk evicted under
  // storage pressure) must fall through to the network rather than hand the
  // player a valid-looking 206 whose body dies mid-stream, which surfaces
  // only as a generic decode error.
  const chunks = [];
  for (let i = span.first; i <= span.last; i++) {
    const chunkRes = await cache.match(self.rpRange.chunkKey(url.pathname, i));
    if (!chunkRes) return fetch(req);
    chunks.push(chunkRes);
  }

  let idx = span.first;
  const pathname = url.pathname;
  const chunkSize = meta.chunkSize;
  const body = new ReadableStream({
    async pull(controller) {
      if (idx > span.last) {
        controller.close();
        return;
      }
      let buf;
      try {
        buf = new Uint8Array(await chunks[idx - span.first].arrayBuffer());
      } catch {
        // Evicted between the check above and now.
        controller.error(new Error(`unreadable offline chunk ${idx} for ${pathname}`));
        return;
      }
      const bounds = self.rpRange.sliceWithin(idx, chunkSize, buf.length, start, end);
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
      '<title>ReadPort — offline</title>' +
      '<body style="font-family:system-ui;background:#F6F1E8;color:#1C1917;display:grid;place-items:center;min-height:100dvh;margin:0">' +
      '<div style="text-align:center;padding:24px"><h1 style="font-size:20px">You are offline</h1>' +
      '<p>ReadPort could not load. Reconnect once, and the app will work offline afterwards.</p></div>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
