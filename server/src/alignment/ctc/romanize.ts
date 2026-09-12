/**
 * Romanization of ebook text into the MMS forced-aligner's alphabet.
 *
 * The aligner model (onnx-community/mms-300m-1130-forced-aligner) has a 31-token
 * vocabulary: four specials (<blank> <pad> </s> <unk>) plus the 26 lowercase
 * Latin letters and an apostrophe. There is NO space token, so its greedy decode
 * is one continuous character stream. To find anchors we must push the ebook
 * through the same funnel: same alphabet, same spelling conventions, no spaces.
 *
 * Everything here is pure and synchronous; the anchor matcher owns the I/O.
 *
 * ## Design
 *
 * Two passes over the ORIGINAL string, so that every emitted character can name
 * the source offset it came from:
 *
 *  1. `findExpansions` scans for runs that must be *said differently than they
 *     are written* — digits, currency, percent, abbreviations, "&" — and records
 *     a replacement written in the source language's own script.
 *  2. `romanizeInto` walks the text, emitting an expansion's replacement when it
 *     reaches one and otherwise transliterating character by character.
 *
 * Replacements are transliterated by the very same character pipeline as body
 * text, so "25" in a Russian book and the word "двадцать пять" in the next
 * sentence can never romanize inconsistently.
 *
 * ## Transliteration schemes (all applied regardless of `language`)
 *
 * Script mapping is keyed on the character, not on the book's language: a
 * Russian name in an English novel, or a Hebrew word in an English preface, must
 * still produce letters. `language` only selects number words, abbreviations and
 * decimal-separator conventions.
 *
 *  - **Latin** — NFKD, drop combining marks, lowercase, keep `[a-z']`. Letters
 *    that NFKD does not decompose get an explicit expansion (ß→ss, æ→ae, œ→oe,
 *    ø→o, þ→th, ð→d, đ→d, ł→l, ŋ→ng, …). This is orthographic, not phonetic:
 *    French "garçon" becomes "garcon" while the narrator says /ɡaʁsɔ̃/. Deep
 *    orthographies (fr, en) therefore anchor on fewer, longer words.
 *  - **Cyrillic** — BGN/PCGN (1947) romanization of Russian, simplified: ё→yo
 *    (BGN writes "ë"), ъ and ь are dropped (BGN writes primes, which are not in
 *    the alphabet and are not spoken), and the positional "ye" rule for е is not
 *    applied (е→e everywhere) because it costs a rule and buys one character.
 *    A handful of non-Russian Cyrillic letters (і ї є ґ ў џ љ њ) are included so
 *    Ukrainian/Belarusian/Serbian quotations do not vanish.
 *  - **Greek** — ISO 843 type-2 style transcription of Modern Greek (η→i, υ→y,
 *    χ→ch, ω→o). Greek is not a supported book language; this exists so that
 *    quotations and loanwords do not leave holes.
 *  - **Hebrew** — consonantal skeleton, after the Academy of the Hebrew Language
 *    2006 simplified transliteration, with deliberate deviations toward Modern
 *    Israeli *pronunciation* (which is what the acoustic model heard):
 *      א, ע → nothing (both are realised as zero in Modern Israeli Hebrew, and
 *      unpointed text gives no way to know which vowel they carry);
 *      ח → kh (Academy writes "h", but ח and כ are homophones today);
 *      ך → kh and ף → f, because the final forms are unambiguous where their
 *      non-final counterparts are not (bare כ/פ are written as k/p);
 *      ב, כ, פ → b, k, p — the plosive reading, since niqqud (and with it the
 *      dagesh that would decide b/v, k/kh, p/f) is stripped as combining marks.
 *    Geresh digraphs (ג׳ ז׳ צ׳) map to j, zh, ch. We do NOT restore vowels: the
 *    aligner anchors on the consonant skeleton, which is enough for long words
 *    but does mean Hebrew yields fewer anchors than Latin-script books.
 *  - **Arabic** — ALA-LC romanization with its diacritics dropped (so emphatic
 *    and plain consonants merge: ص/س→s, ض/د→d, ط/ت→t, ظ/ز→z). ع and ء are
 *    dropped, ة→a (pausal reading, which is how a narrator says it), ى→a,
 *    tatweel is dropped. Presentation forms (U+FB50–U+FEFF, including the لا
 *    ligature) are handled by the NFKD step before the table is consulted.
 *
 * ## Numbers and abbreviations — what is and is not expanded
 *
 * The measured decode/ebook character ratio on a real audiobook was 0.937, and
 * unexpanded digits are a large part of that gap: the narrator says "twenty
 * five" where the ebook has "25", and the model's alphabet cannot spell "25".
 *
 * Expanded:
 *  - Integers 0–9999, in every supported language (en de nl fr es it pt ru he ar).
 *  - Group separators: "1,234" (en) / "1.234" (de) / "1 234" with NBSP-class
 *    spaces. A plain ASCII space never joins digit groups — "100 200" in a table
 *    must not become one hundred million.
 *  - Decimals: "3.5" → "three point five", fraction digits read one by one,
 *    with the decimal separator chosen per language (comma for de nl fr es it
 *    pt ru, period for en he ar).
 *  - Ordinals written with a marker: English "1st/2nd/3rd/4th" fully (via a
 *    cardinal→ordinal transform, so 9999th works); fr "1er/2e/3ème", nl "1e",
 *    es/it/pt "1º/1ª" against a 1–12 ordinal table with a cardinal fallback
 *    beyond that. German ordinals are NOT recognised: they are written "1." and
 *    that is indistinguishable from a number at the end of a sentence.
 *  - Currency: $ € £ ¥ ₪ on either side of the number, emitted as a word AFTER
 *    the number in every language ("twenty five dollars"), with singular/plural
 *    selected on the integer value.
 *  - Percent: "25%" → "twenty five percent" (Russian picks процент/процента/
 *    процентов by the usual 1 / 2–4 / rest rule).
 *  - "&" → the language's word for "and".
 *  - Abbreviations: a substantial English table (Mr, Mrs, Dr, St, Prof, Jr, vs,
 *    etc., e.g., i.e., No., military and street forms) and smaller tables for de
 *    fr es it pt nl. Risky keys require a trailing period, an initial capital,
 *    or a following digit ("No. 5" is a number, "No." at the end of a line is
 *    the word "no").
 *
 * NOT expanded (known gaps, deliberate):
 *  - Integers above 9999. Spelling them needs million/milliard plural grammar
 *    (Russian тысяча/тысячи/тысяч, Arabic duals) that is easy to get wrong, and
 *    a wrong expansion is worse than none: it injects letters the narrator never
 *    said. Such numbers simply contribute no characters.
 *  - Years as digit pairs. "1984" spells as "one thousand nine hundred eighty
 *    four"; the narrator most likely said "nineteen eighty four". Detecting a
 *    year from context is guesswork, so we take the cardinal reading and accept
 *    that those few characters produce no anchor.
 *  - Numbers whose separators do not form 1–3 then 3-digit groups ("12,34" in
 *    an English book). They are consumed and emitted as nothing: the whole run
 *    is skipped so a later group cannot be re-read on its own — otherwise the
 *    tail of "1,250,000" would come back as "zero".
 *  - Roman numerals ("Chapter IV"), because "I" is also an English word.
 *  - Times ("3:30"), phone numbers, version strings and ISBNs: the digits are
 *    read as separate cardinals, which is right for "3:30" and wrong for the rest.
 *  - Clock abbreviations (a.m./p.m.), vulgar fractions, and the º/ª markers when
 *    they do not follow digits.
 *  - Russian, Hebrew and Arabic have no abbreviation table.
 *
 * Both English readings of a hundreds value exist ("one hundred five" vs "one
 * hundred and five"); we emit the American form without "and", matching the book
 * the design was validated on. Where an expansion guesses wrong the region
 * simply produces no anchor, which the matcher already tolerates — it makes no
 * proportionality assumption about un-anchored text.
 */

