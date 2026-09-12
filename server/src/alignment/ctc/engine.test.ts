import { describe, expect, it } from 'vitest';
import { segmentsFromTimings, type EbookSentenceInput } from '../timings.js';
import { matchChars, type BookSentence } from './anchors.js';
import {
  type DecodedBook,
  type DecodedChar,
  type EmissionOptions,
  type ProbeDecoder,
  type ProbeDecoderOptions,
  type ProbeWindow,
} from './emissions.js';
import {
  alignWithCtc,
  AlignmentRefusedError,
  EXACT_SCORE,
  EXACT_UNCERTAINTY_MS,
} from './engine.js';
import { romanize } from './romanize.js';
import { type SparsePlan } from './sparse.js';

/**
 * Engine-level tests for forced alignment.
 *
 * The acoustic model is stubbed out through `CtcAlignRequest.decode`, so these
 * exercise everything the engine itself decides — romanization, anchoring,
 * refusal, gaps, the handover to the shared timing layer and the progress
 * mapping — without the 317 MB aligner or onnxruntime.
 *
 * The stub is not a recording: the "heard" stream is BUILT FROM THE BOOK'S OWN
 * romanized characters at a known rate and offset, which is what makes a
 * per-sentence millisecond assertion possible at all. The real decode differs
 * in ways this cannot model (substitutions, a ~0.94 character ratio), and the
 * evidence that the engine survives those is the measured run on real
 * narration recorded in docs, not this file.
 */

/** Romanized characters per second. Real narration measured ~12–16. */
const CPS = 15;
/** Silence, a publisher's credit, anything before the first sentence is read. */
const OFFSET_MS = 4_000;
/** Millisecond slack allowed against the synthetic truth. */
const TOLERANCE_MS = 50;
/**
 * Silence after the last sentence. Longer than the shared timing layer's
 * 15 s gap threshold, so the trailing narration-only gap is observable.
 */
const TAIL_SILENCE_MS = 30_000;

/** Deterministic PRNG: the same book every run, on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Book {
  sentences: EbookSentenceInput[];
  text: string[];
}

/**
 * A book of nonsense words. Nonsense on purpose: the anchor matcher keys on
 * 14-grams that occur exactly once on each side, and real prose repeats
 * phrases, so random letters give a clean signal for a test that is about the
 * engine's plumbing rather than about anchor quality.
 */
function makeBook(seed: number, sentenceCount: number): Book {
  const rnd = mulberry32(seed);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const text: string[] = [];
  for (let s = 0; s < sentenceCount; s++) {
    const words: string[] = [];
    const wordCount = 8 + Math.floor(rnd() * 7);
    for (let w = 0; w < wordCount; w++) {
      const len = 4 + Math.floor(rnd() * 6);
      let word = '';
      for (let i = 0; i < len; i++) word += letters[Math.floor(rnd() * letters.length)];
      words.push(word);
    }
    text.push(`${words.join(' ')}.`);
  }
  const sentences: EbookSentenceInput[] = text.map((t, i) => ({
    sentenceId: `s${i}`,
    spineIdx: 0,
    sentenceOrd: i,
    tokens: t.replace(/\./g, '').split(' ').filter(Boolean),
  }));
  return { sentences, text };
}

interface Narration {
  chars: DecodedChar[];
  /** Truth per sentence, or null for one the narrator never read. */
  truth: ({ startMs: number; endMs: number } | null)[];
  audioMs: number;
}

/**
 * Read the book aloud at `CPS`, starting at `OFFSET_MS`. Sentences in the
 * half-open `skip` range are not read at all and take no audio time — which is
 * exactly what front matter, a dedication or an index does to a real
 * audiobook.
 */
function narrate(text: string[], opts: { skip?: [number, number] } = {}): Narration {
  const chars: DecodedChar[] = [];
  const truth: ({ startMs: number; endMs: number } | null)[] = [];
  const at = (charIndex: number): number => OFFSET_MS + Math.round((charIndex / CPS) * 1000);
  let heard = 0;
  for (let s = 0; s < text.length; s++) {
    if (opts.skip && s >= opts.skip[0] && s < opts.skip[1]) {
      truth.push(null);
      continue;
    }
    const start = heard;
    for (const c of romanize(text[s]!, 'en')) {
      chars.push({ c, ms: at(heard) });
      heard++;
    }
    truth.push({ startMs: at(start), endMs: at(heard) });
  }
  return { chars, truth, audioMs: at(heard) + TAIL_SILENCE_MS };
}

