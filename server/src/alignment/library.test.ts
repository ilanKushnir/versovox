import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AppContext } from '../context.js';
import { loadConfig } from '../config.js';
import { nowIso, openMemoryDatabase } from '../db/index.js';
import { latestAlignment, storeAlignment } from './service.js';
import { exportAlignments, importAlignments, saveAlignmentFile } from './library.js';
import { listAlignmentFiles, readAlignmentFile, textFingerprint } from './portable.js';

/**
 * The round trip that this whole feature exists for: align on one machine,
 * throw the machine away, and have the next one recognise the work.
 *
 * These tests build a small library by hand rather than through the scanner,
 * because what is being checked is the identity logic — whether a file finds
 * its book again when the database is empty and the ids are different — and
 * the scanner would give both installs the same ids and prove nothing.
 */

let tmp: string;
let ctx: AppContext;

const SENTENCES = [
  [
    { id: 's-a1', ord: 0, start: 0, end: 30 },
    { id: 's-a2', ord: 1, start: 30, end: 70 },
  ],
  [
    { id: 's-b1', ord: 0, start: 0, end: 40 },
    { id: 's-b2', ord: 1, start: 40, end: 90 },
  ],
];

function makeContext(dirName: string): AppContext {
  const root = path.join(tmp, dirName);
  const config = loadConfig({
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    modelsDir: path.join(root, 'models'),
    alignmentDirs: [path.join(tmp, 'shared-alignments')],
    sessionSecret: 'library-test-secret-0123456789ab',
    logLevel: 'error',
  });
  return {
    db: openMemoryDatabase(),
    config,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

/**
 * A pair, its derived sentence index, and the fingerprints the indexing jobs
 * would have written. `idSuffix` lets a test build a second install whose
 * ebook ids differ — the case that proves matching is by content.
 */
function seedPair(
  c: AppContext,
  opts: { ebookId?: string; audioId?: string; pairId?: string; trackMs?: number[] } = {},
): { pairId: string; ebookId: string } {
  const ebookId = opts.ebookId ?? 'ebook-1';
  const audioId = opts.audioId ?? 'audio-1';
  const pairId = opts.pairId ?? 'pair-1';
  const trackMs = opts.trackMs ?? [600_000, 540_000];

  const derived = path.join(c.config.dataDir, 'derived', ebookId);
  fs.mkdirSync(derived, { recursive: true });
  fs.writeFileSync(path.join(derived, 'sentences.json'), JSON.stringify(SENTENCES));

  c.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, language,
                          size_bytes, scan_state, added_at, text_fingerprint, meta_json)
       VALUES (?, 'ebook', '/lib', 'a.epub', 'epub', 'The Lantern', 'A Writer', 'en',
               1234, 'ready', ?, ?, ?)`,
    )
    .run(
      ebookId,
      nowIso(),
      // What runIndexEpub computes: a hash of the sentence ids in reading order.
      textFingerprint(SENTENCES.flatMap((ch) => ch.map((sent) => sent.id))),
      JSON.stringify({ spineCount: SENTENCES.length }),
    );
  c.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, duration_ms,
                          size_bytes, scan_state, added_at)
       VALUES (?, 'audio', '/lib', 'a', 'm4b', 'The Lantern', 'A Narrator', ?, 99, 'ready', ?)`,
    )
    .run(
      audioId,
      trackMs.reduce((a, b) => a + b, 0),
      nowIso(),
    );
  trackMs.forEach((ms, i) => {
    c.db
      .prepare(
        `INSERT INTO audio_tracks (book_id, idx, rel_path, duration_ms, size_bytes, format, start_ms_absolute)
         VALUES (?, ?, ?, ?, 1, 'm4b', ?)`,
      )
      .run(
        audioId,
        i,
        `t${i}.m4b`,
        ms,
        trackMs.slice(0, i).reduce((a, b) => a + b, 0),
      );
  });
  c.db
    .prepare(
      `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at)
       VALUES (?, ?, ?, 'confirmed', 0.97, ?)`,
    )
    .run(pairId, ebookId, audioId, nowIso());
  return { pairId, ebookId };
}

