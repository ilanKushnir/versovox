export type ReaderTheme = 'paper' | 'sepia' | 'night' | 'contrast';

export interface ReaderPrefs {
  /** 'auto' follows the system appearance: paper by day, night in the dark. */
  theme: ReaderTheme | 'auto';
  font: ReaderFont;
  /** px */
  size: number;
  weight: number;
  lineHeight: number;
  /** ch measure for scroll mode / margins feel */
  margin: 'compact' | 'normal' | 'wide';
  align: 'start' | 'justify';
  hyphens: boolean;
  mode: 'paginated' | 'scroll';
  /** Paginated columns: 'auto' shows two pages side by side on wide screens. */
  columns: 'auto' | 'one' | 'two';
  /** 0.35–1: page dimming for night reading (1 = no dimming). */
  brightness: number;
  /** Bottom progress indicator: full (slider + details), compact (one thin line), or hidden. */
  progressBar: 'full' | 'compact' | 'hidden';
}

export type ReaderFont =
  'literata' | 'iowan' | 'charter' | 'palatino' | 'georgia' | 'baskerville' | 'sans';

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
  columns: 'auto',
  brightness: 1,
  progressBar: 'full',
};

export const SIZE_MIN = 14;
export const SIZE_MAX = 32;

const KEY = 'rp-reader-prefs';

export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Omit<ReaderPrefs, 'font'>> & { font?: string };
    // Migrate the pre-0.2 'serif' choice to its closest named face.
    if (parsed.font === 'serif') parsed.font = 'iowan';
    if (parsed.font && !(parsed.font in FONTS)) delete parsed.font;
    return { ...DEFAULT_PREFS, ...(parsed as Partial<ReaderPrefs>) };
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

/** Resolve 'auto' against the system appearance. */
export function effectiveTheme(theme: ReaderPrefs['theme'], systemDark: boolean): ReaderTheme {
  if (theme !== 'auto') return theme;
  return systemDark ? 'night' : 'paper';
}

export const FONTS: Record<ReaderFont, { label: string; stack: string; note: string }> = {
  literata: {
    label: 'Literata',
    stack: "'Literata', 'Iowan Old Style', Georgia, serif",
    note: 'Bundled · designed for screens',
  },
  iowan: {
    label: 'Iowan Old Style',
    stack: "'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif",
    note: 'Apple Books default',
  },
  charter: {
    label: 'Charter',
    stack: "'Charter', 'Bitstream Charter', 'Sitka Text', Cambria, Georgia, serif",
    note: 'Crisp, compact serif',
  },
  palatino: {
    label: 'Palatino',
    stack: "'Palatino', 'Palatino Linotype', 'Book Antiqua', 'URW Palladio L', Georgia, serif",
    note: 'Classic book face',
  },
  georgia: {
    label: 'Georgia',
    stack: "Georgia, 'Times New Roman', serif",
    note: 'Sturdy and familiar',
  },
  baskerville: {
    label: 'Baskerville',
    stack: "'Baskerville', 'Libre Baskerville', 'Baskerville Old Face', Georgia, serif",
    note: 'Elegant transitional serif',
  },
  sans: {
    label: 'System sans',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
    note: 'Your device’s interface font',
  },
};

/** @deprecated kept for callers that only need the stack */
export const FONT_STACKS: Record<ReaderFont, string> = Object.fromEntries(
  Object.entries(FONTS).map(([k, v]) => [k, v.stack]),
) as Record<ReaderFont, string>;

export const MARGINS: Record<ReaderPrefs['margin'], { padding: number; measure: string }> = {
  compact: { padding: 16, measure: '44em' },
  normal: { padding: 24, measure: '38em' },
  wide: { padding: 40, measure: '32em' },
};

/* ------------------------------------------------------------ pagination */

export const MAX_PAGE_WIDTH = 1180;
export const TWO_COLUMN_MIN_WIDTH = 900;
/** Horizontal gap between the two columns of a spread. */
export const SPREAD_GUTTER = 72;
/** Extra travel between consecutive single pages during the turn animation. */
export const PAGE_TRAVEL = 48;

export interface PageLayout {
  /** Rendered page-box width (viewport width capped at MAX_PAGE_WIDTH). */
  width: number;
  /** Inset from the viewport edge to the page box (centred). */
  inset: number;
  columns: 1 | 2;
  /** CSS column-gap to set on the content element. */
  columnGap: number;
  /**
   * Horizontal distance between consecutive page origins. With `columns`
   * columns of equal width filling `width - 2·pad` and `columnGap` between
   * them, the first column of page n starts exactly `n · stride` after page
   * 0's, so translating by `-n · stride` lands text at the same inset.
   */
  stride: number;
  pad: number;
}

export function computePageLayout(
  viewportWidth: number,
  pad: number,
  columnsPref: ReaderPrefs['columns'],
): PageLayout {
  const width = Math.max(1, Math.min(viewportWidth, MAX_PAGE_WIDTH));
  const inset = Math.max(0, Math.floor((viewportWidth - width) / 2));
  const columns: 1 | 2 =
    columnsPref === 'two' || (columnsPref === 'auto' && width >= TWO_COLUMN_MIN_WIDTH) ? 2 : 1;
  const columnGap = columns === 2 ? SPREAD_GUTTER : 2 * pad + PAGE_TRAVEL;
  // n equal columns of width c: n·c + (n−1)·gap = width − 2·pad, so
  // stride = n·(c + gap) = width − 2·pad + gap for every n.
  const stride = width - 2 * pad + columnGap;
  return { width, inset, columns, columnGap, stride, pad };
}

/** Number of pages given the content element's scrollWidth. */
export function pageCountFor(scrollWidth: number, layout: PageLayout): number {
  // Last column's right edge + end padding: scrollWidth ≈ pages·stride − gap + 2·pad.
  return Math.max(1, Math.round((scrollWidth + layout.columnGap - 2 * layout.pad) / layout.stride));
}
