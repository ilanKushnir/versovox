import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../progress/idb', () => {
  const stores = new Map<string, Map<string, unknown>>();
  const get = (s: string) => {
    if (!stores.has(s)) stores.set(s, new Map());
    return stores.get(s)!;
  };
  return {
    STORES: {
      pendingEvents: 'pending-events',
      serverState: 'server-state',
      downloads: 'downloads',
      prefs: 'prefs',
    },
    idbPut: vi.fn(async (s: string, k: string, v: unknown) => void get(s).set(k, v)),
    idbGet: vi.fn(async (s: string, k: string) => get(s).get(k)),
    idbDelete: vi.fn(async (s: string, k: string) => void get(s).delete(k)),
    idbClear: vi.fn(async (s: string) => void get(s).clear()),
    idbAll: vi.fn(async () => []),
  };
});
vi.mock('../api/client', () => ({
  api: vi.fn(),
  isOffline: () => false,
  isUnauthorized: () => false,
}));

import {
  AUDIO_CHUNK_BYTES,
  cachedSwitch,
  chunkKey,
  downloadEntry,
  downloadTrackChunked,
  metaKey,
  partialMetaKey,
  removeDownload,
  type OfflineManifestEntry,
} from './downloads';
import { type AudioLocator, type EbookLocator } from '@versovox/shared';

/** Minimal in-memory Cache implementation for tests. */
class FakeCache {
  store = new Map<string, Response>();
  async match(url: string): Promise<Response | undefined> {
    const hit = this.store.get(url);
    return hit ? hit.clone() : undefined;
  }
  async put(url: string, res: Response): Promise<void> {
    this.store.set(url, res);
  }
  async delete(url: string): Promise<boolean> {
    return this.store.delete(url);
  }
  /** Cache Storage hands back absolute URLs, so the fake does too. */
  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((k) => ({ url: `https://vx.test${k}` }) as Request);
  }
}

const sha256 = async (data: Uint8Array) => {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

let cache: FakeCache;
const signal = new AbortController().signal;

beforeEach(() => {
  cache = new FakeCache();
  vi.restoreAllMocks();
});

describe('downloadEntry integrity verification', () => {
  const BODY = new TextEncoder().encode('<html><body>chapter one</body></html>');

  it('caches a response whose size and hash match the manifest', async () => {
    const entry: OfflineManifestEntry = {
      url: '/api/books/b/chapter/0',
      kind: 'chapter',
      sizeBytes: BODY.byteLength,
      sha256: await sha256(BODY),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(BODY.slice(), { headers: { 'content-type': 'text/html' } })),
    );
    const bytes = await downloadEntry(cache as unknown as Cache, entry, signal);
    expect(bytes).toBe(BODY.byteLength);
    expect(cache.store.has(entry.url)).toBe(true);
  });

  it('rejects and does NOT cache a tampered response (hash mismatch)', async () => {
    const entry: OfflineManifestEntry = {
      url: '/api/books/b/chapter/1',
      kind: 'chapter',
      sizeBytes: BODY.byteLength,
      sha256: 'ab'.repeat(32), // wrong hash
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(BODY.slice())),
    );
    await expect(downloadEntry(cache as unknown as Cache, entry, signal)).rejects.toThrow(
      /Integrity check failed/,
    );
    expect(cache.store.size).toBe(0);
  });

  it('rejects a truncated response (size mismatch)', async () => {
    const entry: OfflineManifestEntry = {
      url: '/api/books/b/chapter/2',
      kind: 'chapter',
      sizeBytes: BODY.byteLength + 100,
      sha256: await sha256(BODY),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(BODY.slice())),
    );
    await expect(downloadEntry(cache as unknown as Cache, entry, signal)).rejects.toThrow(
      /Size mismatch/,
    );
    expect(cache.store.size).toBe(0);
  });
});

