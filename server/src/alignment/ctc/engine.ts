import { segmentsFromTimings, type AlignerResult, type EbookSentenceInput } from '../timings.js';
import { matchChars, type BookSentence, type MatchResult, type MatchStats } from './anchors.js';
import {
  decodeBook,
  openProbeDecoder,
  type DecodedBook,
  type DecodedChar,
  type EmissionOptions,
  type ProbeDecoder,
  type ProbeDecoderOptions,
  type ProbeWindow,
} from './emissions.js';
import { romanize } from './romanize.js';
import {
  assembleProbes,
  gridWindows,
  refineWindows,
  type ProbeRun,
  type SparsePlan,
} from './sparse.js';

/**
 * Forced alignment: line up an audiobook against the ebook text we already
 * have, instead of transcribing it from scratch.
 *
 * Free-form speech recognition is the wrong tool for this job. We are not
 * trying to discover the words — they are sitting in the EPUB. We only need to
 * know *when* each one is spoken. So the engine runs a CTC acoustic model over
 * the audio, greedy-decodes its emissions into a stream of romanized characters
 * with 20 ms timestamps, and then finds where that stream and the book's own
 * romanized characters agree.
 *
 * Agreement is established with character n-grams that occur exactly once on
 * each side, ordered by a longest increasing subsequence. That matters: it
 * assumes nothing about text position being proportional to audio position, so
 * front matter, credits, chapter announcements, endnotes and an index simply
 * produce no anchors instead of dragging the whole alignment off course.
 *
 * And it does not need to hear the whole book. Anchors are what the timeline is
 * built from, and a handful of seconds every couple of minutes yields plenty of
 * them; the rest is interpolation between anchors that a second pass checks and
 * repairs where the implied reading rate says something happened (see
 * sparse.ts). That is the difference between an hour of compute for a six-hour
 * audiobook and about five minutes of it.
 *
 * Measured on a real human-narrated audiobook (67 minutes, 880 sentences):
 * 18,913 candidate anchors, 18,902 of them monotone, 830 sentences timed, and
 * every spot check landed on the correct sentence. The alternative that was
 * tried first — synthesising the text with espeak and warping it onto the
 * narration with DTW — looked superb against a synthetic fixture and failed
 * completely against a real narrator, so it is not in the codebase.
 */

/** Why a book could not be aligned, in words the operator can act on. */
export class AlignmentRefusedError extends Error {
  readonly code = 'alignment-refused';
  constructor(
    message: string,
    readonly stats: MatchStats,
  ) {
    super(message);
    this.name = 'AlignmentRefusedError';
  }
}

export interface CtcAlignRequest {
  /** The aligner model and its vocabulary, already downloaded. */
  modelPath: string;
  vocabPath: string;
  /** Audio files in playback order, with each one's offset on the book timeline. */
  trackPaths: string[];
  trackStartMs: number[];
  /** Each track's length as the library scan measured it, to save an ffprobe. */
  trackDurationMs?: (number | undefined)[];
  /** BCP-47 code; selects the romanization conventions, not a model. */
  language: string;
  /** Sentences in reading order, as the rest of the pipeline knows them. */
  sentences: EbookSentenceInput[];
  /** The text of each sentence, parallel to `sentences`. */
  sentenceText: string[];
  threads: number;
  signal?: AbortSignal;
  /** 0..1 over the decode, which is essentially all of the wall clock. */
  onProgress?: (fraction: number, detail: string) => void;
  /**
   * Listen to short probes on this schedule instead of the whole book. Absent
   * means decode every sample, which is slower by more than an order of
   * magnitude and, on everything measured so far, no more accurate at the
   * sentence level.
   */
  plan?: SparsePlan;
  /**
   * The acoustic front ends, defaulting to the real ones. The only reason they
   * are injectable is testing: everything this module actually decides —
   * refusal, refinement, gaps, how timings become segments — is downstream of
   * the decode, and a test that had to carry the 317 MB model (and onnxruntime,
   * which CI does not install) could not cover any of it.
   */
  decode?: (opts: EmissionOptions) => Promise<DecodedBook>;
  openDecoder?: (opts: ProbeDecoderOptions) => Promise<ProbeDecoder>;
}

