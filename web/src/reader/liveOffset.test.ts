import { describe, expect, it, vi } from 'vitest';
import { liveCheckpointOffset } from './liveOffset';
import { type TextMap } from './textmap';

/**
 * Lifecycle checkpoints in scroll mode must persist the CURRENT viewport
 * position from live scroll geometry — not the 600ms-debounced ref, which
 * is stale when pagehide fires inside the debounce window.
 */

const fakeMap = {} as TextMap;
const rect = { top: 0, bottom: 800, left: 0, right: 400 } as DOMRect;
const scroller = { getBoundingClientRect: () => rect };

describe('liveCheckpointOffset', () => {
  it('SCROLL MODE: returns the live DOM-derived offset, ignoring the stale debounced ref', () => {
    // The reader scrolled to offset 5230, but pagehide fires inside the
    // debounce window while the ref still says 100.
    const firstVisible = vi.fn(() => 5230);
    const off = liveCheckpointOffset('scroll', 100, fakeMap, scroller, firstVisible);
    expect(off).toBe(5230);
    expect(firstVisible).toHaveBeenCalledWith(fakeMap, rect);
  });

  it('scroll mode falls back to the tracked ref when geometry is unavailable', () => {
    expect(liveCheckpointOffset('scroll', 100, null, scroller)).toBe(100);
    expect(liveCheckpointOffset('scroll', 100, fakeMap, null)).toBe(100);
    const firstVisible = vi.fn(() => null);
    expect(liveCheckpointOffset('scroll', 100, fakeMap, scroller, firstVisible)).toBe(100);
  });

  it('scroll mode survives a measurement throwing (detached DOM at pagehide)', () => {
    const firstVisible = vi.fn(() => {
      throw new Error('detached');
    });
    expect(liveCheckpointOffset('scroll', 100, fakeMap, scroller, firstVisible)).toBe(100);
  });

  it('PAGINATED MODE: keeps the synchronously tracked offset (stable behavior)', () => {
    const firstVisible = vi.fn(() => 9999);
    expect(liveCheckpointOffset('paginated', 4321, fakeMap, scroller, firstVisible)).toBe(4321);
    expect(firstVisible).not.toHaveBeenCalled();
  });
});
