import { type AlignmentGap, type AlignmentSegment } from '@versovox/shared';
import { stringSimilarity } from '../util/text.js';

/**
 * Deterministic monotonic text/transcript aligner.
 *
 * Inputs: ordered ebook sentences (normalized token arrays) and a timed
 * transcript (normalized words with start/end ms, absolute across the book).
 *
 * Method (per docs/research-and-architecture.md §C):
 *  1. Seed anchors from distinctive 4-token shingles that occur exactly once
 *     in both streams; enforce global order with a longest increasing
 *     subsequence.
 *  2. Between consecutive anchors, run a banded dynamic-programming token
 *     alignment (match / fuzzy-match / gap), preserving monotonic order.
 *  3. Derive sentence start/end times from their first/last aligned words.
 *  4. Score per-sentence confidence from lexical match rate and timing
 *     continuity. Low-confidence sentences with aligned neighbours are
 *     interpolated (marked as such, never claimed exact); larger holes
 *     become explicit gaps.
 *
 * The output is monotonic by construction and never invents timings across
 * long low-confidence regions.
 */

export interface EbookSentenceInput {
  sentenceId: string;
  spineIdx: number;
  sentenceOrd: number;
  tokens: string[];
}

export interface TranscriptWord {
  w: string;
  s: number; // start ms (absolute)
  e: number; // end ms
}

export interface AlignerResult {
  segments: AlignmentSegment[];
  gaps: AlignmentGap[];
  coverage: number;
  meanConfidence: number;
}

const SHINGLE = 4;
const FUZZY_SIM = 0.8;
const MIN_EXACT_CONFIDENCE = 0.6;
const INTERPOLATE_MAX_RUN = 3;

