import { describe, expect, it } from 'vitest';
import { MANUAL_LINK_NOTE, pairStatusLabel, UNALIGNED_PAIR_NOTE } from './pairLabel';

/**
 * Paired-edition labels must never overclaim: an unaligned linked pair can
 * resolve NO positions at all (the resolve endpoint returns unavailable),
 * so the label must say switching is unavailable until alignment exists —
 * not promise "chapter accuracy" or any other granularity.
 */

const handoff = (exact: number) => ({
  available: true,
  exactSentenceCoverage: exact,
  coverage: 0.9,
  meanConfidence: 0.8,
});

describe('pairStatusLabel', () => {
  it('an unaligned linked pair says switching is UNAVAILABLE until alignment exists', () => {
    for (const status of ['auto', 'confirmed'] as const) {
      const label = pairStatusLabel({ status, switchable: false, handoff: null });
      expect(label).toMatch(/unavailable until alignment/i);
      expect(label).not.toMatch(/chapter accuracy/i);
      expect(label).not.toMatch(/chapter/i);
    }
  });

  it('never claims chapter accuracy in any state', () => {
    const states = [
      { status: 'candidate' as const, switchable: false, handoff: null },
      { status: 'confirmed' as const, switchable: false, handoff: null },
      { status: 'confirmed' as const, switchable: true, handoff: handoff(0.72) },
    ];
    for (const s of states) {
      expect(pairStatusLabel(s)).not.toMatch(/chapter accuracy/i);
    }
  });

  it('a ready handoff quotes the measured exact-sentence coverage honestly', () => {
    const label = pairStatusLabel({
      status: 'confirmed',
      switchable: true,
      handoff: handoff(0.72),
    });
    expect(label).toContain('72%');
    expect(label).toMatch(/approximate or unavailable/);
    expect(label).not.toMatch(/^100%|all sentences/i);
  });

  it('a candidate points to review, claiming nothing about switching', () => {
    const label = pairStatusLabel({ status: 'candidate', switchable: false, handoff: null });
    expect(label).toMatch(/review/i);
    expect(label).not.toMatch(/switch/i);
  });
});

describe('Pairing-page copy (shared constants rendered by PairsPage)', () => {
  it('an unaligned pair is described as UNAVAILABLE until alignment — never approximate', () => {
    for (const copy of [UNALIGNED_PAIR_NOTE, MANUAL_LINK_NOTE]) {
      expect(copy).toMatch(/unavailable until alignment completes/i);
      expect(copy).not.toMatch(/approximate/i);
      expect(copy).not.toMatch(/chapter accuracy/i);
    }
  });
});
