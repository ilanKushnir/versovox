import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = new Map<string, Map<string, unknown>>();
const store = (s: string) => {
  if (!stores.has(s)) stores.set(s, new Map());
  return stores.get(s)!;
};

vi.mock('./idb', () => ({
  STORES: {
    pendingEvents: 'pending-events',
    serverState: 'server-state',
    downloads: 'downloads',
    prefs: 'prefs',
  },
  idbPut: vi.fn(async (s: string, k: string, v: unknown) => void store(s).set(k, v)),
  idbGet: vi.fn(async (s: string, k: string) => store(s).get(k)),
  idbDelete: vi.fn(async (s: string, k: string) => void store(s).delete(k)),
  idbClear: vi.fn(async (s: string) => void store(s).clear()),
  idbAll: vi.fn(async (s: string) =>
    [...store(s).entries()].map(([key, value]) => ({ key, value })),
  ),
}));

const apiMock = vi.fn(async () => ({ results: [], state: null }));
vi.mock('../api/client', () => ({
  api: (...args: unknown[]) => apiMock(...(args as [])),
  isOffline: () => false,
  isUnauthorized: () => false,
}));

import { persistActiveLocatorAndFlush, recordCheckpoint, setActiveLocatorProvider } from './engine';
import { type ProgressEvent } from '@versovox/shared';

beforeEach(() => {
  stores.clear();
  apiMock.mockClear();
});

const flushMicro = () => new Promise((r) => setTimeout(r, 20));

describe('lifecycle persistence (visibilitychange/pagehide path)', () => {
  it('writes the LIVE locator to IndexedDB before the keepalive flush', async () => {
    const locator = { medium: 'audio' as const, trackIdx: 1, positionMs: 42_000, pct: 0.3 };
    const unregister = setActiveLocatorProvider(() => ({ bookId: 'bookX', locator }));
    persistActiveLocatorAndFlush();
    await flushMicro();
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    // The current position — inside the debounce/heartbeat window — is durable.
    expect(pending.some((e) => e.bookId === 'bookX' && e.locator.pct === 0.3)).toBe(true);
    unregister();
  });

  it('without an active surface it still flushes the queue', async () => {
    await recordCheckpoint('bookY', 'pause', {
      medium: 'audio',
      trackIdx: 0,
      positionMs: 1,
      pct: 0.01,
    });
    persistActiveLocatorAndFlush();
    await flushMicro();
    expect(apiMock).toHaveBeenCalled();
  });

  it('unregistering the provider stops live capture', async () => {
    const unregister = setActiveLocatorProvider(() => ({
      bookId: 'bookZ',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 5, pct: 0.5 },
    }));
    unregister();
    persistActiveLocatorAndFlush();
    await flushMicro();
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    expect(pending.some((e) => e.bookId === 'bookZ')).toBe(false);
  });
});

describe('baseRevision propagation', () => {
  it('events declare the last server revision known for the book', async () => {
    store('server-state').set('bookR', { revision: 12 });
    await recordCheckpoint(
      'bookR',
      'seek',
      { medium: 'audio', trackIdx: 0, positionMs: 9, pct: 0.9 },
      { flush: false },
    );
    const pending = [...store('pending-events').values()] as ProgressEvent[];
    const ev = pending.find((e) => e.bookId === 'bookR')!;
    expect(ev.baseRevision).toBe(12);
  });

  it('events without cached server state omit baseRevision', async () => {
    await recordCheckpoint(
      'bookNew',
      'open',
      { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0 },
      { flush: false },
    );
    const ev = ([...store('pending-events').values()] as ProgressEvent[]).find(
      (e) => e.bookId === 'bookNew',
    )!;
    expect(ev.baseRevision).toBeUndefined();
  });
});