function seedAlignment(c: AppContext, pairId: string): void {
  const segments = SENTENCES.flatMap((chapter, spineIdx) =>
    chapter.map((sent, i) => ({
      sentenceId: sent.id,
      spineIdx,
      sentenceOrd: sent.ord,
      startMs: (spineIdx * 2 + i) * 10_000,
      endMs: (spineIdx * 2 + i + 1) * 10_000,
      confidence: 0.9,
      source: 'exact' as const,
      uncertaintyMs: 2000,
    })),
  );
  storeAlignment(
    c.db,
    pairId,
    'en',
    'mms-fa/model_int8.onnx',
    {
      segments,
      gaps: [],
      coverage: 1,
      meanConfidence: 0.9,
    },
    { sentenceCount: segments.length },
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-alignlib-'));
  ctx = makeContext('first');
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('saving an alignment as a file', () => {
  it('writes one file, named after the book and readable on its own', () => {
    const { pairId } = seedPair(ctx);
    seedAlignment(ctx, pairId);

    const written = saveAlignmentFile(ctx, pairId);

    expect(written).not.toBeNull();
    expect(path.basename(written!)).toMatch(/^A Writer - The Lantern \[[0-9a-f]{12}\]\.rpalign$/);
    const read = readAlignmentFile(written!);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.doc.segmentCount).toBe(4);
    expect(read.doc.ebook.title).toBe('The Lantern');
  });

  it('says nothing and breaks nothing when the book has no fingerprint yet', () => {
    // A library indexed by an older version: the columns are NULL until the
    // book is re-indexed, and that must not turn into a failed alignment.
    const { pairId, ebookId } = seedPair(ctx);
    ctx.db.prepare('UPDATE books SET text_fingerprint = NULL WHERE id = ?').run(ebookId);
    seedAlignment(ctx, pairId);

    expect(saveAlignmentFile(ctx, pairId)).toBeNull();
  });

  it('leaves exactly one file behind when the book is retitled and saved again', () => {
    const { pairId, ebookId } = seedPair(ctx);
    seedAlignment(ctx, pairId);
    saveAlignmentFile(ctx, pairId);
    ctx.db.prepare('UPDATE books SET title = ? WHERE id = ?').run('The Lantern, Revised', ebookId);

    saveAlignmentFile(ctx, pairId);

    const files = listAlignmentFiles(path.join(tmp, 'shared-alignments'));
    expect(files).toHaveLength(1);
    expect(path.basename(files[0]!)).toContain('Revised');
  });
});

describe('importing on a fresh install', () => {
  it('recognises the book by its content, not by its ids or paths', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);

    // A second install of the same library: different book ids, different
    // pair id, same books. This is the redeploy the feature exists for.
    const second = makeContext('second');
    seedPair(second, { ebookId: 'other-e', audioId: 'other-a', pairId: 'other-p' });

    const out = importAlignments(second);

    expect(out.imported).toBe(1);
    expect(out.rejected).toEqual([]);
    const handle = latestAlignment(second.db, 'other-p');
    expect(handle).not.toBeNull();
    expect(handle!.summary.coverage).toBe(1);
    second.db.close();
  });

  it('records where an imported alignment came from, rather than implying it was computed here', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);
    const second = makeContext('second');
    seedPair(second, { ebookId: 'other-e', audioId: 'other-a', pairId: 'other-p' });

    importAlignments(second);

    const row = second.db
      .prepare('SELECT provenance_json FROM alignments WHERE pair_id = ?')
      .get('other-p') as { provenance_json: string };
    const prov = JSON.parse(row.provenance_json);
    expect(prov.importedFrom).toContain('.rpalign');
    expect(prov.importedAt).toBeTruthy();
    second.db.close();
  });

  it('does nothing when the pair already has an alignment of its own', () => {
    const { pairId } = seedPair(ctx);
    seedAlignment(ctx, pairId);
    saveAlignmentFile(ctx, pairId);

    // The redeploy that kept its data: the database is the newer truth and
    // must win, which is what makes running this after every scan safe.
    const out = importAlignments(ctx);

    expect(out.imported).toBe(0);
    expect(out.scanned).toBe(1);
  });

  it('leaves a file for a book that is not in this library alone, and does not call it broken', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);

    // Someone with two libraries sharing one alignment folder: this is the
    // normal state, not a fault, and must not be reported as one.
    const other = makeContext('other-library');

    const out = importAlignments(other);

    expect(out.imported).toBe(0);
    expect(out.unmatched).toBe(1);
    expect(out.rejected).toEqual([]);
    other.db.close();
  });

  it('refuses a file whose ebook has been re-converted since', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);

    // Re-running the book through Calibre changes its sentences, so the ids
    // the file references no longer exist. Importing the ones that survive
    // would leave a timeline full of silent holes.
    const second = makeContext('second');
    seedPair(second, { ebookId: 'other-e', audioId: 'other-a', pairId: 'other-p' });
    second.db
      .prepare('UPDATE books SET text_fingerprint = ? WHERE id = ?')
      .run('t1:0000000000000000000000000000000f', 'other-e');

    const out = importAlignments(second);

    expect(out.imported).toBe(0);
    expect(out.unmatched).toBe(1);
    second.db.close();
  });

  it('accepts an audiobook whose durations drifted by a few milliseconds', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);

    // A different ffprobe build reporting 600,040 ms where the last one said
    // 600,000. Nothing about the narration moved; the alignment is still true.
    const second = makeContext('second');
    seedPair(second, {
      ebookId: 'other-e',
      audioId: 'other-a',
      pairId: 'other-p',
      trackMs: [600_040, 540_000],
    });

    const out = importAlignments(second);

    expect(out.imported).toBe(1);
    second.db.close();
  });

  it('refuses an audiobook that was genuinely re-encoded', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    saveAlignmentFile(ctx, first.pairId);

    const second = makeContext('second');
    seedPair(second, {
      ebookId: 'other-e',
      audioId: 'other-a',
      pairId: 'other-p',
      trackMs: [612_000, 540_000],
    });

    const out = importAlignments(second);

    expect(out.imported).toBe(0);
    second.db.close();
  });

  it('refuses a file naming a sentence this install does not have', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    const file = saveAlignmentFile(ctx, first.pairId)!;

    // The fingerprint says the text matches, but one row points at a sentence
    // that is not in the index. That can only be a doctored or corrupted file,
    // and importing the rows that do resolve would leave a silent hole.
    const second = makeContext('second');
    seedPair(second, { ebookId: 'other-e', audioId: 'other-a', pairId: 'other-p' });
    const doc = readAlignmentFile(file);
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    doc.doc.segments.sentenceIds[1] = 's-nope';
    fs.writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(doc.doc), 'utf8')));

    const out = importAlignments(second);

    expect(out.imported).toBe(0);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toMatch(/ebook/i);
    second.db.close();
  });

  it('reports a damaged file in words, and imports the rest of the folder', () => {
    const first = seedPair(ctx);
    seedAlignment(ctx, first.pairId);
    const good = saveAlignmentFile(ctx, first.pairId)!;
    fs.writeFileSync(path.join(path.dirname(good), 'junk [aaaaaaaaaaaa].rpalign'), 'not gzip');

    const second = makeContext('second');
    seedPair(second, { ebookId: 'other-e', audioId: 'other-a', pairId: 'other-p' });
    const out = importAlignments(second);

    expect(out.imported).toBe(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toMatch(/truncated|readable/i);
    second.db.close();
  });
});

describe('exporting what is already here', () => {
  it('writes the alignments that have no file and skips the ones that do', () => {
    const { pairId } = seedPair(ctx);
    seedAlignment(ctx, pairId);

    const first = exportAlignments(ctx);
    const second = exportAlignments(ctx);

    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(1);
    expect(listAlignmentFiles(path.join(tmp, 'shared-alignments'))).toHaveLength(1);
  });
});