describe('chunked audio download (bounded memory, 206 + integrity required)', () => {
  const TRACK_URL = '/api/books/b/track/0';
  const SIZE = Math.floor(AUDIO_CHUNK_BYTES * 2.5); // 3 chunks, last one short

  async function chunkHashesOf(bytes: Uint8Array, chunkSize = AUDIO_CHUNK_BYTES) {
    const out: string[] = [];
    for (let start = 0; start < bytes.length; start += chunkSize) {
      out.push(await sha256(bytes.slice(start, Math.min(bytes.length, start + chunkSize))));
    }
    return out;
  }

  async function trackEntry(
    bytes: Uint8Array,
    sourceVersion = 'v1'.padEnd(64, 'a'),
  ): Promise<OfflineManifestEntry> {
    return {
      url: TRACK_URL,
      kind: 'track',
      sizeBytes: bytes.length,
      sourceVersion,
      chunkSize: AUDIO_CHUNK_BYTES,
      chunkHashes: await chunkHashesOf(bytes),
    };
  }

  function rangeServingFetch(bytes: Uint8Array, sourceVersion = 'v1'.padEnd(64, 'a')) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string>)?.range;
      const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      if (!m) return new Response(bytes, { status: 200 });
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), {
        status: 206,
        headers: {
          'content-type': 'audio/mp4',
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
          etag: `"${sourceVersion}"`,
        },
      });
    });
  }

  it('stores verified chunks and writes the completion meta LAST', async () => {
    const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
    vi.stubGlobal('fetch', rangeServingFetch(bytes));
    const seen: number[] = [];
    const entry = await trackEntry(bytes);
    await downloadTrackChunked(cache as unknown as Cache, entry, signal, async (b) => {
      seen.push(b);
    });
    expect(seen.length).toBe(3);
    expect(seen.reduce((a, b) => a + b, 0)).toBe(SIZE);
    expect(cache.store.has(chunkKey(TRACK_URL, 0))).toBe(true);
    expect(cache.store.has(chunkKey(TRACK_URL, 2))).toBe(true);
    const meta = await (await cache.match(metaKey(TRACK_URL)))!.json();
    expect(meta).toEqual({
      size: SIZE,
      chunkSize: AUDIO_CHUNK_BYTES,
      contentType: 'audio/mp4',
      sourceVersion: entry.sourceVersion,
    });
    expect(cache.store.has(partialMetaKey(TRACK_URL))).toBe(false); // cleaned up
    // Reassembled bytes are identical to the source.
    const c0 = new Uint8Array(await (await cache.match(chunkKey(TRACK_URL, 0)))!.arrayBuffer());
    expect(c0.length).toBe(AUDIO_CHUNK_BYTES);
    expect(c0[5]).toBe(bytes[5]);
  });

  it('a manifest without integrity data is refused outright (fail closed)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(
      downloadTrackChunked(
        cache as unknown as Cache,
        { url: TRACK_URL, kind: 'track', sizeBytes: SIZE },
        signal,
        async () => {},
      ),
    ).rejects.toThrow(/integrity/);
    expect(cache.store.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a server that ignores Range aborts the download (no whole-file buffering)', async () => {
    const bytes = new Uint8Array(SIZE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(10), { status: 200 })),
    );
    await expect(
      downloadTrackChunked(
        cache as unknown as Cache,
        await trackEntry(bytes),
        signal,
        async () => {},
      ),
    ).rejects.toThrow(/did not honor Range/);
    expect(cache.store.has(metaKey(TRACK_URL))).toBe(false);
  });

  it('TAMPER: a chunk whose bytes do not match the declared hash is rejected, not stored', async () => {
    const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
    const entry = await trackEntry(bytes);
    const tampered = bytes.slice();
    tampered[AUDIO_CHUNK_BYTES + 100] ^= 0xff; // flip one byte in chunk 1
    vi.stubGlobal('fetch', rangeServingFetch(tampered));
    await expect(
      downloadTrackChunked(cache as unknown as Cache, entry, signal, async () => {}),
    ).rejects.toThrow(/Integrity check failed .*chunk 1/);
    expect(cache.store.has(chunkKey(TRACK_URL, 0))).toBe(true); // chunk 0 was fine
    expect(cache.store.has(chunkKey(TRACK_URL, 1))).toBe(false); // tampered chunk NOT stored
    expect(cache.store.has(metaKey(TRACK_URL))).toBe(false); // never completed
  });

  it('WRONG RANGE: a response with an off-by-one Content-Range is rejected', async () => {
    const bytes = new Uint8Array(SIZE);
    const entry = await trackEntry(bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const m = /^bytes=(\d+)-(\d+)$/.exec(
          (init?.headers as Record<string, string>)?.range ?? '',
        );
        const start = Number(m![1]);
        const end = Math.min(Number(m![2]), bytes.length - 1);
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            // Lies about where the bytes came from.
            'content-range': `bytes ${start + 1}-${end + 1}/${bytes.length}`,
            etag: `"${entry.sourceVersion}"`,
          },
        });
      }),
    );
    await expect(
      downloadTrackChunked(cache as unknown as Cache, entry, signal, async () => {}),
    ).rejects.toThrow(/Wrong Content-Range/);
    expect(cache.store.size).toBe(1); // only the partial marker, never a chunk
    expect(cache.store.has(partialMetaKey(TRACK_URL))).toBe(true);
  });

  it('SOURCE REPLACEMENT mid-download: mismatched ETag discards everything stored', async () => {
    const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
    const entry = await trackEntry(bytes); // manifest promises version v1
    // Server already serves the replacement (different version).
    vi.stubGlobal('fetch', rangeServingFetch(bytes, 'v2'.padEnd(64, 'b')));
    await expect(
      downloadTrackChunked(cache as unknown as Cache, entry, signal, async () => {}),
    ).rejects.toThrow(/Source changed/);
    // Nothing survives: no chunks, no partial marker, no completion meta.
    expect(cache.store.size).toBe(0);
  });

  it('RESUME AFTER REPLACEMENT: chunks from an old source version are never combined', async () => {
    const oldBytes = new Uint8Array(SIZE).fill(1);
    const newBytes = new Uint8Array(SIZE).map((_, i) => (i * 7) % 251);
    const oldVersion = 'v1'.padEnd(64, 'a');
    const newVersion = 'v2'.padEnd(64, 'b');
    // First attempt (old source): interrupt after two chunks.
    let calls = 0;
    const oldFetch = rangeServingFetch(oldBytes, oldVersion);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 3) throw new Error('network dropped');
        return oldFetch(url, init);
      }),
    );
    await expect(
      downloadTrackChunked(
        cache as unknown as Cache,
        await trackEntry(oldBytes, oldVersion),
        signal,
        async () => {},
      ),
    ).rejects.toThrow('network dropped');
    expect(cache.store.has(chunkKey(TRACK_URL, 0))).toBe(true); // old chunks kept for now

    // Resume, but the source was replaced: the manifest now declares v2.
    const newFetch = rangeServingFetch(newBytes, newVersion);
    vi.stubGlobal('fetch', newFetch);
    await downloadTrackChunked(
      cache as unknown as Cache,
      await trackEntry(newBytes, newVersion),
      signal,
      async () => {},
    );
    // ALL THREE chunks were refetched — the old ones were discarded, and
    // every stored byte belongs to the new version.
    expect(newFetch).toHaveBeenCalledTimes(3);
    const c0 = new Uint8Array(await (await cache.match(chunkKey(TRACK_URL, 0)))!.arrayBuffer());
    expect(c0[10]).toBe(newBytes[10]);
    const meta = await (await cache.match(metaKey(TRACK_URL)))!.json();
    expect(meta.sourceVersion).toBe(newVersion);
  });

  it('INTERRUPTED RESUME (same version): kept chunks are re-verified, corrupt ones refetched', async () => {
    const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
    const entry = await trackEntry(bytes);
    // First attempt: fail on the third chunk.
    let calls = 0;
    const fetchMock = rangeServingFetch(bytes);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls += 1;
        if (calls === 3) throw new Error('network dropped');
        return fetchMock(url, init);
      }),
    );
    await expect(
      downloadTrackChunked(cache as unknown as Cache, entry, signal, async () => {}),
    ).rejects.toThrow('network dropped');
    expect(cache.store.has(metaKey(TRACK_URL))).toBe(false); // not complete

    // Corrupt stored chunk 1 in place (simulated cache damage).
    const corrupt = new Uint8Array(AUDIO_CHUNK_BYTES);
    await cache.put(
      chunkKey(TRACK_URL, 1),
      new Response(corrupt, { headers: { 'content-length': String(corrupt.byteLength) } }),
    );

    // Second attempt: chunk 0 is re-verified and reused; the corrupted
    // chunk 1 and missing chunk 2 are fetched again.
    const fetch2 = rangeServingFetch(bytes);
    vi.stubGlobal('fetch', fetch2);
    await downloadTrackChunked(cache as unknown as Cache, entry, signal, async () => {});
    expect(fetch2).toHaveBeenCalledTimes(2);
    expect(cache.store.has(metaKey(TRACK_URL))).toBe(true);
    const c1 = new Uint8Array(await (await cache.match(chunkKey(TRACK_URL, 1)))!.arrayBuffer());
    expect(c1[100]).toBe(bytes[AUDIO_CHUNK_BYTES + 100]);
  });
});

