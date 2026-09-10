import fs from 'node:fs';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type BookSummary } from '@versovox/shared';
import { type AppContext } from '../../context.js';
import { enqueueJob } from '../../jobs/queue.js';
import { handoffStatus, latestAlignment, isSwitchable } from '../../alignment/service.js';
import { getProgressState } from '../../progress/service.js';

export function bookRowToSummary(
  ctx: AppContext,
  userId: string,
  row: Record<string, unknown>,
): BookSummary {
  const { db } = ctx;
  const id = String(row.id);
  const pairRow = db
    .prepare(
      `SELECT * FROM pairs WHERE (ebook_id = ? OR audio_id = ?) AND status IN ('auto','confirmed','candidate')
       ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, score DESC LIMIT 1`,
    )
    .get(id, id) as Record<string, unknown> | undefined;
  let pair: BookSummary['pair'] = null;
  if (pairRow) {
    const handle = ['auto', 'confirmed'].includes(String(pairRow.status))
      ? latestAlignment(db, String(pairRow.id))
      : null;
    pair = {
      pairId: String(pairRow.id),
      otherBookId:
        String(pairRow.ebook_id) === id ? String(pairRow.audio_id) : String(pairRow.ebook_id),
      status: String(pairRow.status) as NonNullable<BookSummary['pair']>['status'],
      switchable: isSwitchable(handle),
      handoff: handoffStatus(handle),
    };
  }
  const state = getProgressState(db, userId, id);
  return {
    id,
    kind: String(row.kind) as BookSummary['kind'],
    title: String(row.title),
    author: (row.author as string) ?? null,
    series: (row.series as string) ?? null,
    seriesIdx: (row.series_idx as number) ?? null,
    language: (row.language as string) ?? null,
    format: String(row.format),
    scanState: String(row.scan_state) as BookSummary['scanState'],
    scanError: (row.scan_error as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    hasCover: Boolean(row.cover_path) && fs.existsSync(String(row.cover_path)),
    addedAt: String(row.added_at),
    pair,
    progress: state
      ? {
          pct: state.locator.pct,
          locator: state.locator,
          updatedAt: state.updatedAt,
          finished: state.finished,
        }
      : null,
  };
}

const libraryQuerySchema = z.object({
  query: z.string().max(200).optional(),
  kind: z.enum(['ebook', 'audio']).optional(),
  filter: z.enum(['paired', 'in-progress', 'finished']).optional(),
  sort: z.enum(['title', 'author', 'recent', 'added']).optional(),
});

export function registerLibraryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/library', async (req, reply) => {
    const parsedQuery = libraryQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: 'bad-query' });
    const q = parsedQuery.data;
    const rows = db
      .prepare(`SELECT * FROM books WHERE scan_state != 'missing' ORDER BY title COLLATE NOCASE`)
      .all() as Record<string, unknown>[];
    let books = rows.map((r) => bookRowToSummary(ctx, req.user!.id, r));

    if (q.query) {
      const needle = q.query.toLowerCase();
      books = books.filter(
        (b) =>
          b.title.toLowerCase().includes(needle) ||
          (b.author ?? '').toLowerCase().includes(needle) ||
          (b.series ?? '').toLowerCase().includes(needle),
      );
    }
    if (q.kind === 'ebook' || q.kind === 'audio') books = books.filter((b) => b.kind === q.kind);
    if (q.filter === 'paired') books = books.filter((b) => b.pair && b.pair.status !== 'candidate');
    if (q.filter === 'in-progress')
      books = books.filter((b) => b.progress && !b.progress.finished && b.progress.pct > 0.001);
    if (q.filter === 'finished') books = books.filter((b) => b.progress?.finished);

    switch (q.sort) {
      case 'recent':
        books.sort(
          (a, b) =>
            Date.parse(b.progress?.updatedAt ?? b.addedAt) -
            Date.parse(a.progress?.updatedAt ?? a.addedAt),
        );
        break;
      case 'author':
        books.sort((a, b) => (a.author ?? '￿').localeCompare(b.author ?? '￿'));
        break;
      case 'added':
        books.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
        break;
      default:
        break; // title order from SQL
    }

    // Continue-listening/reading rail: most recently touched, unfinished.
    const continueRail = books
      .filter((b) => b.progress && !b.progress.finished)
      .sort((a, b) => Date.parse(b.progress!.updatedAt) - Date.parse(a.progress!.updatedAt))
      .slice(0, 8)
      .map((b) => b.id);

    const scanning = db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs WHERE state IN ('queued','running') AND type IN ('scan','index-ebook','index-audio')`,
      )
      .get() as { c: number };

    return { books, continueRail, scanActive: scanning.c > 0 };
  });

  app.post('/api/library/rescan', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const id = enqueueJob(db, 'scan', {}, { dedupeKey: 'scan' });
    return { jobId: id, queued: id !== null };
  });

  app.get('/api/library/roots', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    return {
      ebookDirs: ctx.config.ebookDirs,
      audiobookDirs: ctx.config.audiobookDirs,
      readOnly: true,
    };
  });
  app.get('/api/books/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    const summary = bookRowToSummary(ctx, req.user!.id, row);
    const chapters = db
      .prepare('SELECT * FROM chapters WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const tracks = db
      .prepare('SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY idx')
      .all(id) as Record<string, unknown>[];
    const meta = JSON.parse(String(row.meta_json ?? '{}'));
    return {
      book: summary,
      description: meta.description ?? null,
      direction: meta.direction ?? 'ltr',
      totalChars: meta.totalChars ?? null,
      chapters: chapters.map((c) => ({
        idx: Number(c.idx),
        title: String(c.title),
        spineIdx: c.spine_idx === null ? null : Number(c.spine_idx),
        href: (c.href as string) ?? null,
        startMs: c.start_ms === null ? null : Number(c.start_ms),
        endMs: c.end_ms === null ? null : Number(c.end_ms),
      })),
      tracks: tracks.map((t) => ({
        idx: Number(t.idx),
        durationMs: Number(t.duration_ms),
        startMsAbsolute: Number(t.start_ms_absolute),
        sizeBytes: Number(t.size_bytes),
        format: String(t.format),
        title: (t.title as string) ?? null,
      })),
    };
  });

  app.get('/api/books/:id/cover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT cover_path FROM books WHERE id = ?').get(id) as
      { cover_path: string | null } | undefined;
    if (!row?.cover_path || !fs.existsSync(row.cover_path)) {
      return reply.code(404).send({ error: 'no-cover' });
    }
    const ext = row.cover_path.split('.').pop()?.toLowerCase();
    const type =
      ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'svg'
            ? 'image/svg+xml'
            : 'image/jpeg';
    reply.header('content-type', type);
    if (ext === 'svg') {
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(row.cover_path));
  });
}
