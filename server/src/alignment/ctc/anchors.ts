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
 *  2. Index every N-gram (N=14) of both strings and keep only the grams that
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
   * The n-gram index hit `maxIndexChars` and only a prefix of each stream was
   * indexed; everything past the cap can only ever be a gap.
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
  /** Memory guard: characters indexed per side. */
  maxIndexChars?: number;
}

export interface MatchResult {
  timings: SentenceTiming[];
  stats: MatchStats;
}

const DEFAULT_NGRAM = 14;
const DEFAULT_GAP_CHARS = 3000;
const DEFAULT_MIN_ANCHORS_PER_KILOCHAR = 2;
/**
 * Each indexed position costs a Map entry plus a sliced-string key, roughly
 * 90 bytes in V8 — so ~110 MB per side at this cap. That is the ceiling we are
 * willing to pay on a 4-CPU home server; a 48,961-character book (67 minutes of
 * audio) uses ~4 MB, and this still covers a ~25 hour audiobook.
 */
const DEFAULT_MAX_INDEX_CHARS = 1_200_000;

/** Sentinel stored in the n-gram index for a gram seen more than once. */
const NOT_UNIQUE = -1;

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
  const indexTruncated = bookText.length > maxIndexChars || heardText.length > maxIndexChars;
  const bookIndex = indexUniqueNgrams(bookText, ngram, maxIndexChars);
  const heardIndex = indexUniqueNgrams(heardText, ngram, maxIndexChars);

  const pairs: { b: number; h: number }[] = [];
  for (const [gram, b] of bookIndex) {
    if (b === NOT_UNIQUE) continue;
    const h = heardIndex.get(gram);
    if (h === undefined || h === NOT_UNIQUE) continue;
    pairs.push({ b, h });
  }
  // Map iteration is insertion order, i.e. already ascending in b, but the sort
  // makes the LIS precondition explicit rather than incidental.
  pairs.sort((x, y) => x.b - y.b);

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

  if (stats.implausible) return { timings: [], stats };

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

    timings.push({
      index: book[i]!.index,
      startMs,
      endMs,
      score: gap ? 0 : Math.max(0, 1 - dist / gapChars),
      gap,
    });
  }
  stats.alignedSentences = timings.reduce((n, t) => n + (t.gap ? 0 : 1), 0);

  return { timings, stats };
}

/**
 * Map gram -> its single position, or NOT_UNIQUE once it is seen twice.
 * Only the first `limit` characters are indexed (memory guard).
 */
function indexUniqueNgrams(str: string, n: number, limit: number): Map<string, number> {
  const index = new Map<string, number>();
  const end = Math.min(str.length, limit) - n;
  for (let i = 0; i <= end; i++) {
    const gram = str.slice(i, i + n);
    index.set(gram, index.has(gram) ? NOT_UNIQUE : i);
  }
  return index;
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