const FAKE_MODEL = 'mms-fa/model_int8.onnx';

/** A decode that returns a prepared stream, reporting progress as the real one does. */
function fakeDecode(n: Narration): (opts: EmissionOptions) => Promise<DecodedBook> {
  return async (opts: EmissionOptions): Promise<DecodedBook> => {
    for (const f of [0.25, 0.5, 0.75, 1]) {
      opts.onProgress?.({ doneMs: Math.round(n.audioMs * f), totalMs: n.audioMs });
    }
    return { chars: n.chars, audioMs: n.audioMs, model: FAKE_MODEL };
  };
}

function request(book: Book, n: Narration, onProgress?: (f: number, detail: string) => void) {
  return {
    // Unused once `decode` is injected, but present so the call is the shape
    // runAlign actually makes.
    modelPath: '/models/mms-fa/model_int8.onnx',
    vocabPath: '/models/mms-fa/vocab.json',
    trackPaths: ['/library/audio/book.m4b'],
    trackStartMs: [0],
    language: 'en',
    sentences: book.sentences,
    sentenceText: book.text,
    threads: 2,
    decode: fakeDecode(n),
    onProgress,
  };
}

/** Segments, indexed by the ordinal their sentence id encodes. */
function byOrd(segments: { sentenceId: string }[]): Map<number, (typeof segments)[number]> {
  return new Map(segments.map((s) => [Number(s.sentenceId.slice(1)), s]));
}

