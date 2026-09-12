import { PROBE_BREAK, type DecodedChar, type ProbeWindow } from './emissions.js';
import { type Anchor } from './anchors.js';

/**
 * Where to listen.
 *
 * Forced alignment does not need to hear a book to time it. It needs enough
 * places where the decoded audio and the text provably agree that everything
 * in between can be interpolated, and narration is close to a constant rate
 * over a couple of minutes — so a short probe every so often buys almost the
 * same timeline as decoding every sample, for a fifteenth of the compute.
 *
 * "Almost" is the whole problem, and it is what the refinement pass is for.
 * Interpolation assumes the narrator kept reading at the same pace between two
 * anchors, and the places where that is false are exactly the places a reader
 * notices: a chapter break, a pause for a section heading, a passage of the
 * ebook the narration skips, a producer's credit. Each of those shows up as a
 * stretch whose implied reading rate is wrong — too few book characters per
 * second across a silence, too many across a skip — so the schedule spends its
 * second round of probes on precisely those stretches and leaves the steady
 * parts alone.
 *
 * Pure: planning is separated from decoding so the schedule can be tested
 * without the model.
 */

export interface SparsePlan {
  /** Audio decoded per probe. */
  windowMs: number;
  /** Distance between probe starts in the first pass. */
  everyMs: number;
  /** Refinement passes over the suspicious stretches. */
  refineRounds: number;
  /**
   * Relative deviation from the book's median reading rate that marks a
   * stretch as worth another probe. 0.2 means "20% faster or slower".
   */
  rateTolerance: number;
  /** Extra probes allowed, as a fraction of the first pass. */
  refineBudget: number;
}

/**
 * Defaults, measured on real narration rather than chosen: see
 * docs/alignment.md. A 6-hour audiobook plans ~145 probes of 8 seconds,
 * about 5% of the audio.
 */
export const DEFAULT_SPARSE_PLAN: SparsePlan = {
  windowMs: 8_000,
  everyMs: 150_000,
  refineRounds: 3,
  rateTolerance: 0.2,
  refineBudget: 0.6,
};

/**
 * The settings-level choice, expressed as a schedule. `exact` has no
 * schedule: it decodes every sample.
 */
/** Schedule for a settings value, or null when every sample is decoded. */
export function planFor(precision: 'standard' | 'exact'): SparsePlan | null {
  return precision === 'exact' ? null : DEFAULT_SPARSE_PLAN;
}

/** The first pass: one probe every `everyMs`, from the top of the book. */
export function gridWindows(audioMs: number, plan: SparsePlan): ProbeWindow[] {
  const every = Math.max(1000, Math.round(plan.everyMs));
  const win = Math.max(1000, Math.round(plan.windowMs));
  const out: ProbeWindow[] = [];
  for (let startMs = 0; startMs < audioMs; startMs += every) {
    out.push({ startMs, durationMs: Math.min(win, audioMs - startMs) });
  }
  return out;
}

/**
 * A stretch of narration between two consecutive anchors, long enough that
 * nothing was decoded inside it.
 */
interface Span {
  fromMs: number;
  toMs: number;
  /** Book characters per millisecond implied by the two anchors. */
  rate: number;
}

/**
 * Pick the next round of probes: the stretches where the implied reading rate
 * says the interpolation is lying, plus any stretch that produced no anchors
 * at all (a probe that landed in music, in silence, or in text the ebook does
 * not contain).
 *
 * Returns an empty array when the timeline looks uniform, which ends the
 * refinement early — most books get there after one round.
 */
