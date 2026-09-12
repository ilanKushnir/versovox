import { describe, expect, it } from 'vitest';
import { between } from './rank.js';

/**
 * The ordering keys behind the reading list and the shelves. Every property
 * here is one the UI depends on: a drag writes one row, and the row it writes
 * must land between its new neighbours on every device that reads it back.
 */

describe('between', () => {
  it('mints a first key in the middle of the space', () => {
    expect(between(null, null)).toBe('U');
  });

  it('appends after a key and prepends before one', () => {
    const first = between(null, null);
    expect(between(first, null) > first).toBe(true);
    expect(between(null, first) < first).toBe(true);
  });

  it('fits a key between two adjacent ones by growing, not renumbering', () => {
    const mid = between('A', 'B');
    expect('A' < mid).toBe(true);
    expect(mid < 'B').toBe(true);
  });

  it('never ends in the padding digit, so an insert before it always has room', () => {
    let head = between(null, null);
    for (let i = 0; i < 200; i++) {
      expect(head.endsWith('0')).toBe(false);
      head = between(null, head);
    }
    let tail = between(null, null);
    for (let i = 0; i < 200; i++) {
      expect(tail.endsWith('0')).toBe(false);
      tail = between(tail, null);
    }
  });

  it('survives a thousand inserts at the same spot', () => {
    const lo = between(null, null);
    const keys: string[] = [];
    let upper = between(lo, null);
    for (let i = 0; i < 1000; i++) {
      const k = between(lo, upper);
      expect(lo < k).toBe(true);
      expect(k < upper).toBe(true);
      keys.push(k);
      upper = k;
    }
    // Each insert lands just under the previous one, so the minted sequence
    // descends; sorted ascending it is exactly its own reverse, with no
    // duplicates and nothing out of place.
    expect([...keys].sort()).toEqual([...keys].reverse());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a whole list ordered when an item is repeatedly dropped into the middle', () => {
    const list: string[] = [];
    for (let i = 0; i < 10; i++) list.push(between(list[list.length - 1] ?? null, null));
    expect([...list].sort()).toEqual(list);
    // The move a drag performs: take the last row and drop it second.
    for (let i = 0; i < 25; i++) {
      list.pop();
      list.splice(1, 0, between(list[0]!, list[1]!));
      expect([...list].sort()).toEqual(list);
    }
  });

  it('refuses a pair that is already out of order', () => {
    expect(() => between('B', 'A')).toThrow(/sort before/);
    expect(() => between('A', 'A')).toThrow(/sort before/);
  });
});
