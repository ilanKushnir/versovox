import { type AlignmentGap, type AlignmentSegment } from '@versovox/shared';

/**
 * Shared timing + honesty layer.
 *
 * Every alignment engine (the fuzzy transcript aligner in align.ts, the CTC
 * forced aligner, anything later) answers exactly one question per sentence:
 * "where in the audio is this, and how much do you believe it?". Turning those
 * raw answers into an `AlignmentSegment` — enforcing monotonicity, deciding
 * what may be called `exact`, interpolating small holes, refusing to guess
 * across large ones — happens here and nowhere else.
 *
 * That single-constructor rule is deliberate. Confidence and `source` are the
 * values the reader's switch decisions are built on, so an engine must not be
 * able to mint an over-confident segment by accident: engines report evidence,
 * this module decides what may be claimed.
 *
 * Stages (per docs/research-and-architecture.md §C, steps 3-4):
 *  1. Collect each sentence's raw timing.
 *  2. Enforce monotonic, non-overlapping order; drop backwards jumps.
 *  3. Interpolate short unmatched runs between confident neighbours, marked as
 *     interpolated so they are never presented as exact.
 *  4. Emit segments, explicit gaps for long unaligned stretches, and the
 *     coverage / mean-confidence summary.
 */

export interface EbookSentenceInput {
  sentenceId: string;
  spineIdx: number;
  sentenceOrd: number;
  tokens: string[];
}

export interface AlignerResult {
  segments: AlignmentSegment[];
  gaps: AlignmentGap[];
  coverage: number;
  meanConfidence: number;
}

/** One engine's unverified answer for a single sentence. */
export interface RawTiming {
  startMs: number;
  endMs: number;
  /** 0..1 belief that this sentence really is at these times. */
  score: number;
  /**
   * The engine believes the sentence matched the audio word-for-word. Only a
   * hint: this module still gates it on {@link TimingOptions.minExactConfidence},
   * so a weakly-scored "exact" claim degrades to `fuzzy` rather than promising
   * the reader a sentence-perfect switch.
   */
  exact?: boolean;
  /**
   * How far `startMs` could be wrong, in milliseconds, in the engine's own
   * judgement. Carried through to the segment so the read-to-listen handoff
   * can step back by exactly this much and land on narration the reader has
   * already passed instead of ahead of it. Omitted means "no estimate", which
   * is recorded as zero rather than guessed at here.
   */
  uncertaintyMs?: number;
}

export interface TimingOptions {
  /** Longest run of unaligned sentences that may be filled by interpolation. */
  maxInterpolateRun?: number;
  /** Score at or above which an engine's `exact` claim is honoured. */
  minExactConfidence?: number;
  /** Total audio duration; bounds timings and closes a trailing gap. */
  audioMs?: number;
}

const DEFAULT_MAX_INTERPOLATE_RUN = 3;
const DEFAULT_MIN_EXACT_CONFIDENCE = 0.6;

/**
 * How far below `minExactConfidence` a non-interpolated sentence may fall
 * before we stop claiming to know where it is at all. Below this it is dropped
 * entirely, which is what turns a weak region into a visible gap instead of a
 * plausible-looking wrong answer.
 */
const TRUST_MARGIN = 0.25;

/** Confidence reported for an interpolated sentence: believable, not trusted. */
const INTERPOLATED_CONFIDENCE = 0.35;

/**
 * Slack allowed when a sentence starts before its predecessor ended. Small
 * backwards steps are normal at fuzzy-match borders (a shared word pulled from
 * the wrong side); anything worse is a genuine ordering failure and the
 * sentence is dropped rather than reordered.
 */
const MONOTONIC_SLACK_MS = 1500;

/** Unaligned audio longer than this is reported as a narration-only gap. */
const GAP_MIN_MS = 15_000;

interface Row {
  sentence: EbookSentenceInput;
  startMs: number | null;
  endMs: number | null;
  score: number;
  exact: boolean;
  interpolated: boolean;
  uncertaintyMs: number;
}

/**
 * Build the alignment segments, gaps and summary for `sentences` from whatever
 * raw timings `timingFor` can supply. `timingFor` is called once per sentence,
 * in order, and returns null for sentences the engine could not place.
 */
