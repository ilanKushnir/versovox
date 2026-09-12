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
