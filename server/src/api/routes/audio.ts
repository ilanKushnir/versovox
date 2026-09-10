import fs from 'node:fs';
import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../../context.js';
import { trackSourceVersion } from '../../audio/integrity.js';
import { realResolveWithin } from '../../util/paths.js';

const AUDIO_TYPES: Record<string, string> = {
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};

/** Range-capable audio streaming straight from the read-only library mount. */
export function registerAudioRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/books/:id/track/:idx', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0) return reply.code(400).send({ error: 'bad-track' });
    const book = db.prepare("SELECT * FROM books WHERE id = ? AND kind = 'audio'").get(id) as
      Record<string, unknown> | undefined;
    if (!book) return reply.code(404).send({ error: 'not-found' });
    const track = db
      .prepare('SELECT * FROM audio_tracks WHERE book_id = ? AND idx = ?')
      .get(id, n) as Record<string, unknown> | undefined;
    if (!track) return reply.code(404).send({ error: 'no-track' });

    let abs: string;
    try {
      abs = realResolveWithin(String(book.root_dir), String(track.rel_path));
    } catch {
      return reply.code(404).send({ error: 'not-found' });
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return reply.code(404).send({ error: 'file-missing' });
    }
    const type = AUDIO_TYPES[String(track.format)] ?? 'application/octet-stream';
    reply.header('content-type', type);
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, max-age=86400');
    // Immutable source identity: matches the offline manifest's
    // sourceVersion, so a downloader can detect a mid-download replacement.
    reply.header('etag', `"${trackSourceVersion(stat, String(track.rel_path))}"`);

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).header('content-range', `bytes */${stat.size}`).send();
      let start = m[1] ? parseInt(m[1], 10) : NaN;
      let end = m[2] ? parseInt(m[2], 10) : NaN;
      if (Number.isNaN(start)) {
        // suffix range: last N bytes
        const suffix = Number.isNaN(end) ? 0 : end;
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else if (Number.isNaN(end)) {
        end = stat.size - 1;
      }
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) {
        return reply.code(416).header('content-range', `bytes */${stat.size}`).send();
      }
      reply.code(206);
      reply.header('content-range', `bytes ${start}-${end}/${stat.size}`);
      reply.header('content-length', end - start + 1);
      return reply.send(fs.createReadStream(abs, { start, end }));
    }
    reply.header('content-length', stat.size);
    return reply.send(fs.createReadStream(abs));
  });
}