/** The aligner's vocabulary minus the four special tokens. */
export const MODEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz'";

const ALPHABET = new Set(MODEL_ALPHABET);

/** True when every character of `s` is in the model's alphabet. */
export function isModelAlphabet(s: string): boolean {
  for (const ch of s) if (!ALPHABET.has(ch)) return false;
  return true;
}

export interface RomanizedText {
  /** Romanized characters, no spaces — the model emits none. */
  chars: string;
  /**
   * `sourceIndex[i]` is the UTF-16 offset in the ORIGINAL string that produced
   * `chars[i]`. Non-decreasing, so a matcher can binary-search it. Characters
   * from an expansion ("25" → "twentyfive") are spread across the span they
   * replaced, so a position inside the expansion still maps inside the digits.
   */
  sourceIndex: number[];
}

/** Romanize `text` for the aligner. `language` is a BCP-47 code or bare subtag. */
export function romanize(text: string, language: string): string {
  return romanizeWithMap(text, language).chars;
}

/** As `romanize`, but also reports where each output character came from. */
export function romanizeWithMap(text: string, language: string): RomanizedText {
  const lang = resolveLanguage(language);
  const out: Emitter = { chars: [], sourceIndex: [] };
  romanizeInto(out, text, findExpansions(text, lang));
  return { chars: out.chars.join(''), sourceIndex: out.sourceIndex };
}

// ---------------------------------------------------------------------------
// character pipeline
// ---------------------------------------------------------------------------

interface Emitter {
  chars: string[];
  sourceIndex: number[];
}

interface Expansion {
  start: number;
  /** Exclusive end offset in the original string. */
  end: number;
  /** Replacement text, in the source language's own script. */
  words: string;
}

const LETTER_RE = /\p{L}/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
const MARKS_RE = /\p{M}+/gu;

/** Apostrophe-ish characters that may stand for the alphabet's `'`. */
const APOSTROPHES = new Set(["'", '’', '‘', 'ʼ', 'ʻ', '´', '`']);

function push(out: Emitter, s: string, index: number): void {
  // Filtering here rather than trusting the tables makes "never emit a
  // character outside the model alphabet" a property of the code, not of my
  // typing accuracy.
  for (const ch of s) {
    if (!ALPHABET.has(ch)) continue;
    out.chars.push(ch);
    out.sourceIndex.push(index);
  }
}

function romanizeInto(out: Emitter, text: string, expansions?: Expansion[]): void {
  let ei = 0;
  let i = 0;
  while (i < text.length) {
    const exp = expansions?.[ei];
    if (exp !== undefined && i === exp.start) {
      emitExpansion(out, exp);
      i = exp.end;
      ei += 1;
      continue;
    }

    const cp = text.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const ch = String.fromCodePoint(cp);

    // Only Hebrew has digraphs, so the two-character lookup (and the string it
    // allocates) is gated on the Hebrew block rather than run for every char.
    if (cp >= 0x05d0 && cp <= 0x05ea) {
      const digraph = DIGRAPHS.get(text.slice(i, i + 2));
      if (digraph !== undefined) {
        push(out, digraph, i);
        i += 2;
        continue;
      }
    }

    if (APOSTROPHES.has(ch)) {
      // Keep an apostrophe only between letters ("don't"). Typographic quotes
      // reuse the same code points, and a stray `'` around a quoted phrase is a
      // character the narrator never uttered.
      const prev = out.chars[out.chars.length - 1];
      if (prev !== undefined && prev !== "'" && isLetterAt(text, i + width)) push(out, "'", i);
      i += width;
      continue;
    }

    push(out, mapChar(ch), i);
    i += width;
  }
}

function emitExpansion(out: Emitter, exp: Expansion): void {
  const tmp: Emitter = { chars: [], sourceIndex: [] };
  romanizeInto(tmp, exp.words);
  const k = tmp.chars.length;
  const span = Math.max(1, exp.end - exp.start);
  for (let j = 0; j < k; j++) {
    out.chars.push(tmp.chars[j]!);
    // Spread the replacement across the span it stands for, so a hit in the
    // middle of "twentyfive" resolves to the middle of "25" rather than to the
    // character before it.
    out.sourceIndex.push(exp.start + Math.floor((j * span) / k));
  }
}

function isLetterAt(text: string, index: number): boolean {
  const cp = text.codePointAt(index);
  return cp !== undefined && LETTER_RE.test(String.fromCodePoint(cp));
}

const charCache = new Map<string, string>();

/** Map one source character (single code point) to zero or more alphabet chars. */
function mapChar(ch: string): string {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if (c >= 0x61 && c <= 0x7a) return ch; // fast path: most of a Latin book
    if (c >= 0x41 && c <= 0x5a) return ch.toLowerCase();
  }
  const cached = charCache.get(ch);
  if (cached !== undefined) return cached;
  const mapped = computeChar(ch);
  charCache.set(ch, mapped);
  return mapped;
}

function computeChar(ch: string): string {
  const direct = SCRIPTS.get(ch);
  if (direct !== undefined) return direct;
  // NFKD both strips diacritics and unfolds compatibility forms — Arabic
  // presentation forms, the ﬁ ligature, fullwidth Latin — into characters the
  // tables above do know.
  const decomposed = ch.normalize('NFKD').replace(MARKS_RE, '');
  if (decomposed === ch) return '';
  let out = '';
  for (const part of decomposed) out += mapChar(part);
  return out;
}

// ---------------------------------------------------------------------------
// script tables
// ---------------------------------------------------------------------------

/** Latin letters NFKD leaves alone. */
const LATIN_EXTRAS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ħ: 'h',
  ŋ: 'ng',
  ŧ: 't',
  ĸ: 'k',
  ı: 'i',
  ſ: 's',
  ƒ: 'f',
  ʒ: 'zh',
  ȝ: 'g',
};

/** BGN/PCGN (simplified) romanization of Cyrillic; see the module doc. */
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  ґ: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'i',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  љ: 'l',
  м: 'm',
  н: 'n',
  њ: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ў: 'w',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  џ: 'dzh',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** ISO 843 type-2 style transcription of Modern Greek. */
