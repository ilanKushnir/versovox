import { NgramIndex } from './ngram-index.js';

/**
 * Character-anchor matcher for CTC forced alignment.
 *
 * The CTC model emits one continuous romanized character stream with a
 * millisecond stamp per character (no word/space token). This module pairs that
 * stream against the ebook's romanized characters and derives per-sentence
 * timings.
 *
 * Method (validated on a 67-minute human-narrated audiobook, 880 sentences /
 * 48,961 romanized characters: 18,913 candidate anchors, 18,902 monotone after
 * LIS, 830/880 sentences aligned, 8/8 spot checks on the correct sentence):
 *
 *  1. Concatenate the sentences into one book string, remembering which span
 *     belongs to which sentence.
 *  2. Take every N-gram (N=14) of both strings and keep only the grams that
 *     occur EXACTLY ONCE on each side. Those pairs are candidate anchors —
 *     unambiguous by construction, so no similarity threshold is needed.
 *  3. A longest increasing subsequence over the heard positions throws away the
 *     candidates that would require the narrator to jump backwards.
 *  4. Linear interpolation between consecutive anchors maps any book character
 *     position to a millisecond; positions outside the anchor range clamp.
 *  5. A sentence whose nearest anchor is further away than `gapChars` is
 *     reported as a gap rather than a timing.
 *
 * Why anchors rather than a global forced alignment or DTW: this makes no
 * proportionality assumption between book position and audio time. Front
 * matter, credits, headings and any other un-narrated text simply produce no
 * anchors, so they become gaps instead of dragging the whole mapping off (the
 * failure mode measured on the DTW prototype, where every spot check landed on
 * the wrong sentence).
 *
 * Pure: no I/O, no clock, deterministic for a given input.
 */

/** One decoded character with the timestamp of the frame that emitted it. */
export interface HeardChar {
  c: string;
  ms: number;
}

/** One ebook sentence, already romanized to the model's character set. */
export interface BookSentence {
  index: number;
  romanized: string;
}

export interface SentenceTiming {
  index: number;
  startMs: number;
  endMs: number;
  /** 1 at an anchor, falling linearly to 0 at `gapChars` away. 0 for gaps. */
  score: number;
  /** True when no anchor is near enough for the timing to be trustworthy. */
  gap: boolean;
  /**
   * How far `startMs` could be wrong, in milliseconds. Zero on an anchor and
   * growing with the audio distance to the nearest one, because everything
   * between two anchors is interpolation and interpolation assumes a steady
   * reading rate that a pause, a chapter break or a page of front matter
   * quietly breaks. The reader subtracts this before a switch, so a handoff
   * lands on narration already read rather than ahead of it.
   */
  uncertaintyMs: number;
}

/** One place where the decoded audio and the book text provably agree. */
export interface Anchor {
  /** Character offset into the concatenated book text. */
  bookPos: number;
  /** Absolute millisecond in the book's audio. */
  ms: number;
}

export interface MatchStats {
  bookChars: number;
  heardChars: number;
  /** heard/book. ~0.94 on real narration; digits and abbreviations decode short. */
  charRatio: number;
  candidateAnchors: number;
  monotoneAnchors: number;
  anchorsPerKiloChar: number;
  alignedSentences: number;
  /**
   * The pairing is not credible: too few monotone anchors for the book's
   * length. This is the refusal signal — a wrong book/audio pairing produces
   * near-zero anchors, where a correct one produced ~386 per 1000 characters.
   */
  implausible: boolean;
  /**
   * The decoded stream was longer than `maxIndexChars` and only a prefix of it
   * was indexed. Reaching this means a whole-book decode of an audiobook
   * longer than any that exists; the ebook side has no such limit.
   */
  indexTruncated: boolean;
}