describe('logout/download race', () => {
  it('purge aborts the active download and WAITS for it before deleting anything', async () => {
    const { startDownload, purgeOfflineData, OFFLINE_CACHE } = await import('./downloads');
    const idb = await import('../progress/idb');
    const { api } = await import('../api/client');

    const SIZE = AUDIO_CHUNK_BYTES * 2; // 2 chunks
    const bytes = new Uint8Array(SIZE).map((_, i) => i % 251);
    const hashes: string[] = [];
    for (let s = 0; s < SIZE; s += AUDIO_CHUNK_BYTES) {
      hashes.push(await sha256(bytes.slice(s, s + AUDIO_CHUNK_BYTES)));
    }
    const version = 'vr'.padEnd(64, 'c');
    vi.mocked(api).mockResolvedValue({
      urls: [
        {
          url: '/api/books/bk1/track/0',
          kind: 'track',
          sizeBytes: SIZE,
          sourceVersion: version,
          chunkSize: AUDIO_CHUNK_BYTES,
          chunkHashes: hashes,
        },
      ],
      totalBytes: SIZE,
    } as never);

    let firstChunkStored: () => void = () => {};
    const storedFirst = new Promise<void>((r) => {
      firstChunkStored = r;
    });
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        call += 1;
        if (call === 1) {
          return new Response(bytes.slice(0, AUDIO_CHUNK_BYTES), {
            status: 206,
            headers: {
              'content-range': `bytes 0-${AUDIO_CHUNK_BYTES - 1}/${SIZE}`,
              etag: `"${version}"`,
            },
          });
        }
        // Second chunk hangs until aborted — the race window.
        return new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('aborted', 'AbortError')),
          );
        });
      }),
    );

    const statusAtDelete: (string | undefined)[] = [];
    vi.stubGlobal('window', { caches: {} });
    vi.stubGlobal('caches', {
      open: vi.fn(async () => {
        return cache;
      }),
      delete: vi.fn(async (name: string) => {
        // The moment the purge deletes the cache, the racing download must
        // ALREADY have settled ('cancelled' written), never still writing.
        const state = (await idb.idbGet(idb.STORES.downloads, 'bk1')) as
          { status?: string } | undefined;
        statusAtDelete.push(state?.status);
        return name === OFFLINE_CACHE;
      }),
    });

    const origPut = cache.put.bind(cache);
    cache.put = async (url: string, res: Response) => {
      await origPut(url, res);
      if (url.includes('vxchunk=0')) firstChunkStored();
    };

    const downloadP = startDownload('bk1', () => {});
    await storedFirst; // chunk 0 landed; chunk 1 is now hanging
    await purgeOfflineData(); // logout during the download

    expect(statusAtDelete).toEqual(['cancelled']);
    await downloadP;
    // After the purge nothing repopulates: the registry stays empty.
    await new Promise((r) => setTimeout(r, 20));
    expect(await idb.idbGet(idb.STORES.downloads, 'bk1')).toBeUndefined();
  });
});