export function refineWindows(
  anchors: Anchor[],
  covered: ProbeWindow[],
  audioMs: number,
  plan: SparsePlan,
  limit: number,
): ProbeWindow[] {
  if (limit <= 0) return [];
  const win = Math.max(1000, Math.round(plan.windowMs));
  // Only stretches wider than a probe can hide anything; anything narrower is
  // already as well anchored as this schedule can make it.
  const minSpanMs = Math.max(2 * win, Math.round(plan.everyMs / 3));

  const spans: Span[] = [];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!;
    const b = anchors[i]!;
    const dt = b.ms - a.ms;
    if (dt < minSpanMs) continue;
    spans.push({ fromMs: a.ms, toMs: b.ms, rate: (b.bookPos - a.bookPos) / Math.max(1, dt) });
  }
  // Unanchored head and tail: no rate to judge, but every bit as unmapped.
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const blind: Span[] = [];
  if (first && first.ms >= minSpanMs) blind.push({ fromMs: 0, toMs: first.ms, rate: NaN });
  if (last && audioMs - last.ms >= minSpanMs) {
    blind.push({ fromMs: last.ms, toMs: audioMs, rate: NaN });
  }

  const rates = spans
    .map((s) => s.rate)
    .filter((r) => r > 0)
    .sort((x, y) => x - y);
  const median = rates.length ? rates[rates.length >> 1]! : 0;
  const tol = Math.log(1 + Math.max(0.01, plan.rateTolerance));

  const suspect = spans.filter(
    (s) => !(s.rate > 0) || median <= 0 || Math.abs(Math.log(s.rate / median)) > tol,
  );
  // Widest first: a five-minute unmapped stretch matters more than a
  // fifteen-second one, and the budget may not cover both.
  const ranked = [...blind, ...suspect].sort((a, b) => b.toMs - b.fromMs - (a.toMs - a.fromMs));

  const out: ProbeWindow[] = [];
  for (const span of ranked) {
    if (out.length >= limit) break;
    const startMs = placeIn(span, [...covered, ...out], win, audioMs);
    if (startMs === null) continue;
    out.push({ startMs, durationMs: Math.min(win, audioMs - startMs) });
  }
  return out;
}

/**
 * Where to put a probe inside a suspicious stretch: the middle of the widest
 * part of it nothing has listened to yet.
 *
 * Aiming at the exact midpoint is not good enough. The commonest reason a
 * stretch is suspicious in the first place is that a grid probe inside it
 * heard nothing — it landed in a pause, in music, in a chapter announcement —
 * and that probe sits at or near the middle. Re-probing the same seconds would
 * spend the budget learning the same nothing.
 */
function placeIn(span: Span, taken: ProbeWindow[], win: number, audioMs: number): number | null {
  const busy = taken
    .filter((w) => w.startMs < span.toMs && w.startMs + w.durationMs > span.fromMs)
    .sort((a, b) => a.startMs - b.startMs);
  let best: { from: number; to: number } | null = null;
  let cursor = span.fromMs;
  for (const w of [...busy, { startMs: span.toMs, durationMs: 0 }]) {
    const free = { from: cursor, to: Math.min(w.startMs, span.toMs) };
    if (free.to - free.from > (best ? best.to - best.from : 0)) best = free;
    cursor = Math.max(cursor, w.startMs + w.durationMs);
  }
  if (!best || best.to - best.from < win) return null;
  const mid = Math.round((best.from + best.to) / 2 - win / 2);
  return Math.max(0, Math.min(mid, audioMs - win));
}

/** One probe and what the model heard in it. */
export interface ProbeRun {
  window: ProbeWindow;
  chars: DecodedChar[];
}

/**
 * Splice every probe decoded so far into one character stream in playback
 * order, with a {@link PROBE_BREAK} between neighbours.
 *
 * The breaks are what make sparse decoding safe rather than merely cheap.
 * Without them the last syllable of one probe and the first of the next —
 * minutes apart in the narration — would form n-grams that the matcher could
 * anchor somewhere neither probe ever visited.
 */
export function assembleProbes(runs: ProbeRun[]): DecodedChar[] {
  const ordered = [...runs].sort((a, b) => a.window.startMs - b.window.startMs);
  const out: DecodedChar[] = [];
  for (const run of ordered) {
    if (run.chars.length === 0) continue;
    if (out.length > 0) out.push({ c: PROBE_BREAK, ms: Math.round(run.window.startMs) });
    for (const c of run.chars) out.push(c);
  }
  return out;
}
