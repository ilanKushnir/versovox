export interface ReaderPrefs {
  theme: 'paper' | 'sepia' | 'night' | 'contrast';
  font: 'literata' | 'serif' | 'sans';
  /** px */
  size: number;
  weight: number;
  lineHeight: number;
  /** ch measure for scroll mode / margins feel */
  margin: 'compact' | 'normal' | 'wide';
  align: 'start' | 'justify';
  hyphens: boolean;
  mode: 'paginated' | 'scroll';
}

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: 'paper',
  font: 'literata',
  size: 19,
  weight: 420,
  lineHeight: 1.62,
  margin: 'normal',
  align: 'start',
  hyphens: true,
  mode: 'paginated',
};

const KEY = 'tl-reader-prefs';

export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<ReaderPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

export const FONT_STACKS: Record<ReaderPrefs['font'], string> = {
  literata: "'Literata', 'Iowan Old Style', Georgia, serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

export const MARGINS: Record<ReaderPrefs['margin'], { padding: number; measure: string }> = {
  compact: { padding: 16, measure: '44em' },
  normal: { padding: 24, measure: '38em' },
  wide: { padding: 40, measure: '32em' },
};
