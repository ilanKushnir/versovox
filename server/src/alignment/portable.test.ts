import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { type AlignmentSegment } from '@versovox/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALIGNMENT_FILE_EXT,
  alignmentFileName,
  buildAlignmentDocument,
  columnsToSegments,
  findAlignmentFile,
  listAlignmentFiles,
  pairKey,
  readAlignmentFile,
  segmentsToColumns,
  textFingerprint,
  timelineFingerprint,
  writeAlignmentFile,
  type PortableAlignment,
} from './portable.js';

/**
 * Tests for the portable alignment file: the only copy of an alignment that
 * survives a from-scratch redeploy.
 *
 * Two properties matter more than the rest. A file must round-trip exactly,
 * because what comes back is used as timing truth for a whole book. And a bad
 * file must come back as a rejection a self-hoster can act on, never as a
 * throw — these files live on a folder the user syncs, edits and backs up, so
 * "damaged" is a normal state of the world, not an exceptional one.
 */

const CHAPTERS = 3;
const PER_CHAPTER = 40;

/** Every sentence of a small three-chapter book, in reading order. */
function bookSentenceIds(): string[] {
  const ids: string[] = [];
  for (let spine = 0; spine < CHAPTERS; spine++) {
    for (let ord = 0; ord < PER_CHAPTER; ord++) ids.push(`s${spine}_${ord}`);
  }
  return ids;
}

/**
 * A realistic aligner result over that book: monotonic across chapter breaks,
 * a handful of sentences the aligner could not place, and interpolated
 * segments carrying real uncertainty. A round-trip that only ever sees clean
 * `exact` segments would not exercise the source enum or uncertaintyMs.
 */
function bookSegments(): AlignmentSegment[] {
  const out: AlignmentSegment[] = [];
  let ms = 0;
  for (let spine = 0; spine < CHAPTERS; spine++) {
    for (let ord = 0; ord < PER_CHAPTER; ord++) {
      ms += 120;
      if (ord % 19 === 7) {
        // Unplaced: the book has this sentence, the alignment does not.
        ms += 2600;
        continue;
      }
      const interpolated = ord % 5 === 0;
      const endMs = ms + 3200 + ((spine * 7 + ord * 13) % 900);
      out.push({
        sentenceId: `s${spine}_${ord}`,
        spineIdx: spine,
        sentenceOrd: ord,
        startMs: ms,
        endMs,
        confidence: interpolated ? 0.35 : 0.93,
        source: interpolated ? 'interpolated' : 'exact',
        uncertaintyMs: interpolated ? 1800 : 0,
      });
      ms = endMs;
    }
    ms += 4000; // chapter break: silence the aligner attributes to nobody
  }
  return out;
}

function mkDoc(over: { title?: string; author?: string } = {}): PortableAlignment {
  return buildAlignmentDocument({
    writtenBy: 'versovox 0.8.1 (test)',
    writtenAt: '2026-09-12T10:00:00.000Z',
    ebook: {
      title: over.title ?? 'The Wind in the Willows',
      author: over.author ?? 'Kenneth Grahame',
      language: 'en',
      spineCount: CHAPTERS,
      sizeBytes: 431_209,
      sentenceIdsInReadingOrder: bookSentenceIds(),
    },
    audio: {
      title: over.title ?? 'The Wind in the Willows',
      narrator: 'Shelly Frasier',
      trackDurationsMs: [1_803_000, 1_744_500, 1_690_250],
    },
    alignment: {
      version: 2,
      createdAt: '2026-09-11T20:14:03.000Z',
      language: 'en',
      model: 'mms-fa-300m',
      coverage: 0.94,
      meanConfidence: 0.81,
      provenance: { engine: 'ctc', anchors: 18_902, device: 'cpu', charRatio: 0.94 },
      gaps: [{ fromMs: 0, toMs: 42_000, reason: 'narration-only' }],
    },
    segments: bookSegments(),
  });
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-portable-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write arbitrary content where an alignment file is expected. */
function plant(name: string, payload: unknown | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    Buffer.isBuffer(payload) ? payload : gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')),
  );
  return file;
}