export interface MatchOptions {
  /** N-gram length used for anchoring. 14 is the validated value. */
  ngram?: number;
  /** Distance (in book characters) to the nearest anchor beyond which a sentence is a gap. */
  gapChars?: number;
  /** True audio duration. Timings are clamped to it; defaults to the last heard stamp. */
  audioMs?: number;
  /** Below this anchor density the pairing is refused outright. */
  minAnchorsPerKiloChar?: number;
  /** Memory guard on the decoded side, which is the only side that is indexed. */
  maxIndexChars?: number;
  /**
   * Fraction of the audio distance to the nearest anchor that a timing may be
   * wrong by. See {@link SentenceTiming.uncertaintyMs}.
   */
  uncertaintyRate?: number;
  /** Floor under every uncertainty, covering frame quantisation and seek error. */
  uncertaintyBaseMs?: number;
}

export interface MatchResult {
  timings: SentenceTiming[];
  stats: MatchStats;
  /**
   * The monotone anchor set the timings were interpolated from, in book order.
   * Exposed so a sparse decode can see where its evidence actually is and
   * spend another probe where the narration rate says something happened.
   */
  anchors: Anchor[];
}

const DEFAULT_NGRAM = 14;
const DEFAULT_GAP_CHARS = 3000;
const DEFAULT_MIN_ANCHORS_PER_KILOCHAR = 2;
/**
 * Uncertainty slope and floor, measured rather than chosen. Against a
 * contiguous decode of a real 67-minute audiobook, sampled every 150 seconds:
 * signed error ran from -19.8 s to +8.8 s with a median of -0.5 s, and this
 * slope covered all but 11 of 817 sentences. The floor covers the rest — the
 * sentences sitting right on an anchor, where the residual is frame
 * quantisation, the seek, and the reference's own imprecision rather than
 * anything this module can model.
 */
const DEFAULT_UNCERTAINTY_RATE = 0.15;
const DEFAULT_UNCERTAINTY_BASE_MS = 2_000;
/**
 * Cap on the DECODED side only. Each indexed position costs sixteen bytes of
 * typed array at a load factor of one half, so this ceiling is ~130 MB and is
 * only ever approached by a whole-book decode of a book of about 180 hours.
 * Sampling a six-hour audiobook indexes about 90,000 characters — under 3 MB.
 * The ebook is streamed past the index rather than indexed, so its length is
 * unbounded.
 */
const DEFAULT_MAX_INDEX_CHARS = 8_000_000;

/**
 * Match the decoded character stream against the book's romanized characters.
 *
 * When the match is implausible the timings are withheld entirely (empty
 * array) rather than returned sparse: a caller that trusted a handful of
 * coincidental anchors would scatter the reader across the wrong audio. The
 * `implausible` flag says why, so the caller can surface the refusal.
 */
