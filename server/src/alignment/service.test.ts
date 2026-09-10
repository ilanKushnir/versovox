import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, nowIso, type DB } from '../db/index.js';
import {
  handoffStatus,
  latestAlignment,
  resolveAudioToEbook,
  resolveEbookToAudio,
  storeAlignment,
  type ResolveContext,
} from './service.js';
import { type AlignerResult } from './align.js';

/**
 * Handoff must never silently cross alignment gaps: positions inside gaps,
 * beyond the drift bound, or too far from any verified sentence return
 * unavailable + surrounding anchors instead of an unrelated sentence.
 */

let db: DB;
let alignmentId: string;

// Ebook: one chapter (spine 0) of 40 sentences, 100 chars each.
const sentences = [
  Array.from({ length: 40 }, (_, i) => ({
    id: `s${i}`,
    ord: i,
    start: i * 100,
    end: (i + 1) * 100,
  })),
];

// Aligned: sentences 0..4 (0..25s) and 31..34 (100..120s).
// Explicit narration-only gap between 25s and 100s (sentences 5..30 are
// absent from the narration).
const result: AlignerResult = {
  segments: [
    ...Array.from({ length: 5 }, (_, i) => ({
      sentenceId: `s${i}`,
      spineIdx: 0,
      sentenceOrd: i,
      startMs: i * 5000,
      endMs: (i + 1) * 5000,
      confidence: 0.9,
      source: 'exact' as const,
    })),
    ...Array.from({ length: 4 }, (_, k) => ({
      sentenceId: `s${31 + k}`,
      spineIdx: 0,
      sentenceOrd: 31 + k,
      startMs: 100_000 + k * 5000,
      endMs: 100_000 + (k + 1) * 5000,
      confidence: 0.85,
      source: 'exact' as const,
    })),
  ],
  gaps: [{ fromMs: 25_000, toMs: 100_000, reason: 'narration-only' }],
  coverage: 9 / 40,
  meanConfidence: 0.88,
};

function ctx(): ResolveContext {
  return {
    db,
    alignmentId,
    gaps: result.gaps,
    tracks: [{ startMsAbsolute: 0, durationMs: 130_000 }],
    sentences,
    chapterCumChars: [0],
    totalChars: 4000,
  };
}

