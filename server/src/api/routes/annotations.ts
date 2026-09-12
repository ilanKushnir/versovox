import { type FastifyInstance } from 'fastify';
import { createAnnotationSchema, type Annotation } from '@versovox/shared';
import { type AppContext } from '../../context.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../db/index.js';

function rowToAnnotation(r: Record<string, unknown>): Annotation {
  return {
    id: String(r.id),
    bookId: String(r.book_id),
    kind: String(r.kind) as Annotation['kind'],
    locator: JSON.parse(String(r.locator_json)),
    endLocator: r.end_locator_json ? JSON.parse(String(r.end_locator_json)) : null,
    color: (r.color as string) ?? null,
    selectedText: (r.selected_text as string) ?? null,
    note: (r.note as string) ?? null,
    createdAt: String(r.created_at),
  };
}

export function registerAnnotationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /**
   * Everything this reader has marked, across every book.
   *
   * Separate from the per-book list because it answers a different question:
   * not "what did I mark in this book" but "where was that thing I wrote
   * down". So it carries enough of the book with it to be readable on its own,
   * and it is ordered newest first — the note you are looking for is almost
   * always a recent one.
   */
  app.get('/api/annotations', async (req) => {
    const q = (req.query ?? {}) as { q?: string; kind?: string };
    const term = typeof q.q === 'string' ? q.q.trim().slice(0, 200) : '';
    const kind = ['highlight', 'note', 'bookmark'].includes(String(q.kind)) ? String(q.kind) : null;
    const rows = db
      .prepare(
        `SELECT a.*, b.title AS book_title, b.author AS book_author, b.kind AS book_kind
           FROM annotations a JOIN books b ON b.id = a.book_id
          WHERE a.user_id = ? AND a.deleted_at IS NULL
            AND (? IS NULL OR a.kind = ?)
            AND (? = '' OR a.note LIKE '%' || ? || '%' OR a.selected_text LIKE '%' || ? || '%'
                 OR b.title LIKE '%' || ? || '%')
          ORDER BY a.created_at DESC
          LIMIT 500`,
      )
      .all(req.user!.id, kind, kind, term, term, term, term) as Record<string, unknown>[];
    return {
      annotations: rows.map((r) => ({
        ...rowToAnnotation(r),
        bookTitle: String(r.book_title ?? ''),
        bookAuthor: (r.book_author as string) ?? null,
      })),
    };
  });

  app.get('/api/books/:id/annotations', async (req) => {
    const { id } = req.params as { id: string };
    const rows = db
      .prepare(
        'SELECT * FROM annotations WHERE user_id = ? AND book_id = ? AND deleted_at IS NULL ORDER BY created_at',
      )
      .all(req.user!.id, id) as Record<string, unknown>[];
    return { annotations: rows.map(rowToAnnotation) };
  });

  app.post('/api/books/:id/annotations', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const parsed = createAnnotationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const a = parsed.data;
    const annId = newId('ann');
    db.prepare(
      `INSERT INTO annotations (id, user_id, book_id, kind, locator_json, end_locator_json, color, selected_text, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      annId,
      req.user!.id,
      id,
      a.kind,
      JSON.stringify(a.locator),
      a.endLocator ? JSON.stringify(a.endLocator) : null,
      a.color ?? null,
      a.selectedText ?? null,
      a.note ?? null,
      nowIso(),
      nowIso(),
    );
    const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(annId) as Record<
      string,
      unknown
    >;
    return { annotation: rowToAnnotation(row) };
  });

  app.patch('/api/annotations/:annId', async (req, reply) => {
    const { annId } = req.params as { annId: string };
    const body = (req.body ?? {}) as { note?: string; color?: string };
    const existing = db
      .prepare('SELECT * FROM annotations WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(annId, req.user!.id) as Record<string, unknown> | undefined;
    if (!existing) return reply.code(404).send({ error: 'not-found' });
    if (typeof body.note === 'string' && body.note.length <= 10000) {
      db.prepare('UPDATE annotations SET note = ?, updated_at = ? WHERE id = ?').run(
        body.note,
        nowIso(),
        annId,
      );
    }
    if (typeof body.color === 'string' && /^[a-z]{1,20}$/.test(body.color)) {
      db.prepare('UPDATE annotations SET color = ?, updated_at = ? WHERE id = ?').run(
        body.color,
        nowIso(),
        annId,
      );
    }
    const row = db.prepare('SELECT * FROM annotations WHERE id = ?').get(annId) as Record<
      string,
      unknown
    >;
    return { annotation: rowToAnnotation(row) };
  });

  app.delete('/api/annotations/:annId', async (req, reply) => {
    const { annId } = req.params as { annId: string };
    const res = db
      .prepare(
        'UPDATE annotations SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .run(nowIso(), annId, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });
}