describe('logout/download pre-registration race', () => {
  it('PURGE WHILE MANIFEST PENDING: a download whose manifest resolves after logout stores nothing', async () => {
    const { startDownload, purgeOfflineData, OFFLINE_CACHE } = await import('./downloads');
    const idb = await import('../progress/idb');
    const { api } = await import('../api/client');

    // The manifest request hangs; it will resolve only AFTER the purge has
    // fully completed — the exact pre-registration race window.
    let resolveManifest!: (v: unknown) => void;
    vi.mocked(api).mockReturnValue(
      new Promise((r) => {
        resolveManifest = r;
      }) as never,
    );

    const SIZE = AUDIO_CHUNK_BYTES;
    const bytes = new Uint8Array(SIZE).fill(3);
    const version = 'vp'.padEnd(64, 'd');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200 })),
    );
    vi.stubGlobal('window', { caches: {} });
    const deleted: string[] = [];
    const open = vi.fn(async () => cache);
    vi.stubGlobal('caches', {
      open,
      delete: vi.fn(async (name: string) => {
        deleted.push(name);
        return true;
      }),
    });

    const downloadP = startDownload('bk1', () => {});
    // The purge starts while the manifest is still pending. It must see
    // the registered attempt, abort it, and complete without deadlocking.
    await purgeOfflineData();
    expect(deleted).toContain(OFFLINE_CACHE);

    // Only NOW does the manifest resolve. The continuation must not open
    // the (just deleted) cache, store content, or write download state.
    resolveManifest({
      urls: [
        {
          url: '/api/books/bk1/track/0',
          kind: 'track',
          sizeBytes: SIZE,
          sourceVersion: version,
          chunkSize: AUDIO_CHUNK_BYTES,
          chunkHashes: [await sha256(bytes)],
        },
      ],
      totalBytes: SIZE,
    });
    await downloadP; // settles silently — nothing was stored, nothing throws
    await new Promise((r) => setTimeout(r, 20));
    expect(open).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
    expect(await idb.idbGet(idb.STORES.downloads, 'bk1')).toBeUndefined();
  });
});

