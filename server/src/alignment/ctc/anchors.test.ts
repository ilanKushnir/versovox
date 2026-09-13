import { describe, expect, it } from 'vitest';
import { matchChars, type BookSentence, type HeardChar } from './anchors.js';

/**
 * The anchor matcher is exercised against synthetic books whose narration
 * timing is known exactly, so every assertion is on a number we can derive
 * rather than on "it produced something".
 *
 * The book text is pseudo-random letters: at N=14 a random gram is unique with
 * overwhelming probability, which is the same property that real prose has at
 * that length (18,913 unique shared 14-grams on the validated audiobook).
 */

const MS_PER_CHAR = 60;
const HEAD_MS = 4000; // narration does not start at t=0, exactly like a real audiobook

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(chars: number, seed: number): string {
  const rng = makeRng(seed);
  let out = '';
  for (let i = 0; i < chars; i++) out += String.fromCharCode(97 + Math.floor(rng() * 26));
  return out;
}

/** Split a string into fixed-size sentences. */
function sentencesOf(text: string, size: number, firstIndex = 0): BookSentence[] {
  const out: BookSentence[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push({ index: firstIndex + out.length, romanized: text.slice(i, i + size) });
  }
  return out;
}

/** Narrate a string at a constant rate: heard char k is stamped start + k*rate. */
function narrate(text: string, startMs = HEAD_MS, msPerChar = MS_PER_CHAR): HeardChar[] {
  return [...text].map((c, i) => ({ c, ms: startMs + i * msPerChar }));
}

function bookTextOf(book: BookSentence[]): string {
  return book.map((s) => s.romanized).join('');
}