export function alignBook(sentences: EbookSentenceInput[], words: TranscriptWord[]): AlignerResult {
  const flatTokens: { tok: string; sentIdx: number }[] = [];
  sentences.forEach((s, i) => {
    for (const t of s.tokens) flatTokens.push({ tok: t, sentIdx: i });
  });
  const wordTokens = words.map((w) => w.w);

  if (flatTokens.length === 0 || words.length === 0) {
    return { segments: [], gaps: [], coverage: 0, meanConfidence: 0 };
  }

  // --- 1. anchor seeding ---
  const anchors = findAnchors(
    flatTokens.map((t) => t.tok),
    wordTokens,
  );
  // Sentinel anchors at both ends.
  const bounds = [{ a: 0, b: 0 }, ...anchors, { a: flatTokens.length, b: words.length }];

  // --- 2. banded DP between anchors ---
  // tokenWord[i] = word index matched to flat ebook token i (or -1)
  const tokenWord = new Array<number>(flatTokens.length).fill(-1);
  const tokenExact = new Array<boolean>(flatTokens.length).fill(false);
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a0 = bounds[k]!.a;
    const b0 = bounds[k]!.b;
    const a1 = bounds[k + 1]!.a;
    const b1 = bounds[k + 1]!.b;
    alignSpan(flatTokens, words, a0, a1, b0, b1, tokenWord, tokenExact);
  }

  // --- 3+4. per-sentence timing + confidence ---
  const segments: AlignmentSegment[] = [];
  const raw: {
    sent: EbookSentenceInput;
    startMs: number | null;
    endMs: number | null;
    matchRate: number;
    exactRate: number;
  }[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const n = s.tokens.length;
    let matched = 0;
    let exact = 0;
    let first: number | null = null;
    let last: number | null = null;
    for (let i = cursor; i < cursor + n; i++) {
      const w = tokenWord[i]!;
      if (w >= 0) {
        matched++;
        if (tokenExact[i]) exact++;
        if (first === null) first = w;
        last = w;
      }
    }
    cursor += n;
    raw.push({
      sent: s,
      startMs: first !== null ? words[first]!.s : null,
      endMs: last !== null ? words[last]!.e : null,
      matchRate: n ? matched / n : 0,
      exactRate: n ? exact / n : 0,
    });
  }

  // Enforce monotonic non-overlapping times; drop matches that violate order
  // (can happen at fuzzy region borders).
  let lastEnd = -1;
  for (const r of raw) {
    if (r.startMs === null || r.endMs === null) continue;
    if (r.startMs < lastEnd - 1500) {
      r.startMs = null;
      r.endMs = null;
      r.matchRate = 0;
      continue;
    }
    if (r.endMs < r.startMs) r.endMs = r.startMs;
    lastEnd = r.endMs;
  }

  // Interpolate short unmatched runs between confident neighbours.
  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.startMs !== null) continue;
    let j = i;
    while (j < raw.length && raw[j]!.startMs === null) j++;
    const prev = i > 0 ? raw[i - 1] : null;
    const next = j < raw.length ? raw[j] : null;
    const run = j - i;
    if (prev?.endMs != null && next?.startMs != null && run <= INTERPOLATE_MAX_RUN) {
      const total = raw.slice(i, j).reduce((acc, r) => acc + Math.max(1, r.sent.tokens.length), 0);
      let t = prev.endMs;
      const span = Math.max(0, next.startMs - prev.endMs);
      for (let k = i; k < j; k++) {
        const w = Math.max(1, raw[k]!.sent.tokens.length) / total;
        raw[k]!.startMs = Math.round(t);
        t += span * w;
        raw[k]!.endMs = Math.round(t);
        raw[k]!.matchRate = -1; // marker: interpolated
      }
    }
    i = j - 1;
  }

  const gaps: AlignmentGap[] = [];
  let prevEnd = 0;
  for (const r of raw) {
    if (r.startMs === null || r.endMs === null) continue;
    const interpolated = r.matchRate === -1;
    const confidence = interpolated
      ? 0.35
      : Math.min(1, 0.15 + 0.55 * r.matchRate + 0.3 * r.exactRate);
    const source = interpolated ? 'interpolated' : r.exactRate > 0.85 ? 'exact' : 'fuzzy';
    if (!interpolated && confidence < MIN_EXACT_CONFIDENCE - 0.25) {
      // Too weak to trust at all: leave unaligned (becomes a gap).
      continue;
    }
    if (r.startMs - prevEnd > 15_000) {
      gaps.push({ fromMs: prevEnd, toMs: r.startMs, reason: 'narration-only' });
    }
    segments.push({
      sentenceId: r.sent.sentenceId,
      spineIdx: r.sent.spineIdx,
      sentenceOrd: r.sent.sentenceOrd,
      startMs: Math.round(r.startMs),
      endMs: Math.round(r.endMs),
      confidence: Math.round(confidence * 1000) / 1000,
      source,
    });
    prevEnd = r.endMs;
  }
  const audioEnd = words[words.length - 1]!.e;
  if (audioEnd - prevEnd > 15_000) {
    gaps.push({ fromMs: prevEnd, toMs: audioEnd, reason: 'narration-only' });
  }

  const coverage = sentences.length ? segments.length / sentences.length : 0;
  const meanConfidence = segments.length
    ? segments.reduce((a, s) => a + s.confidence, 0) / segments.length
    : 0;
  return {
    segments,
    gaps,
    coverage: Math.round(coverage * 1000) / 1000,
    meanConfidence: Math.round(meanConfidence * 1000) / 1000,
  };
}

