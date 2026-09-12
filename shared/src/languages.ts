/**
 * The languages whose numbers and abbreviations the romanizer knows how to
 * spell out, which is the only thing a book's language decides — script
 * transliteration is keyed on the characters themselves, so a book in a
 * language not listed here still aligns, it just loses the anchors around its
 * numerals. Offered in the pairing dropdown and as the server-wide fallback.
 */
export interface LanguageSpec {
  code: string;
  label: string;
  native: string;
}

export const LANGUAGES: LanguageSpec[] = [
  {
    code: 'en',
    label: 'English',
    native: 'English',
  },
  {
    code: 'he',
    label: 'Hebrew',
    native: 'עברית',
  },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
];

export function languageLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const base = code.toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.find((l) => l.code === base)?.label ?? code.toUpperCase();
}

/**
 * The language a code names, ignoring any region suffix: "pt-BR" and "pt" are
 * both Portuguese. Returns undefined for a code this build does not know,
 * which callers show verbatim rather than guessing at.
 */
export function languageByCode(code: string | null | undefined): LanguageSpec | undefined {
  if (!code) return undefined;
  const base = code.toLowerCase().split(/[-_]/)[0]!;
  return LANGUAGES.find((l) => l.code === base);
}

/**
 * Three-letter language codes to two.
 *
 * ffmpeg reports ISO 639-2 ("eng"), EPUBs declare ISO 639-1 ("en"), and a
 * library holding both formats of one book would otherwise show that book's
 * language twice — once as English and once as ENG. Covers the languages
 * this build knows plus the bibliographic variants that differ from the
 * terminological ones, which is where most of the surprises live.
 */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en',
  heb: 'he',
  deu: 'de',
  ger: 'de', // bibliographic
  fra: 'fr',
  fre: 'fr', // bibliographic
  spa: 'es',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  ara: 'ar',
  nld: 'nl',
  dut: 'nl', // bibliographic
  jpn: 'ja',
  zho: 'zh',
  chi: 'zh', // bibliographic
  kor: 'ko',
  pol: 'pl',
  swe: 'sv',
  dan: 'da',
  nor: 'no',
  fin: 'fi',
  tur: 'tr',
  ell: 'el',
  gre: 'el', // bibliographic
  ces: 'cs',
  cze: 'cs', // bibliographic
  ukr: 'uk',
  ron: 'ro',
  rum: 'ro', // bibliographic
  hun: 'hu',
  hin: 'hi',
  fas: 'fa',
  per: 'fa', // bibliographic
};

/**
 * One canonical form for a language tag, whatever wrote it: lower case, no
 * region, two letters where a two-letter code exists. Returns null for
 * anything that is not plausibly a language tag, so junk in a tag field does
 * not become a row in the sidebar.
 */
export function normaliseLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(base)) return null;
  return ISO3_TO_ISO1[base] ?? base;
}
