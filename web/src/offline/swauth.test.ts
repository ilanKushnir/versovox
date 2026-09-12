import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
// The service worker's authorization gate (classic importScripts). Under the
// web package's ESM default the UMD wrapper registers on globalThis instead
// of module.exports; accept either.
const required = require('../../public/sw-auth.js') as Record<string, unknown>;
const vxAuth = (
  (required as { createAuthGate?: unknown }).createAuthGate
    ? required
    : (globalThis as Record<string, unknown>).vxAuth
) as {
  createAuthGate(opts: {
    fetchFn: () => Promise<{ status: number; ok: boolean }>;
    now?: () => number;
    ttlMs?: number;
    onRevoked?: () => Promise<void> | void;
  }): { allowCachedPrivate(): Promise<boolean>; _state(): { ok: boolean; at: number } };
};

describe('service-worker auth gate (online revocation fails closed)', () => {
  it('serves cached content while the server confirms the session', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    const gate = vxAuth.createAuthGate({ fetchFn });
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('REVOCATION: a 401 refuses cached serving and runs the purge exactly once', async () => {
    const onRevoked = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => ({ status: 401, ok: false }));
    let t = 0;
    const gate = vxAuth.createAuthGate({ fetchFn, onRevoked, now: () => t, ttlMs: 1000 });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    // Later checks stay refused without re-running the purge.
    t = 5000;
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('403 is treated as revocation too', async () => {
    const onRevoked = vi.fn();
    const gate = vxAuth.createAuthGate({
      fetchFn: async () => ({ status: 403, ok: false }),
      onRevoked,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('TTL: a fresh verdict is reused without another network check', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    let t = 0;
    const gate = vxAuth.createAuthGate({ fetchFn, now: () => t, ttlMs: 30_000 });
    await gate.allowCachedPrivate();
    t = 10_000;
    await gate.allowCachedPrivate(); // inside TTL
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 40_000;
    await gate.allowCachedPrivate(); // TTL expired: revalidate
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('AIRPLANE MODE: network failure keeps offline reading working', async () => {
    const gate = vxAuth.createAuthGate({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    // Never-checked session + unreachable network => cached books stay
    // readable (deliberate offline access).
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
  });

  it('a session already known revoked STAYS revoked when the device then goes offline', async () => {
    let offline = false;
    const gate = vxAuth.createAuthGate({
      fetchFn: async () => {
        if (offline) throw new TypeError('Failed to fetch');
        return { status: 401, ok: false };
      },
      now: (() => {
        let t = 0;
        return () => (t += 60_000); // every call is past the TTL
      })(),
      ttlMs: 1000,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    offline = true;
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
  });

  it('a server error (5xx) is inconclusive: the last verdict stands', async () => {
    let status = 200;
    let t = 0;
    const gate = vxAuth.createAuthGate({
      fetchFn: async () => ({ status, ok: status >= 200 && status < 300 }),
      now: () => t,
      ttlMs: 1000,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
    status = 500;
    t = 5000;
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* The service worker itself, loaded and driven with fake Cache Storage
   and a stub network. These cover the cache-serving decisions the gate
   above only supplies one input to: who the offline cache belongs to,
   what may overwrite a downloaded title, and what may become the
   offline app shell. */

const ORIGIN = 'https://vx.test';
const SW_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/sw.js'),
  'utf8',
);

const absolute = (u: string) => new URL(u, ORIGIN).toString();

class FakeCache {
  store = new Map<string, Response>();
  async match(req: unknown): Promise<Response | undefined> {
    const hit = this.store.get(keyOf(req));
    return hit ? hit.clone() : undefined;
  }
  async put(req: unknown, res: Response): Promise<void> {
    this.store.set(keyOf(req), res);
  }
  async delete(req: unknown): Promise<boolean> {
    return this.store.delete(keyOf(req));
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.store.keys()].map((url) => ({ url }));
  }
  async addAll(urls: string[]): Promise<void> {
    for (const u of urls) this.store.set(absolute(u), new Response('precached'));
  }
}

function keyOf(req: unknown): string {
  return absolute(typeof req === 'string' ? req : (req as { url: string }).url);
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) this.caches.set(name, (c = new FakeCache()));
    return c;
  }
  async match(req: unknown, opts?: { cacheName?: string }): Promise<Response | undefined> {
    const names = opts?.cacheName ? [opts.cacheName] : [...this.caches.keys()];
    for (const n of names) {
      const hit = await (await this.open(n)).match(req);
      if (hit) return hit;
    }
    return undefined;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

interface SwRequest {
  method: string;
  url: string;
  mode?: string;
  headers: Headers;
}

const OFFLINE_CACHE = 'rp-offline-v1';
const SHELL_CACHE = 'rp-shell-dev';

/** The hashed bundles this worker's build precached (spliced in as the vite build does). */
const PRECACHE = ['/', '/manifest.webmanifest', '/assets/index-dev.js'];

function loadSw() {
  const src = SW_SRC.replace(
    /const PRECACHE = \/\*__RP_PRECACHE__\*\/ \[[^\]]*\];/,
    `const PRECACHE = ${JSON.stringify(PRECACHE)};`,
  );
  if (src === SW_SRC) throw new Error('the precache placeholder web/vite.config.ts fills is gone');
  const caches = new FakeCacheStorage();
  const messages: unknown[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const network = vi.fn<(req: unknown) => Promise<Response>>(async () => {
    throw new TypeError('Failed to fetch');
  });
  const self = {
    vxRange: loadUmd('sw-range.js', 'vxRange'),
    vxAuth,
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m: unknown) => messages.push(m) }],
    },
  };
  const importScripts = () => {};
  const location = { origin: ORIGIN };
  new Function('self', 'caches', 'fetch', 'location', 'importScripts', src)(
    self,
    caches,
    network,
    location,
    importScripts,
  );

  /** Dispatch a fetch event and resolve with what the worker answered. */
  async function request(
    url: string,
    init: { mode?: string; headers?: Record<string, string> } = {},
  ): Promise<Response | null> {
    const req: SwRequest = {
      method: 'GET',
      url: absolute(url),
      mode: init.mode ?? 'cors',
      headers: new Headers(init.headers ?? {}),
    };
    let answered: Promise<Response> | null = null;
    const waits: Promise<unknown>[] = [];
    handlers.get('fetch')!({
      request: req,
      respondWith: (p: Promise<Response>) => {
        answered = Promise.resolve(p);
      },
      waitUntil: (p: Promise<unknown>) => waits.push(Promise.resolve(p).catch(() => {})),
    });
    const res = answered ? await answered : null;
    await Promise.all(waits);
    return res;
  }

  return { caches, network, request, messages };
}

function loadUmd(file: string, global: string): unknown {
  const mod = require(`../../public/${file}`) as Record<string, unknown>;
  return Object.keys(mod).length ? mod : (globalThis as Record<string, unknown>)[global];
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const me = (userId: string) => json({ user: { id: userId, username: userId, role: 'user' } });

/** Seed a downloaded title's detail entry, as the download manager would. */
async function seedDownload(caches: FakeCacheStorage, bookId: string, owner?: string) {
  const cache = await caches.open(OFFLINE_CACHE);
  await cache.put(`/api/books/${bookId}`, json({ book: { id: bookId, title: 'Lantern' } }));
  if (owner) {
    await cache.put('/__vx/offline-owner', json({ userId: owner }));
  }
}

let sw: ReturnType<typeof loadSw>;
beforeEach(() => {
  sw = loadSw();
});

describe('offline cache ownership (a shared device serves nobody else’s books)', () => {
  it('serves a downloaded title back to the account that downloaded it', async () => {
    await seedDownload(sw.caches, 'b1', 'ada');
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      throw new TypeError('Failed to fetch');
    });
    const res = await sw.request('/api/books/b1');
    expect(await res!.json()).toMatchObject({ book: { id: 'b1' } });
  });

  it('LEAK: a different signed-in account is never served the cached books', async () => {
    await seedDownload(sw.caches, 'b1', 'ada');
    // Reverse-proxy SSO: the next person's session is perfectly valid, so
    // nothing ever answers 401 and a status-only gate would allow this.
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('grace');
      throw new TypeError('Failed to fetch');
    });
    const res = await sw.request('/api/books/b1');
    expect(res!.type).toBe('error');
    // The previous account's private content is gone from the device.
    const cache = await sw.caches.open(OFFLINE_CACHE);
    expect(await cache.match('/api/books/b1')).toBeUndefined();
    expect(sw.messages).toContainEqual({ type: 'rp-offline-purged', reason: 'account-changed' });
  });

  it('cached audio is refused for a different account as well', async () => {
    const cache = await sw.caches.open(OFFLINE_CACHE);
    await cache.put('/api/books/b1/track/0?rpmeta=1', json({ size: 4, chunkSize: 4 }));
    await cache.put('/api/books/b1/track/0?rpchunk=0', new Response(new Uint8Array(4)));
    await cache.put('/__vx/offline-owner', json({ userId: 'ada' }));
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('grace');
      return new Response('from server', { status: 200 });
    });
    const res = await sw.request('/api/books/b1/track/0');
    expect(await res!.text()).toBe('from server');
  });

  it('content of unprovable ownership is removed rather than served', async () => {
    await seedDownload(sw.caches, 'b1'); // no stamp: cached before ownership existed
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      throw new TypeError('Failed to fetch');
    });
    expect((await sw.request('/api/books/b1'))!.type).toBe('error');
    const cache = await sw.caches.open(OFFLINE_CACHE);
    expect(await cache.match('/api/books/b1')).toBeUndefined();
  });

  it('claims the empty cache for the account that starts a download', async () => {
    sw.network.mockImplementation(async (req) => {
      const url = keyOf(req);
      if (url.endsWith('/api/auth/me')) return me('ada');
      if (url.endsWith('/offline-manifest')) return json({ urls: [] });
      throw new TypeError('Failed to fetch');
    });
    await sw.request('/api/books/b1/offline-manifest');
    const cache = await sw.caches.open(OFFLINE_CACHE);
    const stamp = await cache.match('/__vx/offline-owner');
    expect(await stamp!.json()).toEqual({ userId: 'ada' });
    // The download that follows is therefore served back to its owner, and
    // is not mistaken later for content of unknown ownership.
    await seedDownload(sw.caches, 'b1');
    const res = await sw.request('/api/books/b1');
    expect(await res!.json()).toMatchObject({ book: { id: 'b1' } });
  });

  it('AIRPLANE MODE: an unreachable server still opens downloaded books', async () => {
    await seedDownload(sw.caches, 'b1', 'ada');
    const res = await sw.request('/api/books/b1');
    expect(await res!.json()).toMatchObject({ book: { id: 'b1' } });
  });
});

describe('a downloaded title survives a bad answer from the server', () => {
  beforeEach(async () => {
    await seedDownload(sw.caches, 'b1', 'ada');
  });

  it('POISONING: a proxy’s 200 HTML page never replaces the cached detail', async () => {
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      return new Response('<html>Maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    await sw.request('/api/books/b1');
    const cache = await sw.caches.open(OFFLINE_CACHE);
    expect(await (await cache.match('/api/books/b1'))!.json()).toMatchObject({
      book: { id: 'b1' },
    });
  });

  it('a fresh book JSON does refresh the cached copy', async () => {
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      return json({ book: { id: 'b1', title: 'Lantern' }, progress: 42 });
    });
    await sw.request('/api/books/b1');
    const cache = await sw.caches.open(OFFLINE_CACHE);
    expect(await (await cache.match('/api/books/b1'))!.json()).toMatchObject({ progress: 42 });
  });

  it('a 502 while the server restarts falls back to the downloaded copy', async () => {
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      return new Response('bad gateway', { status: 502 });
    });
    const res = await sw.request('/api/books/b1');
    expect(res!.status).toBe(200);
    expect(await res!.json()).toMatchObject({ book: { id: 'b1' } });
  });

  it('a 401 is passed through so the app can discover the revocation', async () => {
    sw.network.mockImplementation(async () => new Response('no', { status: 401 }));
    expect((await sw.request('/api/books/b1'))!.status).toBe(401);
  });
});

describe('app shell cache', () => {
  it('stores a navigation response as the offline fallback', async () => {
    sw.network.mockImplementation(
      async () =>
        new Response('<!doctype html><script src="/assets/index-dev.js"></script>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    await sw.request('/library', { mode: 'navigate' });
    const shell = await (await sw.caches.open(SHELL_CACHE)).match('/');
    expect(await shell!.text()).toContain('index-dev.js');
  });

  it('STALE SHELL: a newer build’s index.html is not stored beside this build’s bundles', async () => {
    // This worker precached /assets/index-dev.js; the deploy that answered
    // needs /assets/index-next.js, which this cache will never hold.
    const cache = await sw.caches.open(SHELL_CACHE);
    await cache.put('/', new Response('<!doctype html><script src="/assets/index-dev.js">'));
    sw.network.mockImplementation(
      async () =>
        new Response('<!doctype html><script src="/assets/index-next.js"></script>', {
          headers: { 'content-type': 'text/html' },
        }),
    );
    await sw.request('/library', { mode: 'navigate' });
    expect(await (await cache.match('/'))!.text()).toContain('index-dev.js');
  });

  it('serves the precached web app manifest when the network is gone', async () => {
    const cache = await sw.caches.open(SHELL_CACHE);
    await cache.put('/manifest.webmanifest', new Response('{"name":"ReadPort"}'));
    const res = await sw.request('/manifest.webmanifest');
    expect(await res!.text()).toContain('ReadPort');
    expect(sw.network).not.toHaveBeenCalled();
  });

  it('POISONING: the SPA catch-all is never cached under a hashed bundle’s URL', async () => {
    sw.network.mockImplementation(
      async () =>
        new Response('<!doctype html><title>ReadPort</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await sw.request('/assets/index-gone.js');
    const cache = await sw.caches.open(SHELL_CACHE);
    expect(await cache.match('/assets/index-gone.js')).toBeUndefined();
  });

  it('a real bundle is backfilled into the shell cache', async () => {
    sw.network.mockImplementation(
      async () =>
        new Response('export const a = 1;', {
          headers: { 'content-type': 'text/javascript' },
        }),
    );
    await sw.request('/assets/index-dev.js');
    const cache = await sw.caches.open(SHELL_CACHE);
    expect(await (await cache.match('/assets/index-dev.js'))!.text()).toContain('export');
  });
});

describe('downloaded audio is only served when the whole span is present', () => {
  const meta = { size: 300, chunkSize: 100, contentType: 'audio/mpeg' };

  async function seedTrack(present: number[]) {
    const cache = await sw.caches.open(OFFLINE_CACHE);
    await cache.put('/api/books/b1/track/0?rpmeta=1', json(meta));
    for (const i of present) {
      await cache.put(`/api/books/b1/track/0?rpchunk=${i}`, new Response(new Uint8Array(100)));
    }
    await cache.put('/__vx/offline-owner', json({ userId: 'ada' }));
  }

  it('answers a range request from the stored chunks', async () => {
    await seedTrack([0, 1, 2]);
    const res = await sw.request('/api/books/b1/track/0', { headers: { range: 'bytes=50-149' } });
    expect(res!.status).toBe(206);
    expect(res!.headers.get('content-range')).toBe('bytes 50-149/300');
    expect((await res!.arrayBuffer()).byteLength).toBe(100);
  });

  it('DAMAGED PACKAGE: a missing chunk falls through instead of promising a 206', async () => {
    await seedTrack([0, 2]); // chunk 1 lost to eviction or a failed resume
    sw.network.mockImplementation(async (req) => {
      if (keyOf(req).endsWith('/api/auth/me')) return me('ada');
      return new Response('from server', { status: 200 });
    });
    const res = await sw.request('/api/books/b1/track/0', { headers: { range: 'bytes=0-299' } });
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('from server');
  });

  it('a gap outside the requested span does not block playback of what is there', async () => {
    await seedTrack([0, 2]);
    const res = await sw.request('/api/books/b1/track/0', { headers: { range: 'bytes=0-99' } });
    expect(res!.status).toBe(206);
    expect((await res!.arrayBuffer()).byteLength).toBe(100);
  });
});