export function matchChars(
  book: BookSentence[],
  heard: HeardChar[],
  opts: MatchOptions = {},
): MatchResult {
  const ngram = Math.max(1, Math.trunc(opts.ngram ?? DEFAULT_NGRAM));
  const gapChars = Math.max(1, opts.gapChars ?? DEFAULT_GAP_CHARS);
  const minDensity = Math.max(0, opts.minAnchorsPerKiloChar ?? DEFAULT_MIN_ANCHORS_PER_KILOCHAR);
  const maxIndexChars = Math.max(ngram, Math.trunc(opts.maxIndexChars ?? DEFAULT_MAX_INDEX_CHARS));
  const uncertaintyRate = Math.max(0, opts.uncertaintyRate ?? DEFAULT_UNCERTAINTY_RATE);
  const uncertaintyBaseMs = Math.max(0, opts.uncertaintyBaseMs ?? DEFAULT_UNCERTAINTY_BASE_MS);

  // --- 1. one book string, plus the span each sentence owns ---
  const spans: { start: number; end: number }[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const s of book) {
    const start = cursor;
    cursor += s.romanized.length;
    spans.push({ start, end: cursor });
    pieces.push(s.romanized);
  }
  const bookText = pieces.join('');

  // Heard side. A decoder entry is normally a single character, but we expand
  // defensively so that a multi-character entry cannot desynchronise positions
  // from stamps. The running max hardens the later monotonicity guarantee
  // against a decoder that emits a stamp out of order.
  let heardText = '';
  const heardMs: number[] = [];
  let lastMs = 0;
  for (const h of heard) {
    lastMs = Math.max(lastMs, h.ms);
    heardText += h.c;
    for (let i = 0; i < h.c.length; i++) heardMs.push(lastMs);
  }

  const durationMs = Math.max(0, opts.audioMs ?? lastMs);

  // --- 2. candidate anchors: grams unique on both sides ---
  // Indexed on the heard side and streamed on the book side. Under sampling
  // the heard stream is a few tens of thousands of characters against a book's
  // million-plus, so this is both the small index and the one that bounds
  // memory; the book is never truncated.
  const indexTruncated = heardText.length > maxIndexChars;
  const index = new NgramIndex(heardText, ngram, maxIndexChars);
  const pairs = index
    .matchAgainst(bookText)
    .map((m) => ({ b: m.b, h: m.a }))
    // The scan runs in book order already, but the sort makes the LIS
    // precondition explicit rather than incidental.
    .sort((x, y) => x.b - y.b);

  // --- 3. LIS over the heard positions enforces narration order ---
  const anchors = longestIncreasingByHeard(pairs);
  const anchorBook = anchors.map((a) => a.b);
  const anchorMs = anchors.map((a) => heardMs[a.h] ?? 0);

  const density = bookText.length > 0 ? (anchors.length * 1000) / bookText.length : 0;
  const stats: MatchStats = {
    bookChars: bookText.length,
    heardChars: heardText.length,
    charRatio: bookText.length > 0 ? heardText.length / bookText.length : 0,
    candidateAnchors: pairs.length,
    monotoneAnchors: anchors.length,
    anchorsPerKiloChar: density,
    alignedSentences: 0,
    // An empty book has nothing to verify against, so it can never be credible.
    implausible: bookText.length === 0 || density < minDensity,
    indexTruncated,
  };

  const anchorList: Anchor[] = anchorBook.map((bookPos, i) => ({ bookPos, ms: anchorMs[i]! }));
  if (stats.implausible) return { timings: [], stats, anchors: anchorList };

  // Fallback for positions clamped outside the anchor span, where there is no
  // bracketing pair to measure a time distance against.
  const msPerChar =
    anchorBook.length > 1
      ? Math.max(
          0,
          (anchorMs[anchorMs.length - 1]! - anchorMs[0]!) /
            Math.max(1, anchorBook[anchorBook.length - 1]! - anchorBook[0]!),
        )
      : 0;

  // --- 4 + 5. interpolate, then gate on anchor distance ---
  const timings: SentenceTiming[] = [];
  let floorMs = 0;
  for (let i = 0; i < book.length; i++) {
    const span = spans[i]!;
    const length = span.end - span.start;
    const dist = nearestAnchorDistance(anchorBook, span.start);
    // Measured from the sentence start, as validated. An empty sentence (a
    // heading, or one that romanized to nothing) has no characters to anchor,
    // so we never claim a timing for it.
    const gap = length === 0 || anchorBook.length === 0 || dist > gapChars;

    let startMs = clamp(msAtBookPos(anchorBook, anchorMs, span.start), 0, durationMs);
    // Monotone in position by construction; the running floor makes it a
    // guarantee the caller can rely on rather than a property of the anchors.
    startMs = Math.max(startMs, floorMs);
    const endMs = Math.max(
      startMs,
      clamp(msAtBookPos(anchorBook, anchorMs, span.end), 0, durationMs),
    );
    floorMs = startMs;

    // Measured on the interpolated timing, not the floored one: the floor only
    // ever moves a start later, and a start pushed later is exactly the case
    // the reader must be protected from.
    const reach = anchorTimeDistance(anchorMs, anchorBook, span.start, dist, msPerChar);
    // Between two anchors the timing is an interpolation and only the drift in
    // reading rate is in doubt. Outside them it is not an interpolation at all
    // — it is the edge anchor's time, held, while the narration kept going —
    // so the whole extrapolated distance is the error.
    const doubt = reach.clamped ? reach.ms : uncertaintyRate * reach.ms;
    timings.push({
      index: book[i]!.index,
      startMs,
      endMs,
      score: gap ? 0 : Math.max(0, 1 - dist / gapChars),
      gap,
      uncertaintyMs: Math.round(uncertaintyBaseMs + doubt),
    });
  }
  stats.alignedSentences = timings.reduce((n, t) => n + (t.gap ? 0 : 1), 0);

  return { timings, stats, anchors: anchorList };
}

