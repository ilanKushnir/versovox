import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';
import { type FastifyInstance } from 'fastify';
import { settingsSchema, type Locator, type SwitchResolution } from '@versovox/shared';
import { requireRole } from '../../auth/roles.js';
import { enqueueJob } from '../../jobs/queue.js';
import { type AppContext, activeDerivedDir } from '../../context.js';
import { loadManifest, loadSentences } from '../../epub/extract.js';
import {
  hashFileChunks,
  OFFLINE_AUDIO_CHUNK_BYTES,
  trackSourceVersion,
} from '../../audio/integrity.js';
import { realResolveWithin } from '../../util/paths.js';
import {
  alignmentRoots,
  libraryRoots,
  resolveSettings,
  saveSettings,
} from '../../domain/settings.js';
import { alignmentFolderSummary } from '../../alignment/library.js';
import { cancelJob, retryJob } from '../../jobs/queue.js';
import { modelById } from '../../alignment/model.js';
import {
  isSwitchable,
  latestAlignment,
  resolveAudioToEbook,
  resolveEbookToAudio,
  type ResolveContext,
} from '../../alignment/service.js';

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const bookTitle = (id: string): string | null => {
    const row = db.prepare('SELECT title FROM books WHERE id = ?').get(id) as
      { title: string } | undefined;
    return row?.title ?? null;
  };
  /** Human subject of a job: pair titles, book title, model label. */
  const subjectOf = (type: string, payload: Record<string, unknown>) => {
    try {
      if (type === 'align' && typeof payload.pairId === 'string') {
        const pair = db
          .prepare('SELECT ebook_id, audio_id FROM pairs WHERE id = ?')
          .get(payload.pairId) as { ebook_id: string; audio_id: string } | undefined;
        if (!pair) return null;
        const e = bookTitle(pair.ebook_id);
        const a = bookTitle(pair.audio_id);
        return {
          title: e ?? a ?? 'Pair',
          sub: e && a && e !== a ? `${e} ⇄ ${a}` : null,
          pairId: payload.pairId,
          bookId: pair.ebook_id,
        };
      }
      if (
        (type === 'index-ebook' || type === 'index-audio') &&
        typeof payload.bookId === 'string'
      ) {
        return {
          title: bookTitle(payload.bookId) ?? 'Book',
          sub: null,
          pairId: null,
          bookId: payload.bookId,
        };
      }
      if (type === 'model-download' && typeof payload.modelId === 'string') {
        return {
          title: modelById(payload.modelId)?.label ?? String(payload.modelId),
          sub: 'Speech model',
          pairId: null,
          bookId: null,
        };
      }
    } catch {
      /* subject is best effort */
    }
    return null;
  };

  app.get('/api/jobs', async () => {
    const rows = db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100')
      .all() as Record<string, unknown>[];
    return {
      jobs: rows.map((r) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(r.payload_json ?? '{}'));
        } catch {
          /* ignore */
        }
        return {
          id: String(r.id),
          type: String(r.type),
          state: String(r.state),
          progress: Number(r.progress),
          detail: (r.detail as string) ?? null,
          error: (r.error as string) ?? null,
          attempts: Number(r.attempts),
          createdAt: String(r.created_at),
          startedAt: (r.started_at as string) ?? null,
          finishedAt: (r.finished_at as string) ?? null,
          subject: subjectOf(String(r.type), payload),
        };
      }),
    };
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireRole(req, reply, 'curator')) return reply;
    return { ok: cancelJob(db, id) };
  });

  app.post('/api/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireRole(req, reply, 'curator')) return reply;
    return { ok: retryJob(db, id) };
  });
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  /** One cheap round trip for the settings dashboard's overview cards. */
  const dashboardStats = () => {
    const count = (sql: string) => Number((db.prepare(sql).get() as { c: number }).c);
    return {
      ebooks: count("SELECT COUNT(*) AS c FROM books WHERE kind = 'ebook'"),
      audiobooks: count("SELECT COUNT(*) AS c FROM books WHERE kind = 'audio'"),
      booksIndexing: count(
        "SELECT COUNT(*) AS c FROM books WHERE scan_state IN ('discovered','indexing')",
      ),
      pairsLinked: count("SELECT COUNT(*) AS c FROM pairs WHERE status IN ('auto','confirmed')"),
      pairsCandidate: count("SELECT COUNT(*) AS c FROM pairs WHERE status = 'candidate'"),
      pairsAligned: count('SELECT COUNT(DISTINCT pair_id) AS c FROM alignments'),
      jobsRunning: count("SELECT COUNT(*) AS c FROM jobs WHERE state = 'running'"),
      jobsQueued: count("SELECT COUNT(*) AS c FROM jobs WHERE state = 'queued'"),
      jobsFailed: count("SELECT COUNT(*) AS c FROM jobs WHERE state = 'failed'"),
      users: count("SELECT COUNT(*) AS c FROM users WHERE status = 'active'"),
    };
  };

  app.get('/api/settings', async () => {
    const { values, envPinned } = resolveSettings(db, config);
    return {
      settings: values,
      envPinned,
      stats: dashboardStats(),
      paths: {
        dataDir: config.dataDir,
        cacheDir: config.cacheDir,
        modelsDir: config.modelsDir,
        ...libraryRoots(db, config),
        alignmentDirs: alignmentRoots(db, config),
      },
      alignments: alignmentFolderSummary(ctx),
      precedence:
        'Environment variables override in-app settings; in-app settings override defaults.',
    };
  });

  app.put('/api/settings', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const parsed = settingsSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const { envPinned } = resolveSettings(db, config);
    // `.partial()` does NOT stop zod from filling in `.default()` values for
    // keys the caller never sent, so parsed.data always contains every
    // defaulted field. Writing those would silently reset unrelated settings —
    // library folders included. Persist only what was actually sent.
    const sent = new Set(Object.keys((req.body ?? {}) as Record<string, unknown>));
    const patch = Object.fromEntries(
      Object.entries(parsed.data).filter(([k]) => sent.has(k) && !envPinned.includes(k)),
    );
    saveSettings(db, patch);
    const { values } = resolveSettings(db, config);
    return { settings: values, envPinned };
  });

  /**
   * Take any saved alignment on disk that belongs to a pair here. Runs by
   * itself after every scan; this is for the operator who just mounted a
   * second folder and does not want to wait for one.
   */
  app.post('/api/alignments/import', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const id = enqueueJob(db, 'import-alignments', {}, { dedupeKey: 'import-alignments' });
    return { queued: Boolean(id) };
  });

  /** Write out every alignment this server holds that is not already saved. */
  app.post('/api/alignments/export', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const id = enqueueJob(db, 'export-alignments', {}, { dedupeKey: 'export-alignments' });
    return { queued: Boolean(id) };
  });
}