const GREEK: Record<string, string> = {
  α: 'a',
  β: 'v',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'i',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  ς: 's',
  τ: 't',
  υ: 'y',
  φ: 'f',
  χ: 'ch',
  ψ: 'ps',
  ω: 'o',
};

/** Consonantal Hebrew; see the module doc for the deviations and why. */
const HEBREW: Record<string, string> = {
  א: '',
  ב: 'b',
  ג: 'g',
  ד: 'd',
  ה: 'h',
  ו: 'v',
  ז: 'z',
  ח: 'kh',
  ט: 't',
  י: 'y',
  כ: 'k',
  ך: 'kh',
  ל: 'l',
  מ: 'm',
  ם: 'm',
  נ: 'n',
  ן: 'n',
  ס: 's',
  ע: '',
  פ: 'p',
  ף: 'f',
  צ: 'ts',
  ץ: 'ts',
  ק: 'k',
  ר: 'r',
  ש: 'sh',
  ת: 't',
  װ: 'v',
  ױ: 'vy',
  ײ: 'y',
  '־': '',
  '׳': '',
  '״': '',
};

/** ALA-LC Arabic with diacritics dropped; see the module doc. */
const ARABIC: Record<string, string> = {
  ا: 'a',
  آ: 'a',
  أ: 'a',
  إ: 'i',
  ب: 'b',
  ت: 't',
  ة: 'a',
  ث: 'th',
  ج: 'j',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'dh',
  ر: 'r',
  ز: 'z',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'd',
  ط: 't',
  ظ: 'z',
  ع: '',
  غ: 'gh',
  ف: 'f',
  ق: 'q',
  ك: 'k',
  ل: 'l',
  م: 'm',
  ن: 'n',
  ه: 'h',
  و: 'w',
  ؤ: 'w',
  ي: 'y',
  ئ: 'y',
  ى: 'a',
  ء: '',
  ٱ: 'a',
  ـ: '',
  'ٰ': '',
};

const SCRIPTS = buildScriptTable();

function buildScriptTable(): Map<string, string> {
  const map = new Map<string, string>();
  for (const table of [LATIN_EXTRAS, CYRILLIC, GREEK, HEBREW, ARABIC]) {
    for (const [key, value] of Object.entries(table)) {
      map.set(key, value);
      // Cyrillic, Greek and the Latin extras are cased; Hebrew and Arabic are
      // not, and for them toUpperCase is the identity.
      const upper = key.toUpperCase();
      if (upper !== key && upper.length === 1 && !map.has(upper)) map.set(upper, value);
    }
  }
  return map;
}

/**
 * Two-character source sequences. Hebrew borrows foreign consonants by putting
 * a geresh after a letter; the pair must be read before either character is.
 */
const DIGRAPHS = new Map<string, string>(
  (
    [
      ['ג', 'j'],
      ['ז', 'zh'],
      ['צ', 'ch'],
      ['ת', 'th'],
      ['ד', 'dh'],
    ] as const
  ).flatMap(([letter, value]) =>
    ['׳', "'", '’'].map((geresh) => [letter + geresh, value] as [string, string]),
  ),
);

// ---------------------------------------------------------------------------
// number spelling
// ---------------------------------------------------------------------------

function joinWords(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

// --- English ---

const EN_UNITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];

function enBelow100(n: number): string {
  if (n < 20) return EN_UNITS[n]!;
  const u = n % 10;
  return joinWords(EN_TENS[Math.floor(n / 10)]!, u ? EN_UNITS[u]! : null);
}

function enBelow1000(n: number): string {
  if (n < 100) return enBelow100(n);
  const r = n % 100;
  return joinWords(EN_UNITS[Math.floor(n / 100)]!, 'hundred', r ? enBelow100(r) : null);
}

function spellEn(n: number): string {
  if (n < 1000) return enBelow1000(n);
  const r = n % 1000;
  return joinWords(EN_UNITS[Math.floor(n / 1000)]!, 'thousand', r ? enBelow1000(r) : null);
}

const EN_ORDINAL_TAIL: Record<string, string> = {
  zero: 'zeroth',
  one: 'first',
  two: 'second',
  three: 'third',
  five: 'fifth',
  eight: 'eighth',
  nine: 'ninth',
  twelve: 'twelfth',
  hundred: 'hundredth',
  thousand: 'thousandth',
};

function ordinalEn(n: number): string {
  const cardinal = spellEn(n);
  const cut = cardinal.lastIndexOf(' ');
  const head = cut < 0 ? '' : cardinal.slice(0, cut + 1);
  const tail = cut < 0 ? cardinal : cardinal.slice(cut + 1);
  const ordinal =
    EN_ORDINAL_TAIL[tail] ?? (tail.endsWith('y') ? `${tail.slice(0, -1)}ieth` : `${tail}th`);
  return head + ordinal;
}

// --- German ---

const DE_UNITS = [
  'null',
  'eins',
  'zwei',
  'drei',
  'vier',
  'fünf',
  'sechs',
  'sieben',
  'acht',
  'neun',
  'zehn',
  'elf',
  'zwölf',
  'dreizehn',
  'vierzehn',
  'fünfzehn',
  'sechzehn',
  'siebzehn',
  'achtzehn',
  'neunzehn',
];
const DE_TENS = [
  '',
  '',
  'zwanzig',
  'dreißig',
  'vierzig',
  'fünfzig',
  'sechzig',
  'siebzig',
  'achtzig',
  'neunzig',
];

/** "eins" only stands alone; inside a compound it is "ein" (einundzwanzig). */
const deUnit = (u: number): string => (u === 1 ? 'ein' : DE_UNITS[u]!);

function deBelow100(n: number): string {
  if (n < 20) return DE_UNITS[n]!;
  const u = n % 10;
  const tens = DE_TENS[Math.floor(n / 10)]!;
  return u ? `${deUnit(u)}und${tens}` : tens;
}

function deBelow1000(n: number): string {
  if (n < 100) return deBelow100(n);
  const r = n % 100;
  return `${deUnit(Math.floor(n / 100))}hundert${r ? deBelow100(r) : ''}`;
}

function spellDe(n: number): string {
  if (n < 1000) return deBelow1000(n);
  const r = n % 1000;
  return `${deUnit(Math.floor(n / 1000))}tausend${r ? deBelow1000(r) : ''}`;
}

// --- Dutch ---

const NL_UNITS = [
  'nul',
  'een',
  'twee',
  'drie',
  'vier',
  'vijf',
  'zes',
  'zeven',
  'acht',
  'negen',
  'tien',
  'elf',
  'twaalf',
  'dertien',
  'veertien',
  'vijftien',
  'zestien',
  'zeventien',
  'achttien',
  'negentien',
];
const NL_TENS = [
  '',
  '',
  'twintig',
  'dertig',
  'veertig',
  'vijftig',
  'zestig',
  'zeventig',
  'tachtig',
  'negentig',
];

