import { describe, expect, it } from 'vitest';
import { alignBook, type EbookSentenceInput, type TranscriptWord } from './align.js';
import { normalizeForMatch } from '../util/text.js';

/**
 * Deterministic aligner tests built from a synthetic "book": sentences of
 * distinctive words, a transcript that narrates them with known timings,
 * plus controlled perturbations (narrator intro, dropped words, fillers).
 */

const SENTS = [
  'Maren Solt arrived at Ash Harbor on the last ferry of October.',
  'The lighthouse stood on the northern spit like a patient animal.',
  'Her grandmother had kept this light for forty one years.',
  'Inside the cottage the air smelled of lamp oil and dried seaweed.',
  'On the kitchen table lay a ledger bound in sailcloth.',
  'The last entry said the lens remembers what the water forgets.',
  'Outside the first fog of the season swallowed the channel markers.',
  'Maren lit the stove and began to read the ledger from the beginning.',
];

function mkSentences(): EbookSentenceInput[] {
  return SENTS.map((s, i) => ({
    sentenceId: `s${i}`,
    spineIdx: 0,
    sentenceOrd: i,
    tokens: normalizeForMatch(s).split(' '),
  }));
}

/** Narrate tokens at 300ms/word starting at startMs; returns words+nextMs. */
function narrate(tokens: string[], startMs: number): { words: TranscriptWord[]; end: number } {
  const words: TranscriptWord[] = [];
  let t = startMs;
  for (const tok of tokens) {
    words.push({ w: tok, s: t, e: t + 280 });
    t += 300;
  }
  return { words, end: t };
}

function transcriptFor(
  sentences: EbookSentenceInput[],
  opts: { intro?: string[]; dropEvery?: number; pauseMs?: number } = {},
): { words: TranscriptWord[]; sentenceStarts: number[] } {
  const words: TranscriptWord[] = [];
  const starts: number[] = [];
  let t = 0;
  if (opts.intro) {
    const r = narrate(opts.intro, t);
    words.push(...r.words);
    t = r.end + 500;
  }
  let dropCounter = 0;
  for (const s of sentences) {
    starts.push(t);
    for (const tok of s.tokens) {
      dropCounter += 1;
      if (opts.dropEvery && dropCounter % opts.dropEvery === 0) {
        t += 300; // narrator "slurred" the word; time passes, token missing
        continue;
      }
      words.push({ w: tok, s: t, e: t + 280 });
      t += 300;
    }
    t += opts.pauseMs ?? 400;
  }
  return { words, sentenceStarts: starts };
}

describe('alignBook', () => {
  it('aligns a perfect narration with full coverage and exact confidence', () => {
    const sentences = mkSentences();
    const { words, sentenceStarts } = transcriptFor(sentences);
    const r = alignBook(sentences, words);
    expect(r.coverage).toBe(1);
    expect(r.meanConfidence).toBeGreaterThan(0.9);
    r.segments.forEach((seg, i) => {
      expect(seg.sentenceId).toBe(`s${i}`);
      expect(seg.source).toBe('exact');
      // Timing recovered to the true sentence start.
      expect(Math.abs(seg.startMs - sentenceStarts[i]!)).toBeLessThan(50);
    });
  });

  it('is deterministic', () => {
    const sentences = mkSentences();
    const { words } = transcriptFor(sentences);
    const a = alignBook(sentences, words);
    const b = alignBook(sentences, words);
    expect(a).toEqual(b);
  });

  it('tolerates a narrator intro that is not in the text', () => {
    const sentences = mkSentences();
    const { words, sentenceStarts } = transcriptFor(sentences, {
      intro: 'this is a sample narration of an original story'.split(' '),
    });
    const r = alignBook(sentences, words);
    expect(r.coverage).toBe(1);
    expect(Math.abs(r.segments[0]!.startMs - sentenceStarts[0]!)).toBeLessThan(400);
  });

  it('keeps monotonic order and survives dropped words', () => {
    const sentences = mkSentences();
    const { words } = transcriptFor(sentences, { dropEvery: 7 });
    const r = alignBook(sentences, words);
    expect(r.coverage).toBeGreaterThan(0.85);
    let last = -1;
    for (const seg of r.segments) {
      expect(seg.startMs).toBeGreaterThanOrEqual(last);
      last = seg.startMs;
    }
  });

  it('does not claim exact matches for garbage transcripts', () => {
    const sentences = mkSentences();
    const junk: TranscriptWord[] = Array.from({ length: 200 }, (_, i) => ({
      w: `zz${i % 17}`,
      s: i * 300,
      e: i * 300 + 280,
    }));
    const r = alignBook(sentences, junk);
    expect(r.meanConfidence).toBeLessThan(0.5);
    const exact = r.segments.filter((s) => s.source === 'exact');
    expect(exact.length).toBe(0);
  });

  it('interpolates short unmatched runs but marks them', () => {
    const sentences = mkSentences();
    // Replace sentence 3's tokens in the transcript with unrelated words.
    const { words } = transcriptFor(sentences);
    const s3 = sentences[3]!;
    const start = sentences.slice(0, 3).reduce((a, s) => a + s.tokens.length, 0);
    for (let i = 0; i < s3.tokens.length; i++) {
      words[start + i] = { ...words[start + i]!, w: `qqq${i}` };
    }
    const r = alignBook(sentences, words);
    const seg3 = r.segments.find((s) => s.sentenceId === 's3');
    expect(seg3).toBeDefined();
    expect(['interpolated', 'fuzzy']).toContain(seg3!.source);
    expect(seg3!.confidence).toBeLessThan(0.6);
  });

  it('reports narration-only gaps', () => {
    const sentences = mkSentences().slice(0, 2);
    const { words } = transcriptFor(sentences);
    // Long narration-only tail (e.g., an appended interview).
    let t = words[words.length - 1]!.e + 100;
    for (let i = 0; i < 60; i++) {
      words.push({ w: `bonus${i}`, s: t, e: t + 280 });
      t += 300;
    }
    const r = alignBook(sentences, words);
    expect(r.gaps.some((g) => g.reason === 'narration-only')).toBe(true);
  });
});
