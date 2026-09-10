import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from './prefs';

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
    store.set('tl-reader-prefs', JSON.stringify({ theme: 'sepia' }));
    const p = loadPrefs();
    expect(p.theme).toBe('sepia');
    expect(p.lineHeight).toBe(DEFAULT_PREFS.lineHeight);
  });

  it('survives corrupt storage', () => {
    store.set('tl-reader-prefs', '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });
});