describe('purgeOfflineData (logout-as-revocation)', () => {
  it('deletes the offline cache bucket and the cached server content', async () => {
    const { purgeOfflineData, OFFLINE_CACHE } = await import('./downloads');
    const idb = await import('../progress/idb');
    await idb.idbPut(idb.STORES.downloads, 'b1', { bookId: 'b1' });
    await idb.idbPut(idb.STORES.serverState, 'b1', { revision: 3 });
    const deleted: string[] = [];
    vi.stubGlobal('caches', {
      delete: vi.fn(async (name: string) => {
        deleted.push(name);
        return true;
      }),
    });
    await purgeOfflineData();
    expect(deleted).toContain(OFFLINE_CACHE);
    expect(await idb.idbGet(idb.STORES.downloads, 'b1')).toBeUndefined();
    expect(await idb.idbGet(idb.STORES.serverState, 'b1')).toBeUndefined();
  });

  it('KEEPS un-synced progress: a revoked session must not destroy unsent reading', async () => {
    const { purgeOfflineData } = await import('./downloads');
    const idb = await import('../progress/idb');
    // An hour of offline reading, queued and not yet delivered, when a 401
    // discovers the session has expired.
    await idb.idbPut(idb.STORES.pendingEvents, 'e1', { eventId: 'e1' });
    vi.stubGlobal('caches', { delete: vi.fn(async () => true) });
    await purgeOfflineData();
    expect(await idb.idbGet(idb.STORES.pendingEvents, 'e1')).toEqual({ eventId: 'e1' });
  });
});

describe('removing a download reclaims every stored chunk', () => {
  const TRACK_URL = '/api/books/gap/track/0';

  it('collects chunks past a gap, however far past it they are', async () => {
    const idb = await import('../progress/idb');
    // A track whose chunks were evicted non-contiguously: 0 and 1 survive, 2
    // is gone, and 3 and 200 are still occupying space. Counting upwards
    // from zero — or sweeping a fixed window past the first gap — leaves the
    // far one orphaned with nothing in the app that would ever collect it.
    for (const i of [0, 1, 3, 200]) {
      await cache.put(chunkKey(TRACK_URL, i), new Response(new Uint8Array(8)));
    }
    await cache.put(metaKey(TRACK_URL), new Response('{}'));
    await cache.put(partialMetaKey(TRACK_URL), new Response('{}'));
    await idb.idbPut(idb.STORES.downloads, 'gap', {
      bookId: 'gap',
      status: 'cancelled',
      urls: [TRACK_URL],
    });
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });

    await removeDownload('gap');

    expect(cache.store.size).toBe(0);
    expect(await idb.idbGet(idb.STORES.downloads, 'gap')).toBeUndefined();
  });

  it('reads the cache key list ONCE, not once per URL in the package', async () => {
    // A real package is hundreds of URLs and the cache holds thousands of
    // chunk entries. Enumerating per URL turns removing one audiobook into
    // hundreds of full key reads, which on a phone is a visible freeze.
    const idb = await import('../progress/idb');
    const urls = Array.from({ length: 40 }, (_, i) => `/api/books/many/chapter/${i}`);
    urls.push('/api/books/many/track/0');
    for (const url of urls) await cache.put(url, new Response('x'));
    await cache.put(chunkKey('/api/books/many/track/0', 0), new Response(new Uint8Array(8)));
    await idb.idbPut(idb.STORES.downloads, 'many', {
      bookId: 'many',
      status: 'done',
      urls,
    });
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    const keys = vi.spyOn(cache, 'keys');

    await removeDownload('many');

    expect(keys).toHaveBeenCalledTimes(1);
    expect(cache.store.size).toBe(0);
  });

  it('leaves a sibling track untouched', async () => {
    const other = '/api/books/gap/track/1';
    await cache.put(chunkKey(TRACK_URL, 0), new Response(new Uint8Array(8)));
    await cache.put(chunkKey(other, 0), new Response(new Uint8Array(8)));
    const idb = await import('../progress/idb');
    await idb.idbPut(idb.STORES.downloads, 'gap2', {
      bookId: 'gap2',
      status: 'cancelled',
      urls: [TRACK_URL],
    });
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    await removeDownload('gap2');
    expect(cache.store.has(chunkKey(other, 0))).toBe(true);
  });
});

