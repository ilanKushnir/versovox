import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addToReadingListSchema,
  addToShelfSchema,
  bulkAddSchema,
  createShelfSchema,
  movePositionSchema,
  readingListNoteSchema,
  updateShelfSchema,
  RECENTLY_ADDED_DAYS,
  RECENTLY_ADDED_LIMIT,
  SHELVES_PER_USER_MAX,
  type ReadingListItem,
  type ShelfSummary,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import { type DB } from '../../db/index.js';
import { nowIso } from '../../db/index.js';
import { newId } from '../../util/ids.js';
import { between } from '../../util/rank.js';
import { bookRowToSummary } from './library.js';

/**
 * Shelves and the reading list: the furniture each reader arranges for
 * themselves.
 *
 * No route here calls requireRole. Every /api/* path is already behind
 * requireUser + csrfCheck in the global onRequest hook, and these are
 * reader-level by nature — an admin's extra powers are about the library, not
 * about somebody else's shelves. The guard is OWNERSHIP, and it is
 * structural: every statement is scoped `WHERE user_id = ?`, and every shelf
 * sub-resource resolves through ownedShelf(). No route ever selects a shelf
 * by id alone. A miss answers 404 rather than 403, because a 403 would
 * confirm that another person's shelf id exists.
 */

interface ShelfRow {
  id: string;
  user_id: string;
  name: string;
  sort_key: string;
  created_at: string;
  updated_at: string;
}

function shelfRowToSummary(db: DB, row: ShelfRow): ShelfSummary {
  const c = db.prepare('SELECT COUNT(*) AS c FROM shelf_items WHERE shelf_id = ?').get(row.id) as {
    c: number;
  };
  return {
    id: row.id,
    name: row.name,
    count: Number(c.c),
    sortKey: row.sort_key,
    updatedAt: row.updated_at,
  };
}

