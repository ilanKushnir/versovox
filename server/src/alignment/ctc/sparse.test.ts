import { describe, expect, it } from 'vitest';
import { matchChars, type Anchor, type BookSentence } from './anchors.js';
import { PROBE_BREAK, type DecodedChar, type ProbeWindow } from './emissions.js';
import {
  DEFAULT_SPARSE_PLAN,
  assembleProbes,
  gridWindows,
  planFor,
  refineWindows,
  type ProbeRun,
  type SparsePlan,
} from './sparse.js';

/**
 * The probe schedule, tested without the model.
 *
 * Everything here is arithmetic over anchors and windows, and it decides how
 * much of a book gets listened to — so it is worth pinning down precisely,
 * particularly the refinement rule, whose whole job is to notice the places
 * where interpolating between two anchors would be a lie.
 */

const PLAN: SparsePlan = { ...DEFAULT_SPARSE_PLAN, windowMs: 8_000, everyMs: 100_000 };

function anchorsAtRate(count: number, rate: number, fromMs = 0, everyMs = 100_000): Anchor[] {
  return Array.from({ length: count }, (_, i) => ({
    ms: fromMs + i * everyMs,
    bookPos: Math.round(i * everyMs * rate),
  }));
}

describe('gridWindows', () => {
  it('covers the book at the planned spacing', () => {
    const win = gridWindows(500_000, PLAN);
    expect(win.map((w) => w.startMs)).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(win.every((w) => w.durationMs === 8_000)).toBe(true);
  });

  it('clips the last probe to the end of the audio instead of running past it', () => {
    const win = gridWindows(203_000, PLAN);
    expect(win.at(-1)).toEqual({ startMs: 200_000, durationMs: 3_000 });
  });
});

describe('planFor', () => {
  it('maps the thorough setting to no schedule at all', () => {
    expect(planFor('thorough')).toBeNull();
  });

  it('makes careful listen more often than fast', () => {
    expect(planFor('careful')!.everyMs).toBeLessThan(planFor('fast')!.everyMs);
  });
});

describe('refineWindows', () => {
  it('leaves a steadily-read book alone', () => {
    const anchors = anchorsAtRate(10, 0.015);
    expect(refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10)).toEqual([]);
  });

  it('probes the stretch where the narration slowed down', () => {
    // A pause in the middle: the same audio span carries a third of the text,
    // which is what a chapter break or a long musical sting looks like from
    // here.
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos -= 1000;

    const out = refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10);
    expect(out).toHaveLength(1);
    // Between the fourth and fifth anchors, i.e. 400 s and 500 s.
    expect(out[0]!.startMs).toBeGreaterThan(400_000);
    expect(out[0]!.startMs).toBeLessThan(500_000);
  });

  it('probes a stretch the narration raced through, too', () => {
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos += 4000;
    const out = refineWindows(anchors, gridWindows(900_000, PLAN), 900_000, PLAN, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.startMs).toBeGreaterThan(400_000);
    expect(out[0]!.startMs).toBeLessThan(500_000);
  });

  it('probes an unanchored head — the part no measured rate can describe', () => {
    // Nothing matched for the first four minutes: a foreword, a credit, or a
    // probe that landed in music.
    const anchors = anchorsAtRate(6, 0.015, 240_000);
    const out = refineWindows(anchors, [], 900_000, PLAN, 10);
    expect(out.some((w) => w.startMs < 240_000)).toBe(true);
  });

  it('probes an unanchored tail', () => {
    const anchors = anchorsAtRate(4, 0.015);
    const out = refineWindows(anchors, [], 900_000, PLAN, 10);
    expect(out.some((w) => w.startMs > 300_000)).toBe(true);
  });

  it('never proposes a window over audio it has already decoded', () => {
    const anchors = anchorsAtRate(10, 0.015);
    for (let i = 5; i < anchors.length; i++) anchors[i]!.bookPos -= 1000;
    const covered: ProbeWindow[] = [{ startMs: 400_000, durationMs: 100_000 }];
    expect(refineWindows(anchors, covered, 900_000, PLAN, 10)).toEqual([]);
  });

  it('spends a small budget on the widest unmapped stretches first', () => {
    const anchors: Anchor[] = [
      { ms: 0, bookPos: 0 },
      // A 400 s hole, then a 120 s one. Both are suspicious; only one fits.
      { ms: 400_000, bookPos: 1_000 },
      { ms: 520_000, bookPos: 7_800 },
      { ms: 620_000, bookPos: 9_300 },
    ];
    const out = refineWindows(anchors, [], 900_000, PLAN, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.startMs).toBeGreaterThan(150_000);
    expect(out[0]!.startMs).toBeLessThan(250_000);
  });

  it('proposes nothing when the budget is spent', () => {
    const anchors = anchorsAtRate(4, 0.015, 240_000);
    expect(refineWindows(anchors, [], 900_000, PLAN, 0)).toEqual([]);
  });
});

describe('assembleProbes', () => {
  const run = (startMs: number, text: string, msPerChar = 60): ProbeRun => ({
    window: { startMs, durationMs: 8_000 },
    chars: [...text].map((c, i) => ({ c, ms: startMs + i * msPerChar })),
  });

  it('splices probes in playback order however they were scheduled', () => {
    const out = assembleProbes([run(200_000, 'ccc'), run(0, 'aaa'), run(100_000, 'bbb')]);
    expect(out.map((c) => c.c).join('')).toBe(`aaa${PROBE_BREAK}bbb${PROBE_BREAK}ccc`);
    expect(out.map((c) => c.ms)).toEqual([...out].sort((a, b) => a.ms - b.ms).map((c) => c.ms));
  });

  it('skips a probe that heard nothing rather than leaving a stray break', () => {
    const out = assembleProbes([
      run(0, 'aaa'),
      { window: { startMs: 100_000, durationMs: 8_000 }, chars: [] },
      run(200_000, 'bbb'),
    ]);
    expect(out.map((c) => c.c).join('')).toBe(`aaa${PROBE_BREAK}bbb`);
  });

  it('never lets an n-gram straddle two probes', () => {
    // The two probes are minutes apart, but their characters would spell a
    // phrase from the middle of the book if they were run together. That
    // phantom must not become an anchor: it would drag every sentence around
    // it to a time nobody spoke it.
    const book: BookSentence[] = [
      { index: 0, romanized: 'zzzzzzzzzzzzzzzzzz' },
      { index: 1, romanized: 'thequickbrownfoxjumped' },
      { index: 2, romanized: 'yyyyyyyyyyyyyyyyyy' },
    ];
    const heard: DecodedChar[] = assembleProbes([
      run(0, 'thequickbrow'),
      run(600_000, 'nfoxjumpedxx'),
    ]);
    const { anchors } = matchChars(book, heard, { audioMs: 700_000 });
    // "thequickbrownfoxjumped" spans the seam; nothing may match it.
    expect(anchors.every((a) => a.bookPos < 18 || a.bookPos >= 40)).toBe(true);
  });
});