function nlBelow100(n: number): string {
  if (n < 20) return NL_UNITS[n]!;
  const u = n % 10;
  const tens = NL_TENS[Math.floor(n / 10)]!;
  return u ? `${NL_UNITS[u]!}en${tens}` : tens;
}

function nlBelow1000(n: number): string {
  if (n < 100) return nlBelow100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  return `${h === 1 ? '' : NL_UNITS[h]!}honderd${r ? nlBelow100(r) : ''}`;
}

function spellNl(n: number): string {
  if (n < 1000) return nlBelow1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return `${t === 1 ? '' : NL_UNITS[t]!}duizend${r ? nlBelow1000(r) : ''}`;
}

// --- French ---

const FR_UNITS = [
  'zéro',
  'un',
  'deux',
  'trois',
  'quatre',
  'cinq',
  'six',
  'sept',
  'huit',
  'neuf',
  'dix',
  'onze',
  'douze',
  'treize',
  'quatorze',
  'quinze',
  'seize',
  'dix-sept',
  'dix-huit',
  'dix-neuf',
];
const FR_TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function frBelow100(n: number): string {
  if (n < 20) return FR_UNITS[n]!;
  if (n < 70) {
    const tens = FR_TENS[Math.floor(n / 10)]!;
    const u = n % 10;
    if (u === 1) return `${tens} et un`;
    return u ? `${tens} ${FR_UNITS[u]!}` : tens;
  }
  // 70–79 and 90–99 count on in teens: soixante-dix, quatre-vingt-dix.
  if (n < 80) return n === 71 ? 'soixante et onze' : `soixante ${FR_UNITS[n - 60]!}`;
  const rest = n - 80;
  if (rest === 0) return 'quatre-vingts';
  return `quatre-vingt ${FR_UNITS[rest]!}`;
}

function frBelow1000(n: number): string {
  if (n < 100) return frBelow100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h === 1) return joinWords('cent', r ? frBelow100(r) : null);
  return joinWords(FR_UNITS[h]!, r ? 'cent' : 'cents', r ? frBelow100(r) : null);
}

function spellFr(n: number): string {
  if (n < 1000) return frBelow1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return joinWords(t === 1 ? null : FR_UNITS[t]!, 'mille', r ? frBelow1000(r) : null);
}

// --- Spanish ---

const ES_UNITS = [
  'cero',
  'uno',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
];
const ES_TENS = [
  '',
  '',
  '',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
];
const ES_HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
];

function esBelow100(n: number): string {
  if (n < 30) return ES_UNITS[n]!;
  const u = n % 10;
  return joinWords(ES_TENS[Math.floor(n / 10)]!, u ? 'y' : null, u ? ES_UNITS[u]! : null);
}

function esBelow1000(n: number): string {
  if (n < 100) return esBelow100(n);
  if (n === 100) return 'cien'; // "ciento" only ever appears with a remainder
  const r = n % 100;
  return joinWords(ES_HUNDREDS[Math.floor(n / 100)]!, r ? esBelow100(r) : null);
}

function spellEs(n: number): string {
  if (n < 1000) return esBelow1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return joinWords(t === 1 ? null : ES_UNITS[t]!, 'mil', r ? esBelow1000(r) : null);
}

// --- Italian ---

const IT_UNITS = [
  'zero',
  'uno',
  'due',
  'tre',
  'quattro',
  'cinque',
  'sei',
  'sette',
  'otto',
  'nove',
  'dieci',
  'undici',
  'dodici',
  'tredici',
  'quattordici',
  'quindici',
  'sedici',
  'diciassette',
  'diciotto',
  'diciannove',
];
const IT_TENS = [
  '',
  '',
  'venti',
  'trenta',
  'quaranta',
  'cinquanta',
  'sessanta',
  'settanta',
  'ottanta',
  'novanta',
];

function itBelow100(n: number): string {
  if (n < 20) return IT_UNITS[n]!;
  const u = n % 10;
  let tens = IT_TENS[Math.floor(n / 10)]!;
  // The tens lose their final vowel before uno and otto: ventuno, ventotto.
  if (u === 1 || u === 8) tens = tens.slice(0, -1);
  return u ? `${tens}${u === 3 ? 'tré' : IT_UNITS[u]!}` : tens;
}

function itBelow1000(n: number): string {
  if (n < 100) return itBelow100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  return `${h === 1 ? '' : IT_UNITS[h]!}cento${r ? itBelow100(r) : ''}`;
}

function spellIt(n: number): string {
  if (n < 1000) return itBelow1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return `${t === 1 ? 'mille' : `${IT_UNITS[t]!}mila`}${r ? itBelow1000(r) : ''}`;
}

// --- Portuguese ---

const PT_UNITS = [
  'zero',
  'um',
  'dois',
  'três',
  'quatro',
  'cinco',
  'seis',
  'sete',
  'oito',
  'nove',
  'dez',
  'onze',
  'doze',
  'treze',
  'catorze',
  'quinze',
  'dezesseis',
  'dezessete',
  'dezoito',
  'dezenove',
];
const PT_TENS = [
  '',
  '',
  'vinte',
  'trinta',
  'quarenta',
  'cinquenta',
  'sessenta',
  'setenta',
  'oitenta',
  'noventa',
];
const PT_HUNDREDS = [
  '',
  'cento',
  'duzentos',
  'trezentos',
  'quatrocentos',
  'quinhentos',
  'seiscentos',
  'setecentos',
  'oitocentos',
  'novecentos',
];

function ptBelow100(n: number): string {
  if (n < 20) return PT_UNITS[n]!;
  const u = n % 10;
  return joinWords(PT_TENS[Math.floor(n / 10)]!, u ? 'e' : null, u ? PT_UNITS[u]! : null);
}

function ptBelow1000(n: number): string {
  if (n < 100) return ptBelow100(n);
  if (n === 100) return 'cem';
  const r = n % 100;
  return joinWords(PT_HUNDREDS[Math.floor(n / 100)]!, r ? 'e' : null, r ? ptBelow100(r) : null);
}

function spellPt(n: number): string {
  if (n < 1000) return ptBelow1000(n);
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  return joinWords(t === 1 ? null : PT_UNITS[t]!, 'mil', r ? 'e' : null, r ? ptBelow1000(r) : null);
}

// --- Russian (masculine nominative) ---

const RU_UNITS = [
  'ноль',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];
const RU_TENS = [
  '',
  '',
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто',
];
const RU_HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
];

function ruBelow100(n: number): string {
  if (n < 20) return RU_UNITS[n]!;
  const u = n % 10;
  return joinWords(RU_TENS[Math.floor(n / 10)]!, u ? RU_UNITS[u]! : null);
}

function ruBelow1000(n: number): string {
  if (n < 100) return ruBelow100(n);
  const r = n % 100;
  return joinWords(RU_HUNDREDS[Math.floor(n / 100)]!, r ? ruBelow100(r) : null);
}

/** тысяча is feminine and takes the usual 1 / 2–4 / rest count forms. */
function ruThousands(t: number): string {
  if (t === 1) return 'одна тысяча';
  if (t === 2) return 'две тысячи';
  if (t <= 4) return `${RU_UNITS[t]!} тысячи`;
  return `${RU_UNITS[t]!} тысяч`;
}