describe('alignWithCtc', () => {
  it('recovers the narration offset and rate as per-sentence timings', async () => {
    const book = makeBook(1, 200);
    const heard = narrate(book.text);

    const out = await alignWithCtc(request(book, heard));

    expect(out.model).toBe(FAKE_MODEL);
    expect(out.audioMs).toBe(heard.audioMs);
    expect(out.stats.implausible).toBe(false);
    // Every sentence is narrated here, so nothing should be missing.
    expect(out.result.coverage).toBeGreaterThan(0.99);

    const placed = byOrd(out.result.segments);
    for (let i = 0; i < book.sentences.length; i++) {
      const seg = placed.get(i);
      expect(seg, `sentence ${i} was not timed`).toBeDefined();
      const truth = heard.truth[i]!;
      expect(Math.abs(seg!.startMs - truth.startMs)).toBeLessThanOrEqual(TOLERANCE_MS);
      expect(seg!.endMs).toBeGreaterThanOrEqual(seg!.startMs);
    }
    // The first sentence is where the 4 s offset shows up unambiguously: an
    // engine that assumed text position is proportional to audio position
    // would start it at 0.
    expect(placed.get(0)!.startMs).toBeGreaterThan(OFFSET_MS - TOLERANCE_MS);

    // Dense anchors mean almost everything is claimed as an acoustic match
    // rather than as interpolation between two of them.
    const exact = out.result.segments.filter((s) => s.source === 'exact').length;
    expect(exact / out.result.segments.length).toBeGreaterThan(0.95);
  });

  it('REFUSES a pairing whose audio narrates a different book', async () => {
    const book = makeBook(2, 200);
    // Same length, same language, same rate — only the words differ, which is
    // all that separates a wrong edition from a right one.
    const other = makeBook(999, 200);
    const heard = narrate(other.text);

    const err = await alignWithCtc(request(book, heard)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AlignmentRefusedError);
    const refusal = err as AlignmentRefusedError;
    expect(refusal.code).toBe('alignment-refused');
    // The operator has to be able to act on this without reading the source.
    expect(refusal.message).toContain('does not appear to narrate this ebook');
    expect(refusal.message).toContain('the same work');
    expect(refusal.message).not.toMatch(/undefined|NaN|\[object/);
    expect(refusal.stats.implausible).toBe(true);
    expect(refusal.stats.monotoneAnchors).toBeLessThan(10);
  });

  it('leaves un-narrated text as a hole and picks the timing back up after it', async () => {
    const book = makeBook(3, 600);
    // ~10,000 characters the narrator never reads. It has to be wide: a
    // sentence only becomes a gap once every anchor is more than `gapChars`
    // (3,000) away from it.
    const skip: [number, number] = [200, 340];
    const heard = narrate(book.text, { skip });

    const out = await alignWithCtc(request(book, heard));

    expect(out.stats.implausible).toBe(false);
    const placed = byOrd(out.result.segments);

    // Deep inside the hole nothing is claimed at all.
    for (let i = 250; i < 290; i++) {
      expect(placed.get(i), `sentence ${i} sits in un-narrated text`).toBeUndefined();
    }
    // Before it, and again after it, the timings are the truth — the hole did
    // not drag the mapping off, which is the whole point of anchoring rather
    // than warping the book onto the audio.
    for (const i of [0, 50, 150, 199, 340, 400, 500, 599]) {
      const seg = placed.get(i);
      expect(seg, `sentence ${i} was not timed`).toBeDefined();
      expect(Math.abs(seg!.startMs - heard.truth[i]!.startMs)).toBeLessThanOrEqual(TOLERANCE_MS);
    }
    // The hole is visible in the summary rather than papered over.
    expect(out.result.coverage).toBeLessThan(0.9);
    expect(out.stats.alignedSentences).toBeLessThan(book.sentences.length);
  });

  it('builds its segments with segmentsFromTimings and nothing else', async () => {
    const book = makeBook(4, 300);
    const heard = narrate(book.text, { skip: [100, 240] });

    const out = await alignWithCtc(request(book, heard));

    // The engine may not mint a segment shape of its own: replay the same
    // inputs through the shared constructor and demand an identical result.
    const romanized: BookSentence[] = book.text.map((t, i) => ({
      index: i,
      romanized: romanize(t, 'en'),
    }));
    const { timings } = matchChars(romanized, heard.chars, { audioMs: heard.audioMs });
    const byIndex = new Map(timings.map((t) => [t.index, t]));
    const expected = segmentsFromTimings(
      book.sentences,
      (i) => {
        const t = byIndex.get(i);
        if (!t || t.gap) return null;
        return {
          startMs: t.startMs,
          endMs: t.endMs,
          score: t.score,
          exact: t.score >= EXACT_SCORE && t.uncertaintyMs <= EXACT_UNCERTAINTY_MS,
          uncertaintyMs: t.uncertaintyMs,
        };
      },
      { audioMs: heard.audioMs },
    );
    expect(out.result).toEqual(expected);

    // The audio outlives the text by half a minute, and that has to reach the
    // shared layer: it is the only thing that can report the tail as a gap
    // rather than leaving the player to run past the last sentence blind.
    const tail = out.result.gaps.at(-1);
    expect(tail).toBeDefined();
    expect(tail!.toMs).toBe(heard.audioMs);
    expect(tail!.reason).toBe('narration-only');

    // And the properties that layer exists to guarantee, asserted directly so
    // a change to both sides at once still trips something.
    let prev = -1;
    for (const s of out.result.segments) {
      expect(s.startMs).toBeGreaterThanOrEqual(0);
      expect(s.startMs).toBeGreaterThanOrEqual(prev);
      expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
      expect(s.endMs).toBeLessThanOrEqual(heard.audioMs);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(['exact', 'fuzzy', 'interpolated']).toContain(s.source);
      prev = s.startMs;
    }
  });

  it('reports progress that only ever rises, and ends on the matching stage', async () => {
    const book = makeBook(5, 120);
    const heard = narrate(book.text);
    const reported: { fraction: number; detail: string }[] = [];

    await alignWithCtc(
      request(book, heard, (fraction, detail) => reported.push({ fraction, detail })),
    );

    expect(reported.length).toBeGreaterThan(2);
    expect(reported[0]!.fraction).toBe(0);
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i]!.fraction).toBeGreaterThanOrEqual(reported[i - 1]!.fraction);
    }
    expect(reported.at(-1)!.fraction).toBeGreaterThanOrEqual(0.97);
    expect(reported.at(-1)!.fraction).toBeLessThanOrEqual(1);
    // The decode owns the wall clock, so its share must dominate the bar.
    expect(reported.some((r) => r.detail.includes('Listening to the narration'))).toBe(true);
    expect(reported.at(-1)!.detail).toContain('Matching the narration to the text');
    for (const r of reported) expect(r.detail.trim().length).toBeGreaterThan(0);
  });

  it('refuses a book whose text romanizes to nothing rather than timing it', async () => {
    const book = makeBook(6, 20);
    const empty: Book = {
      sentences: book.sentences,
      // Punctuation and whitespace only: the aligner's alphabet has nothing to
      // anchor on, and a "0 % coverage" alignment would be worse than an error.
      text: book.text.map(() => '— … !?'),
    };
    const heard = narrate(book.text);

    await expect(alignWithCtc(request(empty, heard))).rejects.toThrow(
      /no alignable text for this language/i,
    );
  });
});