/**
 * Sampling step for an audiobook's offline switch answers. Coarser than a
 * sentence, but the client always takes the entry at or BEFORE its position,
 * so the rounding error only ever lands the reader earlier in the text —
 * the same direction the resolver's own rewind margin errs in, and the only
 * direction that cannot spoil what has not been heard yet.
 */
const OFFLINE_SWITCH_GRID_MS = 5_000;

/**
 * Upper bound on precomputed switch answers per title, so a pathological
 * book cannot turn its offline package into a hundred-megabyte JSON. Past
 * the cap the remaining positions simply have no offline answer.
 */
const OFFLINE_SWITCH_MAX_ENTRIES = 60_000;

/** One precomputed cross-medium switch answer. */
interface OfflineSwitchEntry {
  /** Ebook packages: the sentence this answer belongs to. */
  sentenceId?: string;
  /** Audio packages: whole-book milliseconds from which this answer applies. */
  atMs?: number;
  to: Locator | null;
  resolution: SwitchResolution;
}

interface OfflineSwitchTable {
  pairId: string;
  otherBookId: string;
  direction: 'ebook-to-audio' | 'audio-to-ebook';
  /** Audio packages only: the step `atMs` was sampled on. */
  gridMs?: number;
  entries: OfflineSwitchEntry[];
}

/**
 * Per-title offline package manifest: what the PWA downloads for offline
 * use. Every static entry carries its true byte size and a SHA-256 of the
 * exact bytes the corresponding route serves, so the client can verify each
 * response before marking the package complete. Dynamic JSON (book detail,
 * which embeds progress) is marked `dynamic` and validated structurally
 * instead. Audio tracks are downloaded in verified-size chunks (`hash`
 * omitted; the total size is authoritative).
 */
