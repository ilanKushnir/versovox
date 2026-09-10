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
  chunkKey,
  downloadEntry,
  downloadTrackChunked,
  metaKey,
  partialMetaKey,
  type OfflineManifestEntry,
} from './downloads';

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
  it('deletes the offline cache bucket and per-user IDB stores', async () => {
    const { purgeOfflineData, OFFLINE_CACHE } = await import('./downloads');
    const idb = await import('../progress/idb');
    await idb.idbPut(idb.STORES.downloads, 'b1', { bookId: 'b1' });
    await idb.idbPut(idb.STORES.serverState, 'b1', { revision: 3 });
    await idb.idbPut(idb.STORES.pendingEvents, 'e1', { eventId: 'e1' });
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
    expect(await idb.idbGet(idb.STORES.pendingEvents, 'e1')).toBeUndefined();
  });
});