describe('storage quota', () => {
  it('refuses a package that cannot fit BEFORE storing any of it', async () => {
    const { startDownload } = await import('./downloads');
    const idb = await import('../progress/idb');
    const { api } = await import('../api/client');
    vi.mocked(api).mockResolvedValue({
      urls: [{ url: '/api/books/big/chapter/0', kind: 'chapter', sizeBytes: 500_000_000 }],
      totalBytes: 500_000_000,
    } as never);
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('window', { caches: {} });
    const open = vi.fn(async () => cache);
    vi.stubGlobal('caches', { open, delete: vi.fn(async () => true) });
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 900_000_000, quota: 1_000_000_000 }) },
    });

    await startDownload('big', () => {});

    const state = (await idb.idbGet(idb.STORES.downloads, 'big')) as {
      status: string;
      error: string;
    };
    expect(state.status).toBe('error');
    // Actionable, not "The quota has been exceeded."
    expect(state.error).toMatch(/not enough room/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(0);
  });

  it('registers the package BEFORE the first byte, so an interrupted attempt is reclaimable', async () => {
    // Nothing but the download registry records which URLs a package owns.
    // A tab killed during the first entry must still leave a registry entry,
    // or the bytes already written are invisible to "Remove offline copy".
    const { startDownload } = await import('./downloads');
    const idb = await import('../progress/idb');
    const { api } = await import('../api/client');
    const BODY = new TextEncoder().encode('chapter');
    const URL_ = '/api/books/reg/chapter/0';
    vi.mocked(api).mockResolvedValue({
      urls: [
        { url: URL_, kind: 'chapter', sizeBytes: BODY.byteLength, sha256: await sha256(BODY) },
      ],
      totalBytes: BODY.byteLength,
    } as never);
    let registryAtFirstFetch: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        registryAtFirstFetch = await idb.idbGet(idb.STORES.downloads, 'reg');
        return new Response(BODY.slice(), { headers: { 'content-type': 'text/html' } });
      }),
    );
    vi.stubGlobal('window', { caches: {} });
    vi.stubGlobal('caches', { open: vi.fn(async () => cache), delete: vi.fn(async () => true) });
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 0, quota: 1_000_000_000 }) },
    });

    await startDownload('reg', () => {});

    expect(registryAtFirstFetch).toMatchObject({ status: 'downloading', urls: [URL_] });
  });

  it('credits what an interrupted attempt already stored, so a resume is not refused', async () => {
    const { startDownload } = await import('./downloads');
    const idb = await import('../progress/idb');
    const { api } = await import('../api/client');
    const BODY = new TextEncoder().encode('chapter');
    const sha = await sha256(BODY);
    vi.mocked(api).mockResolvedValue({
      urls: [
        {
          url: '/api/books/rez/chapter/0',
          kind: 'chapter',
          sizeBytes: BODY.byteLength,
          sha256: sha,
        },
      ],
      totalBytes: 90_000_000,
    } as never);
    // 89 MB of the 90 MB package is already on disk and counted in `usage`;
    // only 1 MB is still needed and 5 MB is free.
    await idb.idbPut(idb.STORES.downloads, 'rez', {
      bookId: 'rez',
      status: 'cancelled',
      totalUrls: 1,
      doneUrls: 0,
      estimatedBytes: 90_000_000,
      storedBytes: 89_000_000,
      updatedAt: new Date().toISOString(),
      urls: ['/api/books/rez/chapter/0'],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(BODY.slice(), { headers: { 'content-type': 'text/html' } })),
    );
    vi.stubGlobal('window', { caches: {} });
    vi.stubGlobal('caches', { open: vi.fn(async () => cache), delete: vi.fn(async () => true) });
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ usage: 95_000_000, quota: 100_000_000 }) },
    });

    await startDownload('rez', () => {});

    const state = (await idb.idbGet(idb.STORES.downloads, 'rez')) as { status: string };
    expect(state.status).toBe('done');
  });
});