export interface CtcAlignResult {
  result: AlignerResult;
  stats: MatchStats;
  /** Provenance for the alignments table. */
  model: string;
  audioMs: number;
  /** Audio actually put through the model, for the speed estimate. 0 = all of it. */
  decodedMs: number;
  /** Probes decoded, or 0 for a whole-book decode. */
  probes: number;
  /**
   * How much of the ebook's text the narration appears to cover: ~1 for a
   * complete reading, well under 1 for an abridgement.
   *
   * NOT the raw heard/book character ratio, which under sampling is the
   * fraction of the audio that was decoded and says nothing about the
   * narration. Dividing that fraction back out is what makes the number mean
   * the same thing at every precision.
   */
  narrationRatio: number;
}

/**
 * A sentence is only claimed as exact when it sits close to an anchor, because
 * that is the only place the timing comes from a real acoustic match rather
 * than from interpolation between two of them.
 */
export const EXACT_SCORE = 0.9;

/**
 * ...and when the anchor is close in *time*, not just in characters.
 *
 * Character distance was a good enough proxy while the whole book was decoded
 * and anchors were everywhere. Under sampling it is not: three hundred
 * characters is twenty seconds of narration, so a sentence can be "near an
 * anchor" by the character score and still be an interpolation across a third
 * of a minute. Measured, this threshold is what separates the sentences a
 * probe actually heard from the ones inferred between two probes.
 */
export const EXACT_UNCERTAINTY_MS = 2_500;

