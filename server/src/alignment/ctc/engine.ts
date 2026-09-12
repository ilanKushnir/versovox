import { segmentsFromTimings, type AlignerResult, type EbookSentenceInput } from '../timings.js';
import { matchChars, type BookSentence, type MatchStats } from './anchors.js';
import {
  decodeBook,
  type DecodedBook,
  type DecodedChar,
  type EmissionOptions,
} from './emissions.js';
import { romanize } from './romanize.js';

/**
 * Forced alignment: line up an audiobook against the ebook text we already
 * have, instead of transcribing it from scratch.
 *
 * Free-form speech recognition is the wrong tool for this job. We are not
 * trying to discover the words — they are sitting in the EPUB. We only need to
 * know *when* each one is spoken. So the engine runs one pass of a CTC
 * acoustic model over the audio, greedy-decodes its emissions into a stream of
 * romanized characters with 20 ms timestamps, and then finds where that stream
 * and the book's own romanized characters agree.
 *
 * Agreement is established with character n-grams that occur exactly once on
 * each side, ordered by a longest increasing subsequence. That matters: it
 * assumes nothing about text position being proportional to audio position, so
 * front matter, credits, chapter announcements, endnotes and an index simply
 * produce no anchors instead of dragging the whole alignment off course.
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
   * The acoustic front end, defaulting to {@link decodeBook}. The only reason
   * it is injectable is testing: everything this module actually decides —
   * refusal, gaps, how timings become segments — is downstream of the decode,
   * and a test that had to carry the 317 MB model (and onnxruntime, which CI
   * does not install) could not cover any of it.
   */
  decode?: (opts: EmissionOptions) => Promise<DecodedBook>;
}

export interface CtcAlignResult {
  result: AlignerResult;
  stats: MatchStats;
  /** Provenance for the alignments table. */
  model: string;
  audioMs: number;
}

/**
 * A sentence is only claimed as exact when it sits close to an anchor, because
 * that is the only place the timing comes from a real acoustic match rather
 * than from interpolation between two of them.
 */
export const EXACT_SCORE = 0.9;

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
  const { timings, stats } = matchChars(book, heard, { audioMs: decoded.audioMs });

  if (stats.implausible) {
    throw new AlignmentRefusedError(
      `This audio does not appear to narrate this ebook: only ${stats.monotoneAnchors} matching ` +
        `passages were found across ${stats.bookChars.toLocaleString()} characters of text. ` +
        `Check that the two editions really are the same work.`,
      stats,
    );
  }

  // One shared layer owns monotonicity, interpolation, gaps and confidence, so
  // this engine cannot invent a segment shape of its own.
  const byIndex = new Map(timings.map((t) => [t.index, t]));
  const result = segmentsFromTimings(
    req.sentences,
    (i) => {
      const t = byIndex.get(i);
      if (!t || t.gap) return null;
      return {
        startMs: t.startMs,
        endMs: t.endMs,
        score: t.score,
        exact: t.score >= EXACT_SCORE,
      };
    },
    { audioMs: decoded.audioMs },
  );

  return { result, stats, model: decoded.model, audioMs: decoded.audioMs };
}
