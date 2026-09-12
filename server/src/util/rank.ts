/**
 * Fractional ordering keys.
 *
 * Ordered collections here (the reading list, the books inside a shelf, the
 * shelves themselves) store a TEXT rank rather than a position integer, so
 * moving one item writes exactly one row. A position column would rewrite
 * every row below the insertion point — a transaction whose size grows with
 * the list, and one that can half-apply if the process dies mid-drag.
 *
 * Keys are minted only on the server. The client sends the gesture ("put
 * this after that one"), never a key, so two devices reordering at the same
 * moment cannot mint colliding keys.
 */

const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// 62 digits, ASCII-ascending, so JavaScript's string `<` and SQLite's BINARY
// collation both agree with the alphabet's own order. Keys must therefore
// never be compared NOCASE anywhere: 'a' and 'A' are different digits.
const BASE = A.length;

/**
 * A key that sorts strictly between `a` and `b` in byte order. `null` means
 * an open end: `between(null, first)` prepends, `between(last, null)`
 * appends, and `between(null, null)` is the first key of an empty list.
 */
export function between(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) throw new Error('rank: a must sort before b');
  let out = '';
  for (let i = 0; ; i++) {
    const da = a !== null && i < a.length ? A.indexOf(a[i]!) : -1;
    const db = b !== null && i < b.length ? A.indexOf(b[i]!) : BASE;
    if (db - da > 1) {
      const mid = Math.floor((da + db) / 2);
      // A key ending in the padding digit has no room before it: the next
      // insert above it would need a digit below '0'. Descend a place instead
      // and let the key grow by one character.
      if (mid > 0) return out + A[mid]!;
    }
    out += da >= 0 ? A[da]! : A[0]!;
  }
}