function spellRu(n: number): string {
  if (n < 1000) return ruBelow1000(n);
  const r = n % 1000;
  return joinWords(ruThousands(Math.floor(n / 1000)), r ? ruBelow1000(r) : null);
}

// --- Hebrew (feminine, which is how a bare number is read aloud) ---

const HE_UNITS = [
  'אפס',
  'אחת',
  'שתיים',
  'שלוש',
  'ארבע',
  'חמש',
  'שש',
  'שבע',
  'שמונה',
  'תשע',
  'עשר',
  'אחת עשרה',
  'שתים עשרה',
  'שלוש עשרה',
  'ארבע עשרה',
  'חמש עשרה',
  'שש עשרה',
  'שבע עשרה',
  'שמונה עשרה',
  'תשע עשרה',
];
const HE_TENS = [
  '',
  '',
  'עשרים',
  'שלושים',
  'ארבעים',
  'חמישים',
  'שישים',
  'שבעים',
  'שמונים',
  'תשעים',
];
const HE_HUNDREDS = [
  '',
  'מאה',
  'מאתיים',
  'שלוש מאות',
  'ארבע מאות',
  'חמש מאות',
  'שש מאות',
  'שבע מאות',
  'שמונה מאות',
  'תשע מאות',
];
const HE_THOUSANDS = [
  '',
  'אלף',
  'אלפיים',
  'שלושת אלפים',
  'ארבעת אלפים',
  'חמשת אלפים',
  'ששת אלפים',
  'שבעת אלפים',
  'שמונת אלפים',
  'תשעת אלפים',
];

function heBelow100(n: number): string {
  if (n < 20) return HE_UNITS[n]!;
  const u = n % 10;
  const tens = HE_TENS[Math.floor(n / 10)]!;
  return u ? `${tens} ו${HE_UNITS[u]!}` : tens;
}

function spellHe(n: number): string {
  const parts = [
    HE_THOUSANDS[Math.floor(n / 1000)]!,
    HE_HUNDREDS[Math.floor((n % 1000) / 100)]!,
    n % 100 || n === 0 ? heBelow100(n % 100) : '',
  ].filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  if (parts.length < 2 || last === undefined) return parts.join(' ');
  // ו ("and") attaches to the final group — unless heBelow100 already put it
  // there (שלושים וארבע), in which case a second one would be ungrammatical.
  const head = parts.slice(0, -1).join(' ');
  return `${head} ${last.includes(' ו') ? last : `ו${last}`}`;
}

// --- Arabic (masculine) ---

