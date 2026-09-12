import { describe, expect, it } from 'vitest';
import { afterIdFor, moveItem } from './reorder';

/**
 * The arithmetic behind every reordering gesture. The keyboard path, the
 * pointer path and the overflow menu all end here, and all of them then send
 * the server one thing: which item this one now follows.
 */

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves an item up and down by one', () => {
    expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves an item to either end', () => {
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves the list alone when nothing moves', () => {
    expect(moveItem(list, 2, 2)).toBe(list);
    expect(moveItem(list, -1, 0)).toBe(list);
    expect(moveItem(list, 9, 0)).toBe(list);
  });

  it('never loses or duplicates an item', () => {
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to < list.length; to++) {
        expect([...moveItem(list, from, to)].sort()).toEqual([...list].sort());
      }
    }
  });
});

describe('afterIdFor', () => {
  it('reports the neighbour the item now follows', () => {
    expect(afterIdFor(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('reports null for the first item, which is what "make it first" sends', () => {
    expect(afterIdFor(['a', 'b', 'c'], 'a')).toBeNull();
  });

  it('reports null for an item that is not in the list at all', () => {
    expect(afterIdFor(['a', 'b'], 'z')).toBeNull();
  });

  it('round-trips a move: apply it, then ask what it now follows', () => {
    const moved = moveItem(['a', 'b', 'c', 'd'], 3, 1);
    expect(moved).toEqual(['a', 'd', 'b', 'c']);
    expect(afterIdFor(moved, 'd')).toBe('a');
  });
});
