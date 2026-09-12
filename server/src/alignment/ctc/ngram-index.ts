/**
 * The n-gram index, built over the SHORTER of the two strings.
 *
 * Anchoring needs the grams that occur exactly once on each side. The obvious
 * way to find them — index both sides into `Map<string, number>` — allocates
 * one 14-character string per position, about ninety bytes each in V8, which
 * put a hard cap on book length: at 1.2 million characters the index already
 * cost ~110 MB a side, and a 36-hour Russian audiobook romanizes to more than
 * that, so the tail of the book silently became one long gap.
 *
 * This indexes only the heard side — under sampling that is a few tens of
 * thousands of characters against a book's million-plus — into flat typed
 * arrays, then streams the book past it with a rolling hash. Every hit is
 * confirmed by comparing the actual characters, so a hash collision costs a
 * wasted comparison and never a wrong anchor, and a gram's multiplicity on the
 * book side falls out of counting how many book positions hit the same entry.
 *
 * The book is therefore never truncated and never allocated; only the heard
 * side has a size guard, and reaching it means the whole book was decoded at
 * a length no audiobook has.
 */

/** Polynomial base. Odd, so the low bits still move when the tail changes. */
const HASH_BASE = 131;

/** Final avalanche (murmur3 fmix32): a polynomial hash alone has weak low bits. */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Rolling hash of `str[from .. from+n)`, and the multiplier that rolls it. */
function hashAt(str: string, from: number, n: number): number {
  let h = 0;
  for (let i = 0; i < n; i++) h = (Math.imul(h, HASH_BASE) + str.charCodeAt(from + i)) | 0;
  return h;
}

function rollPower(n: number): number {
  let p = 1;
  for (let i = 0; i < n - 1; i++) p = Math.imul(p, HASH_BASE);
  return p | 0;
}

/** True when the two n-character windows are identical. */
function sameGram(a: string, ai: number, b: string, bi: number, n: number): boolean {
  for (let i = 0; i < n; i++) if (a.charCodeAt(ai + i) !== b.charCodeAt(bi + i)) return false;
  return true;
}

const EMPTY = -1;
/** The gram occurs more than once on this side, so it can anchor nothing. */
const REPEATED = -2;

/**
 * Open-addressed index of the grams of one string, exact despite hashing
 * because every probe that matches on hash is confirmed character by
 * character.
 */
export class NgramIndex {
  private readonly mask: number;
  private readonly hashes: Int32Array;
  private readonly pos: Int32Array;
  /** Book-side positions seen for each slot, so multiplicity is exact too. */
  private readonly hits: Int32Array;
  private readonly hitPos: Int32Array;

  constructor(
    private readonly text: string,
    private readonly n: number,
    limit: number,
  ) {
    const end = Math.min(text.length, limit) - n;
    const count = Math.max(1, end + 1);
    // Load factor 0.5: linear probing degrades sharply past that, and the
    // memory is eight bytes a slot either way.
    let size = 1;
    while (size < count * 2) size <<= 1;
    this.mask = size - 1;
    this.hashes = new Int32Array(size);
    this.pos = new Int32Array(size).fill(EMPTY);
    this.hits = new Int32Array(size);
    this.hitPos = new Int32Array(size);

    if (end < 0) return;
    const power = rollPower(n);
    let h = hashAt(text, 0, n);
    for (let i = 0; ; i++) {
      this.insert(h, i);
      if (i >= end) break;
      h =
        (Math.imul(h - Math.imul(text.charCodeAt(i), power), HASH_BASE) + text.charCodeAt(i + n)) |
        0;
    }
  }

  private slotFor(h: number, other: string, at: number): number {
    let slot = mix32(h) & this.mask;
    for (;;) {
      const p = this.pos[slot]!;
      if (p === EMPTY) return slot;
      if (this.hashes[slot] === h) {
        const known = p === REPEATED ? this.hitPos[slot]! : p;
        if (sameGram(this.text, known, other, at, this.n)) return slot;
      }
      slot = (slot + 1) & this.mask;
    }
  }

  private insert(h: number, at: number): void {
    const slot = this.slotFor(h, this.text, at);
    if (this.pos[slot] === EMPTY) {
      this.hashes[slot] = h;
      this.pos[slot] = at;
      // Remembered separately so a slot that later turns out to be repeated
      // still knows a position whose characters it can be compared against.
      this.hitPos[slot] = at;
      return;
    }
    this.pos[slot] = REPEATED;
  }

  /**
   * Stream `other` past this index and return every position pair whose gram
   * occurs exactly once on each side.
   *
   * `other` is the long side and is never indexed: its multiplicity is counted
   * per matched slot as the scan runs, which is the same thing as asking
   * whether that gram is unique in it.
   */
  matchAgainst(other: string): { a: number; b: number }[] {
    const n = this.n;
    const end = other.length - n;
    if (end < 0) return [];
    const power = rollPower(n);
    const found: { a: number; b: number; slot: number }[] = [];
    let h = hashAt(other, 0, n);
    for (let i = 0; ; i++) {
      const slot = mix32(h) & this.mask;
      let s = slot;
      for (;;) {
        const p = this.pos[s]!;
        if (p === EMPTY) break;
        if (this.hashes[s] === h) {
          const known = p === REPEATED ? this.hitPos[s]! : p;
          if (sameGram(this.text, known, other, i, n)) {
            if (p !== REPEATED) {
              this.hits[s] = (this.hits[s]! + 1) | 0;
              found.push({ a: p, b: i, slot: s });
            }
            break;
          }
        }
        s = (s + 1) & this.mask;
      }
      if (i >= end) break;
      h =
        (Math.imul(h - Math.imul(other.charCodeAt(i), power), HASH_BASE) +
          other.charCodeAt(i + n)) |
        0;
    }
    // A gram the long side used twice is no more of an anchor than one this
    // side used twice.
    return found.filter((f) => this.hits[f.slot] === 1).map((f) => ({ a: f.a, b: f.b }));
  }
}