/**
 * Longest strictly increasing subsequence of heard positions, over pairs that
 * are already sorted by book position. Patience sorting, O(n log n).
 */
function longestIncreasingByHeard(pairs: { b: number; h: number }[]): { b: number; h: number }[] {
  if (pairs.length === 0) return [];
  const tails: number[] = []; // tails[k] = smallest heard pos ending a run of length k+1
  const tailIdx: number[] = []; // index into pairs of that run's last element
  const prev = new Array<number>(pairs.length).fill(-1);

  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i]!.h;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
    tailIdx[lo] = i;
  }

  const out: { b: number; h: number }[] = [];
  let k = tailIdx[tails.length - 1] ?? -1;
  while (k >= 0) {
    out.push(pairs[k]!);
    k = prev[k]!;
  }
  out.reverse();
  return out;
}

/** Linear interpolation between the bracketing anchors; clamps outside them. */
function msAtBookPos(anchorBook: number[], anchorMs: number[], pos: number): number {
  const last = anchorBook.length - 1;
  if (last < 0) return 0;
  if (pos <= anchorBook[0]!) return anchorMs[0]!;
  if (pos >= anchorBook[last]!) return anchorMs[last]!;

  // Greatest i with anchorBook[i] <= pos.
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! <= pos) lo = mid;
    else hi = mid;
  }
  const b0 = anchorBook[lo]!;
  const b1 = anchorBook[hi]!;
  const m0 = anchorMs[lo]!;
  const m1 = anchorMs[hi]!;
  const f = (pos - b0) / Math.max(1, b1 - b0);
  return Math.round(m0 + f * (m1 - m0));
}

/**
 * Milliseconds of audio between `pos` and the nearer of its two bracketing
 * anchors — the span over which the interpolation is unverified.
 *
 * Character distance is not a usable proxy: 500 characters is two seconds of
 * brisk narration or twenty across a chapter break, and it is the seconds that
 * decide how far a switch can land from where the reader expected. Outside the
 * anchored range there is no bracketing pair, so the char distance is converted
 * at the book's average rate instead.
 */
function anchorTimeDistance(
  anchorMs: number[],
  anchorBook: number[],
  pos: number,
  charDist: number,
  msPerChar: number,
): { ms: number; clamped: boolean } {
  const last = anchorBook.length - 1;
  if (last < 0) return { ms: 0, clamped: false };
  if (pos <= anchorBook[0]! || pos >= anchorBook[last]!) {
    return { ms: charDist * msPerChar, clamped: true };
  }
  let lo = 0;
  let hi = last;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! <= pos) lo = mid;
    else hi = mid;
  }
  const b0 = anchorBook[lo]!;
  const b1 = anchorBook[hi]!;
  const m0 = anchorMs[lo]!;
  const m1 = anchorMs[hi]!;
  const f = (pos - b0) / Math.max(1, b1 - b0);
  const ms = m0 + f * (m1 - m0);
  return { ms: Math.max(0, Math.min(ms - m0, m1 - ms)), clamped: false };
}

/** Characters from `pos` to the closest anchor, or Infinity when there are none. */
function nearestAnchorDistance(anchorBook: number[], pos: number): number {
  if (anchorBook.length === 0) return Infinity;
  let lo = 0;
  let hi = anchorBook.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchorBook[mid]! < pos) lo = mid + 1;
    else hi = mid;
  }
  const after = lo < anchorBook.length ? anchorBook[lo]! - pos : Infinity;
  const before = lo > 0 ? pos - anchorBook[lo - 1]! : Infinity;
  return Math.min(after, before);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