/**
 * Sparse decoding, driven through the same synthetic narration.
 *
 * The fake probe decoder hears exactly what the schedule asks it to hear and
 * nothing else, so these tests measure the real cost of listening to a
 * fraction of a book: how much audio goes through the model, and how far the
 * resulting sentence times drift from the truth in between.
 */
function fakeProbeDecoder(
  n: Narration,
  seen: ProbeWindow[] = [],
): (opts: ProbeDecoderOptions) => Promise<ProbeDecoder> {
  return async (): Promise<ProbeDecoder> => ({
    model: FAKE_MODEL,
    audioMs: n.audioMs,
    async decode(windows, onWindow) {
      return windows.map((w, i) => {
        seen.push(w);
        onWindow?.(i + 1, windows.length);
        const hi = w.startMs + w.durationMs;
        return n.chars.filter((c) => c.ms >= w.startMs && c.ms < hi);
      });
    },
    async close() {},
  });
}

function sparseRequest(
  book: Book,
  n: Narration,
  plan: SparsePlan,
  seen?: ProbeWindow[],
  onProgress?: (f: number, detail: string) => void,
) {
  return { ...request(book, n, onProgress), plan, openDecoder: fakeProbeDecoder(n, seen) };
}

describe('alignWithCtc, sampling the narration', () => {
  /** 15 characters per second over 400 sentences is a little over an hour. */
  const PLAN: SparsePlan = {
    windowMs: 8_000,
    everyMs: 120_000,
    refineRounds: 2,
    rateTolerance: 0.2,
    refineBudget: 0.6,
  };

  it('times the whole book after listening to a fraction of it', async () => {
    const book = makeBook(11, 400);
    const heard = narrate(book.text);
    const seen: ProbeWindow[] = [];

    const out = await alignWithCtc(sparseRequest(book, heard, PLAN, seen));

    // The point of the exercise: a small share of the audio through the model.
    expect(out.decodedMs).toBeLessThan(heard.audioMs * 0.15);
    expect(out.probes).toBe(seen.length);
    expect(out.audioMs).toBe(heard.audioMs);
    expect(out.stats.implausible).toBe(false);
    // And still a timing for nearly every sentence.
    expect(out.result.coverage).toBeGreaterThan(0.95);

    const placed = byOrd(out.result.segments);
    for (let i = 0; i < book.sentences.length; i++) {
      const seg = placed.get(i);
      if (!seg) continue;
      const truth = heard.truth[i]!;
      // Steady narration between anchors interpolates almost exactly; the
      // slack here is for the sentences that fall between two probes.
      expect(Math.abs(seg.startMs - truth.startMs)).toBeLessThan(20_000);
      // Whatever the error, the segment has to own up to it: the handoff
      // subtracts exactly this, and that is the only reason a switch cannot
      // land ahead of the reader.
      expect(seg.startMs - seg.uncertaintyMs).toBeLessThanOrEqual(truth.startMs);
    }
  });

  it('admits more uncertainty the further a sentence sits from a probe', async () => {
    const book = makeBook(12, 400);
    const heard = narrate(book.text);
    const seen: ProbeWindow[] = [];

    const out = await alignWithCtc(sparseRequest(book, heard, PLAN, seen));
    const inProbe = (ms: number) =>
      seen.some((w) => ms >= w.startMs && ms < w.startMs + w.durationMs);

    const heardDirectly = out.result.segments.filter((s) => inProbe(s.startMs));
    const guessed = out.result.segments.filter((s) => !inProbe(s.startMs));
    expect(heardDirectly.length).toBeGreaterThan(0);
    expect(guessed.length).toBeGreaterThan(0);
    expect(mean(heardDirectly.map((s) => s.uncertaintyMs))).toBeLessThan(
      mean(guessed.map((s) => s.uncertaintyMs)),
    );
    // Whatever the schedule, the claim has to cover the actual error — that is
    // the only thing standing between a reader and a switch that spoils the
    // next paragraph.
    for (const s of out.result.segments) {
      const truth = heard.truth[Number(s.sentenceId.slice(1))];
      if (!truth) continue;
      expect(s.startMs - s.uncertaintyMs).toBeLessThanOrEqual(truth.startMs);
    }
  });

  it('spends its second pass on the stretch where the narrator paused', async () => {
    // A book read straight through, except for two minutes of silence in the
    // middle — the shape of a chapter break, and the one thing interpolation
    // between two distant anchors cannot see.
    const book = makeBook(13, 400);
    const heard = narrate(book.text);
    const pauseAt = Math.round(heard.audioMs / 2);
    const PAUSE_MS = 120_000;
    for (const c of heard.chars) if (c.ms >= pauseAt) c.ms += PAUSE_MS;
    for (const t of heard.truth) {
      if (t && t.startMs >= pauseAt) {
        t.startMs += PAUSE_MS;
        t.endMs += PAUSE_MS;
      }
    }
    heard.audioMs += PAUSE_MS;

    const seen: ProbeWindow[] = [];
    await alignWithCtc(sparseRequest(book, heard, PLAN, seen));

    const grid = Math.ceil(heard.audioMs / PLAN.everyMs);
    const extra = seen.slice(grid);
    expect(extra.length).toBeGreaterThan(0);
    // The refinement probes cluster on the pause rather than spreading evenly.
    const nearPause = extra.filter(
      (w) => Math.abs(w.startMs - (pauseAt + PAUSE_MS / 2)) < PLAN.everyMs,
    );
    expect(nearPause.length).toBeGreaterThan(0);
  });

  it('still refuses audio that narrates a different book', async () => {
    const book = makeBook(14, 300);
    const other = makeBook(15, 300);
    const heard = narrate(other.text);

    await expect(alignWithCtc(sparseRequest(book, heard, PLAN))).rejects.toBeInstanceOf(
      AlignmentRefusedError,
    );
  });

  it('closes the decoder even when the match is refused', async () => {
    const book = makeBook(16, 300);
    const heard = narrate(makeBook(17, 300).text);
    let closed = false;
    const req = {
      ...request(book, heard),
      plan: PLAN,
      openDecoder: async (): Promise<ProbeDecoder> => ({
        model: FAKE_MODEL,
        audioMs: heard.audioMs,
        async decode(windows: ProbeWindow[]) {
          return windows.map((w) =>
            heard.chars.filter((c) => c.ms >= w.startMs && c.ms < w.startMs + w.durationMs),
          );
        },
        async close() {
          closed = true;
        },
      }),
    };
    await expect(alignWithCtc(req)).rejects.toBeInstanceOf(AlignmentRefusedError);
    expect(closed).toBe(true);
  });

  it('reports progress that only ever rises, across both passes', async () => {
    const book = makeBook(18, 400);
    const heard = narrate(book.text);
    const reported: number[] = [];

    await alignWithCtc(sparseRequest(book, heard, PLAN, [], (fraction) => reported.push(fraction)));

    expect(reported.length).toBeGreaterThan(5);
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i]).toBeGreaterThanOrEqual(reported[i - 1]!);
    }
    expect(reported.at(-1)).toBeGreaterThanOrEqual(0.97);
    expect(reported.at(-1)).toBeLessThanOrEqual(1);
  });
});

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