describe('matchChars', () => {
  it('recovers known sentence offsets from an exactly narrated book', () => {
    const book = sentencesOf(randomText(3000, 1), 100);
    const heard = narrate(bookTextOf(book));

    const { timings, stats } = matchChars(book, heard);

    expect(stats.bookChars).toBe(3000);
    expect(stats.heardChars).toBe(3000);
    expect(stats.charRatio).toBe(1);
    expect(stats.implausible).toBe(false);
    expect(stats.alignedSentences).toBe(30);
    // Practically every position is a unique shared gram, and all of them
    // survive the LIS because the two streams run in lockstep.
    expect(stats.monotoneAnchors).toBeGreaterThan(2900);
    expect(stats.monotoneAnchors).toBe(stats.candidateAnchors);

    for (let i = 0; i < 30; i++) {
      const t = timings[i]!;
      expect(t.index).toBe(i);
      expect(t.gap).toBe(false);
      expect(t.score).toBeGreaterThan(0.99);
      expect(t.startMs).toBeCloseTo(HEAD_MS + i * 100 * MS_PER_CHAR, -1);
    }
    // Every sentence but the last ends where the next one starts.
    for (let i = 0; i < 29; i++) expect(timings[i]!.endMs).toBe(timings[i + 1]!.startMs);
    // The final N-1 characters cannot carry an anchor, so the last end clamps
    // to the last anchor rather than overshooting the audio.
    const last = timings[29]!;
    expect(last.endMs).toBeLessThanOrEqual(HEAD_MS + 3000 * MS_PER_CHAR);
    expect(last.endMs).toBeGreaterThan(HEAD_MS + 2900 * MS_PER_CHAR);
  });

  it('gaps un-narrated text in the middle and keeps the text after it correct', () => {
    // The case whole-book DTW got catastrophically wrong: a block of book text
    // that is simply never spoken must not shift everything that follows.
    const before = randomText(1000, 2);
    const unNarrated = randomText(1000, 3);
    const after = randomText(1000, 4);

    const book = [
      ...sentencesOf(before, 100, 0),
      ...sentencesOf(unNarrated, 100, 10),
      ...sentencesOf(after, 100, 20),
    ];
    const heard = narrate(before + after);

    const { timings, stats } = matchChars(book, heard, { gapChars: 200 });

    expect(stats.implausible).toBe(false);

    // Narrated prose before the hole: exact.
    for (let i = 0; i < 10; i++) {
      const t = timings[i]!;
      expect(t.gap).toBe(false);
      expect(t.startMs).toBeCloseTo(HEAD_MS + i * 100 * MS_PER_CHAR, -1);
    }

    // The interior of the hole is further than gapChars from any anchor. Its
    // edges legitimately stay anchored to the prose either side of them.
    for (let i = 12; i < 18; i++) {
      const t = timings[i]!;
      expect(t.gap).toBe(true);
      expect(t.score).toBe(0);
    }

    // Prose after the hole: still exact, offset by the 1000 heard characters
    // that were actually spoken before it, NOT by its book position.
    for (let i = 20; i < 30; i++) {
      const t = timings[i]!;
      expect(t.gap).toBe(false);
      const heardPos = 1000 + (i - 20) * 100;
      expect(t.startMs).toBeCloseTo(HEAD_MS + heardPos * MS_PER_CHAR, -1);
    }
  });

  it('refuses an unrelated audio stream instead of returning sparse timings', () => {
    const book = sentencesOf(randomText(3000, 5), 100);
    const heard = narrate(randomText(3000, 6));

    const { timings, stats } = matchChars(book, heard);

    expect(stats.monotoneAnchors).toBe(0);
    expect(stats.anchorsPerKiloChar).toBe(0);
    expect(stats.implausible).toBe(true);
    expect(timings).toEqual([]);
    expect(stats.alignedSentences).toBe(0);
  });

  it('does not build a monotone match from reordered narration', () => {
    // Same prose, chapters read out of order: plenty of candidate anchors, but
    // the LIS can only keep one run of them.
    const blocks = Array.from({ length: 10 }, (_, i) => randomText(300, 100 + i));
    const book = sentencesOf(blocks.join(''), 100);
    const heard = narrate([...blocks].reverse().join(''));

    const { timings, stats } = matchChars(book, heard);

    expect(stats.candidateAnchors).toBeGreaterThan(2000);
    // One block's worth survives; anything near the candidate count would mean
    // the matcher had accepted a backwards jump.
    expect(stats.monotoneAnchors).toBeLessThan(stats.candidateAnchors * 0.25);
    expectNonDecreasing(timings);
  });

  it('keeps timings non-decreasing even when the decoder stamps go backwards', () => {
    const book = sentencesOf(randomText(3000, 7), 100);
    const heard = narrate(bookTextOf(book));
    // Corrupt a run of stamps into the past; a naive interpolation would emit a
    // sentence that starts before the one before it.
    for (let i = 1500; i < 1600; i++) heard[i]!.ms = 0;

    const { timings } = matchChars(book, heard);

    expectNonDecreasing(timings);
  });

  it('never emits a timing past the audio duration', () => {
    const book = sentencesOf(randomText(3000, 8), 100);
    const heard = narrate(bookTextOf(book));
    // The true duration wins over the decoder's stamps: a stamp beyond the file
    // is a decoder bug, and a player cannot seek there.
    const audioMs = 50_000;

    const { timings } = matchChars(book, heard, { audioMs });

    expect(timings).toHaveLength(30);
    for (const t of timings) {
      expect(t.startMs).toBeLessThanOrEqual(audioMs);
      expect(t.endMs).toBeLessThanOrEqual(audioMs);
      expect(t.endMs).toBeGreaterThanOrEqual(t.startMs);
    }
    expect(timings[29]!.endMs).toBe(audioMs);
  });

  it('reports when the n-gram index cap truncated the streams', () => {
    const book = sentencesOf(randomText(3000, 9), 100);
    const heard = narrate(bookTextOf(book));

    const capped = matchChars(book, heard, { maxIndexChars: 500, gapChars: 200 });

    expect(capped.stats.indexTruncated).toBe(true);
    // Only the indexed prefix can be anchored; the rest degrades to gaps rather
    // than to invented timings.
    expect(capped.timings[0]!.gap).toBe(false);
    expect(capped.timings[29]!.gap).toBe(true);
    expect(capped.stats.alignedSentences).toBeLessThan(15);

    const uncapped = matchChars(book, heard, { gapChars: 200 });
    expect(uncapped.stats.indexTruncated).toBe(false);
    expect(uncapped.stats.alignedSentences).toBe(30);
  });

  it('marks a sentence that romanized to nothing as a gap', () => {
    const text = randomText(1000, 10);
    const book = sentencesOf(text, 100);
    // e.g. a heading or a numerals-only line: no characters, so nothing to
    // prove the narrator ever read it.
    book.splice(5, 0, { index: 99, romanized: '' });
    book.forEach((s, i) => {
      if (s.index !== 99) s.index = i;
    });
    const heard = narrate(text);

    const { timings, stats } = matchChars(book, heard);

    const empty = timings.find((t) => t.index === 99)!;
    expect(empty.gap).toBe(true);
    expect(empty.score).toBe(0);
    expect(stats.alignedSentences).toBe(10);
  });

  it('scores by distance to the nearest anchor', () => {
    const narrated = randomText(600, 11);
    const silent = randomText(600, 12);
    const book = [...sentencesOf(narrated, 100, 0), ...sentencesOf(silent, 100, 6)];
    const heard = narrate(narrated);

    const { timings } = matchChars(book, heard, { gapChars: 400 });

    // On an anchor.
    expect(timings[0]!.score).toBeGreaterThan(0.99);
    // 100 characters past the last anchor, i.e. a quarter of the gap budget.
    expect(timings[6]!.score).toBeGreaterThan(0.6);
    expect(timings[6]!.score).toBeLessThan(1);
    // Beyond the budget.
    expect(timings[5 + 5]!.gap).toBe(true);
    expect(timings[5 + 5]!.score).toBe(0);
  });

  it('covers a chapter-break pause in the doubt it reports', () => {
    // The failure this pins down: interpolating between two anchors assumes a
    // constant reading rate, so a pause adds seconds without adding
    // characters and every sentence in the span is placed early by up to the
    // whole pause. Measuring the doubt as the distance to the nearer anchor
    // missed it entirely — a sentence a moment after a fifteen-second break
    // sits beside an anchor, so it reported almost no doubt while being
    // fifteen seconds out. `startMs - uncertaintyMs` is where a switch lands;
    // if that is AFTER the reader, they are shown text they have not reached.
    const CHARS = 3000;
    const SENTENCE = 100;
    // The pause sits just BEFORE the trailing anchors, which is the shape
    // that breaks: the sentences right before it are placed late by nearly
    // the whole pause while sitting close to an anchor, so a doubt measured
    // as "distance to the nearer anchor" reports almost none.
    const PAUSE_AT = 2550;
    const PAUSE_MS = 15_000;
    const text = randomText(CHARS, 21);
    const book = sentencesOf(text, SENTENCE);
    const trueMs = (charPos: number) =>
      HEAD_MS + charPos * MS_PER_CHAR + (charPos >= PAUSE_AT ? PAUSE_MS : 0);

    // Narrated in full, with a break in the middle...
    const full = [...text].map((c, i) => ({ c, ms: trueMs(i) }));
    // ...but only sampled at each end, which is what sparse probing leaves
    // behind and why the middle has to be interpolated at all.
    const heard = full.filter((_, i) => i < 400 || i >= CHARS - 400);

    const { timings } = matchChars(book, heard, {
      gapChars: CHARS,
      audioMs: trueMs(CHARS - 1) + MS_PER_CHAR,
    });

    const placed = timings.filter((t) => !t.gap);
    expect(placed.length).toBeGreaterThan(20);
    const late = placed.filter((t) => {
      const truth = trueMs((t.index - book[0]!.index) * SENTENCE);
      // Landing early is a nuisance; landing late is a spoiler.
      return t.startMs - t.uncertaintyMs > truth;
    });
    expect(late).toEqual([]);

    // And the doubt has to be real, not merely large enough: a sentence in
    // the interpolated span must not claim to be exactly placed.
    const inSpan = placed.filter((t) => {
      const at = (t.index - book[0]!.index) * SENTENCE;
      return at > 600 && at < PAUSE_AT;
    });
    expect(inSpan.length).toBeGreaterThan(5);
    expect(Math.min(...inSpan.map((t) => t.uncertaintyMs))).toBeGreaterThan(PAUSE_MS * 0.5);
  });

  it('refuses empty input on either side', () => {
    const book = sentencesOf(randomText(1000, 13), 100);

    expect(matchChars([], narrate('abc')).stats.implausible).toBe(true);
    expect(matchChars([], narrate('abc')).timings).toEqual([]);

    const noAudio = matchChars(book, []);
    expect(noAudio.stats.heardChars).toBe(0);
    expect(noAudio.stats.monotoneAnchors).toBe(0);
    expect(noAudio.stats.implausible).toBe(true);
    expect(noAudio.timings).toEqual([]);
  });

  it('reports the character ratio the caller uses as a sanity check', () => {
    const text = randomText(2000, 14);
    const book = sentencesOf(text, 100);
    // The decoder drops what is not in its vocabulary (digits, abbreviations);
    // on real narration this lands around 0.94.
    const heard = narrate(text.slice(0, 1800));

    const { stats } = matchChars(book, heard);

    expect(stats.charRatio).toBeCloseTo(0.9, 5);
  });
});

function expectNonDecreasing(timings: { startMs: number; endMs: number }[]): void {
  let floor = -1;
  for (const t of timings) {
    expect(t.startMs).toBeGreaterThanOrEqual(floor);
    expect(t.endMs).toBeGreaterThanOrEqual(t.startMs);
    floor = t.startMs;
  }
}
