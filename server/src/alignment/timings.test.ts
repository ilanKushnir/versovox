import { describe, expect, it } from 'vitest';
import {
  segmentsFromTimings,
  type EbookSentenceInput,
  type RawTiming,
  type TimingOptions,
} from './timings.js';

/**
 * Tests for the shared timing layer in isolation from any aligner: raw
 * timings go in, honest segments come out. Every engine's output passes
 * through here, so these assertions are the contract the reader's switch
 * behaviour depends on.
 */

/** `n` sentences, sentence i carrying `tokenCounts[i]` (default 5) tokens. */
function mkSentences(n: number, tokenCounts: number[] = []): EbookSentenceInput[] {
  return Array.from({ length: n }, (_, i) => ({
    sentenceId: `s${i}`,
    spineIdx: 0,
    sentenceOrd: i,
    tokens: Array.from({ length: tokenCounts[i] ?? 5 }, (_, k) => `t${i}_${k}`),
  }));
}

/** Run the layer over a sparse array of raw timings indexed by sentence. */
function run(
  sentences: EbookSentenceInput[],
  timings: (RawTiming | null)[],
  opts: TimingOptions = {},
) {
  return segmentsFromTimings(sentences, (i) => timings[i] ?? null, opts);
}

const strong = (startMs: number, endMs: number, score = 0.9): RawTiming => ({
  startMs,
  endMs,
  score,
  exact: true,
});

