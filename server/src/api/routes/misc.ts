import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';
import { type FastifyInstance } from 'fastify';
import { settingsSchema } from '@versovox/shared';
import { requireRole } from '../../auth/roles.js';
import { type AppContext, activeDerivedDir } from '../../context.js';
import { loadManifest, loadSentences } from '../../epub/extract.js';
import {
  hashFileChunks,
  OFFLINE_AUDIO_CHUNK_BYTES,
  trackSourceVersion,
} from '../../audio/integrity.js';
import { realResolveWithin } from '../../util/paths.js';
import { libraryRoots, resolveSettings, saveSettings } from '../../domain/settings.js';
import { cancelJob, retryJob } from '../../jobs/queue.js';
import { modelById } from '../../transcription/models.js';

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
      },
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
    // A web admin may only point the worker at executables/models that the
    // operator placed inside the models volume — never at arbitrary paths
    // in the container (that would turn an admin session into code
    // execution). Paths are checked again by the provider at run time.
    for (const key of ['whisperBin', 'whisperModel'] as const) {
      const value = patch[key];
      if (typeof value !== 'string' || value === '') continue;
      try {
        realResolveWithin(
          config.modelsDir,
          path.relative(config.modelsDir, path.resolve(config.modelsDir, value)),
        );
      } catch {
        return reply.code(400).send({
          error: 'invalid',
          detail: `${key} must be a file inside the models directory (${config.modelsDir})`,
        });
      }
    }
    saveSettings(db, patch);
    const { values } = resolveSettings(db, config);
    return { settings: values, envPinned };
  });
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
      // an illustrated book is genuinely complete offline.
      const assetDir = path.join(dir, 'assets');
      for (const rel of walkAssets(assetDir)) {
        const asset = fileEntry(
          `/api/books/${id}/asset/${rel.split('/').map(encodeURIComponent).join('/')}`,
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
    urls.push({ url: `/api/books/${id}`, sizeBytes: 10_000, kind: 'detail', dynamic: true });
    const totalBytes = urls.reduce((a, u) => a + u.sizeBytes, 0);
    return { bookId: id, urls, totalBytes };
  });
}
