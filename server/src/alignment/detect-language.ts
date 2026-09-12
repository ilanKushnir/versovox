import { LANGUAGES } from '@readport/shared';

/**
 * Work out what language a book is in, from the book.
 *
 * Alignment needs a language for one narrow purpose: the romanizer uses it to
 * spell out numbers and abbreviations ("25" -> "twenty five" or
 * "vingt-cinq"). Script transliteration is keyed on the characters themselves,
 * so getting the language wrong costs anchors around numbers and nowhere else.
 *
 * The text itself answers the question for free, and answers it better than
 * the narration can: the language of the WORDS is what decides how a numeral
 * is spelled, and the words are in the ebook. Script
 * decides it outright for Cyrillic, Hebrew, Arabic and Greek; for the Latin
 * languages a few dozen function words separate them decisively, because
 * function words are the most frequent words in any language and barely
 * overlap between these seven.
 *
 * Deliberately narrow: it only ever chooses among the languages the romanizer
 * knows, and it abstains rather than guessing when the evidence is thin. The
 * caller falls back to the configured default.
 */

/**
 * Function words chosen for how badly they overlap: `il` and `gli` are only
 * Italian, `het` only Dutch, `los`/`las` only Spanish. Content words would be
 * a worse signal — a translated novel shares its proper nouns with every
 * edition of itself.
 */
const MARKERS: Record<string, string[]> = {
  en: [
    'the',
    'and',
    'of',
    'that',
    'was',
    'with',
    'his',
    'her',
    'they',
    'have',
    'from',
    'this',
    'were',
    'which',
    'been',
    'their',
  ],
  de: [
    'der',
    'die',
    'und',
    'das',
    'nicht',
    'ich',
    'sie',
    'mit',
    'ein',
    'eine',
    'auch',
    'war',
    'den',
    'dem',
    'ist',
    'sich',
    'aber',
    'noch',
  ],
  fr: [
    'les',
    'des',
    'pas',
    'une',
    'dans',
    'pour',
    'qui',
    'elle',
    'sur',
    'avec',
    'était',
    'mais',
    'ses',
    'aux',
    'cette',
    'tout',
    'est',
    'je',
  ],
  es: [
    'los',
    'las',
    'una',
    'por',
    'para',
    'como',
    'pero',
    'más',
    'sus',
    'del',
    'ella',
    'sobre',
    'muy',
    'había',
    'cuando',
    'con',
  ],
  it: [
    'che',
    'non',
    'della',
    'delle',
    'degli',
    'nel',
    'nella',
    'sono',
    'anche',
    'alla',
    'gli',
    'più',
    'questo',
    'dei',
    'il',
    'lo',
  ],
  pt: [
    'não',
    'uma',
    'com',
    'para',
    'como',
    'mais',
    'dos',
    'das',
    'seu',
    'pelo',
    'ele',
    'foi',
    'muito',
    'quando',
    'então',
    'já',
  ],
  nl: [
    'het',
    'een',
    'niet',
    'van',
    'dat',
    'zijn',
    'met',
    'maar',
    'voor',
    'aan',
    'ook',
    'werd',
    'hij',
    'deze',
    'naar',
    'over',
    'door',
  ],
};

/**
 * A script that belongs to exactly one supported language. Latin is absent on
 * purpose — it is shared by seven of them and settles nothing.
 */
const SCRIPTS: [RegExp, string][] = [
  [/\p{Script=Cyrillic}/gu, 'ru'],
  [/\p{Script=Hebrew}/gu, 'he'],
  [/\p{Script=Arabic}/gu, 'ar'],
  [/\p{Script=Greek}/gu, 'el'],
];

/** Characters to look at. More than this changes no answer and costs time. */
const SAMPLE_CHARS = 200_000;
/** Below this many words there is not enough evidence to prefer one language. */
const MIN_WORDS = 60;
/**
 * How far ahead the winner must be. Spanish, Portuguese and Italian share
 * "que" and "com"/"con"; a narrow win between them is a coin toss, and a coin
 * toss is worse than the operator's own default.
 */
const MIN_LEAD = 1.4;

export interface LanguageGuess {
  language: string;
  /** 0..1. Script matches are certain; word evidence is scored by its lead. */
  confidence: number;
  /** Named so a log line or a settings hint can say where the answer came from. */
  basis: 'script' | 'words';
}

/**
 * Guess the language of `text`, or null when the evidence does not support a
 * confident answer.
 */
export function detectLanguageFromText(text: string): LanguageGuess | null {
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  if (!sample.trim()) return null;

  // A non-Latin script is decisive on its own, but only once there is enough of
  // it: a Russian name in an English novel is not a Russian book.
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (letters >= 120) {
    for (const [re, code] of SCRIPTS) {
      const hits = (sample.match(re) ?? []).length;
      if (hits / letters > 0.3) return { language: code, confidence: 0.99, basis: 'script' };
    }
  }

  const words = sample
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  if (words.length < MIN_WORDS) return null;

  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);

  const scores: [string, number][] = [];
  for (const [code, markers] of Object.entries(MARKERS)) {
    let hits = 0;
    for (const m of markers) hits += counts.get(m) ?? 0;
    scores.push([code, hits / words.length]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = scores[0]!;
  const runnerUp = scores[1]?.[1] ?? 0;
  // An absolute floor as well as a relative one: a page of proper nouns scores
  // near zero for everything, and the leader of nothing is still nothing.
  if (bestScore < 0.02) return null;
  if (runnerUp > 0 && bestScore / runnerUp < MIN_LEAD) return null;

  const lead = runnerUp > 0 ? bestScore / runnerUp : 4;
  return { language: best, confidence: Math.min(0.95, 0.5 + (lead - 1) / 6), basis: 'words' };
}

/** True when the romanizer has conventions for this language. */
export function isSupportedLanguage(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code);
}