/**
 * The rejection reason ends up in an import report and a log line, read by
 * someone who runs a server but did not write one: a real sentence, no stack
 * trace, no schema jargon, and never a stray "undefined" leaked from string
 * building.
 */
function expectPlainLanguage(reason: string): void {
  expect(reason.split(/\s+/).length).toBeGreaterThanOrEqual(8);
  expect(reason).toMatch(/^[A-Z]/);
  expect(reason.trimEnd()).toMatch(/[.!]$/);
  expect(reason).not.toMatch(/undefined|\[object |ZodError|Error:|\n\s+at /);
}

describe('round-trip', () => {
  it('returns a multi-chapter alignment exactly as it was written', () => {
    const doc = mkDoc();
    const file = writeAlignmentFile(dir, doc);
    const result = readAlignmentFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(doc);
  });

  it('restores every segment field, including the uncertainty a handoff depends on', () => {
    // The columnar layout is an encoding detail; the reader's switch logic sees
    // AlignmentSegment[], and a field lost in the columns would degrade a
    // handoff silently rather than fail anything.
    const segments = bookSegments();
    const file = writeAlignmentFile(dir, mkDoc());
    const result = readAlignmentFile(file);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(columnsToSegments(result.doc.segments)).toEqual(segments);
    expect(result.doc.segmentCount).toBe(segments.length);
  });

  it('derives the counts and total duration from the inputs they must agree with', () => {
    // A declared sentence count that disagrees with the ids the fingerprint was
    // taken over produces a file that fails to match for undebuggable reasons.
    const doc = mkDoc();
    expect(doc.ebook.sentenceCount).toBe(CHAPTERS * PER_CHAPTER);
    expect(doc.ebook.textFingerprint).toBe(textFingerprint(bookSentenceIds()));
    expect(doc.audio.trackCount).toBe(3);
    expect(doc.audio.durationMs).toBe(1_803_000 + 1_744_500 + 1_690_250);
    expect(doc.pairKey).toBe(pairKey(doc.ebook.textFingerprint, doc.audio.timelineFingerprint));
  });

  it('converts segments to columns and back without loss', () => {
    const segments = bookSegments();
    expect(columnsToSegments(segmentsToColumns(segments))).toEqual(segments);
  });

  it('stays gunzip-and-read inspectable, which is the point of not delta-encoding', () => {
    // A self-hoster must be able to gunzip a file and see plain timestamps.
    // Delta-encoding would save about 82 KiB of a 309 KiB file and cost this.
    const file = writeAlignmentFile(dir, mkDoc());
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.segments.startMs.slice(0, 3)).toEqual(
      bookSegments()
        .slice(0, 3)
        .map((s) => s.startMs),
    );
  });
});

