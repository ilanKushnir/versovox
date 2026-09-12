import { describe, expect, it } from 'vitest';
import { NgramIndex } from './ngram-index.js';

/**
 * The index is exact, and this file's job is to keep it that way.
 *
 * It reaches exactness through a hash, so the failure that matters is not "it
 * is slow" but "it quietly returned a pair whose characters do not match", or
 * "it dropped a pair that a naive implementation would have found". Both are
 * checked against a brute-force reference over randomised inputs, including
 * inputs built to force hash collisions and repeated grams.
 */

/** What the old Map-of-strings implementation computed, kept as the oracle. */
function bruteForce(short: string, long: string, n: number): { a: number; b: number }[] {
  const index = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i + n <= s.length; i++) {
      const g = s.slice(i, i + n);
      m.set(g, m.has(g) ? -1 : i);
    }
    return m;
  };
  const si = index(short);
  const li = index(long);
  const out: { a: number; b: number }[] = [];
  for (const [gram, a] of si) {
    if (a === -1) continue;
    const b = li.get(gram);
    if (b === undefined || b === -1) continue;
    out.push({ a, b });
  }
  return out.sort((x, y) => x.b - y.b);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(rnd: () => number, length: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
}

const HUGE = 100_000_000;

describe('NgramIndex', () => {
  it('finds the grams that occur exactly once on each side', () => {
    // The shared passage is unique in both; the runs of 'a' repeat on the left.
    const shared = 'thequickbrownfoxjumpedoverthelazydog';
    const heard = `aaaaaaaaaaaaaa${shared}aaaaaaaaaaaaaa`;
    const book = `zzzzzzzzzzzzzz${shared}yyyyyyyyyyyyyy`;
    const got = new NgramIndex(heard, 14, HUGE).matchAgainst(book);
    expect(got).toEqual(bruteForce(heard, book, 14));
    expect(got.length).toBeGreaterThan(0);
    for (const { a, b } of got) {
      expect(heard.slice(a, a + 14)).toBe(book.slice(b, b + 14));
    }
  });

  it('drops a gram the indexed side used twice', () => {
    const gram = 'abcdefghijklmn';
    const heard = `${gram}xxxxxxxxxxxxxx${gram}`;
    expect(new NgramIndex(heard, 14, HUGE).matchAgainst(`qqqq${gram}qqqq`)).toEqual([]);
  });

  it('drops a gram the streamed side used twice', () => {
    const gram = 'abcdefghijklmn';
    const book = `${gram}zzzzzzzzzzzzzz${gram}`;
    expect(new NgramIndex(`ww${gram}ww`, 14, HUGE).matchAgainst(book)).toEqual([]);
  });

  it('agrees with brute force on random text, across alphabet sizes', () => {
    // A two-letter alphabet forces heavy gram repetition; a full one gives
    // almost none. Both shapes have to come out identical.
    for (const alphabet of ['ab', 'abcde', "abcdefghijklmnopqrstuvwxyz'"]) {
      for (let seed = 1; seed <= 8; seed++) {
        const rnd = mulberry32(seed * 7919);
        const heard = randomText(rnd, 400, alphabet);
        // The book shares real passages with the heard stream, as a real one does.
        const book =
          randomText(rnd, 300, alphabet) +
          heard.slice(50, 150) +
          randomText(rnd, 300, alphabet) +
          heard.slice(200, 260) +
          randomText(rnd, 200, alphabet);
        const n = 14;
        expect(
          new NgramIndex(heard, n, HUGE).matchAgainst(book),
          `alphabet ${alphabet.length}, seed ${seed}`,
        ).toEqual(bruteForce(heard, book, n));
      }
    }
  });

  it('agrees with brute force for n from 1 to 20', () => {
    const rnd = mulberry32(4242);
    const heard = randomText(rnd, 220, 'abcdef');
    const book = randomText(rnd, 180, 'abcdef') + heard.slice(30, 120);
    for (let n = 1; n <= 20; n++) {
      expect(new NgramIndex(heard, n, HUGE).matchAgainst(book), `n=${n}`).toEqual(
        bruteForce(heard, book, n),
      );
    }
  });

  it('never returns a pair whose characters differ', () => {
    // 30,000 characters of a four-letter alphabet is dense enough in 14-grams
    // that hash collisions are near-certain somewhere in the table; every
    // survivor still has to be a real character-for-character match.
    const rnd = mulberry32(31337);
    const heard = randomText(rnd, 30_000, 'abcd');
    const book = randomText(rnd, 30_000, 'abcd');
    for (const { a, b } of new NgramIndex(heard, 14, HUGE).matchAgainst(book)) {
      expect(heard.slice(a, a + 14)).toBe(book.slice(b, b + 14));
    }
  });

  it('handles the degenerate sizes without throwing', () => {
    expect(new NgramIndex('', 14, HUGE).matchAgainst('abcdefghijklmnop')).toEqual([]);
    expect(new NgramIndex('short', 14, HUGE).matchAgainst('abcdefghijklmnop')).toEqual([]);
    expect(new NgramIndex('abcdefghijklmnop', 14, HUGE).matchAgainst('')).toEqual([]);
    expect(new NgramIndex('abcdefghijklmn', 14, HUGE).matchAgainst('abcdefghijklmn')).toEqual([
      { a: 0, b: 0 },
    ]);
  });

  it('indexes only the first `limit` characters of the indexed side', () => {
    const gram = 'zyxwvutsrqponm';
    const heard = `${'a'.repeat(500)}${gram}`;
    // The gram starts at 500, past a limit of 100, so it cannot be found.
    expect(new NgramIndex(heard, 14, 100).matchAgainst(`qq${gram}qq`)).toEqual([]);
    expect(new NgramIndex(heard, 14, HUGE).matchAgainst(`qq${gram}qq`)).toEqual([
      { a: 500, b: 2 },
    ]);
  });

  it('scales past the length that used to be the ceiling', () => {
    // The old Map-of-strings index capped both sides at 1.2M characters, which
    // silently truncated a 36-hour audiobook's ebook. The book side is now
    // streamed, so only the decoded side is bounded at all.
    const rnd = mulberry32(9001);
    const heard = randomText(rnd, 4_000, "abcdefghijklmnopqrstuvwxyz'");
    const filler = randomText(rnd, 1_600_000, "abcdefghijklmnopqrstuvwxyz'");
    const book = filler + heard.slice(1_000, 1_400);
    const got = new NgramIndex(heard, 14, HUGE).matchAgainst(book);
    expect(got.length).toBeGreaterThan(300);
    // Every match lands in the tail, past where the old cap would have stopped.
    for (const { b } of got) expect(b).toBeGreaterThan(1_200_000);
  });
});
