import { api } from '../api/client';
import { idbAll, idbClear, idbDelete, idbGet, idbPut, STORES } from '../progress/idb';
import { type BookSummary } from '@versovox/shared';

/**
 * Explicit per-title offline packages. Downloads go into a dedicated Cache
 * Storage bucket the service worker consults before the network; state and
 * real byte counts live in IndexedDB and drive honest UI.
 *
 * Integrity: every static entry in the server's offline manifest carries its
 * byte size and SHA-256. Each response is verified BEFORE it is cached, and
 * the package is only marked complete after every entry verified. Audio
 * tracks are fetched with Range requests in bounded chunks (never one giant
 * ArrayBuffer), stored chunk-by-chunk, and served back by the service worker
 * with correct 206/Content-Range behavior.
 */

export const OFFLINE_CACHE = 'vx-offline-v1';
/** Per-chunk audio buffer bound (max bytes in memory at once per download). */
export const AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;

/* Cache-key conventions — MUST stay in sync with web/public/sw-range.js
   (asserted by web/src/offline/downloads.test.ts). */
export const chunkKey = (url: string, i: number) =>
  `${url}${url.includes('?') ? '&' : '?'}vxchunk=${i}`;
export const metaKey = (url: string) => `${url}${url.includes('?') ? '&' : '?'}vxmeta=1`;
/** In-progress marker recording which source version partial chunks belong to
    (client-only; the service worker never serves from it). */
export const partialMetaKey = (url: string) => `${url}${url.includes('?') ? '&' : '?'}vxpartial=1`;
export const chunkCount = (size: number, chunk: number) =>
  size === 0 ? 0 : Math.ceil(size / chunk);

export interface OfflineManifestEntry {
  url: string;
  sizeBytes: number;
  kind: string;
  sha256?: string;
  dynamic?: boolean;
  /** Tracks: immutable identity of the source file's bytes. */
  sourceVersion?: string;
  /** Tracks: fixed chunk size the per-chunk hashes were computed over. */
  chunkSize?: number;
  /** Tracks: SHA-256 per chunk, in order. */
  chunkHashes?: string[];
}

export interface DownloadState {
  bookId: string;
  status: 'idle' | 'downloading' | 'done' | 'error' | 'cancelled';
  totalUrls: number;
  doneUrls: number;
  estimatedBytes: number;
  storedBytes: number;
  error?: string;
  updatedAt: string;
  urls: string[];
}

export async function getDownloadState(bookId: string): Promise<DownloadState | null> {
  return (await idbGet<DownloadState>(STORES.downloads, bookId)) ?? null;
}

/** Every download this browser knows about (any status). */
export async function listDownloads(): Promise<DownloadState[]> {
  try {
    return (await idbAll<DownloadState>(STORES.downloads)).map((d) => d.value);
  } catch {
    return [];
  }
}

/**
 * The book summary embedded in a downloaded title's cached detail JSON —
 * enough to render a library card with no network at all.
 */
export async function cachedBookSummary(bookId: string): Promise<BookSummary | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(OFFLINE_CACHE);
    const hit = await cache.match(`/api/books/${bookId}`);
    if (!hit) return null;
    const data = (await hit.json()) as { book?: BookSummary };
    return data.book ?? null;
  } catch {
    return null;
  }
}

