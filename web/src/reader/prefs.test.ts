import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computePageLayout,
  DEFAULT_PREFS,
  effectiveTheme,
  loadPrefs,
  pageCountFor,
  savePrefs,
} from './prefs';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => store.clear());

describe('reader prefs', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips and merges with defaults (forward compatible)', () => {
    savePrefs({ ...DEFAULT_PREFS, theme: 'night', size: 22 });
    expect(loadPrefs().theme).toBe('night');
    expect(loadPrefs().size).toBe(22);
    // A pref added in a future version falls back to its default.
    store.set('rp-reader-prefs', JSON.stringify({ theme: 'sepia' }));
    const p = loadPrefs();
    expect(p.theme).toBe('sepia');
    expect(p.lineHeight).toBe(DEFAULT_PREFS.lineHeight);
  });

  it('survives corrupt storage', () => {
    store.set('rp-reader-prefs', '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});

describe('page layout', () => {
  it('single column: text lands at the same inset on every page', () => {
    // A 375px phone with 24px margins: one column of 327px, and the stride
    // between page origins must equal the column pitch the browser lays out
    // (column width + column gap) — that pitch is what the transform steps by.
    const l = computePageLayout(375, 24, 'auto');
    expect(l.columns).toBe(1);
    expect(l.width).toBe(375);
    const columnWidth = l.width - 2 * l.pad;
    expect(l.stride).toBe(columnWidth + l.columnGap);
    // Page n's first column starts n·stride after page 0's; translating by
    // -n·stride therefore puts it exactly at the 24px inset.
    expect((l.pad + 2 * l.stride) % l.stride).toBe(l.pad);
  });

  it('two columns on wide viewports, capped and centred', () => {
    const l = computePageLayout(1440, 24, 'auto');
    expect(l.columns).toBe(2);
    expect(l.width).toBeLessThanOrEqual(1180);
    expect(l.inset).toBe(Math.floor((1440 - l.width) / 2));
    const columnWidth = (l.width - 2 * l.pad - l.columnGap) / 2;
    expect(l.stride).toBeCloseTo(2 * (columnWidth + l.columnGap), 6);
  });

  it('respects an explicit column preference', () => {
    expect(computePageLayout(1440, 24, 'one').columns).toBe(1);
    expect(computePageLayout(700, 24, 'two').columns).toBe(2);
  });

  it('derives the page count from the content scrollWidth', () => {
    const l = computePageLayout(375, 24, 'one');
    // Three columns: last right edge = pad + 3·(cw+gap) − gap, plus end padding.
    const cw = l.width - 2 * l.pad;
    const scrollWidth = l.pad + 3 * (cw + l.columnGap) - l.columnGap + l.pad;
    expect(pageCountFor(scrollWidth, l)).toBe(3);
    expect(pageCountFor(0, l)).toBe(1);
  });

  it('auto theme follows the system appearance', () => {
    expect(effectiveTheme('auto', true)).toBe('night');
    expect(effectiveTheme('auto', false)).toBe('paper');
    expect(effectiveTheme('sepia', true)).toBe('sepia');
  });

  it('migrates the retired serif font choice', () => {
    store.set('rp-reader-prefs', JSON.stringify({ font: 'serif' }));
    expect(loadPrefs().font).toBe('iowan');
    store.set('rp-reader-prefs', JSON.stringify({ font: 'comic' }));
    expect(loadPrefs().font).toBe(DEFAULT_PREFS.font);
  });
});