const AR_UNITS = [
  'صفر',
  'واحد',
  'اثنان',
  'ثلاثة',
  'أربعة',
  'خمسة',
  'ستة',
  'سبعة',
  'ثمانية',
  'تسعة',
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = [
  '',
  'مئة',
  'مئتان',
  'ثلاثمئة',
  'أربعمئة',
  'خمسمئة',
  'ستمئة',
  'سبعمئة',
  'ثمانمئة',
  'تسعمئة',
];
const AR_THOUSANDS = [
  '',
  'ألف',
  'ألفان',
  'ثلاثة آلاف',
  'أربعة آلاف',
  'خمسة آلاف',
  'ستة آلاف',
  'سبعة آلاف',
  'ثمانية آلاف',
  'تسعة آلاف',
];

function arBelow100(n: number): string {
  if (n < 20) return AR_UNITS[n]!;
  const u = n % 10;
  const tens = AR_TENS[Math.floor(n / 10)]!;
  return u ? `${AR_UNITS[u]!} و${tens}` : tens;
}

function spellAr(n: number): string {
  const parts = [
    AR_THOUSANDS[Math.floor(n / 1000)]!,
    AR_HUNDREDS[Math.floor((n % 1000) / 100)]!,
    n % 100 || n === 0 ? arBelow100(n % 100) : '',
  ].filter((p) => p.length > 0);
  // Arabic coordinates every group with و, attached to the following word.
  return parts.join(' و');
}

// ---------------------------------------------------------------------------
// language rules
// ---------------------------------------------------------------------------

interface Abbreviation {
  /** Matched case-insensitively; may itself contain periods ("e.g."). */
  key: string;
  words: string;
  /** Only match when a period follows (or the key ends in one). */
  needsPeriod?: boolean;
  /** Only match when written with an initial capital. */
  needsCapital?: boolean;
  /** Only match when a number follows ("No. 5" but not a sentence-final "No."). */
  needsDigit?: boolean;
}

interface LanguageRules {
  code: string;
  /** True where "," is the decimal separator and "." groups thousands. */
  decimalComma: boolean;
  spellCardinal(n: number): string;
  spellOrdinal(n: number): string;
  /** Lowercase ordinal markers that may follow digits, longest first. */
  ordinalMarkers: string[];
  decimalPoint: string;
  percent(n: number): string;
  currency: Record<string, { one: string; many: string }>;
  and: string;
  abbreviations: Abbreviation[];
}

/** Ordinal words 1–12 where a digit+marker form is common; else the cardinal. */
function tableOrdinal(table: string[], spell: (n: number) => string): (n: number) => string {
  // Index 0 is the empty placeholder: "0th" falls through to the cardinal.
  return (n) => table[n] || spell(n);
}

const EN_ABBREVIATIONS: Abbreviation[] = [
  { key: 'mr', words: 'mister', needsCapital: true },
  { key: 'mrs', words: 'missus', needsCapital: true },
  { key: 'ms', words: 'miz', needsCapital: true },
  { key: 'dr', words: 'doctor', needsCapital: true },
  { key: 'prof', words: 'professor', needsCapital: true },
  { key: 'st', words: 'saint', needsCapital: true, needsPeriod: true },
  { key: 'jr', words: 'junior', needsCapital: true },
  { key: 'sr', words: 'senior', needsCapital: true },
  { key: 'capt', words: 'captain', needsCapital: true },
  { key: 'lt', words: 'lieutenant', needsCapital: true },
  { key: 'sgt', words: 'sergeant', needsCapital: true },
  { key: 'col', words: 'colonel', needsCapital: true, needsPeriod: true },
  { key: 'gen', words: 'general', needsCapital: true, needsPeriod: true },
  { key: 'rev', words: 'reverend', needsCapital: true, needsPeriod: true },
  { key: 'hon', words: 'honourable', needsCapital: true, needsPeriod: true },
  { key: 'pres', words: 'president', needsCapital: true, needsPeriod: true },
  { key: 'mt', words: 'mount', needsCapital: true, needsPeriod: true },
  { key: 'ave', words: 'avenue', needsCapital: true, needsPeriod: true },
  { key: 'blvd', words: 'boulevard', needsCapital: true, needsPeriod: true },
  { key: 'rd', words: 'road', needsCapital: true, needsPeriod: true },
  { key: 'inc', words: 'incorporated', needsCapital: true, needsPeriod: true },
  { key: 'ltd', words: 'limited', needsCapital: true, needsPeriod: true },
  { key: 'corp', words: 'corporation', needsCapital: true, needsPeriod: true },
  { key: 'co', words: 'company', needsCapital: true, needsPeriod: true },
  { key: 'dept', words: 'department', needsPeriod: true },
  { key: 'approx', words: 'approximately', needsPeriod: true },
  { key: 'vol', words: 'volume', needsPeriod: true },
  { key: 'no', words: 'number', needsCapital: true, needsPeriod: true, needsDigit: true },
  { key: 'vs', words: 'versus' },
  { key: 'etc', words: 'et cetera' },
  { key: 'e.g.', words: 'for example' },
  { key: 'i.e.', words: 'that is' },
];

const LATIN_CURRENCY = (
  dollar: [string, string],
  euro: [string, string],
  pound: [string, string],
  yen: string,
  shekel: [string, string],
): LanguageRules['currency'] => ({
  $: { one: dollar[0], many: dollar[1] },
  '€': { one: euro[0], many: euro[1] },
  '£': { one: pound[0], many: pound[1] },
  '¥': { one: yen, many: yen },
  '₪': { one: shekel[0], many: shekel[1] },
});

const RULES: Record<string, LanguageRules> = {
  en: {
    code: 'en',
    decimalComma: false,
    spellCardinal: spellEn,
    spellOrdinal: ordinalEn,
    ordinalMarkers: ['st', 'nd', 'rd', 'th'],
    decimalPoint: 'point',
    percent: () => 'percent',
    currency: LATIN_CURRENCY(['dollar', 'dollars'], ['euro', 'euros'], ['pound', 'pounds'], 'yen', [
      'shekel',
      'shekels',
    ]),
    and: 'and',
    abbreviations: EN_ABBREVIATIONS,
  },
  de: {
    code: 'de',
    decimalComma: true,
    spellCardinal: spellDe,
    // German ordinals are written "1." — indistinguishable from a sentence end.
    spellOrdinal: spellDe,
    ordinalMarkers: [],
    decimalPoint: 'komma',
    percent: () => 'prozent',
    currency: LATIN_CURRENCY(['dollar', 'dollar'], ['euro', 'euro'], ['pfund', 'pfund'], 'yen', [
      'schekel',
      'schekel',
    ]),
    and: 'und',
    abbreviations: [
      { key: 'hr', words: 'herr', needsCapital: true, needsPeriod: true },
      { key: 'fr', words: 'frau', needsCapital: true, needsPeriod: true },
      { key: 'dr', words: 'doktor', needsCapital: true },
      { key: 'prof', words: 'professor', needsCapital: true },
      { key: 'st', words: 'sankt', needsCapital: true, needsPeriod: true },
      { key: 'nr', words: 'nummer', needsCapital: true, needsPeriod: true },
      { key: 'str', words: 'straße', needsCapital: true, needsPeriod: true },
      { key: 'z.b.', words: 'zum beispiel' },
      { key: 'd.h.', words: 'das heißt' },
      { key: 'u.a.', words: 'unter anderem' },
      { key: 'usw', words: 'und so weiter', needsPeriod: true },
      { key: 'bzw', words: 'beziehungsweise', needsPeriod: true },
      { key: 'ca', words: 'zirka', needsPeriod: true },
    ],
  },
  nl: {
    code: 'nl',
    decimalComma: true,
    spellCardinal: spellNl,
    spellOrdinal: tableOrdinal(
      [
        '',
        'eerste',
        'tweede',
        'derde',
        'vierde',
        'vijfde',
        'zesde',
        'zevende',
        'achtste',
        'negende',
        'tiende',
        'elfde',
        'twaalfde',
      ],
      spellNl,
    ),
    ordinalMarkers: ['ste', 'de', 'e'],
    decimalPoint: 'komma',
    percent: () => 'procent',
    currency: LATIN_CURRENCY(['dollar', 'dollar'], ['euro', 'euro'], ['pond', 'pond'], 'yen', [
      'sjekel',
      'sjekel',
    ]),
    and: 'en',
    abbreviations: [
      { key: 'dhr', words: 'de heer', needsPeriod: true },
      { key: 'mevr', words: 'mevrouw', needsPeriod: true },
      { key: 'mw', words: 'mevrouw', needsPeriod: true },
      { key: 'dr', words: 'dokter', needsCapital: true },
      { key: 'prof', words: 'professor', needsCapital: true },
      { key: 'st', words: 'sint', needsCapital: true, needsPeriod: true },
      { key: 'bijv', words: 'bijvoorbeeld', needsPeriod: true },
      { key: 'enz', words: 'enzovoort', needsPeriod: true },
      { key: 'blz', words: 'bladzijde', needsPeriod: true },
    ],
  },
  fr: {
    code: 'fr',
    decimalComma: true,
    spellCardinal: spellFr,
    spellOrdinal: tableOrdinal(
      [
        '',
        'premier',
        'deuxième',
        'troisième',
        'quatrième',
        'cinquième',
        'sixième',
        'septième',
        'huitième',
        'neuvième',
        'dixième',
        'onzième',
        'douzième',
      ],
      spellFr,
    ),
    ordinalMarkers: ['ères', 'ère', 'ers', 'ème', 'er', 're', 'e'],
    decimalPoint: 'virgule',
    percent: () => 'pour cent',
    currency: LATIN_CURRENCY(['dollar', 'dollars'], ['euro', 'euros'], ['livre', 'livres'], 'yen', [
      'shekel',
      'shekels',
    ]),
    and: 'et',
    abbreviations: [
      { key: 'mme', words: 'madame', needsCapital: true },
      { key: 'mlle', words: 'mademoiselle', needsCapital: true },
      { key: 'mm', words: 'messieurs', needsCapital: true, needsPeriod: true },
      { key: 'm', words: 'monsieur', needsCapital: true, needsPeriod: true },
      { key: 'dr', words: 'docteur', needsCapital: true },
      { key: 'ste', words: 'sainte', needsCapital: true, needsPeriod: true },
      { key: 'st', words: 'saint', needsCapital: true, needsPeriod: true },
      { key: 'etc', words: 'et cetera' },
      { key: 'p.ex.', words: 'par exemple' },
      { key: 'c.-à-d.', words: "c'est-à-dire" },
    ],
  },
  es: {
    code: 'es',
    decimalComma: true,
    spellCardinal: spellEs,
    spellOrdinal: tableOrdinal(
      [
        '',
        'primero',
        'segundo',
        'tercero',
        'cuarto',
        'quinto',
        'sexto',
        'séptimo',
        'octavo',
        'noveno',
        'décimo',
        'undécimo',
        'duodécimo',
      ],
      spellEs,
    ),
    ordinalMarkers: ['º', 'ª', '°', 'er'],
    decimalPoint: 'coma',
    percent: () => 'por ciento',
    currency: LATIN_CURRENCY(['dólar', 'dólares'], ['euro', 'euros'], ['libra', 'libras'], 'yen', [
      'séquel',
      'séqueles',
    ]),
    and: 'y',
    abbreviations: [
      { key: 'sr', words: 'señor', needsCapital: true, needsPeriod: true },
      { key: 'sra', words: 'señora', needsCapital: true, needsPeriod: true },
      { key: 'srta', words: 'señorita', needsCapital: true, needsPeriod: true },
      { key: 'dra', words: 'doctora', needsCapital: true, needsPeriod: true },
      { key: 'dr', words: 'doctor', needsCapital: true, needsPeriod: true },
      { key: 'ud', words: 'usted', needsCapital: true, needsPeriod: true },
      { key: 'etc', words: 'etcétera' },
    ],
  },
  it: {
    code: 'it',
    decimalComma: true,
    spellCardinal: spellIt,
    spellOrdinal: tableOrdinal(
      [
        '',
        'primo',
        'secondo',
        'terzo',
        'quarto',
        'quinto',
        'sesto',
        'settimo',
        'ottavo',
        'nono',
        'decimo',
        'undicesimo',
        'dodicesimo',
      ],
      spellIt,
    ),
    ordinalMarkers: ['º', 'ª', '°'],
    decimalPoint: 'virgola',
    percent: () => 'per cento',
    currency: LATIN_CURRENCY(
      ['dollaro', 'dollari'],
      ['euro', 'euro'],
      ['sterlina', 'sterline'],
      'yen',
      ['siclo', 'sicli'],
    ),
    and: 'e',
    abbreviations: [
      { key: 'sig.ra', words: 'signora', needsCapital: true },
      { key: 'sig', words: 'signore', needsCapital: true, needsPeriod: true },
      { key: 'dott', words: 'dottore', needsCapital: true, needsPeriod: true },
      { key: 'prof', words: 'professore', needsCapital: true, needsPeriod: true },
      { key: 'ecc', words: 'eccetera', needsPeriod: true },
    ],
  },
  pt: {
    code: 'pt',
    decimalComma: true,
    spellCardinal: spellPt,
    spellOrdinal: tableOrdinal(
      [
        '',
        'primeiro',
        'segundo',
        'terceiro',
        'quarto',
        'quinto',
        'sexto',
        'sétimo',
        'oitavo',
        'nono',
        'décimo',
        'décimo primeiro',
        'décimo segundo',
      ],
      spellPt,
    ),
    ordinalMarkers: ['º', 'ª', '°'],
    decimalPoint: 'vírgula',
    percent: () => 'por cento',
    currency: LATIN_CURRENCY(['dólar', 'dólares'], ['euro', 'euros'], ['libra', 'libras'], 'iene', [
      'shekel',
      'shekels',
    ]),
    and: 'e',
    abbreviations: [
      { key: 'sr', words: 'senhor', needsCapital: true, needsPeriod: true },
      { key: 'sra', words: 'senhora', needsCapital: true, needsPeriod: true },
      { key: 'dra', words: 'doutora', needsCapital: true, needsPeriod: true },
      { key: 'dr', words: 'doutor', needsCapital: true, needsPeriod: true },
      { key: 'st', words: 'santo', needsCapital: true, needsPeriod: true },
      { key: 'etc', words: 'etcétera' },
    ],
  },
  ru: {
    code: 'ru',
    decimalComma: true,
    spellCardinal: spellRu,
    spellOrdinal: spellRu, // Russian ordinals decline; digits+marker are rare
    ordinalMarkers: [],
    decimalPoint: 'запятая',
    percent: (n) => {
      const tens = n % 100;
      if (tens >= 11 && tens <= 14) return 'процентов';
      const u = n % 10;
      if (u === 1) return 'процент';
      if (u >= 2 && u <= 4) return 'процента';
      return 'процентов';
    },
    currency: LATIN_CURRENCY(['доллар', 'долларов'], ['евро', 'евро'], ['фунт', 'фунтов'], 'иен', [
      'шекель',
      'шекелей',
    ]),
    and: 'и',
    abbreviations: [],
  },
  he: {
    code: 'he',
    decimalComma: false,
    spellCardinal: spellHe,
    spellOrdinal: spellHe,
    ordinalMarkers: [],
    decimalPoint: 'נקודה',
    percent: () => 'אחוז',
    currency: LATIN_CURRENCY(['דולר', 'דולר'], ['אירו', 'אירו'], ['לירה', 'לירות'], 'ין', [
      'שקל',
      'שקלים',
    ]),
    and: 'ו',
    abbreviations: [],
  },
  ar: {
    code: 'ar',
    decimalComma: false,
    spellCardinal: spellAr,
    spellOrdinal: spellAr,
    ordinalMarkers: [],
    decimalPoint: 'فاصلة',
    percent: () => 'بالمئة',
    currency: LATIN_CURRENCY(['دولار', 'دولار'], ['يورو', 'يورو'], ['جنيه', 'جنيه'], 'ين', [
      'شيكل',
      'شيكل',
    ]),
    and: 'و',
    abbreviations: [],
  },
};

/**
 * An unknown language still gets full script transliteration; it just borrows
 * English number words and abbreviations, which is the least-wrong default for
 * an ebook whose metadata lied about its language.
 */
function resolveLanguage(language: string): LanguageRules {
  const base = (language || '').toLowerCase().split(/[-_]/)[0] ?? '';
  return RULES[base] ?? RULES.en!;
}

// ---------------------------------------------------------------------------
// expansion scanning
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = new Set(['$', '€', '£', '¥', '₪']);
/** Thousands separators a typesetter uses; a plain space is never one. */
const THIN_SPACES = new Set([' ', ' ', ' ']);
const MAX_SPELLABLE = 9999;

function digitValue(ch: string | undefined): number {
  if (ch === undefined) return -1;
  const c = ch.charCodeAt(0);
  if (c >= 0x30 && c <= 0x39) return c - 0x30; // ASCII
  if (c >= 0x660 && c <= 0x669) return c - 0x660; // Arabic-Indic
  if (c >= 0x6f0 && c <= 0x6f9) return c - 0x6f0; // Extended Arabic-Indic
  return -1;
}

/** First character at or after `at` that is not whitespace. */
function nextNonSpace(text: string, at: number): string | undefined {
  let p = at;
  while (p < text.length && /\s/.test(text[p]!)) p += 1;
  return text[p];
}

function findExpansions(text: string, lang: LanguageRules): Expansion[] {
  const out: Expansion[] = [];
  const abbreviations = indexAbbreviations(lang);
  let prevAlnum = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    // Numbers and abbreviations only start at a word boundary, so "A4" and
    // "x2" stay untouched.
    const number = prevAlnum ? null : scanNumber(text, i, lang);
    if (number !== null) {
      if (number.words !== null) out.push({ start: i, end: number.end, words: number.words });
      i = number.end;
      prevAlnum = false;
      continue;
    }
    const abbreviation = prevAlnum ? null : scanAbbreviation(text, i, abbreviations);
    if (abbreviation !== null) {
      out.push(abbreviation);
      i = abbreviation.end;
      prevAlnum = false;
      continue;
    }
    if (ch === '&') {
      out.push({ start: i, end: i + 1, words: lang.and });
      i += 1;
      prevAlnum = false;
      continue;
    }
    prevAlnum = ALNUM_RE.test(ch);
    i += 1;
  }
  return out;
}