const controllers = new Map<string, AbortController>();

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  try {
    if (!crypto?.subtle) return null; // insecure context: size checks still apply
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function fetchOpts(signal: AbortSignal, range?: string): RequestInit {
  return {
    credentials: 'same-origin',
    headers: { 'x-vx-csrf': '1', ...(range ? { range } : {}) },
    signal,
  };
}

/** Download + verify one non-chunked entry; returns stored byte count. */
export async function downloadEntry(
  cache: Cache,
  entry: OfflineManifestEntry,
  signal: AbortSignal,
): Promise<number> {
  const existing = await cache.match(entry.url);
  if (existing) return Number(existing.headers.get('content-length') ?? 0);
  const res = await fetch(entry.url, fetchOpts(signal));
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${entry.url}`);
  const buf = await res.arrayBuffer();
  if (entry.dynamic) {
    // Dynamic JSON has no stable hash; validate structure instead.
    try {
      JSON.parse(new TextDecoder().decode(buf));
    } catch {
      throw new Error(`Invalid response for ${entry.url}`);
    }
  } else {
    if (buf.byteLength !== entry.sizeBytes) {
      throw new Error(
        `Size mismatch for ${entry.url}: got ${buf.byteLength}, expected ${entry.sizeBytes}`,
      );
    }
    if (entry.sha256) {
      const digest = await sha256Hex(buf);
      if (digest !== null && digest !== entry.sha256) {
        throw new Error(`Integrity check failed for ${entry.url}`);
      }
    }
  }
  await cache.put(
    entry.url,
    new Response(buf, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': String(buf.byteLength),
      },
    }),
  );
  return buf.byteLength;
}

/** Remove a chunked track's completion meta, partial marker, and chunks. */
async function deleteTrackChunks(cache: Cache, url: string): Promise<void> {
  await cache.delete(metaKey(url));
  await cache.delete(partialMetaKey(url));
  let i = 0;
  for (; await cache.delete(chunkKey(url, i)); i++);
  // A gap can exist after a failed resume: sweep a bounded window past it.
  for (let j = i + 1; j < i + 64; j++) await cache.delete(chunkKey(url, j));
}

/**
 * Download one audio track as verified fixed-size chunks. Memory use is
 * bounded by the chunk size regardless of the track size (a whole-file
 * ArrayBuffer of a large M4B would OOM an iPhone tab), and hashing is
 * per-chunk — the file is never digested through one giant buffer.
 *
 * Integrity: the manifest supplies an immutable sourceVersion plus a
 * SHA-256 per chunk. Every fetched chunk must arrive as an exact 206 with
 * the exact Content-Range, the expected byte count, an ETag matching the
 * sourceVersion, and a matching chunk digest — otherwise the download
 * fails without storing the chunk. A resume first checks the stored
 * partial marker: chunks downloaded under a DIFFERENT source version are
 * discarded wholesale (old and new bytes are never combined), and chunks
 * kept from a matching earlier attempt are re-hashed before being trusted.
 * The completion meta — which makes the track servable offline — is
 * written only after every chunk verified.
 */
export async function downloadTrackChunked(
  cache: Cache,
  entry: OfflineManifestEntry,
  signal: AbortSignal,
  onChunk: (bytes: number) => Promise<void>,
): Promise<void> {
  const version = entry.sourceVersion;
  const hashes = entry.chunkHashes;
  const chunkSize = entry.chunkSize ?? AUDIO_CHUNK_BYTES;
  const total = entry.sizeBytes;
  const chunks = chunkCount(total, chunkSize);
  if (!version || !hashes || hashes.length !== chunks) {
    // Fail closed: without the integrity contract nothing is stored.
    throw new Error(`Offline manifest is missing integrity data for ${entry.url}`);
  }

  const doneMetaRes = await cache.match(metaKey(entry.url));
  if (doneMetaRes) {
    const doneMeta = (await doneMetaRes.json()) as { sourceVersion?: string };
    if (doneMeta.sourceVersion === version) {
      await onChunk(entry.sizeBytes);
      return;
    }
    // The source was replaced since this track completed: rebuild from zero.
    await deleteTrackChunks(cache, entry.url);
  }

  // Resume bookkeeping: partial chunks are only reusable when they were
  // fetched from the SAME source version.
  const partialRes = await cache.match(partialMetaKey(entry.url));
  if (partialRes) {
    const partial = (await partialRes.json()) as { sourceVersion?: string };
    if (partial.sourceVersion !== version) await deleteTrackChunks(cache, entry.url);
  }
  await cache.put(
    partialMetaKey(entry.url),
    new Response(JSON.stringify({ sourceVersion: version, chunkSize }), {
      headers: { 'content-type': 'application/json' },
    }),
  );

  let contentType = 'audio/mpeg';
  for (let i = 0; i < chunks; i++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    const start = i * chunkSize;
    const end = Math.min(total, start + chunkSize) - 1;
    const expectedLen = end - start + 1;

    const existing = await cache.match(chunkKey(entry.url, i));
    if (existing) {
      // Same-version leftover from an interrupted attempt: re-verify its
      // bytes before counting it.
      const buf = await existing.arrayBuffer();
      const digest = await sha256Hex(buf);
      if (buf.byteLength === expectedLen && (digest === null || digest === hashes[i])) {
        await onChunk(buf.byteLength);
        continue;
      }
      await cache.delete(chunkKey(entry.url, i));
    }

    const res = await fetch(entry.url, fetchOpts(signal, `bytes=${start}-${end}`));
    if (res.status !== 206) {
      throw new Error(`Server did not honor Range for ${entry.url} (status ${res.status})`);
    }
    const contentRange = res.headers.get('content-range');
    if (contentRange !== `bytes ${start}-${end}/${total}`) {
      throw new Error(
        `Wrong Content-Range for ${entry.url}: got "${contentRange ?? ''}", expected "bytes ${start}-${end}/${total}"`,
      );
    }
    const etag = res.headers.get('etag');
    if (etag && etag.replace(/^(W\/)?"|"$/g, '') !== version) {
      // The source file changed under us mid-download: nothing stored so
      // far may be combined with the new bytes.
      await deleteTrackChunks(cache, entry.url);
      throw new Error(`Source changed during download of ${entry.url}; download restarted`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== expectedLen) {
      throw new Error(`Chunk size mismatch for ${entry.url} at ${start}`);
    }
    const digest = await sha256Hex(buf);
    if (digest !== null && digest !== hashes[i]) {
      throw new Error(`Integrity check failed for ${entry.url} (chunk ${i})`);
    }
    contentType = res.headers.get('content-type') ?? contentType;
    await cache.put(
      chunkKey(entry.url, i),
      new Response(buf, { headers: { 'content-length': String(buf.byteLength) } }),
    );
    await onChunk(buf.byteLength);
  }
  // Completion marker: only now does the service worker serve this track.
  await cache.put(
    metaKey(entry.url),
    new Response(JSON.stringify({ size: total, chunkSize, contentType, sourceVersion: version }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await cache.delete(partialMetaKey(entry.url));
}

/** In-flight download loops, so a purge can wait for writers to stop. */
const activeDownloads = new Map<string, Promise<void>>();

/**
 * Purge generation: bumped by purgeOfflineData() once every registered
 * writer has settled. A download continuation from before the bump — e.g.
 * a manifest request that resolves only after logout completed — belongs
 * to a dead generation and must not write to Cache Storage or IndexedDB.
 */
let purgeGeneration = 0;

/** Reject as soon as the signal aborts, even if `p` itself never settles. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) {
      p.catch(() => {}); // abandoned: its outcome is discarded
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}

export async function startDownload(
  bookId: string,
  onUpdate: (s: DownloadState) => void,
): Promise<void> {
  if (!('caches' in window)) throw new Error('Cache Storage is not available in this browser.');
  // Register the controller and in-flight marker BEFORE the first await: a
  // purge that begins while the manifest request is still pending must see
  // this attempt, abort it, and wait for it to settle — otherwise the
  // resolved manifest would repopulate caches after logout.
  const generation = purgeGeneration;
  const controller = new AbortController();
  controllers.set(bookId, controller);
  let release: () => void = () => {};
  activeDownloads.set(
    bookId,
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const invalidated = () => generation !== purgeGeneration;
  try {
    let manifest: { urls: OfflineManifestEntry[]; totalBytes: number };
    try {
      manifest = await raceAbort(
        api<{ urls: OfflineManifestEntry[]; totalBytes: number }>(
          `/api/books/${bookId}/offline-manifest`,
          { signal: controller.signal },
        ),
        controller.signal,
      );
    } catch (err) {
      // Aborted (logout or cancel) before anything was stored: settle
      // silently and store NOTHING — nothing may outlive the purge.
      if (controller.signal.aborted || invalidated()) return;
      throw err;
    }
    if (controller.signal.aborted || invalidated()) return;
    const state: DownloadState = {
      bookId,
      status: 'downloading',
      totalUrls: manifest.urls.length,
      doneUrls: 0,
      estimatedBytes: manifest.totalBytes,
      storedBytes: 0,
      updatedAt: new Date().toISOString(),
      urls: manifest.urls.map((u) => u.url),
    };
    const save = async () => {
      // A continuation running after a completed purge must not repopulate
      // the download registry the purge just cleared.
      if (invalidated()) return;
      state.updatedAt = new Date().toISOString();
      await idbPut(STORES.downloads, bookId, { ...state });
      onUpdate({ ...state });
    };
    await save();
    const cache = await caches.open(OFFLINE_CACHE);
    try {
      for (const entry of manifest.urls) {
        if (controller.signal.aborted) {
          state.status = 'cancelled';
          await save();
          return;
        }
        if (entry.kind === 'track') {
          await downloadTrackChunked(cache, entry, controller.signal, async (bytes) => {
            state.storedBytes += bytes;
            await save();
          });
        } else {
          state.storedBytes += await downloadEntry(cache, entry, controller.signal);
        }
        state.doneUrls += 1;
        await save();
      }
      // Atomic completion: 'done' is written only after every entry verified.
      state.status = 'done';
      await save();
    } catch (err) {
      if (controller.signal.aborted) {
        state.status = 'cancelled';
      } else {
        state.status = 'error';
        state.error = (err as Error).message;
      }
      await save();
    }
  } finally {
    controllers.delete(bookId);
    activeDownloads.delete(bookId);
    release();
  }
}

export function cancelDownload(bookId: string): void {
  controllers.get(bookId)?.abort();
}

export async function removeDownload(bookId: string): Promise<void> {
  const state = await getDownloadState(bookId);
  if (state) {
    const cache = await caches.open(OFFLINE_CACHE);
    for (const url of state.urls) await deleteEntry(cache, url);
  }
  await idbDelete(STORES.downloads, bookId);
}

async function deleteEntry(cache: Cache, url: string): Promise<void> {
  await cache.delete(url);
  await cache.delete(partialMetaKey(url));
  // Chunked tracks: remove meta + every chunk.
  if (await cache.delete(metaKey(url))) {
    for (let i = 0; ; i++) {
      if (!(await cache.delete(chunkKey(url, i)))) break;
    }
  } else {
    // Meta may be absent after a failed download; sweep chunks anyway.
    for (let i = 0; await cache.delete(chunkKey(url, i)); i++);
  }
}

/**
 * Abort every in-flight download and WAIT for its loop to settle, so no
 * writer can repopulate caches or IndexedDB after a purge started.
 */
export async function abortAllDownloads(): Promise<void> {
  for (const c of controllers.values()) c.abort();
  await Promise.allSettled([...activeDownloads.values()]);
}

/**
 * Logout-as-revocation: remove every per-user offline artifact from this
 * browser profile — downloaded book content (Cache Storage) and the
 * per-user IndexedDB state (queued progress, cached server state, download
 * registry). Active download controllers are aborted and AWAITED first, so
 * a logout/download race cannot leave freshly written content behind.
 * Called on logout and whenever the session is discovered invalid (any API
 * 401, or the service worker's own revocation check). Documented in
 * docs/security.md.
 */
export async function purgeOfflineData(): Promise<void> {
  try {
    await abortAllDownloads();
  } catch {
    /* no active downloads */
  }
  // Every registered writer has settled. Anything still pending beyond
  // this point — a manifest request that survived the abort, or a
  // download started mid-purge — now belongs to a dead generation and
  // refuses to write to Cache Storage or IndexedDB.
  purgeGeneration += 1;
  try {
    if (typeof caches !== 'undefined') await caches.delete(OFFLINE_CACHE);
  } catch {
    /* cache storage unavailable */
  }
  try {
    await idbClear(STORES.downloads);
    await idbClear(STORES.serverState);
    await idbClear(STORES.pendingEvents);
  } catch {
    /* indexeddb unavailable */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