export async function alignWithCtc(req: CtcAlignRequest): Promise<CtcAlignResult> {
  const book: BookSentence[] = req.sentences.map((_, i) => ({
    index: i,
    romanized: romanize(req.sentenceText[i] ?? '', req.language),
  }));
  const bookChars = book.reduce((a, s) => a + s.romanized.length, 0);
  if (bookChars === 0) {
    throw new Error('The ebook produced no alignable text for this language.');
  }

  req.onProgress?.(0, 'Listening to the narration');
  const heard = req.plan
    ? await listenSparsely(req, book, req.plan)
    : await listenThroughout(req, book);

  if (heard.match.stats.implausible) {
    const stats = heard.match.stats;
    throw new AlignmentRefusedError(
      `This audio does not appear to narrate this ebook: only ${stats.monotoneAnchors} matching ` +
        `passages were found across ${stats.bookChars.toLocaleString()} characters of text. ` +
        `Check that the two editions really are the same work.`,
      stats,
    );
  }

  // One shared layer owns monotonicity, interpolation, gaps and confidence, so
  // this engine cannot invent a segment shape of its own.
  const byIndex = new Map(heard.match.timings.map((t) => [t.index, t]));
  const result = segmentsFromTimings(
    req.sentences,
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

  const decodedFraction = heard.audioMs > 0 ? heard.decodedMs / heard.audioMs : 1;
  return {
    result,
    stats: heard.match.stats,
    model: heard.model,
    audioMs: heard.audioMs,
    decodedMs: heard.decodedMs,
    probes: heard.probes,
    narrationRatio: decodedFraction > 0 ? heard.match.stats.charRatio / decodedFraction : 0,
  };
}

interface Heard {
  match: MatchResult;
  audioMs: number;
  model: string;
  decodedMs: number;
  probes: number;
}

/** Decode every sample. Slow, and kept for operators who want it that way. */
async function listenThroughout(req: CtcAlignRequest, book: BookSentence[]): Promise<Heard> {
  const decoded = await (req.decode ?? decodeBook)({
    modelPath: req.modelPath,
    vocabPath: req.vocabPath,
    trackPaths: req.trackPaths,
    trackStartMs: req.trackStartMs,
    threads: req.threads,
    signal: req.signal,
    onProgress: ({ doneMs, totalMs }) => {
      const f = totalMs > 0 ? Math.min(1, doneMs / totalMs) : 0;
      // The decode is the whole cost; matching afterwards is milliseconds.
      req.onProgress?.(f * 0.97, `Listening to the narration · ${Math.round(f * 100)}%`);
    },
  });

  req.onProgress?.(0.97, 'Matching the narration to the text');
  const heard: DecodedChar[] = decoded.chars;
  return {
    match: matchChars(book, heard, { audioMs: decoded.audioMs }),
    audioMs: decoded.audioMs,
    model: decoded.model,
    decodedMs: decoded.audioMs,
    probes: 0,
  };
}

/**
 * Decode a grid of short probes, then spend a bounded number of extra probes
 * on the stretches whose implied reading rate says the interpolation between
 * them cannot be trusted.
 *
 * The rounds are re-matched from scratch rather than patched: matching a
 * 50,000-character book against its anchors takes milliseconds, and rebuilding
 * means a late probe can revise an anchor the earlier rounds got wrong instead
 * of being stitched onto a mistake.
 */
async function listenSparsely(
  req: CtcAlignRequest,
  book: BookSentence[],
  plan: SparsePlan,
): Promise<Heard> {
  const decoder = await (req.openDecoder ?? openProbeDecoder)({
    modelPath: req.modelPath,
    vocabPath: req.vocabPath,
    trackPaths: req.trackPaths,
    trackStartMs: req.trackStartMs,
    trackDurationMs: req.trackDurationMs,
    threads: req.threads,
    signal: req.signal,
  });
  try {
    const audioMs = decoder.audioMs;
    const grid = gridWindows(audioMs, plan);
    const budget = Math.floor(grid.length * Math.max(0, plan.refineBudget));

    // The bar counts probes, not rounds: every probe costs about the same, so
    // a bar linear in probes is linear in time.
    //
    // The refinement budget is counted from the start, before a single round
    // is scheduled. Counting only the grid put the bar at 97% with up to 60%
    // of the probes still to come, and then dragged it BACKWARDS each time a
    // round was added — which is precisely the shape that makes a thirteen
    // minute alignment announce eight. Planning for the worst case means the
    // bar can only move forward, and a book that needs little refinement
    // finishes early instead of late, which is the direction to be wrong in.
    const planned = grid.length + budget;
    let finished = 0;
    const report = () => {
      const f = planned > 0 ? Math.min(1, finished / planned) : 0;
      req.onProgress?.(
        f * 0.97,
        `Listening to the narration · ${finished.toLocaleString()} of ${planned.toLocaleString()} samples`,
      );
    };

    const runs: ProbeRun[] = [];
    const decodeRound = async (windows: ProbeWindow[]) => {
      const chunks = await decoder.decode(windows, (done) => {
        finished = runs.length + done;
        report();
      });
      windows.forEach((window, i) => runs.push({ window, chars: chunks[i] ?? [] }));
      finished = runs.length;
      report();
    };

    report();
    await decodeRound(grid);
    let match = matchChars(book, assembleProbes(runs), { audioMs });

    let spent = 0;
    for (let round = 0; round < plan.refineRounds && spent < budget; round++) {
      const covered = runs.map((r) => r.window);
      const extra = refineWindows(match.anchors, covered, audioMs, plan, budget - spent);
      if (extra.length === 0) break;
      await decodeRound(extra);
      spent += extra.length;
      match = matchChars(book, assembleProbes(runs), { audioMs });
    }

    // Refinement is done, whether or not it used its whole budget. Closing the
    // gap here is the one forward jump the bar is allowed.
    finished = planned;
    report();
    req.onProgress?.(0.97, 'Matching the narration to the text');
    return {
      match,
      audioMs,
      model: decoder.model,
      decodedMs: runs.reduce((a, r) => a + r.window.durationMs, 0),
      probes: runs.length,
    };
  } finally {
    await decoder.close();
  }
}