// --- numbers ---

interface NumberScan {
  start: number;
  end: number;
  /**
   * `null` when the run is a number we decline to spell (too large, implausible
   * grouping). The caller still skips the whole run: re-entering it one digit
   * later would read the last group of "1,250,000" as "zero".
   */
  words: string | null;
}

function scanNumber(text: string, start: number, lang: LanguageRules): NumberScan | null {
  let p = start;
  let currency: string | null = null;

  const lead = text[p];
  if (lead !== undefined && CURRENCY_SYMBOLS.has(lead)) {
    let q = p + 1;
    if (text[q] === ' ' || THIN_SPACES.has(text[q] ?? '')) q += 1;
    if (digitValue(text[q]) < 0) return null; // a lone "$" is not a number
    currency = lead;
    p = q;
  }
  if (digitValue(text[p]) < 0) return null;

  // Collect digits plus any separator that is itself followed by a digit; that
  // proviso keeps a sentence-final "1990." from swallowing the period.
  let token = '';
  while (p < text.length) {
    const c = text[p]!;
    const d = digitValue(c);
    if (d >= 0) {
      token += String(d);
      p += 1;
      continue;
    }
    if ((c === '.' || c === ',' || THIN_SPACES.has(c)) && digitValue(text[p + 1]) >= 0) {
      token += THIN_SPACES.has(c) ? ' ' : c;
      p += 1;
      continue;
    }
    break;
  }

  const parsed = parseNumberToken(token, lang);
  if (parsed === null) return { start, end: p, words: null };

  const ordinal = scanOrdinalMarker(text, p, lang);
  if (ordinal !== null) p = ordinal.end;

  let percent = false;
  if (!currency && ordinal === null) {
    let q = p;
    if (text[q] === ' ' || THIN_SPACES.has(text[q] ?? '')) q += 1;
    const c = text[q];
    if (c === '%') {
      percent = true;
      p = q + 1;
    } else if (c !== undefined && CURRENCY_SYMBOLS.has(c)) {
      currency = c;
      p = q + 1;
    }
  }

  const words = spellNumber(lang, parsed, { ordinal: ordinal !== null, currency, percent });
  return { start, end: p, words: words.length > 0 ? words : null };
}

