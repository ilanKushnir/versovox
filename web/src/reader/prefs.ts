import {
  DEFAULT_READER_PREFS,
  EMPTY_SYNCED_READER_PREFS,
  type DeviceClass,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
  type SyncedReaderPrefs,
  mergeReaderPrefs,
  reconcileReaderPrefs,
  readerPrefsSchema,
  splitReaderPrefs,
  syncedReaderPrefsSchema,
} from '@readport/shared';
import { api } from '../api/client';

export {
  DEFAULT_READER_PREFS as DEFAULT_PREFS,
  SIZE_MAX,
  SIZE_MIN,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
} from '@readport/shared';

/**
 * Reader appearance on this device.
 *
 * The contract — what a preference is, and which of them belong to the screen
 * rather than to the person — lives in @readport/shared so the server can
 * validate what it is handed. This module is the browser half: which device
 * class this is, where the local copy lives, and how the two are kept in step.
 *
 * localStorage stays the source the reader actually sees. It answers instantly,
 * it works with no server, and a reader changing the type size must never wait
 * for a round trip to see it. The server copy is the sync layer underneath.
 */

const KEY = 'rp-reader-prefs';

/**
 * Which kind of screen this is.
 *
 * Width alone would call a laptop in a narrow window a phone and hand it that
 * phone's type size, so the pointer is consulted too: a coarse pointer at
 * tablet width is a tablet, a fine pointer at any width is a desktop. Read
 * once per load — a reader does not change device mid-session, and re-deciding
 * on every resize would swap their settings while they drag a window.
 */
export function deviceClass(): DeviceClass {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const width = Math.min(window.screen?.width || window.innerWidth, window.innerWidth || 9999);
  if (!coarse) return 'desktop';
  return width < 600 ? 'phone' : 'tablet';
}

/** The synced document as this browser last knew it. */
function loadSynced(): SyncedReaderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY_SYNCED_READER_PREFS;
    const parsed = JSON.parse(raw);
    // Before 0.9 this key held a flat ReaderPrefs object. Fold it into the
    // shared bucket rather than discarding what the reader had chosen.
    if (parsed && typeof parsed === 'object' && !('shared' in parsed)) {
      // The pre-0.2 'serif' choice became a named face.
      if (parsed.font === 'serif') parsed.font = 'iowan';
      // Validated key by key rather than trusted: this is a value that has sat
      // in a browser across many versions, and one setting this build no
      // longer understands must not take the rest of them down with it.
      const kept = readerPrefsSchema.partial().safeParse(parsed);
      const legacy = { ...DEFAULT_READER_PREFS, ...(kept.success ? kept.data : {}) };
      return splitReaderPrefs(legacy, deviceClass(), null, new Date(0).toISOString());
    }
    const ok = syncedReaderPrefsSchema.safeParse(parsed);
    return ok.success ? ok.data : EMPTY_SYNCED_READER_PREFS;
  } catch {
    return EMPTY_SYNCED_READER_PREFS;
  }
}

function storeSynced(next: SyncedReaderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: the reader still gets their settings for this session */
  }
}

export function loadPrefs(): ReaderPrefs {
  return mergeReaderPrefs(loadSynced(), deviceClass());
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pending: SyncedReaderPrefs | null = null;

/**
 * Save locally at once, and to the server shortly afterwards.
 *
 * The push is debounced because the size stepper fires on every press, and a
 * reader adjusting it is making one decision, not eight. A failed push is
 * left for the next change or the next load to carry: preferences are not
 * worth a retry queue, and the local copy is already correct.
 */
export function savePrefs(next: ReaderPrefs): void {
  const merged = splitReaderPrefs(next, deviceClass(), loadSynced(), new Date().toISOString());
  storeSynced(merged);
  pending = merged;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const body = pending;
    pending = null;
    pushTimer = null;
    if (body) void api('/api/prefs/reader', { method: 'PUT', body }).catch(() => {});
  }, 900);
}

/**
 * Take whatever the server has and reconcile it with this browser's copy.
 *
 * Returns the preferences to use now. Called when the reader opens a book, so
 * a size chosen on the laptop this morning is in place on the phone tonight
 * without either device having to be told about the other.
 */
export async function syncPrefs(): Promise<ReaderPrefs> {
  const local = loadSynced();
  try {
    const res = await api<{ reader: SyncedReaderPrefs | null }>('/api/prefs/reader');
    const winner = reconcileReaderPrefs(local, res.reader);
    if (winner !== local) storeSynced(winner);
    // This device has something the server has not seen — a change made
    // offline, or a first run against a server that has never been told.
    else if (Date.parse(local.updatedAt) > Date.parse(res.reader?.updatedAt ?? '1970-01-01')) {
      void api('/api/prefs/reader', { method: 'PUT', body: local }).catch(() => {});
    }
    return mergeReaderPrefs(winner, deviceClass());
  } catch {
    return mergeReaderPrefs(local, deviceClass());
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