describe('cachedSwitch (the handoff with no network)', () => {
  const TABLE_URL = '/api/books/eb/offline-switch';
  const audioTo = { medium: 'audio', trackIdx: 1, positionMs: 4000, bookMs: 604000, pct: 0.4 };

  const putTable = async (url: string, table: unknown) => {
    await cache.put(url, new Response(JSON.stringify(table)));
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  };

  it('returns the stored answer for the sentence being read', async () => {
    await putTable(TABLE_URL, {
      pairId: 'p1',
      otherBookId: 'au',
      direction: 'ebook-to-audio',
      entries: [
        {
          sentenceId: 's1',
          to: { ...audioTo, bookMs: 1000 },
          resolution: { granularity: 'sentence', confidence: 0.9 },
        },
        {
          sentenceId: 's2',
          to: audioTo,
          resolution: { granularity: 'sentence', confidence: 0.97 },
        },
      ],
    });
    const from: EbookLocator = { medium: 'ebook', spineIdx: 1, sentenceId: 's2', pct: 0.4 };
    expect(await cachedSwitch('eb', from)).toEqual({
      to: audioTo,
      resolution: { granularity: 'sentence', confidence: 0.97 },
    });
  });

  it('answers nothing for a sentence with no stored answer, rather than guessing', async () => {
    await putTable(TABLE_URL, {
      pairId: 'p1',
      otherBookId: 'au',
      direction: 'ebook-to-audio',
      entries: [
        { sentenceId: 's1', to: audioTo, resolution: { granularity: 'sentence', confidence: 0.9 } },
      ],
    });
    const from: EbookLocator = { medium: 'ebook', spineIdx: 1, sentenceId: 'sX', pct: 0.4 };
    expect(await cachedSwitch('eb', from)).toBeNull();
  });

  it('takes the audio answer in force at or before the position, never a later one', async () => {
    const at10 = { medium: 'ebook', spineIdx: 0, charOffset: 10, pct: 0.1 };
    const at30 = { medium: 'ebook', spineIdx: 0, charOffset: 30, pct: 0.3 };
    await putTable('/api/books/au/offline-switch', {
      pairId: 'p1',
      otherBookId: 'eb',
      direction: 'audio-to-ebook',
      gridMs: 5000,
      entries: [
        { atMs: 0, to: at10, resolution: { granularity: 'paragraph', confidence: 0.8 } },
        { atMs: 20000, to: at30, resolution: { granularity: 'sentence', confidence: 0.95 } },
        {
          atMs: 40000,
          to: null,
          resolution: { granularity: 'none', confidence: 0, reason: 'gap' },
        },
      ],
    });
    const at = async (bookMs: number) =>
      cachedSwitch('au', {
        medium: 'audio',
        trackIdx: 0,
        positionMs: bookMs,
        bookMs,
        pct: 0,
      } as AudioLocator);
    expect((await at(19999))!.to).toEqual(at10);
    expect((await at(20000))!.to).toEqual(at30);
    expect((await at(39999))!.to).toEqual(at30);
    // An unaligned stretch is stored as its own entry, so it can never
    // inherit the previous answer.
    expect((await at(45000))!.to).toBeNull();
  });

  it('has no answer when the package was never downloaded', async () => {
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
    const from: EbookLocator = { medium: 'ebook', spineIdx: 0, sentenceId: 's1', pct: 0 };
    expect(await cachedSwitch('missing', from)).toBeNull();
  });
});
