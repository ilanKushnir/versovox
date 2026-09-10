/**
 * Languages Versovox offers one-click speech models for. Shared by the
 * server catalog (model URLs live server-side) and the settings/pairing UI.
 */
export interface LanguageSpec {
  code: string;
  label: string;
  native: string;
  /** Catalog model ids in preference order; the first installed one is used. */
  models: string[];
}

export const LANGUAGES: LanguageSpec[] = [
  {
    code: 'en',
    label: 'English',
    native: 'English',
    models: ['large-v3-turbo', 'large-v3', 'small'],
  },
  {
    code: 'he',
    label: 'Hebrew',
    native: 'עברית',
    models: ['ivrit-large-v3-turbo', 'ivrit-large-v3', 'large-v3-turbo', 'large-v3'],
  },
  { code: 'de', label: 'German', native: 'Deutsch', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'fr', label: 'French', native: 'Français', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'es', label: 'Spanish', native: 'Español', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'it', label: 'Italian', native: 'Italiano', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'pt', label: 'Portuguese', native: 'Português', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'ru', label: 'Russian', native: 'Русский', models: ['large-v3-turbo', 'large-v3'] },
  { code: 'ar', label: 'Arabic', native: 'العربية', models: ['large-v3', 'large-v3-turbo'] },
  { code: 'nl', label: 'Dutch', native: 'Nederlands', models: ['large-v3-turbo', 'large-v3'] },
];

export function languageLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown';
  const base = code.toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.find((l) => l.code === base)?.label ?? code.toUpperCase();
}