export function registerOfflineRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  interface OfflineEntry {
    url: string;
    sizeBytes: number;
    kind: string;
    sha256?: string;
    dynamic?: boolean;
    /** Tracks: immutable identity of the source file's current bytes. */
    sourceVersion?: string;
    /** Tracks: fixed chunking the per-chunk hashes are computed over. */
    chunkSize?: number;
    /** Tracks: SHA-256 of each chunk, in order. */
    chunkHashes?: string[];
  }

  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

  const fileEntry = (url: string, kind: string, filePath: string): OfflineEntry | null => {
    try {
      const buf = fs.readFileSync(filePath);
      return { url, kind, sizeBytes: buf.byteLength, sha256: sha256(buf) };
    } catch {
      return null;
    }
  };

  const jsonEntry = (url: string, kind: string, value: unknown): OfflineEntry => {
    const body = JSON.stringify(value);
    return { url, kind, sizeBytes: Buffer.byteLength(body), sha256: sha256(body) };
  };

  const walkAssets = (dir: string, base = ''): string[] => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const rel = base ? posix.join(base, e.name) : e.name;
      if (e.isDirectory()) out.push(...walkAssets(path.join(dir, e.name), rel));
      else if (e.isFile()) out.push(rel);
    }
    return out;
  };

  /**
   * Precompute every cross-medium switch answer for a paired title, so the
   * handoff that is the point of owning both editions still works with no
   * network.
   *
   * The SERVER's resolver produces each answer and the client only looks one
   * up: the confidence thresholds, gap handling and spoiler-rewind margin
   * that decide where a switch lands must have exactly one implementation,
   * and a second one written against a cached segment table would drift from
   * it silently. Ebook packages are keyed by sentence id (the reader's saved
   * position always carries one); audio packages are sampled on a time grid
   * and run-length encoded — an entry is emitted only where the answer
   * changes, including where it changes to "no aligned position here", so an
   * unaligned stretch can never inherit the previous entry's answer.
   */
  const buildSwitchTable = (bookId: string): OfflineSwitchTable | null => {
    const pairRow = db
      .prepare(
        `SELECT * FROM pairs WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto','confirmed')
         ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, score DESC LIMIT 1`,
      )
      .get(bookId, bookId) as Record<string, unknown> | undefined;
    if (!pairRow) return null;
    const pairId = String(pairRow.id);
    const handle = latestAlignment(db, pairId);
    if (!handle || !isSwitchable(handle)) return null;
    const ebookId = String(pairRow.ebook_id);
    const audioId = String(pairRow.audio_id);
    const derived = activeDerivedDir(ctx, ebookId);
    const manifest = loadManifest(derived);
    const sentences = loadSentences(derived);
    if (!manifest || !sentences) return null;
    const tracks = (
      db
        .prepare(
          'SELECT start_ms_absolute, duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx',
        )
        .all(audioId) as { start_ms_absolute: number; duration_ms: number }[]
    ).map((t) => ({
      startMsAbsolute: Number(t.start_ms_absolute),
      durationMs: Number(t.duration_ms),
    }));
    if (tracks.length === 0) return null;
    const rctx: ResolveContext = {
      db,
      alignmentId: handle.alignmentId,
      gaps: handle.summary.gaps,
      tracks,
      sentences,
      chapterCumChars: manifest.chapters.map((c) => c.cumChars),
      totalChars: manifest.totalChars,
    };

    const entries: OfflineSwitchEntry[] = [];
    const fromEbook = bookId === ebookId;
    if (fromEbook) {
      for (let spineIdx = 0; spineIdx < sentences.length; spineIdx++) {
        for (const s of sentences[spineIdx] ?? []) {
          if (entries.length >= OFFLINE_SWITCH_MAX_ENTRIES) break;
          const out = resolveEbookToAudio(rctx, {
            medium: 'ebook',
            spineIdx,
            sentenceId: s.id,
            charOffset: s.start,
            pct: 0,
          });
          // A sentence with no answer is simply absent: the client treats a
          // miss and a stored "unavailable" the same way.
          if (!out.to) continue;
          entries.push({ sentenceId: s.id, to: out.to, resolution: out.resolution });
        }
      }
    } else {
      const totalMs = tracks.reduce((a, t) => a + t.durationMs, 0);
      let previous: string | null = null;
      for (let atMs = 0; atMs <= totalMs; atMs += OFFLINE_SWITCH_GRID_MS) {
        if (entries.length >= OFFLINE_SWITCH_MAX_ENTRIES) break;
        const out = resolveAudioToEbook(rctx, {
          medium: 'audio',
          trackIdx: 0,
          positionMs: 0,
          bookMs: atMs,
          pct: 0,
        });
        const answer = JSON.stringify([out.to, out.resolution]);
        if (answer === previous) continue;
        previous = answer;
        entries.push({ atMs, to: out.to, resolution: out.resolution });
      }
    }
    if (entries.length === 0) return null;
    return {
      pairId,
      otherBookId: fromEbook ? audioId : ebookId,
      direction: fromEbook ? 'ebook-to-audio' : 'audio-to-ebook',
      ...(fromEbook ? {} : { gridMs: OFFLINE_SWITCH_GRID_MS }),
      entries,
    };
  };

  app.get('/api/books/:id/offline-switch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const exists = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
    if (!exists) return reply.code(404).send({ error: 'not-found' });
    const table = buildSwitchTable(id);
    if (!table) return reply.code(404).send({ error: 'no-alignment' });
    reply.header('cache-control', 'private, max-age=3600');
    return table;
  });

  app.get('/api/books/:id/offline-manifest', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const urls: OfflineEntry[] = [];
    if (book.cover_path) {
      const cover = fileEntry(`/api/books/${id}/cover`, 'cover', String(book.cover_path));
      if (cover) urls.push(cover);
    }
    if (String(book.kind) === 'ebook') {
      const dir = activeDerivedDir(ctx, id);
      const manifest = loadManifest(dir);
      const sentences = loadSentences(dir);
      if (!manifest || !sentences) return reply.code(409).send({ error: 'not-indexed' });
      // Hashes cover the exact serialized bytes the reader routes emit.
      urls.push(jsonEntry(`/api/books/${id}/manifest`, 'manifest', manifest));
      for (const ch of manifest.chapters) {
        const chapter = fileEntry(
          `/api/books/${id}/chapter/${ch.idx}`,
          'chapter',
          path.join(dir, `ch_${ch.idx}.html`),
        );
        if (chapter) urls.push(chapter);
        if (sentences[ch.idx]) {
          urls.push(
            jsonEntry(`/api/books/${id}/sentences/${ch.idx}`, 'sentences', {
              sentences: sentences[ch.idx],
            }),
          );
        }
      }
      // Every referenced derived asset (images) is part of the package, so
      // an illustrated book is genuinely complete offline. The URL must be
      // spelled EXACTLY as the sanitizer wrote it into the chapter HTML —
      // one percent-encoded path segment, separators included (see
      // sanitize.ts) — because Cache Storage matches on the literal URL: an
      // entry stored under `.../asset/img/pic.png` is invisible to a reader
      // asking for `.../asset/img%2Fpic.png`.
      const assetDir = path.join(dir, 'assets');
      for (const rel of walkAssets(assetDir)) {
        const asset = fileEntry(
          `/api/books/${id}/asset/${encodeURIComponent(rel)}`,
          'asset',
          path.join(assetDir, ...rel.split('/')),
        );
        if (asset) urls.push(asset);
      }
    } else {
      const tracks = db
        .prepare('SELECT idx, rel_path FROM audio_tracks WHERE book_id = ? ORDER BY idx')
        .all(id) as { idx: number; rel_path: string }[];
      for (const t of tracks) {
        // Integrity is computed from the file AS CURRENTLY SERVED (not the
        // scan-time database row): size, an immutable source version the
        // track route also emits as its ETag, and a SHA-256 per 8MiB chunk
        // (streamed — the file is never buffered whole). A track that
        // cannot be read must fail the manifest rather than yield a
        // "complete" offline package with holes.
        let abs: string;
        let stat: fs.Stats;
        try {
          abs = realResolveWithin(String(book.root_dir), t.rel_path);
          stat = fs.statSync(abs);
        } catch {
          return reply.code(409).send({ error: 'track-missing' });
        }
        urls.push({
          url: `/api/books/${id}/track/${t.idx}`,
          sizeBytes: stat.size,
          kind: 'track',
          sourceVersion: trackSourceVersion(stat, t.rel_path),
          chunkSize: OFFLINE_AUDIO_CHUNK_BYTES,
          chunkHashes: await hashFileChunks(abs, OFFLINE_AUDIO_CHUNK_BYTES),
        });
      }
    }
    // The alignment travels with the package: without it, a downloaded pair
    // can be read or listened to offline but not switched between, which is
    // the one thing owning both editions is for.
    const switchTable = buildSwitchTable(id);
    if (switchTable) {
      urls.push(jsonEntry(`/api/books/${id}/offline-switch`, 'switch', switchTable));
    }
    urls.push({ url: `/api/books/${id}`, sizeBytes: 10_000, kind: 'detail', dynamic: true });
    const totalBytes = urls.reduce((a, u) => a + u.sizeBytes, 0);
    return { bookId: id, urls, totalBytes };
  });
}
