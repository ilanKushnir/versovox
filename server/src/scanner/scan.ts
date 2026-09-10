import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type DB, nowIso } from '../db/index.js';
import { stableId } from '../util/ids.js';

/**
 * Read-only filesystem scan of configured library roots. Discovers EPUBs and
 * audiobooks (single files or one-directory-per-book track sets), upserts
 * book rows, and reports which books need (re)indexing. Never writes inside
 * a library root.
 */

export const EBOOK_EXTS = new Set(['.epub']);
export const AUDIO_EXTS = new Set(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus']);
/** Detected but honestly unsupported for reading in V1. */
export const KNOWN_UNSUPPORTED_EBOOK = new Set(['.pdf', '.mobi', '.azw3', '.azw', '.cbz', '.cbr']);

const MAX_DEPTH = 8;
const MAX_FILES = 100_000;

export interface DiscoveredEbook {
  rootDir: string;
  relPath: string;
  sizeBytes: number;
  contentHash: string;
}

export interface DiscoveredAudioBook {
  rootDir: string;
  /** rel path of the directory (multi-file) or the file itself. */
  relPath: string;
  tracks: { relPath: string; sizeBytes: number; ext: string }[];
  sizeBytes: number;
  contentHash: string;
}

export interface ScanReport {
  ebooks: DiscoveredEbook[];
  audiobooks: DiscoveredAudioBook[];
  unsupported: { relPath: string; ext: string }[];
  errors: string[];
}

function quickHash(filePath: string, stat: fs.Stats): string {
  // Cheap change-detection hash: size + mtime + head/tail bytes. Not a
  // cryptographic identity of content; used to decide when to re-index.
  const h = createHash('sha256');
  h.update(`${stat.size}:${Math.floor(stat.mtimeMs)}`);
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(Math.min(65536, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    h.update(head);
    if (stat.size > 65536) {
      const tail = Buffer.alloc(65536);
      fs.readSync(fd, tail, 0, tail.length, stat.size - 65536);
      h.update(tail);
    }
    fs.closeSync(fd);
  } catch {
    /* hash stays size+mtime based */
  }
  return h.digest('hex').slice(0, 32);
}

/** Natural sort so "Track 2" < "Track 10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

export function scanRoots(ebookRoots: string[], audioRoots: string[]): ScanReport {
  const report: ScanReport = { ebooks: [], audiobooks: [], unsupported: [], errors: [] };
  let fileCount = 0;

  const walk = (
    root: string,
    dir: string,
    depth: number,
    onFile: (abs: string, rel: string, ext: string, stat: fs.Stats) => void,
  ) => {
    if (depth > MAX_DEPTH || fileCount > MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      report.errors.push(`Cannot read ${dir}: ${(err as Error).message}`);
      return;
    }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Follow only symlinks that resolve inside the root.
        try {
          const real = fs.realpathSync(abs);
          const rootReal = fs.realpathSync(root);
          if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
        } catch {
          continue;
        }
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(root, abs, depth + 1, onFile);
      } else if (stat.isFile()) {
        fileCount += 1;
        const ext = path.extname(e.name).toLowerCase();
        onFile(abs, path.relative(root, abs), ext, stat);
      }
    }
  };

  for (const root of ebookRoots) {
    if (!fs.existsSync(root)) {
      report.errors.push(`Ebook root does not exist: ${root}`);
      continue;
    }
    walk(root, root, 0, (abs, rel, ext, stat) => {
      if (EBOOK_EXTS.has(ext)) {
        report.ebooks.push({
          rootDir: root,
          relPath: rel,
          sizeBytes: stat.size,
          contentHash: quickHash(abs, stat),
        });
      } else if (KNOWN_UNSUPPORTED_EBOOK.has(ext)) {
        report.unsupported.push({ relPath: rel, ext });
      }
    });
  }

  for (const root of audioRoots) {
    if (!fs.existsSync(root)) {
      report.errors.push(`Audiobook root does not exist: ${root}`);
      continue;
    }
    const byDir = new Map<
      string,
      { relPath: string; sizeBytes: number; ext: string; abs: string; stat: fs.Stats }[]
    >();
    walk(root, root, 0, (abs, rel, ext, stat) => {
      if (!AUDIO_EXTS.has(ext)) return;
      const dir = path.dirname(rel);
      const list = byDir.get(dir) ?? [];
      list.push({ relPath: rel, sizeBytes: stat.size, ext, abs, stat });
      byDir.set(dir, list);
    });
    for (const [dir, files] of byDir) {
      files.sort((a, b) => naturalCompare(a.relPath, b.relPath));
      if (dir === '.') {
        // Loose files at the root: each is its own book.
        for (const f of files) {
          report.audiobooks.push({
            rootDir: root,
            relPath: f.relPath,
            tracks: [{ relPath: f.relPath, sizeBytes: f.sizeBytes, ext: f.ext }],
            sizeBytes: f.sizeBytes,
            contentHash: quickHash(f.abs, f.stat),
          });
        }
      } else {
        const h = createHash('sha256');
        let size = 0;
        for (const f of files) {
          h.update(quickHash(f.abs, f.stat));
          size += f.sizeBytes;
        }
        report.audiobooks.push({
          rootDir: root,
          relPath: dir,
          tracks: files.map((f) => ({ relPath: f.relPath, sizeBytes: f.sizeBytes, ext: f.ext })),
          sizeBytes: size,
          contentHash: h.digest('hex').slice(0, 32),
        });
      }
    }
  }
  return report;
}

export interface UpsertResult {
  /** Book ids that are new or whose content changed and need indexing. */
  needsIndex: { bookId: string; kind: 'ebook' | 'audio' }[];
  discovered: number;
  missing: number;
}

/** Apply a scan report to the database. */
export function applyScan(db: DB, report: ScanReport): UpsertResult {
  const needsIndex: UpsertResult['needsIndex'] = [];
  const seenIds = new Set<string>();
  const now = nowIso();

  const upsert = db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, content_hash, scan_state, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?)
     ON CONFLICT(kind, root_dir, rel_path) DO UPDATE SET size_bytes = excluded.size_bytes`,
  );
  const getExisting = db.prepare(
    'SELECT id, content_hash, scan_state FROM books WHERE kind = ? AND root_dir = ? AND rel_path = ?',
  );

  for (const e of report.ebooks) {
    const id = stableId('ebook', e.rootDir, e.relPath);
    seenIds.add(id);
    const existing = getExisting.get('ebook', e.rootDir, e.relPath) as
      { id: string; content_hash: string | null; scan_state: string } | undefined;
    if (!existing) {
      upsert.run(
        id,
        'ebook',
        e.rootDir,
        e.relPath,
        'epub',
        path.basename(e.relPath, '.epub'),
        e.sizeBytes,
        e.contentHash,
        now,
      );
      needsIndex.push({ bookId: id, kind: 'ebook' });
    } else if (
      existing.content_hash !== e.contentHash ||
      existing.scan_state === 'error' ||
      existing.scan_state === 'missing' ||
      existing.scan_state === 'discovered'
    ) {
      db.prepare(
        'UPDATE books SET content_hash = ?, size_bytes = ?, scan_state = ? WHERE id = ?',
      ).run(
        e.contentHash,
        e.sizeBytes,
        existing.scan_state === 'missing'
          ? 'discovered'
          : existing.scan_state === 'ready'
            ? 'discovered'
            : existing.scan_state,
        existing.id,
      );
      needsIndex.push({ bookId: existing.id, kind: 'ebook' });
    }
  }

  for (const a of report.audiobooks) {
    const id = stableId('audio', a.rootDir, a.relPath);
    seenIds.add(id);
    const format = a.tracks.length === 1 ? a.tracks[0]!.ext.slice(1) : 'multi';
    const existing = getExisting.get('audio', a.rootDir, a.relPath) as
      { id: string; content_hash: string | null; scan_state: string } | undefined;
    if (!existing) {
      upsert.run(
        id,
        'audio',
        a.rootDir,
        a.relPath,
        format,
        path.basename(a.relPath).replace(/\.[^.]+$/, ''),
        a.sizeBytes,
        a.contentHash,
        now,
      );
      insertTracks(db, id, a);
      needsIndex.push({ bookId: id, kind: 'audio' });
    } else if (
      existing.content_hash !== a.contentHash ||
      ['error', 'missing', 'discovered'].includes(existing.scan_state)
    ) {
      db.prepare(
        'UPDATE books SET content_hash = ?, size_bytes = ?, scan_state = ? WHERE id = ?',
      ).run(a.contentHash, a.sizeBytes, 'discovered', existing.id);
      insertTracks(db, existing.id, a);
      needsIndex.push({ bookId: existing.id, kind: 'audio' });
    }
  }

  // Mark books whose files disappeared.
  const all = db.prepare("SELECT id FROM books WHERE scan_state != 'missing'").all() as {
    id: string;
  }[];
  let missing = 0;
  for (const row of all) {
    if (!seenIds.has(row.id)) {
      db.prepare("UPDATE books SET scan_state = 'missing' WHERE id = ?").run(row.id);
      missing += 1;
    }
  }

  return { needsIndex, discovered: report.ebooks.length + report.audiobooks.length, missing };
}

function insertTracks(db: DB, bookId: string, a: DiscoveredAudioBook): void {
  db.prepare('DELETE FROM audio_tracks WHERE book_id = ?').run(bookId);
  const ins = db.prepare(
    'INSERT INTO audio_tracks (book_id, idx, rel_path, size_bytes, format) VALUES (?, ?, ?, ?, ?)',
  );
  a.tracks.forEach((t, idx) => ins.run(bookId, idx, t.relPath, t.sizeBytes, t.ext.slice(1)));
}