export function segmentsFromTimings(
  sentences: EbookSentenceInput[],
  timingFor: (sentenceIndex: number) => RawTiming | null,
  opts: TimingOptions = {},
): AlignerResult {
  const maxInterpolateRun = opts.maxInterpolateRun ?? DEFAULT_MAX_INTERPOLATE_RUN;
  const minExactConfidence = opts.minExactConfidence ?? DEFAULT_MIN_EXACT_CONFIDENCE;
  const audioMs = opts.audioMs;

  const rows: Row[] = sentences.map((sentence, i) => {
    const t = timingFor(i);
    return {
      sentence,
      startMs: t ? t.startMs : null,
      endMs: t ? t.endMs : null,
      score: t ? t.score : 0,
      exact: t ? t.exact === true : false,
      interpolated: false,
      uncertaintyMs: t ? Math.max(0, Math.round(t.uncertaintyMs ?? 0)) : 0,
    };
  });

  enforceMonotonic(rows);
  interpolateShortRuns(rows, maxInterpolateRun);

  const segments: AlignmentSegment[] = [];
  const gaps: AlignmentGap[] = [];
  let prevEnd = 0;
  for (const r of rows) {
    if (r.startMs === null || r.endMs === null) continue;
    const confidence = r.interpolated ? INTERPOLATED_CONFIDENCE : clamp01(r.score);
    // Too weak to trust at all: leave unaligned so the region reads as a gap.
    if (!r.interpolated && confidence < minExactConfidence - TRUST_MARGIN) continue;
    const source = r.interpolated
      ? 'interpolated'
      : r.exact && confidence >= minExactConfidence
        ? 'exact'
        : 'fuzzy';
    if (r.startMs - prevEnd > GAP_MIN_MS) {
      gaps.push({
        fromMs: Math.round(prevEnd),
        toMs: Math.round(r.startMs),
        reason: 'narration-only',
      });
    }
    const startMs = bound(r.startMs, audioMs);
    segments.push({
      sentenceId: r.sentence.sentenceId,
      spineIdx: r.sentence.spineIdx,
      sentenceOrd: r.sentence.sentenceOrd,
      startMs,
      endMs: Math.max(startMs, bound(r.endMs, audioMs)),
      confidence: round3(confidence),
      source,
      uncertaintyMs: r.uncertaintyMs,
    });
    prevEnd = r.endMs;
  }
  if (audioMs !== undefined && audioMs - prevEnd > GAP_MIN_MS) {
    gaps.push({ fromMs: Math.round(prevEnd), toMs: Math.round(audioMs), reason: 'narration-only' });
  }

  const coverage = sentences.length ? segments.length / sentences.length : 0;
  const meanConfidence = segments.length
    ? segments.reduce((a, s) => a + s.confidence, 0) / segments.length
    : 0;
  return {
    segments,
    gaps,
    coverage: round3(coverage),
    meanConfidence: round3(meanConfidence),
  };
}

/**
 * Drop timings that jump backwards past the slack allowance, and clip any
 * sentence whose end precedes its own start. Output order is the reading
 * order, so a segment stream that is not monotonic is worse than a missing
 * one: the player would seek backwards mid-chapter.
 */
function enforceMonotonic(rows: Row[]): void {
  let lastEnd = -1;
  for (const r of rows) {
    if (r.startMs === null || r.endMs === null) continue;
    if (r.startMs < lastEnd - MONOTONIC_SLACK_MS) {
      r.startMs = null;
      r.endMs = null;
      r.score = 0;
      r.exact = false;
      continue;
    }
    if (r.endMs < r.startMs) r.endMs = r.startMs;
    lastEnd = r.endMs;
  }
}

/**
 * Fill runs of at most `maxRun` unplaced sentences that sit between two placed
 * neighbours, splitting the enclosed audio in proportion to token count. Longer
 * runs, and runs at either end of the book, are left alone: without both
 * neighbours there is nothing to interpolate between, and a long hole is more
 * honestly reported as a gap than smeared over.
 */
function interpolateShortRuns(rows: Row[], maxRun: number): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.startMs !== null) continue;
    let j = i;
    while (j < rows.length && rows[j]!.startMs === null) j++;
    const prev = i > 0 ? rows[i - 1] : null;
    const next = j < rows.length ? rows[j] : null;
    const run = j - i;
    if (prev?.endMs != null && next?.startMs != null && run <= maxRun) {
      const total = rows
        .slice(i, j)
        .reduce((acc, r) => acc + Math.max(1, r.sentence.tokens.length), 0);
      let t = prev.endMs;
      const span = Math.max(0, next.startMs - prev.endMs);
      // Split by token count, which is a guess about pace; the whole span is
      // therefore in play as error, on top of whatever the neighbours already
      // admit to.
      const unsure = Math.max(prev.uncertaintyMs, next.uncertaintyMs) + Math.round(span / 2);
      for (let k = i; k < j; k++) {
        const w = Math.max(1, rows[k]!.sentence.tokens.length) / total;
        rows[k]!.startMs = Math.round(t);
        t += span * w;
        rows[k]!.endMs = Math.round(t);
        rows[k]!.interpolated = true;
        rows[k]!.uncertaintyMs = unsure;
      }
    }
    i = j - 1;
  }
}

/** Round to whole ms inside [0, audioMs]; the schema forbids negatives. */
function bound(ms: number, audioMs: number | undefined): number {
  const v = Math.round(ms);
  if (v < 0) return 0;
  if (audioMs !== undefined && v > audioMs) return Math.max(0, Math.floor(audioMs));
  return v;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Three decimals: enough to compare confidences, stable across runs. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
