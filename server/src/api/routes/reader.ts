import fs from 'node:fs';
import path from 'node:path';
import { type FastifyInstance } from 'fastify';
import { type AppContext, activeDerivedDir } from '../../context.js';
import { loadChapterText, loadManifest, loadSentences } from '../../epub/extract.js';
import { resolveWithin } from '../../util/paths.js';

/** Reader content routes: derived manifest, sanitized chapters, assets, search. */
export function registerReaderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  // Reading resolves the ACTIVE derived version (books.derived_rev), which a
  // re-index switches atomically — so a book that has ever been indexed
  // stays readable while it is being re-indexed and even when a later index
  // attempt failed ('indexing'/'error' states still resolve the last good
  // version; loadManifest simply returns null when none exists yet).
  const READABLE_STATES = new Set(['ready', 'indexing', 'error']);
  const requireEbook = (id: string): { dir: string } | null => {
    const row = db.prepare('SELECT id, kind, scan_state FROM books WHERE id = ?').get(id) as
      { id: string; kind: string; scan_state: string } | undefined;
    if (!row || row.kind !== 'ebook' || !READABLE_STATES.has(row.scan_state)) return null;
    return { dir: activeDerivedDir(ctx, id) };
  };

  app.get('/api/books/:id/manifest', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = requireEbook(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const manifest = loadManifest(book.dir);
    if (!manifest) return reply.code(409).send({ error: 'not-indexed' });
    return manifest;
  });

  app.get('/api/books/:id/chapter/:idx', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const book = requireEbook(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      return reply.code(400).send({ error: 'bad-chapter' });
    }
    const file = path.join(book.dir, `ch_${n}.html`);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'no-chapter' });
    reply.header('content-type', 'text/html; charset=utf-8');
    // Sanitized fragment that the reader fetches as text and injects into its
    // own DOM under the app CSP. If a browser is pointed at this URL
    // directly, `sandbox` gives the document an opaque origin (no cookies,
    // no same-origin DOM) and `default-src 'none'` blocks every load — so a
    // sanitizer bypass still has no script or exfiltration channel.
    reply.header('content-security-policy', "sandbox; default-src 'none'");
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(file));
  });

  app.get('/api/books/:id/sentences/:idx', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const book = requireEbook(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const all = loadSentences(book.dir);
    const n = Number(idx);
    if (!all || !Number.isInteger(n) || n < 0 || n >= all.length) {
      return reply.code(404).send({ error: 'no-chapter' });
    }
    reply.header('cache-control', 'private, max-age=3600');
    return { sentences: all[n] };
  });

  app.get('/api/books/:id/asset/*', async (req, reply) => {
    const { id } = req.params as { id: string };
    const book = requireEbook(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const rel = decodeURIComponent(wildcard);
    let abs: string;
    try {
      abs = resolveWithin(path.join(book.dir, 'assets'), rel);
    } catch {
      return reply.code(400).send({ error: 'bad-path' });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return reply.code(404).send({ error: 'no-asset' });
    }
    const ext = path.extname(abs).toLowerCase();
    const types: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    // Only images are copied into the derived asset dir; anything else 404s.
    const type = types[ext];
    if (!type) return reply.code(404).send({ error: 'no-asset' });
    reply.header('content-type', type);
    if (ext === '.svg') {
      // Defense in depth: SVGs can carry scripts; serve as attachment-safe.
      reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    }
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(abs));
  });

  app.get('/api/books/:id/search', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { q } = (req.query ?? {}) as { q?: string };
    const book = requireEbook(id);
    if (!book) return reply.code(404).send({ error: 'not-found' });
    if (!q || q.trim().length < 2 || q.length > 200) {
      return { matches: [] };
    }
    const manifest = loadManifest(book.dir);
    if (!manifest) return { matches: [] };
    const needle = q.trim().toLowerCase();
    const matches: {
      spineIdx: number;
      charOffset: number;
      excerpt: string;
      chapterTitle: string | null;
    }[] = [];
    for (const ch of manifest.chapters) {
      if (matches.length >= 100) break;
      const text = loadChapterText(book.dir, ch.idx);
      if (!text) continue;
      const hay = text.toLowerCase();
      let from = 0;
      while (matches.length < 100) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        const start = Math.max(0, at - 60);
        const end = Math.min(text.length, at + needle.length + 60);
        matches.push({
          spineIdx: ch.idx,
          charOffset: at,
          excerpt:
            (start > 0 ? '…' : '') +
            text.slice(start, end).replace(/\s+/g, ' ').trim() +
            (end < text.length ? '…' : ''),
          chapterTitle: ch.title,
        });
        from = at + needle.length;
      }
    }
    return { matches };
  });
}