export function registerShelfRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  /** The only way a shelf is ever fetched: by id AND owner, together. */
  const ownedShelf = (userId: string, shelfId: string): ShelfRow | undefined =>
    db.prepare('SELECT * FROM shelves WHERE id = ? AND user_id = ?').get(shelfId, userId) as
      ShelfRow | undefined;

  const bookExists = (bookId: string): boolean =>
    db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId) !== undefined;

  /**
   * Neighbour keys for a drop. Reads the key of the row the item now follows
   * and the key of whatever follows THAT, then mints one key between them.
   * `afterId` null means the item goes first.
   *
   * ORDER BY sort_key is BINARY throughout this file — the rank alphabet is
   * case-significant and a NOCASE comparison would make the order
   * non-deterministic.
   */
  function moveWithin(opts: {
    /** `SELECT <idColumn>, sort_key FROM …` for one list, ordered. */
    rows: { id: string; sort_key: string }[];
    afterId: string | null;
    /** The row being moved: it is not its own neighbour. */
    movingId: string;
  }): { ok: true; key: string } | { ok: false; error: 'stale-order' } {
    const others = opts.rows.filter((r) => r.id !== opts.movingId);
    if (opts.afterId === null) {
      return { ok: true, key: between(null, others[0]?.sort_key ?? null) };
    }
    const idx = others.findIndex((r) => r.id === opts.afterId);
    // The neighbour the client named is gone, or is the row itself: the
    // client's picture of the list is stale. It refetches and re-applies.
    if (idx < 0) return { ok: false, error: 'stale-order' };
    return { ok: true, key: between(others[idx]!.sort_key, others[idx + 1]?.sort_key ?? null) };
  }

  const shelfItemRows = (shelfId: string) =>
    db
      .prepare(
        'SELECT book_id AS id, sort_key FROM shelf_items WHERE shelf_id = ? ORDER BY sort_key',
      )
      .all(shelfId) as { id: string; sort_key: string }[];

  const readingListRows = (userId: string) =>
    db
      .prepare(
        'SELECT book_id AS id, sort_key FROM reading_list WHERE user_id = ? ORDER BY sort_key',
      )
      .all(userId) as { id: string; sort_key: string }[];

  /**
   * Ranking uses every row — a book on an unplugged drive still holds its
   * place in the queue — but a POSITION quoted back to the reader has to
   * count what the reading list page actually shows them, or the book page
   * says "3rd" above a list where the book is second.
   */
  const visibleReadingList = (userId: string): string[] =>
    (
      db
        .prepare(
          `SELECT r.book_id AS id FROM reading_list r JOIN books b ON b.id = r.book_id
           WHERE r.user_id = ? AND b.scan_state != 'missing' ORDER BY r.sort_key`,
        )
        .all(userId) as { id: string }[]
    ).map((r) => r.id);

  /** 1-based place in the list the reader can see, or null if it is not in it. */
  const visiblePosition = (userId: string, bookId: string): number | null => {
    const at = visibleReadingList(userId).indexOf(bookId);
    return at < 0 ? null : at + 1;
  };

  const shelfCount = (shelfId: string): number =>
    Number(
      (
        db.prepare('SELECT COUNT(*) AS c FROM shelf_items WHERE shelf_id = ?').get(shelfId) as {
          c: number;
        }
      ).c,
    );

  /* ------------------------------------------------------------ overview */

  /**
   * The whole sidebar in one request, because the sidebar is on every page.
   * Counts are COUNT(*) queries, never materialised book lists.
   */
  app.get('/api/shelves', async (req) => {
    const userId = req.user!.id;
    const one = (sql: string, ...params: unknown[]): number =>
      Number((db.prepare(sql).get(...(params as never[])) as { c: number }).c);

    const readingNow = one(
      `SELECT COUNT(*) AS c FROM progress_state p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND p.finished = 0 AND b.scan_state != 'missing'
         AND json_extract(p.locator_json, '$.pct') > 0.001`,
      userId,
    );
    const finished = one(
      `SELECT COUNT(*) AS c FROM progress_state p JOIN books b ON b.id = p.book_id
       WHERE p.user_id = ? AND p.finished = 1 AND b.scan_state != 'missing'`,
      userId,
    );
    // One count per PAIR, not per book: a title owned twice is one title.
    const bothFormats = one(
      `SELECT COUNT(*) AS c FROM pairs p
       JOIN books e ON e.id = p.ebook_id JOIN books a ON a.id = p.audio_id
       WHERE p.status IN ('auto','confirmed')
         AND (e.scan_state != 'missing' OR a.scan_state != 'missing')`,
    );
    const recentlyAdded = one(
      `SELECT COUNT(*) AS c FROM (
         SELECT id FROM books WHERE scan_state != 'missing' AND added_at >= ?
         ORDER BY added_at DESC LIMIT ?
       )`,
      new Date(Date.now() - RECENTLY_ADDED_DAYS * 86400000).toISOString(),
      RECENTLY_ADDED_LIMIT,
    );

    const shelves = (
      db
        .prepare('SELECT * FROM shelves WHERE user_id = ? ORDER BY sort_key')
        .all(userId) as unknown as ShelfRow[]
    ).map((r) => shelfRowToSummary(db, r));

    const queueCount = one('SELECT COUNT(*) AS c FROM reading_list WHERE user_id = ?', userId);
    const next = db
      .prepare(
        `SELECT b.id, b.title FROM reading_list r JOIN books b ON b.id = r.book_id
         WHERE r.user_id = ? AND b.scan_state != 'missing' ORDER BY r.sort_key LIMIT 1`,
      )
      .get(userId) as { id: string; title: string } | undefined;

    return {
      auto: [
        { id: 'reading-now', count: readingNow },
        { id: 'finished', count: finished },
        { id: 'both-formats', count: bothFormats },
        { id: 'recently-added', count: recentlyAdded },
      ],
      shelves,
      readingList: {
        count: queueCount,
        nextBookId: next?.id ?? null,
        nextTitle: next?.title ?? null,
      },
    };
  });

  /* -------------------------------------------------------------- shelves */

  app.post('/api/shelves', async (req, reply) => {
    const parsed = createShelfSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const userId = req.user!.id;
    const existing = db
      .prepare('SELECT COUNT(*) AS c FROM shelves WHERE user_id = ?')
      .get(userId) as { c: number };
    if (Number(existing.c) >= SHELVES_PER_USER_MAX) {
      return reply.code(409).send({ error: 'too-many-shelves' });
    }
    const last = db
      .prepare('SELECT sort_key FROM shelves WHERE user_id = ? ORDER BY sort_key DESC LIMIT 1')
      .get(userId) as { sort_key: string } | undefined;
    const id = newId('shelf');
    const now = nowIso();
    try {
      db.prepare(
        `INSERT INTO shelves (id, user_id, name, sort_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, parsed.data.name, between(last?.sort_key ?? null, null), now, now);
    } catch (err) {
      if (String((err as Error).message).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'shelf-name-taken' });
      }
      throw err;
    }
    return reply.code(201).send({ shelf: shelfRowToSummary(db, ownedShelf(userId, id)!) });
  });

  app.patch('/api/shelves/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = updateShelfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const { name, afterShelfId } = parsed.data;
    if (name !== undefined) {
      try {
        db.prepare('UPDATE shelves SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
          name,
          nowIso(),
          id,
          userId,
        );
      } catch (err) {
        if (String((err as Error).message).includes('UNIQUE')) {
          return reply.code(409).send({ error: 'shelf-name-taken' });
        }
        throw err;
      }
    }
    // An ABSENT afterShelfId means "do not move"; an explicit null means
    // "make it first". Only `!== undefined` can tell those apart.
    if (afterShelfId !== undefined) {
      const rows = db
        .prepare('SELECT id, sort_key FROM shelves WHERE user_id = ? ORDER BY sort_key')
        .all(userId) as { id: string; sort_key: string }[];
      const moved = moveWithin({ rows, afterId: afterShelfId, movingId: id });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      db.prepare(
        'UPDATE shelves SET sort_key = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      ).run(moved.key, nowIso(), id, userId);
    }
    return { shelf: shelfRowToSummary(db, ownedShelf(userId, id)!) };
  });

  app.delete('/api/shelves/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Membership rows go with it through the foreign key; no book and no
    // file on disk is touched.
    const res = db
      .prepare('DELETE FROM shelves WHERE id = ? AND user_id = ?')
      .run(id, req.user!.id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  const shelfBooksQuerySchema = z.object({
    sort: z.enum(['manual', 'title', 'author', 'added']).optional(),
  });

  app.get('/api/shelves/:id/books', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsedQuery = shelfBooksQuerySchema.safeParse(req.query ?? {});
    if (!parsedQuery.success) return reply.code(400).send({ error: 'bad-query' });

    // sort_key ordering is BINARY: the rank alphabet is case-significant.
    const rows = db
      .prepare(
        `SELECT b.*, s.sort_key AS shelf_sort_key FROM shelf_items s JOIN books b ON b.id = s.book_id
         WHERE s.shelf_id = ? ORDER BY s.sort_key`,
      )
      .all(id) as Record<string, unknown>[];
    // A book on an unmounted drive is still on the shelf. Counting it
    // separately lets the page say so instead of quietly shrinking.
    const present = rows.filter((r) => String(r.scan_state) !== 'missing');
    const books = present.map((r) => bookRowToSummary(ctx, userId, r));
    switch (parsedQuery.data.sort) {
      case 'title':
        books.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'author':
        books.sort((a, b) => (a.author ?? '￿').localeCompare(b.author ?? '￿'));
        break;
      case 'added':
        books.sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
        break;
      default:
        break; // manual: the shelf's own order, from SQL
    }
    return {
      shelf: shelfRowToSummary(db, shelf),
      books,
      missingCount: rows.length - present.length,
    };
  });

  /** Idempotent add. A second tap is a no-op, which is why this is a PUT. */
  app.put('/api/shelves/:id/books/:bookId', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    if (!bookExists(bookId)) return reply.code(404).send({ error: 'not-found' });
    const parsed = addToShelfSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });

    const already = db
      .prepare('SELECT 1 FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
      .get(id, bookId);
    if (already) return { added: false, count: shelfCount(id) };

    const rows = shelfItemRows(id);
    let key: string;
    if (parsed.data.afterBookId === undefined) {
      key = between(rows[rows.length - 1]?.sort_key ?? null, null);
    } else {
      const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      key = moved.key;
    }
    db.prepare(
      'INSERT INTO shelf_items (shelf_id, book_id, sort_key, added_at) VALUES (?, ?, ?, ?)',
    ).run(id, bookId, key, nowIso());
    db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return { added: true, count: shelfCount(id) };
  });

  /** Bulk add, for "everything in this filtered view onto Summer". */
  app.post('/api/shelves/:id/books', async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const shelf = ownedShelf(userId, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = bulkAddSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    let added = 0;
    let skipped = 0;
    const insert = db.prepare(
      'INSERT INTO shelf_items (shelf_id, book_id, sort_key, added_at) VALUES (?, ?, ?, ?)',
    );
    const now = nowIso();
    db.exec('BEGIN IMMEDIATE');
    try {
      let last =
        (
          db
            .prepare(
              'SELECT sort_key FROM shelf_items WHERE shelf_id = ? ORDER BY sort_key DESC LIMIT 1',
            )
            .get(id) as { sort_key: string } | undefined
        )?.sort_key ?? null;
      for (const bookId of parsed.data.bookIds) {
        const exists = bookExists(bookId);
        const dup = db
          .prepare('SELECT 1 FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
          .get(id, bookId);
        if (!exists || dup) {
          skipped++;
          continue;
        }
        last = between(last, null);
        insert.run(id, bookId, last, now);
        added++;
      }
      db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(now, id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { added, skipped };
  });

  app.delete('/api/shelves/:id/books/:bookId', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const shelf = ownedShelf(req.user!.id, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const res = db
      .prepare('DELETE FROM shelf_items WHERE shelf_id = ? AND book_id = ?')
      .run(id, bookId);
    if (Number(res.changes) > 0) {
      db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    }
    return { removed: Number(res.changes) > 0, count: shelfCount(id) };
  });

  app.patch('/api/shelves/:id/books/:bookId/position', async (req, reply) => {
    const { id, bookId } = req.params as { id: string; bookId: string };
    const shelf = ownedShelf(req.user!.id, id);
    if (!shelf) return reply.code(404).send({ error: 'not-found' });
    const parsed = movePositionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const rows = shelfItemRows(id);
    if (!rows.some((r) => r.id === bookId)) return reply.code(404).send({ error: 'not-found' });
    const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
    if (!moved.ok) return reply.code(409).send({ error: moved.error });
    db.prepare('UPDATE shelf_items SET sort_key = ? WHERE shelf_id = ? AND book_id = ?').run(
      moved.key,
      id,
      bookId,
    );
    db.prepare('UPDATE shelves SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    return { ok: true, sortKey: moved.key };
  });

  /* --------------------------------------------------------- reading list */

  app.get('/api/reading-list', async (req) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT b.*, r.note AS rl_note, r.added_at AS rl_added_at, r.sort_key AS rl_sort_key
         FROM reading_list r JOIN books b ON b.id = r.book_id
         WHERE r.user_id = ? ORDER BY r.sort_key`,
      )
      .all(userId) as Record<string, unknown>[];
    const present = rows.filter((r) => String(r.scan_state) !== 'missing');
    const items: ReadingListItem[] = present.map((r) => ({
      book: bookRowToSummary(ctx, userId, r),
      note: (r.rl_note as string) ?? null,
      addedAt: String(r.rl_added_at),
      sortKey: String(r.rl_sort_key),
    }));
    return { items, missingCount: rows.length - present.length };
  });

  app.put('/api/reading-list/:bookId', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const userId = req.user!.id;
    if (!bookExists(bookId)) return reply.code(404).send({ error: 'not-found' });
    const parsed = addToReadingListSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const rows = readingListRows(userId);
    const existing = rows.findIndex((r) => r.id === bookId);
    // A placement was ASKED FOR: `position` or `afterBookId` was sent. An
    // empty body means "just queue it", and for a book already queued that is
    // rightly a no-op.
    const placement = parsed.data.afterBookId !== undefined || parsed.data.position !== undefined;

    if (existing >= 0 && !placement) {
      if (parsed.data.note !== undefined) {
        db.prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?').run(
          parsed.data.note,
          userId,
          bookId,
        );
      }
      return {
        added: false,
        moved: false,
        position: visiblePosition(userId, bookId),
        count: rows.length,
      };
    }

    // Read next on a book that is already 7th has to MOVE it to the front.
    // Reporting "it is 7th" while the button said "front of the queue" is the
    // button lying, and the reader has no way to see which one is true
    // without opening the list.
    let key: string;
    if (parsed.data.afterBookId !== undefined) {
      const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
      if (!moved.ok) return reply.code(409).send({ error: moved.error });
      key = moved.key;
    } else {
      const others = rows.filter((r) => r.id !== bookId);
      key =
        parsed.data.position === 'top'
          ? between(null, others[0]?.sort_key ?? null)
          : between(others[others.length - 1]?.sort_key ?? null, null);
    }
    if (existing >= 0) {
      db.prepare('UPDATE reading_list SET sort_key = ? WHERE user_id = ? AND book_id = ?').run(
        key,
        userId,
        bookId,
      );
      if (parsed.data.note !== undefined) {
        db.prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?').run(
          parsed.data.note,
          userId,
          bookId,
        );
      }
    } else {
      db.prepare(
        'INSERT INTO reading_list (user_id, book_id, sort_key, note, added_at) VALUES (?, ?, ?, ?, ?)',
      ).run(userId, bookId, key, parsed.data.note ?? null, nowIso());
    }
    return {
      added: existing < 0,
      moved: existing >= 0,
      position: visiblePosition(userId, bookId),
      count: readingListRows(userId).length,
    };
  });

  app.delete('/api/reading-list/:bookId', async (req) => {
    const { bookId } = req.params as { bookId: string };
    const res = db
      .prepare('DELETE FROM reading_list WHERE user_id = ? AND book_id = ?')
      .run(req.user!.id, bookId);
    return { removed: Number(res.changes) > 0 };
  });

  app.patch('/api/reading-list/:bookId/position', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const userId = req.user!.id;
    const parsed = movePositionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    const rows = readingListRows(userId);
    if (!rows.some((r) => r.id === bookId)) return reply.code(404).send({ error: 'not-found' });
    const moved = moveWithin({ rows, afterId: parsed.data.afterBookId, movingId: bookId });
    if (!moved.ok) return reply.code(409).send({ error: moved.error });
    db.prepare('UPDATE reading_list SET sort_key = ? WHERE user_id = ? AND book_id = ?').run(
      moved.key,
      userId,
      bookId,
    );
    return { ok: true, sortKey: moved.key };
  });

  /**
   * The queue has notes and a shelf does not: "after the sequel" and "book
   * club, November" are things you write about a POSITION, not about a book.
   */
  app.patch('/api/reading-list/:bookId', async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const parsed = readingListNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const res = db
      .prepare('UPDATE reading_list SET note = ? WHERE user_id = ? AND book_id = ?')
      .run(parsed.data.note, req.user!.id, bookId);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: 'not-found' });
    return { ok: true };
  });

  /* ---------------------------------------------------------- memberships */

  /** Two indexed lookups, so the book page can open its Add-to panel pre-ticked. */
  app.get('/api/books/:id/shelves', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!bookExists(id)) return reply.code(404).send({ error: 'not-found' });
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT s.id FROM shelf_items i JOIN shelves s ON s.id = i.shelf_id
         WHERE i.book_id = ? AND s.user_id = ?`,
      )
      .all(id, userId) as { id: string }[];
    const queued = db
      .prepare('SELECT 1 FROM reading_list WHERE user_id = ? AND book_id = ?')
      .get(userId, id);
    // Where in the queue, so the book page can say "3rd" rather than merely
    // "queued" — and it must be the third row of the list the reader can
    // open, so books on an unmounted drive are not counted past.
    const position = queued ? visiblePosition(userId, id) : null;
    return {
      shelfIds: rows.map((r) => r.id),
      onReadingList: queued !== undefined,
      readingListPosition: position,
    };
  });
}