beforeEach(() => {
  db = openMemoryDatabase();
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
     VALUES ('e1','ebook','/x','a.epub','epub','E',1,'ready',?), ('a1','audio','/x','a','m4b','A',1,'ready',?)`,
  ).run(nowIso(), nowIso());
  db.prepare(
    `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at) VALUES ('p1','e1','a1','confirmed',0.9,?)`,
  ).run(nowIso());
  alignmentId = storeAlignment(db, 'p1', 'en', 'test', result, { sentenceCount: 40 });
});

describe('resolveEbookToAudio', () => {
  it('exact sentence resolves at sentence granularity', () => {
    const r = resolveEbookToAudio(ctx(), {
      medium: 'ebook',
      spineIdx: 0,
      sentenceId: 's2',
      charOffset: 210,
      pct: 0.05,
    });
    expect(r.to?.medium).toBe('audio');
    expect(r.resolution.granularity).toBe('sentence');
    expect(r.resolution.source).toBe('exact');
    expect((r.to as { bookMs?: number }).bookMs).toBe(10_000);
  });

  it('nearby unaligned sentence degrades honestly to approximate', () => {
    // Sentence 6 is unaligned but only 2 away from aligned sentence 4.
    const r = resolveEbookToAudio(ctx(), {
      medium: 'ebook',
      spineIdx: 0,
      charOffset: 650,
      pct: 0.16,
    });
    expect(r.to).not.toBeNull();
    expect(r.resolution.granularity).toBe('paragraph');
    expect(r.resolution.approximate).toBe(true);
  });

  it('GAP: a sentence deep inside an omitted passage refuses and returns anchors', () => {
    // Sentence 20 is 16 sentences past the last aligned one: far outside
    // the bound. It must NOT map to sentence 4's audio position.
    const r = resolveEbookToAudio(ctx(), {
      medium: 'ebook',
      spineIdx: 0,
      sentenceId: 's20',
      charOffset: 2050,
      pct: 0.5,
    });
    expect(r.to).toBeNull();
    expect(r.resolution.granularity).toBe('none');
    expect(r.anchors?.before?.sentenceId).toBe('s4');
    expect(r.anchors?.after?.sentenceId).toBe('s31');
    expect((r.anchors!.before!.to as { bookMs?: number }).bookMs).toBe(20_000);
  });
});

describe('resolveAudioToEbook', () => {
  it('inside an aligned segment resolves to that sentence', () => {
    const r = resolveAudioToEbook(ctx(), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 12_000,
      pct: 0.09,
    });
    expect((r.to as { sentenceId?: string })?.sentenceId).toBe('s2');
    expect(r.resolution.granularity).toBe('sentence');
  });

  it('GAP: a timestamp inside a narration-only region refuses with anchors', () => {
    const r = resolveAudioToEbook(ctx(), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 60_000, // squarely inside the 25s..100s gap
      pct: 0.46,
    });
    expect(r.to).toBeNull();
    expect(r.resolution.granularity).toBe('none');
    expect(r.resolution.reason).toMatch(/no matching text/i);
    expect(r.anchors?.before?.sentenceId).toBe('s4');
    expect(r.anchors?.after?.sentenceId).toBe('s31');
  });

  it('DRIFT: far past the last segment (no explicit gap) still refuses', () => {
    const c = ctx();
    c.gaps = []; // even without stored gaps, the drift bound catches it
    const r = resolveAudioToEbook(c, {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 60_000,
      pct: 0.46,
    });
    expect(r.to).toBeNull();
    expect(r.anchors?.before?.sentenceId).toBe('s4');
  });

  it('slightly past a segment end resolves approximately, not exactly', () => {
    const r = resolveAudioToEbook(ctx(), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 121_000, // 1s past the last segment's end
      pct: 0.93,
    });
    expect((r.to as { sentenceId?: string })?.sentenceId).toBe('s34');
    expect(r.resolution.granularity).toBe('paragraph');
    expect(r.resolution.approximate).toBe(true);
  });

  it('before the first aligned audio refuses unless within the drift bound', () => {
    const c = ctx();
    // Shift all segments to start at 50s to create leading narration.
    db.prepare(
      'UPDATE alignment_segments SET start_ms = start_ms + 50000, end_ms = end_ms + 50000',
    ).run();
    c.gaps = [];
    const near = resolveAudioToEbook(c, {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 30_000,
      pct: 0.2,
    });
    expect(near.to).not.toBeNull(); // 20s before first segment: within bound
    expect(near.resolution.approximate).toBe(true);
    const far = resolveAudioToEbook(c, {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 1_000,
      pct: 0.01,
    });
    expect(far.to).toBeNull();
    expect(far.anchors?.after?.sentenceId).toBe('s0');
  });
});

describe('honest granularity provenance (audio -> ebook)', () => {
  function withSource(source: 'fuzzy' | 'interpolated' | 'anchor'): ResolveContext {
    // Rewrite segment s2 (10s..15s) to a high-confidence NON-exact segment:
    // confidence alone must never earn the 'sentence' label.
    db.prepare(
      `UPDATE alignment_segments SET source = ?, confidence = 0.95 WHERE sentence_id = 's2'`,
    ).run(source);
    return ctx();
  }

  it('a high-confidence FUZZY segment is paragraph-granular and approximate', () => {
    const r = resolveAudioToEbook(withSource('fuzzy'), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 12_000, // inside s2's segment
      pct: 0.09,
    });
    expect((r.to as { sentenceId?: string })?.sentenceId).toBe('s2');
    expect(r.resolution.granularity).toBe('paragraph');
    expect(r.resolution.granularity).not.toBe('sentence');
    expect(r.resolution.approximate).toBe(true);
    expect(r.resolution.source).toBe('fuzzy');
  });

  it('a high-confidence INTERPOLATED segment is paragraph-granular and approximate', () => {
    const r = resolveAudioToEbook(withSource('interpolated'), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 12_000,
      pct: 0.09,
    });
    expect(r.resolution.granularity).toBe('paragraph');
    expect(r.resolution.approximate).toBe(true);
    expect(r.resolution.source).toBe('interpolated');
  });

  it('only an exact-provenance segment earns sentence granularity', () => {
    const r = resolveAudioToEbook(ctx(), {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 12_000,
      pct: 0.09,
    });
    expect(r.resolution.granularity).toBe('sentence');
    expect(r.resolution.source).toBe('exact');
    expect(r.resolution.approximate).toBe(false);
  });

  it('ebook -> audio equally refuses the sentence label for fuzzy provenance', () => {
    const r = resolveEbookToAudio(withSource('fuzzy'), {
      medium: 'ebook',
      spineIdx: 0,
      sentenceId: 's2',
      charOffset: 210,
      pct: 0.05,
    });
    expect(r.to?.medium).toBe('audio');
    expect(r.resolution.granularity).toBe('paragraph');
    expect(r.resolution.approximate).toBe(true);
    expect(r.resolution.source).toBe('fuzzy');
  });
});

describe('honest handoff status', () => {
  it('reports exact sentence coverage, not a global exact claim', () => {
    const handle = latestAlignment(db, 'p1')!;
    expect(handle.summary.exactSentenceCoverage).toBeCloseTo(9 / 40, 3);
    const status = handoffStatus(handle)!;
    // Coverage below the switchable floor: handoff not even available here.
    expect(status.available).toBe(false);
    expect(status.exactSentenceCoverage).toBeCloseTo(9 / 40, 3);
  });
});
