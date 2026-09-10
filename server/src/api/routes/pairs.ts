import { type FastifyInstance } from 'fastify';
import { locatorSchema } from '@versovox/shared';
import { z } from 'zod';
import { type AppContext, activeDerivedDir } from '../../context.js';
import { nowIso } from '../../db/index.js';
import { stableId } from '../../util/ids.js';
import { enqueueJob } from '../../jobs/queue.js';
import {
  handoffStatus,
  isSwitchable,
  latestAlignment,
  resolveSwitch,
  type ResolveContext,
} from '../../alignment/service.js';
import { loadManifest, loadSentences } from '../../epub/extract.js';
import { languageCode } from '../../pairing/score.js';
import { LANGUAGES, parseModelMissing } from '../../transcription/models.js';

export function registerPairRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  const pairDto = (row: Record<string, unknown>) => {
    const handle = latestAlignment(db, String(row.id));
    const ebook = db
      .prepare('SELECT id, title, author, cover_path, language FROM books WHERE id = ?')
      .get(String(row.ebook_id)) as Record<string, unknown> | undefined;
    const audio = db
      .prepare(
        'SELECT id, title, author, duration_ms, cover_path, language FROM books WHERE id = ?',
      )
      .get(String(row.audio_id)) as Record<string, unknown> | undefined;
    const lastJob = db
      .prepare(
        `SELECT state, progress, detail, error, created_at FROM jobs
         WHERE type = 'align' AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(`%"pairId":"${String(row.id)}"%`) as
      | {
          state: string;
          progress: number;
          detail: string | null;
          error: string | null;
          created_at: string;
        }
      | undefined;
    const override = languageCode(row.language as string | null);
    const effectiveLanguage =
      override ??
      languageCode(row.detected_language as string | null) ??
      languageCode(ebook?.language as string | null) ??
      languageCode(audio?.language as string | null);
    return {
      language: {
        override,
        detected: languageCode(row.detected_language as string | null),
        effective: effectiveLanguage,
        source: override
          ? 'override'
          : row.detected_language
            ? 'alignment'
            : ebook?.language
              ? 'ebook-metadata'
              : audio?.language
                ? 'audio-tags'
                : 'unknown',
      },
      lastAlignJob: lastJob
        ? {
            state: lastJob.state,
            progress: Number(lastJob.progress),
            detail: lastJob.detail,
            error: lastJob.error,
            modelMissing: parseModelMissing(lastJob.error),
            createdAt: lastJob.created_at,
          }
        : null,
      id: String(row.id),
      status: String(row.status),
      score: Number(row.score),
      evidence: JSON.parse(String(row.evidence_json ?? '{}')),
      compat: row.compat_json ? JSON.parse(String(row.compat_json)) : null,
      createdAt: String(row.created_at),
      decidedAt: (row.decided_at as string) ?? null,
      ebook: ebook
        ? {
            id: String(ebook.id),
            title: String(ebook.title),
            author: (ebook.author as string) ?? null,
          }
        : null,
      audio: audio
        ? {
            id: String(audio.id),
            title: String(audio.title),
            author: (audio.author as string) ?? null,
            durationMs: (audio.duration_ms as number) ?? null,
          }
        : null,
      alignment: handle?.summary ?? null,
      // `switchable` means "handoff available", never "exact everywhere";
      // `handoff` carries the honest exact-sentence coverage numbers.
      switchable: isSwitchable(handle),
      handoff: handoffStatus(handle),
    };
  };

  /** Per-pair narration language override (drives speech-model choice). */
  app.post('/api/pairs/:id/language', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const parsed = z.object({ language: z.string().max(8).nullable() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const code = parsed.data.language ? languageCode(parsed.data.language) : null;
    if (parsed.data.language && (!code || !LANGUAGES.some((l) => l.code === code))) {
      return reply.code(400).send({ error: 'unsupported-language' });
    }
    const res = db.prepare('UPDATE pairs SET language = ? WHERE id = ?').run(code, id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown>;
    return { pair: pairDto(row) };
  });

  app.get('/api/pairs', async () => {
    const rows = db
      .prepare(
        `SELECT * FROM pairs ORDER BY CASE status WHEN 'candidate' THEN 0 WHEN 'auto' THEN 1 WHEN 'confirmed' THEN 2 ELSE 3 END, score DESC`,
      )
      .all() as Record<string, unknown>[];
    return { pairs: rows.map(pairDto) };
  });

  app.get('/api/pairs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    return { pair: pairDto(row) };
  });

  const decide = (id: string, status: 'confirmed' | 'rejected', userId: string): boolean => {
    const res = db
      .prepare('UPDATE pairs SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(status, nowIso(), userId, id);
    return Number(res.changes) > 0;
  };

  app.post('/api/pairs/:id/confirm', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    if (!decide(id, 'confirmed', req.user!.id)) return reply.code(404).send({ error: 'not-found' });
    enqueueJob(db, 'align', { pairId: id }, { dedupeKey: `align:${id}` });
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown>;
    return { pair: pairDto(row) };
  });

  app.post('/api/pairs/:id/reject', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    if (!decide(id, 'rejected', req.user!.id)) return reply.code(404).send({ error: 'not-found' });
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown>;
    return { pair: pairDto(row) };
  });

  /** Unlink returns an auto/confirmed pair to rejected (durable decision). */
  app.post('/api/pairs/:id/unlink', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    if (!decide(id, 'rejected', req.user!.id)) return reply.code(404).send({ error: 'not-found' });
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown>;
    return { pair: pairDto(row) };
  });

  /** Manual link between an ebook and an audiobook. */
  app.post('/api/pairs/link', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const parsed = z.object({ ebookId: z.string(), audioId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const { ebookId, audioId } = parsed.data;
    const ebook = db.prepare("SELECT id FROM books WHERE id = ? AND kind = 'ebook'").get(ebookId);
    const audio = db.prepare("SELECT id FROM books WHERE id = ? AND kind = 'audio'").get(audioId);
    if (!ebook || !audio) return reply.code(404).send({ error: 'not-found' });
    const id = stableId('pair', ebookId, audioId);
    const existing = db.prepare('SELECT id FROM pairs WHERE id = ?').get(id);
    if (existing) {
      db.prepare('UPDATE pairs SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?').run(
        'confirmed',
        nowIso(),
        req.user!.id,
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO pairs (id, ebook_id, audio_id, status, score, evidence_json, created_at, decided_at, decided_by)
         VALUES (?, ?, ?, 'confirmed', 0, ?, ?, ?, ?)`,
      ).run(
        id,
        ebookId,
        audioId,
        JSON.stringify({ notes: ['Manually linked by user.'] }),
        nowIso(),
        nowIso(),
        req.user!.id,
      );
    }
    enqueueJob(db, 'align', { pairId: id }, { dedupeKey: `align:${id}` });
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown>;
    return { pair: pairDto(row) };
  });

  app.post('/api/pairs/:id/align', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not-found' });
    const jobId = enqueueJob(db, 'align', { pairId: id }, { dedupeKey: `align:${id}` });
    return { jobId, queued: jobId !== null };
  });

  /** Resolve a locator across media: the two-way switch. */
  app.post('/api/pairs/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ from: locatorSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const pair = db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!pair) return reply.code(404).send({ error: 'not-found' });
    if (!['auto', 'confirmed'].includes(String(pair.status))) {
      return reply.code(409).send({ error: 'not-linked' });
    }
    const handle = latestAlignment(db, id);
    if (!handle) {
      return {
        to: null,
        resolution: {
          granularity: 'none',
          confidence: 0,
          reason: 'This pair has not been aligned yet.',
        },
      };
    }
    const dd = activeDerivedDir(ctx, String(pair.ebook_id));
    const manifest = loadManifest(dd);
    const sentences = loadSentences(dd);
    if (!manifest || !sentences) {
      return reply.code(409).send({ error: 'ebook-not-indexed' });
    }
    const tracks = db
      .prepare(
        'SELECT start_ms_absolute, duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx',
      )
      .all(String(pair.audio_id)) as { start_ms_absolute: number; duration_ms: number }[];
    const rctx: ResolveContext = {
      db,
      alignmentId: handle.alignmentId,
      gaps: handle.summary.gaps,
      tracks: tracks.map((t) => ({
        startMsAbsolute: Number(t.start_ms_absolute),
        durationMs: Number(t.duration_ms),
      })),
      sentences,
      chapterCumChars: manifest.chapters.map((c) => c.cumChars),
      totalChars: manifest.totalChars,
    };
    return resolveSwitch(rctx, parsed.data.from);
  });

  /** Alignment coverage detail for the pairing review screen. */
  app.get('/api/pairs/:id/alignment', async (req, reply) => {
    const { id } = req.params as { id: string };
    const handle = latestAlignment(db, id);
    if (!handle) return reply.code(404).send({ error: 'no-alignment' });
    const buckets = db
      .prepare(
        `SELECT CAST(start_ms / 60000 AS INTEGER) AS minute, AVG(confidence) AS conf, COUNT(*) AS n
         FROM alignment_segments WHERE alignment_id = ? GROUP BY minute ORDER BY minute`,
      )
      .all(handle.alignmentId) as { minute: number; conf: number; n: number }[];
    return {
      summary: handle.summary,
      confidenceByMinute: buckets.map((b) => ({
        minute: Number(b.minute),
        confidence: Math.round(Number(b.conf) * 1000) / 1000,
        segments: Number(b.n),
      })),
    };
  });
}