/** Unique-shingle anchors + longest increasing subsequence for monotonicity. */
function findAnchors(aTokens: string[], bTokens: string[]): { a: number; b: number }[] {
  const key = (toks: string[], i: number) => toks.slice(i, i + SHINGLE).join(' ');
  const aMap = new Map<string, number>();
  const aDup = new Set<string>();
  for (let i = 0; i + SHINGLE <= aTokens.length; i++) {
    const k = key(aTokens, i);
    if (aMap.has(k)) aDup.add(k);
    else aMap.set(k, i);
  }
  const bMap = new Map<string, number>();
  const bDup = new Set<string>();
  for (let i = 0; i + SHINGLE <= bTokens.length; i++) {
    const k = key(bTokens, i);
    if (bMap.has(k)) bDup.add(k);
    else bMap.set(k, i);
  }
  const cand: { a: number; b: number }[] = [];
  for (const [k, ai] of aMap) {
    if (aDup.has(k) || bDup.has(k)) continue;
    const bi = bMap.get(k);
    if (bi !== undefined) cand.push({ a: ai, b: bi });
  }
  cand.sort((x, y) => x.a - y.a);
  // LIS on b to keep a monotone subset.
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev = new Array<number>(cand.length).fill(-1);
  for (let i = 0; i < cand.length; i++) {
    const v = cand[i]!.b;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1;
  }
  const out: { a: number; b: number }[] = [];
  let cur = tails.length ? tailIdx[tails.length - 1]! : -1;
  while (cur >= 0) {
    out.push(cand[cur]!);
    cur = prev[cur]!;
  }
  out.reverse();
  return out;
}

const MAX_SPAN_CELLS = 4_000_000;

/** Needleman–Wunsch between anchor bounds; fills tokenWord/tokenExact. */
function alignSpan(
  flatTokens: { tok: string; sentIdx: number }[],
  words: TranscriptWord[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  tokenWord: number[],
  tokenExact: boolean[],
): void {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n <= 0 || m <= 0) return;
  if (n * m > MAX_SPAN_CELLS) {
    // Span too large to align exactly (weak anchor coverage). Match greedily
    // on exact tokens in order rather than exploding memory.
    let bi = b0;
    for (let ai = a0; ai < a1 && bi < b1; ai++) {
      for (let k = bi; k < Math.min(b1, bi + 200); k++) {
        if (words[k]!.w === flatTokens[ai]!.tok) {
          tokenWord[ai] = k;
          tokenExact[ai] = true;
          bi = k + 1;
          break;
        }
      }
    }
    return;
  }
  const GAP = -1;
  const cols = m + 1;
  const score = new Int32Array((n + 1) * cols);
  for (let j = 0; j <= m; j++) score[j] = j * GAP;
  for (let i = 1; i <= n; i++) score[i * cols] = i * GAP;
  for (let i = 1; i <= n; i++) {
    const at = flatTokens[a0 + i - 1]!.tok;
    for (let j = 1; j <= m; j++) {
      const bt = words[b0 + j - 1]!.w;
      let matchScore: number;
      if (at === bt) matchScore = 3;
      else if (at.length > 3 && bt.length > 3 && stringSimilarity(at, bt) >= FUZZY_SIM)
        matchScore = 2;
      else matchScore = -2;
      const diag = score[(i - 1) * cols + (j - 1)]! + matchScore;
      const up = score[(i - 1) * cols + j]! + GAP;
      const left = score[i * cols + (j - 1)]! + GAP;
      score[i * cols + j] = Math.max(diag, up, left);
    }
  }
  // Traceback.
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const at = flatTokens[a0 + i - 1]!.tok;
    const bt = words[b0 + j - 1]!.w;
    const exact = at === bt;
    const fuzzy = !exact && at.length > 3 && bt.length > 3 && stringSimilarity(at, bt) >= FUZZY_SIM;
    const matchScore = exact ? 3 : fuzzy ? 2 : -2;
    if (score[i * cols + j] === score[(i - 1) * cols + (j - 1)]! + matchScore) {
      if (exact || fuzzy) {
        tokenWord[a0 + i - 1] = b0 + j - 1;
        tokenExact[a0 + i - 1] = exact;
      }
      i--;
      j--;
    } else if (score[i * cols + j] === score[(i - 1) * cols + j]! + GAP) {
      i--;
    } else {
      j--;
    }
  }
}