describe('segmentsFromTimings', () => {
  it('asks for every sentence exactly once, in reading order', () => {
    const sentences = mkSentences(4);
    const asked: number[] = [];
    segmentsFromTimings(sentences, (i) => {
      asked.push(i);
      return strong(i * 1000, i * 1000 + 900);
    });
    expect(asked).toEqual([0, 1, 2, 3]);
  });

  it('passes a well-formed run through untouched', () => {
    const sentences = mkSentences(3);
    const r = run(sentences, [strong(0, 900), strong(1000, 1900), strong(2000, 2900)]);
    expect(r.segments).toHaveLength(3);
    expect(r.segments.map((s) => s.source)).toEqual(['exact', 'exact', 'exact']);
    expect(r.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 900],
      [1000, 1900],
      [2000, 2900],
    ]);
    expect(r.coverage).toBe(1);
    expect(r.gaps).toEqual([]);
  });

  describe('monotonicity', () => {
    it('drops a sentence that jumps backwards past the slack allowance', () => {
      const sentences = mkSentences(4);
      // Sentence 2 claims to start 1900 ms before sentence 1 ended: beyond the
      // 1500 ms fuzzy-border slack, so it is dropped rather than reordered.
      const r = run(
        sentences,
        [strong(0, 1000), strong(1000, 2000), strong(100, 200), strong(3000, 4000)],
        { maxInterpolateRun: 0 },
      );
      expect(r.segments.map((s) => s.sentenceId)).toEqual(['s0', 's1', 's3']);
      expect(r.coverage).toBe(0.75);
    });

    it('keeps a small backwards overlap within the slack allowance', () => {
      const sentences = mkSentences(3);
      // 1200 is only 800 ms before the previous end: a shared word pulled from
      // the wrong side of a fuzzy border, not an ordering failure.
      const r = run(sentences, [strong(0, 1000), strong(1000, 2000), strong(1200, 2500)], {
        maxInterpolateRun: 0,
      });
      expect(r.segments).toHaveLength(3);
      expect(r.segments[2]!.startMs).toBe(1200);
    });

    it('clips a sentence whose end precedes its own start', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [strong(5000, 4000)]);
      expect(r.segments[0]!.startMs).toBe(5000);
      expect(r.segments[0]!.endMs).toBe(5000);
    });

    it('does not let a dropped sentence move the monotonic frontier', () => {
      const sentences = mkSentences(4);
      const r = run(
        sentences,
        [strong(0, 1000), strong(10_000, 11_000), strong(100, 200), strong(11_500, 12_000)],
        { maxInterpolateRun: 0 },
      );
      // s3 follows s1's end, not the rejected s2's.
      expect(r.segments.map((s) => s.sentenceId)).toEqual(['s0', 's1', 's3']);
    });
  });

  describe('interpolation', () => {
    it('fills a short hole in proportion to token counts and marks it', () => {
      const sentences = mkSentences(4, [5, 1, 3, 5]);
      const r = run(sentences, [strong(0, 1000), null, null, strong(2000, 3000)]);
      expect(r.segments).toHaveLength(4);
      const [, a, b] = r.segments;
      // 1000 ms of audio split 1:3 by token count.
      expect([a!.startMs, a!.endMs]).toEqual([1000, 1250]);
      expect([b!.startMs, b!.endMs]).toEqual([1250, 2000]);
      expect(a!.source).toBe('interpolated');
      expect(b!.source).toBe('interpolated');
      expect(a!.confidence).toBe(0.35);
      expect(r.coverage).toBe(1);
    });

    it('never claims an interpolated sentence is exact, however strong its neighbours', () => {
      const sentences = mkSentences(3);
      const r = run(sentences, [strong(0, 1000, 1), null, strong(2000, 3000, 1)]);
      expect(r.segments[1]!.source).toBe('interpolated');
      expect(r.segments[1]!.confidence).toBeLessThan(0.6);
    });

    it('refuses to interpolate at the ends of the book', () => {
      const sentences = mkSentences(3);
      // No left neighbour for s0, no right neighbour for s2.
      const r = run(sentences, [null, strong(1000, 2000), null]);
      expect(r.segments.map((s) => s.sentenceId)).toEqual(['s1']);
    });

    it('leaves a run longer than maxInterpolateRun unaligned', () => {
      const sentences = mkSentences(7);
      const timings = [strong(0, 1000), null, null, null, null, null, strong(40_000, 41_000)];
      const r = run(sentences, timings);
      expect(r.segments.map((s) => s.sentenceId)).toEqual(['s0', 's6']);
      // The same hole is interpolated once the allowance covers it.
      const wide = run(sentences, timings, { maxInterpolateRun: 5 });
      expect(wide.segments).toHaveLength(7);
      expect(wide.segments.slice(1, 6).every((s) => s.source === 'interpolated')).toBe(true);
    });
  });

  describe('gaps', () => {
    it('turns a long unaligned hole into an explicit narration-only gap', () => {
      const sentences = mkSentences(7);
      const r = run(sentences, [
        strong(0, 1000),
        null,
        null,
        null,
        null,
        null,
        strong(40_000, 41_000),
      ]);
      expect(r.gaps).toEqual([{ fromMs: 1000, toMs: 40_000, reason: 'narration-only' }]);
    });

    it('does not report a hole shorter than the gap threshold', () => {
      const sentences = mkSentences(7);
      const r = run(sentences, [
        strong(0, 1000),
        null,
        null,
        null,
        null,
        null,
        strong(15_000, 16_000),
      ]);
      expect(r.gaps).toEqual([]);
    });

    it('reports leading and trailing narration-only audio', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [strong(30_000, 31_000)], { audioMs: 90_000 });
      expect(r.gaps).toEqual([
        { fromMs: 0, toMs: 30_000, reason: 'narration-only' },
        { fromMs: 31_000, toMs: 90_000, reason: 'narration-only' },
      ]);
    });

    it('cannot report a trailing gap without knowing the audio duration', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [strong(0, 1000)]);
      expect(r.gaps).toEqual([]);
    });
  });

  describe('honesty', () => {
    it('downgrades an exact claim that the engine is not confident about', () => {
      const sentences = mkSentences(2);
      const r = run(sentences, [
        { startMs: 0, endMs: 1000, score: 0.59, exact: true },
        { startMs: 1000, endMs: 2000, score: 0.6, exact: true },
      ]);
      expect(r.segments.map((s) => s.source)).toEqual(['fuzzy', 'exact']);
    });

    it('honours a custom minExactConfidence in both directions', () => {
      const sentences = mkSentences(1);
      const strict = run(sentences, [{ startMs: 0, endMs: 1000, score: 0.8, exact: true }], {
        minExactConfidence: 0.9,
      });
      expect(strict.segments[0]!.source).toBe('fuzzy');
      const lax = run(sentences, [{ startMs: 0, endMs: 1000, score: 0.8, exact: true }], {
        minExactConfidence: 0.7,
      });
      expect(lax.segments[0]!.source).toBe('exact');
    });

    it('never calls a sentence exact when the engine made no such claim', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [{ startMs: 0, endMs: 1000, score: 1 }]);
      expect(r.segments[0]!.source).toBe('fuzzy');
      expect(r.segments[0]!.confidence).toBe(1);
    });

    it('drops a timing too weak to trust rather than guessing', () => {
      const sentences = mkSentences(3);
      const r = run(
        sentences,
        [
          strong(0, 1000),
          { startMs: 1000, endMs: 2000, score: 0.34 },
          { startMs: 2000, endMs: 3000, score: 0.35 },
        ],
        { maxInterpolateRun: 0 },
      );
      expect(r.segments.map((s) => s.sentenceId)).toEqual(['s0', 's2']);
    });

    it('clamps out-of-range scores instead of emitting an invalid confidence', () => {
      const sentences = mkSentences(2);
      const r = run(sentences, [
        { startMs: 0, endMs: 1000, score: 4 },
        { startMs: 1000, endMs: 2000, score: Number.NaN },
      ]);
      // 4 clamps to 1; NaN is no evidence at all, so that sentence is dropped.
      expect(r.segments.map((s) => s.confidence)).toEqual([1]);
    });
  });

  describe('audio bounds', () => {
    it('never emits a timing past the end of the audio', () => {
      const sentences = mkSentences(2);
      const r = run(sentences, [strong(0, 4000), strong(4000, 99_000)], { audioMs: 5000 });
      expect(r.segments.map((s) => [s.startMs, s.endMs])).toEqual([
        [0, 4000],
        [4000, 5000],
      ]);
    });

    it('clamps a start beyond the audio to the audio end, keeping end >= start', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [strong(60_000, 61_000)], { audioMs: 5000 });
      expect(r.segments[0]!.startMs).toBe(5000);
      expect(r.segments[0]!.endMs).toBe(5000);
    });

    it('emits whole-millisecond integers as the schema requires', () => {
      const sentences = mkSentences(1);
      const r = run(sentences, [strong(10.4, 1000.6)]);
      expect(r.segments[0]!.startMs).toBe(10);
      expect(r.segments[0]!.endMs).toBe(1001);
    });
  });

  describe('summary arithmetic', () => {
    it('computes coverage over sentences and mean confidence over segments', () => {
      const sentences = mkSentences(4);
      const r = run(
        sentences,
        [
          { startMs: 0, endMs: 1000, score: 0.8 },
          { startMs: 1000, endMs: 2000, score: 0.5 },
          null,
          null,
        ],
        { maxInterpolateRun: 0 },
      );
      expect(r.coverage).toBe(0.5);
      expect(r.meanConfidence).toBe(0.65);
    });

    it('counts interpolated sentences in coverage at their lower confidence', () => {
      const sentences = mkSentences(3);
      const r = run(sentences, [
        { startMs: 0, endMs: 1000, score: 1 },
        null,
        { startMs: 2000, endMs: 3000, score: 1 },
      ]);
      expect(r.coverage).toBe(1);
      // (1 + 0.35 + 1) / 3
      expect(r.meanConfidence).toBe(0.783);
    });

    it('rounds coverage to three decimals', () => {
      const sentences = mkSentences(3);
      const r = run(sentences, [strong(0, 1000), null, null], { maxInterpolateRun: 0 });
      expect(r.coverage).toBe(0.333);
    });

    it('reports nothing for an empty book', () => {
      expect(segmentsFromTimings([], () => null)).toEqual({
        segments: [],
        gaps: [],
        coverage: 0,
        meanConfidence: 0,
      });
    });
  });
});