describe('rejections', () => {
  it('rejects a file that is not gzip at all', () => {
    const file = plant(`whatever [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, Buffer.from('plain text'));
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toMatch(/gzip/i);
  });

  it('rejects gzip that stops halfway, the shape a killed sync client leaves', () => {
    const whole = gzipSync(Buffer.from(JSON.stringify(mkDoc()), 'utf8'));
    const file = plant(
      `truncated [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`,
      whole.subarray(0, Math.floor(whole.length / 2)),
    );
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
  });

  it('rejects a file that unpacks to invalid JSON', () => {
    const file = plant(
      `broken [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`,
      gzipSync(Buffer.from('{"format": "versovox-align', 'utf8')),
    );
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toMatch(/JSON/);
  });

  it('rejects valid JSON that is not an alignment document', () => {
    const file = plant(`notours [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, { format: 'someone-elses' });
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
  });

  it('rejects a field of the wrong type', () => {
    const file = plant(`badtype [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, {
      ...mkDoc(),
      alignment: { ...mkDoc().alignment, coverage: 'high' },
    });
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toContain('alignment.coverage');
  });

  it('describes a missing field without echoing the word undefined at the user', () => {
    const doc = mkDoc() as unknown as Record<string, unknown>;
    delete doc.writtenBy;
    const file = plant(`missing [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, doc);
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toContain('writtenBy');
  });

  it('tells the user to upgrade when the file comes from a newer Versovox', () => {
    // The one rejection with a real remedy, so it must name it rather than
    // reporting the same "damaged file" as everything else.
    const file = plant(`future [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, {
      ...mkDoc(),
      formatVersion: 2,
    });
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toMatch(/upgrade this server/i);
  });

  it('refuses a fingerprint scheme it cannot compare instead of comparing it blindly', () => {
    // A t2: fingerprint means a later Versovox changed how text identity is
    // computed. Treating it as an opaque string would match the wrong book.
    const doc = mkDoc();
    doc.ebook.textFingerprint = `t2:${'a'.repeat(32)}`;
    const file = plant(`futurefp [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, doc);
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toMatch(/t2/);
    expect(result.reason).toMatch(/upgrade this server/i);
  });

  it('refuses an unknown audio fingerprint scheme too', () => {
    const doc = mkDoc();
    doc.audio.timelineFingerprint = `a9:${'b'.repeat(32)}`;
    const file = plant(`futureaudio [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, doc);
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toMatch(/a9/);
  });

  it('refuses ragged columns, which would import a whole book shifted by a sentence', () => {
    const doc = mkDoc();
    doc.segments.startMs.pop();
    const file = plant(`ragged [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, doc);
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
    expect(result.reason).toContain('startMs');
    expect(result.reason).toContain(String(doc.segmentCount));
  });

  it('refuses a segmentCount that overstates the columns', () => {
    const doc = mkDoc();
    doc.segmentCount += 1;
    const file = plant(`overstated [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`, doc);
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
  });

  it('reports a file that is not there rather than throwing at the importer', () => {
    const result = readAlignmentFile(path.join(dir, `gone [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
  });

  it('reports a directory handed to it where a file was expected', () => {
    const asDir = path.join(dir, `adir [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`);
    fs.mkdirSync(asDir);
    const result = readAlignmentFile(asDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expectPlainLanguage(result.reason);
  });
});

describe('writeAlignmentFile', () => {
  it('leaves nothing behind but the finished file', () => {
    // The temporary lives in the same directory as the target, so a leaked one
    // would be sitting in the user's synced library forever.
    const target = writeAlignmentFile(dir, mkDoc());
    expect(fs.readdirSync(dir)).toEqual([path.basename(target)]);
  });

  it('replaces the previous file for the pair when the book is retitled', () => {
    // The library's metadata changes far more often than its audio does. Each
    // retitle would otherwise add an importable, stale copy of the same pair.
    const first = writeAlignmentFile(dir, mkDoc({ title: 'The Wind in the Willows' }));
    const second = writeAlignmentFile(
      dir,
      mkDoc({ title: 'The Wind in the Willows (Illustrated)' }),
    );

    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
    expect(listAlignmentFiles(dir)).toEqual([second]);
  });

  it('leaves other books alone when it sweeps duplicates', () => {
    // The sweep matches on the bracketed pair key, so it must be blind to
    // everything else in a folder holding a whole library's alignments.
    const other = writeAlignmentFile(
      dir,
      buildAlignmentDocument({
        writtenBy: 'versovox 0.8.1 (test)',
        writtenAt: '2026-09-12T10:00:00.000Z',
        ebook: {
          title: 'Another Book',
          author: 'Someone Else',
          language: 'en',
          spineCount: 1,
          sizeBytes: 1000,
          sentenceIdsInReadingOrder: ['x0', 'x1'],
        },
        audio: { title: 'Another Book', narrator: 'Reader', trackDurationsMs: [60_000] },
        alignment: {
          version: 1,
          createdAt: '2026-09-11T20:14:03.000Z',
          language: 'en',
          model: 'mms-fa-300m',
          coverage: 1,
          meanConfidence: 0.9,
          provenance: {},
          gaps: [],
        },
        segments: [],
      }),
    );
    writeAlignmentFile(dir, mkDoc());
    writeAlignmentFile(dir, mkDoc({ title: 'Retitled' }));

    expect(fs.existsSync(other)).toBe(true);
    expect(listAlignmentFiles(dir)).toHaveLength(2);
  });

  it('rewriting the same book in place keeps one file and the newest content', () => {
    const first = writeAlignmentFile(dir, mkDoc());
    const doc = mkDoc();
    doc.alignment.version = 3;
    const second = writeAlignmentFile(dir, doc);

    expect(second).toBe(first);
    const result = readAlignmentFile(second);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.alignment.version).toBe(3);
  });

  it('creates the export folder on first use', () => {
    // The mount point exists; the alignments folder under it usually does not.
    const nested = path.join(dir, 'library', 'alignments');
    const file = writeAlignmentFile(nested, mkDoc());
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('buildAlignmentDocument', () => {
  it('accepts a fingerprint the caller already has instead of the sentence ids', () => {
    // Exporting out of the database is the common case, and the database keeps
    // the ebook's fingerprint, not the ids it was taken over. Re-deriving them
    // would mean re-extracting the EPUB for every file written.
    const ids = bookSentenceIds();
    const fromIds = mkDoc();
    const fromFingerprint = buildAlignmentDocument({
      writtenBy: 'versovox 0.8.1 (test)',
      writtenAt: '2026-09-12T10:00:00.000Z',
      ebook: {
        title: 'The Wind in the Willows',
        author: 'Kenneth Grahame',
        language: 'en',
        spineCount: CHAPTERS,
        sizeBytes: 431_209,
        sentenceCount: ids.length,
        textFingerprint: textFingerprint(ids),
      },
      audio: {
        title: 'The Wind in the Willows',
        narrator: 'Shelly Frasier',
        trackDurationsMs: [1_803_000, 1_744_500, 1_690_250],
        trackCount: 3,
        durationMs: 5_237_750,
        timelineFingerprint: timelineFingerprint([1_803_000, 1_744_500, 1_690_250]),
      },
      alignment: fromIds.alignment,
      segments: bookSegments(),
    });
    expect(fromFingerprint).toEqual(fromIds);
  });
});

describe('findAlignmentFile', () => {
  it('finds a pair by key even after the book was renamed', () => {
    // A bulk export asks "is this pair already on disk?" and the library's
    // metadata is the one thing that cannot be trusted to answer it.
    const doc = mkDoc({ title: 'Under Another Name' });
    const written = writeAlignmentFile(dir, doc);
    expect(findAlignmentFile(dir, doc.pairKey)).toBe(written);
  });

  it('returns null for a pair with no file and for a folder with none', () => {
    writeAlignmentFile(dir, mkDoc());
    expect(findAlignmentFile(dir, 'ffffffffffffffffffffffff')).toBeNull();
    expect(findAlignmentFile(path.join(dir, 'not-mounted'), 'ffffffffffffffffffffffff')).toBeNull();
  });
});

describe('listAlignmentFiles', () => {
  it('returns nothing for a folder that is missing or unmounted', () => {
    // A user-configured mount that is not there means "no alignments to
    // import", not an error to propagate up through a scan.
    expect(listAlignmentFiles(path.join(dir, 'not-mounted'))).toEqual([]);
  });

  it('ignores dotfiles and anything that is not an alignment file', () => {
    const real = writeAlignmentFile(dir, mkDoc());
    fs.writeFileSync(path.join(dir, `.hidden [aaaaaaaaaaaa]${ALIGNMENT_FILE_EXT}`), 'x');
    fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    expect(listAlignmentFiles(dir)).toEqual([real]);
  });
});

describe('alignmentFileName', () => {
  const KEY = '9f2c1a7b3d5e0011abcd2233';

  it('names a file after the book and the pair it belongs to', () => {
    expect(alignmentFileName({ author: 'Kenneth Grahame', title: 'The Wind', pairKey: KEY })).toBe(
      `Kenneth Grahame - The Wind [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`,
    );
  });

  it('folds accents to ASCII so the name survives a trip through an SMB share', () => {
    expect(alignmentFileName({ author: 'Émile Zola', title: 'Le Rêve', pairKey: KEY })).toBe(
      `Emile Zola - Le Reve [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`,
    );
  });

  it('drops punctuation that a filesystem or a shell would object to', () => {
    const name = alignmentFileName({
      author: 'Stevenson, R.L.',
      title: 'Dr. Jekyll & Mr. Hyde: A "Novel"? / v2 *',
      pairKey: KEY,
    });
    expect(name).toBe(
      `Stevenson R L - Dr Jekyll Mr Hyde A Novel v2 [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`,
    );
    expect(name).toMatch(/^[A-Za-z0-9 [\]\-.]+$/);
  });

  it('caps each half and never ends a slug on a stray space', () => {
    const name = alignmentFileName({
      author: 'A'.repeat(200),
      title: `${'x'.repeat(59)} word`,
      pairKey: KEY,
    });
    const [author, rest] = name.split(' - ');
    expect(author).toBe('A'.repeat(60));
    expect(rest).toBe(`${'x'.repeat(59)} [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`);
  });

  it('falls back to a readable placeholder when a slug would be empty', () => {
    // A title with no Latin characters slugs to nothing. The pair key in the
    // brackets is the real identifier, so an empty half is cosmetic, not fatal.
    expect(alignmentFileName({ author: '   ', title: '', pairKey: KEY })).toBe(
      `Unknown Author - Untitled [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`,
    );
    expect(alignmentFileName({ author: 'עגנון', title: '春の雪', pairKey: KEY })).toBe(
      `Unknown Author - Untitled [9f2c1a7b3d5e]${ALIGNMENT_FILE_EXT}`,
    );
  });

  it('produces a name this module can find again', () => {
    const doc = mkDoc({ title: 'Ünïcodé & Co.' });
    const written = writeAlignmentFile(dir, doc);
    expect(listAlignmentFiles(dir)).toEqual([written]);
    expect(path.basename(written)).toContain(`[${doc.pairKey.slice(0, 12)}]`);
  });
});

describe('fingerprints', () => {
  const ids = bookSentenceIds();

  it('gives the same answer for the same book every time', () => {
    // Stability across processes and installs is the whole premise: the ids are
    // content-derived, so a fresh install re-segmenting the same EPUB must land
    // on the same fingerprint or every imported segment is worthless.
    expect(textFingerprint(ids)).toBe(textFingerprint([...ids]));
    expect(textFingerprint(ids)).toMatch(/^t1:[0-9a-f]{32}$/);
  });

  it('changes when a single sentence changes', () => {
    const edited = [...ids];
    edited[57] = 's1_17_revised';
    expect(textFingerprint(edited)).not.toBe(textFingerprint(ids));
  });

  it('changes when the sentences are reordered', () => {
    expect(textFingerprint(['a', 'b'])).not.toBe(textFingerprint(['b', 'a']));
  });

  it('cannot be fooled by an id that contains the separator', () => {
    // Folding the count in is what stops ['a\nb'] and ['a', 'b'] from hashing
    // the same joined string.
    expect(textFingerprint(['a\nb'])).not.toBe(textFingerprint(['a', 'b']));
  });

  it('survives a retag: 40 ms of ffprobe disagreement is not a different audiobook', () => {
    // Rounding to 100 ms is deliberate. Re-tagging cover art or a narrator name
    // rewrites every file and can shift a reported duration by a frame or two,
    // and no alignment should be lost over that.
    expect(timelineFingerprint([1_803_000, 1_744_500])).toBe(
      timelineFingerprint([1_803_040, 1_744_460]),
    );
  });

  it('does not survive a real edit: 40 s more audio is a different timeline', () => {
    expect(timelineFingerprint([1_803_000, 1_744_500])).not.toBe(
      timelineFingerprint([1_843_000, 1_744_500]),
    );
  });

  it('distinguishes the same total duration split into different tracks', () => {
    // Segment timings are absolute across the book, but a different track split
    // means a different edition, and matching it would place every timing wrong.
    expect(timelineFingerprint([600_000, 600_000])).not.toBe(timelineFingerprint([1_200_000]));
    expect(timelineFingerprint([1_200_000])).toMatch(/^a1:[0-9a-f]{32}$/);
  });

  it('derives a pair key that moves with either side', () => {
    const t = textFingerprint(ids);
    const a = timelineFingerprint([1_803_000]);
    expect(pairKey(t, a)).toBe(pairKey(t, a));
    expect(pairKey(t, a)).toMatch(/^[0-9a-f]{24}$/);
    expect(pairKey(textFingerprint(['other']), a)).not.toBe(pairKey(t, a));
    expect(pairKey(t, timelineFingerprint([1_900_000]))).not.toBe(pairKey(t, a));
  });
});

describe('size', () => {
  it('keeps a full-length book to a couple of hundred kilobytes on disk', () => {
    // 16,000 segments is a long novel, with sentence ids shaped like the real
    // ones (content hashes, so incompressible) and timings that drift the way
    // narration does. Measured on this book: 892 KiB of JSON, 262 KiB gzipped,
    // against 2392 KiB / 359 KiB for an array of per-segment objects. The bound
    // is loose enough not to be brittle and tight enough that going back to
    // objects, or letting a per-segment field grow unnoticed, fails it.
    let seed = 0x9e3779b9;
    const rnd = (): number => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed;
    };
    const hex = (): string => rnd().toString(16).padStart(8, '0');
    let ms = 0;
    const segments: AlignmentSegment[] = Array.from({ length: 16_000 }, (_, i) => {
      const startMs = ms + (rnd() % 400);
      const endMs = startMs + 2400 + (rnd() % 2600);
      ms = endMs;
      return {
        sentenceId: `s${hex()}${hex()}`.slice(0, 13),
        spineIdx: Math.floor(i / 400),
        sentenceOrd: i % 400,
        startMs,
        endMs,
        confidence: i % 5 === 0 ? 0.35 : Math.round((0.7 + (rnd() % 300) / 1000) * 100) / 100,
        source: i % 5 === 0 ? 'interpolated' : 'exact',
        uncertaintyMs: i % 5 === 0 ? 1500 + (rnd() % 900) : 0,
      };
    });
    const doc = buildAlignmentDocument({
      writtenBy: 'versovox 0.8.1 (test)',
      ebook: {
        title: 'A Long Novel',
        author: 'A Prolific Author',
        language: 'en',
        spineCount: 40,
        sizeBytes: 2_100_000,
        sentenceIdsInReadingOrder: segments.map((s) => s.sentenceId),
      },
      audio: {
        title: 'A Long Novel',
        narrator: 'A Patient Narrator',
        trackDurationsMs: Array.from({ length: 40 }, () => 1_360_000),
      },
      alignment: {
        version: 1,
        createdAt: '2026-09-11T20:14:03.000Z',
        language: 'en',
        model: 'mms-fa-300m',
        coverage: 0.97,
        meanConfidence: 0.84,
        provenance: { engine: 'ctc' },
        gaps: [],
      },
      segments,
    });

    const file = writeAlignmentFile(dir, doc);
    expect(fs.statSync(file).size).toBeLessThan(320 * 1024);

    // Still exact at that size: a book's worth of timings, none of them rounded
    // or dropped on the way through the columns.
    const result = readAlignmentFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(columnsToSegments(result.doc.segments)).toEqual(segments);
  });
});