interface ParsedNumber {
  integer: number;
  /** Fraction digits, read one by one; empty when the number is an integer. */
  fraction: string;
}

function parseNumberToken(token: string, lang: LanguageRules): ParsedNumber | null {
  const decimalSep = lang.decimalComma ? ',' : '.';

  let body = token;
  let fraction = '';
  const decimals = countOccurrences(body, decimalSep);
  if (decimals === 1) {
    const at = body.indexOf(decimalSep);
    fraction = body.slice(at + 1);
    body = body.slice(0, at);
  }
  // Two or more "decimal" separators can only be grouping ("1.234.567" in an
  // English book), so they fall through to the grouping check below.

  const groups = body.split(SEPARATOR_RE);
  if (groups.length > 1) {
    // Reject anything that is not 1–3 digits then 3-digit groups: "3,5" in an
    // English book is a typo or a list, not three and a half.
    const head = groups[0]!;
    if (head.length === 0 || head.length > 3) return null;
    for (const g of groups.slice(1)) if (g.length !== 3) return null;
  }
  const digits = groups.join('');
  if (digits.length === 0 || digits.length > 4) return null; // > 9999: see the module doc
  const integer = Number(digits);
  if (!Number.isFinite(integer) || integer > MAX_SPELLABLE) return null;
  if (fraction.length > 0 && !/^\d+$/.test(fraction)) return null;
  return { integer, fraction };
}

/** Any separator that survived into the integer part is grouping. */
const SEPARATOR_RE = /[., ]/;

function countOccurrences(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n += 1;
  return n;
}

function scanOrdinalMarker(text: string, at: number, lang: LanguageRules): { end: number } | null {
  for (const marker of lang.ordinalMarkers) {
    const slice = text.slice(at, at + marker.length);
    if (slice.toLowerCase() !== marker) continue;
    const after = at + marker.length;
    // The marker must end the word, or "1ster" would read as an ordinal.
    if (isLetterAt(text, after) || digitValue(text[after]) >= 0) continue;
    return { end: after };
  }
  return null;
}

function spellNumber(
  lang: LanguageRules,
  parsed: ParsedNumber,
  opts: { ordinal: boolean; currency: string | null; percent: boolean },
): string {
  const { integer, fraction } = parsed;
  let words = opts.ordinal ? lang.spellOrdinal(integer) : lang.spellCardinal(integer);
  if (fraction.length > 0) {
    const digits = [...fraction].map((d) => lang.spellCardinal(Number(d)));
    words = joinWords(words, lang.decimalPoint, ...digits);
  }
  if (opts.currency !== null) {
    const names = lang.currency[opts.currency];
    // The currency word follows the amount in every language we support, even
    // where the symbol precedes it ("$25" → "twenty five dollars").
    if (names) words = joinWords(words, integer === 1 && !fraction ? names.one : names.many);
  }
  if (opts.percent) words = joinWords(words, lang.percent(integer));
  return words;
}

// --- abbreviations ---

const abbreviationIndex = new Map<string, Map<string, Abbreviation[]>>();

/** Bucket a language's abbreviations by first letter; longest key wins. */
function indexAbbreviations(lang: LanguageRules): Map<string, Abbreviation[]> {
  const cached = abbreviationIndex.get(lang.code);
  if (cached !== undefined) return cached;
  const index = new Map<string, Abbreviation[]>();
  for (const entry of [...lang.abbreviations].sort((a, b) => b.key.length - a.key.length)) {
    const first = entry.key[0]!;
    const bucket = index.get(first);
    if (bucket) bucket.push(entry);
    else index.set(first, [entry]);
  }
  abbreviationIndex.set(lang.code, index);
  return index;
}

function scanAbbreviation(
  text: string,
  start: number,
  index: Map<string, Abbreviation[]>,
): Expansion | null {
  const bucket = index.get(text[start]!.toLowerCase());
  if (bucket === undefined) return null;
  for (const entry of bucket) {
    const slice = text.slice(start, start + entry.key.length);
    if (slice.toLowerCase() !== entry.key) continue;
    if (entry.needsCapital && slice[0] !== slice[0]!.toUpperCase()) continue;

    let end = start + entry.key.length;
    if (!entry.key.endsWith('.')) {
      if (text[end] === '.') end += 1;
      else if (entry.needsPeriod) continue;
    }
    if (isLetterAt(text, end) || digitValue(text[end]) >= 0) continue;
    if (entry.needsDigit && digitValue(nextNonSpace(text, end)) < 0) continue;
    return { start, end, words: entry.words };
  }
  return null;
}
