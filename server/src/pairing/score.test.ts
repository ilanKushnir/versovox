import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTO_THRESHOLD, scorePair, type PairInputs } from './score.js';

function inputs(overrides: {
  ebook?: Partial<PairInputs['ebook']>;
  audio?: Partial<PairInputs['audio']>;
}): PairInputs {
  return {
    ebook: {
      title: 'The Lantern of Ash Harbor',
      author: 'Rivka Sharon',
      language: 'en',
      series: null,
      identifiers: {},
      totalChars: 20000,
      ...overrides.ebook,
    },
    audio: {
      title: 'The Lantern of Ash Harbor',
      author: 'Rivka Sharon',
      language: 'en',
      series: null,
      identifiers: {},
      durationMs: (20000 / 16.5) * 1000,
      ...overrides.audio,
    },
  };
}

describe('scorePair', () => {
  it('same title+author+language+plausible duration scores above auto threshold', () => {
    const { score } = scorePair(inputs({}));
    expect(score).toBeGreaterThanOrEqual(DEFAULT_AUTO_THRESHOLD);
  });

  it('title variants (unabridged marker, articles) still match', () => {
    const { score } = scorePair(inputs({ audio: { title: 'Lantern of Ash Harbor (Unabridged)' } }));
    expect(score).toBeGreaterThan(0.85);
  });

  it('different books stay below candidate threshold', () => {
    const { score } = scorePair(
      inputs({ audio: { title: 'Field Notes from a Quiet Valley', author: 'Tamar Bell' } }),
    );
    expect(score).toBeLessThan(0.55);
  });

  it('language mismatch caps the score even for identical titles (translation guard)', () => {
    const { score, evidence } = scorePair(inputs({ audio: { language: 'he' } }));
    expect(evidence.languageMatch).toBe(false);
    expect(score).toBeLessThanOrEqual(0.4);
  });

  it('identifier match raises confidence, but never above 1', () => {
    const { score, evidence } = scorePair(
      inputs({
        ebook: { identifiers: { isbn: '9780000000017' } },
        audio: { identifiers: { asin: 'B000000000', isbn: '9780000000017' } },
      }),
    );
    expect(evidence.identifierMatch).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0.96);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('flags suspicious duration ratios as abridged evidence', () => {
    const { evidence } = scorePair(inputs({ audio: { durationMs: (20000 / 16.5) * 1000 * 0.3 } }));
    expect(evidence.notes.join(' ')).toMatch(/abridged/i);
  });

  it('similar-but-different titles remain candidates, not auto', () => {
    const { score } = scorePair(inputs({ audio: { title: 'The Lantern of Oak Harbor' } }));
    expect(score).toBeGreaterThan(0.55);
    expect(score).toBeLessThan(DEFAULT_AUTO_THRESHOLD);
  });
});
