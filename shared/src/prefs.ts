import { z } from 'zod';

/**
 * Personal preferences, and which of them belong to the person rather than to
 * the screen in front of them.
 *
 * Everything here follows a reader between their devices — that is the point.
 * But not everything *should*. A type size chosen on a phone held at arm's
 * length is the wrong size on a 27-inch monitor, and two-page spreads are
 * meaningless on either. Pushing one number to both places is worse than not
 * syncing at all, because the reader has to keep undoing it.
 *
 * So preferences are stored in two buckets: the ones that describe taste,
 * which are shared, and the ones that describe a screen, which are kept per
 * device class. `PER_DEVICE_READER_KEYS` is the whole of that judgement, in
 * one place, and `mergeReaderPrefs` is the only thing that reads it.
 */

export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

export const READER_THEMES = ['paper', 'sepia', 'night', 'contrast'] as const;
export const READER_FONTS = [
  'literata',
  'iowan',
  'charter',
  'palatino',
  'georgia',
  'baskerville',
  'sans',
] as const;

export const SIZE_MIN = 14;
export const SIZE_MAX = 32;

export const readerPrefsSchema = z.object({
  /** 'auto' follows the system appearance: paper by day, night in the dark. */
  theme: z.enum([...READER_THEMES, 'auto']),
  font: z.enum(READER_FONTS),
  /** px */
  size: z.number().min(SIZE_MIN).max(SIZE_MAX),
  weight: z.number().min(300).max(700),
  lineHeight: z.number().min(1.1).max(2.4),
  margin: z.enum(['compact', 'normal', 'wide']),
  align: z.enum(['start', 'justify']),
  hyphens: z.boolean(),
  mode: z.enum(['paginated', 'scroll']),
  /** Paginated columns: 'auto' shows two pages side by side on wide screens. */
  columns: z.enum(['auto', 'one', 'two']),
  /** 0.35–1: page dimming for night reading (1 = no dimming). */
  brightness: z.number().min(0.35).max(1),
  /** Bottom progress indicator: full, one thin line, or nothing. */
  progressBar: z.enum(['full', 'compact', 'hidden']),
});

export type ReaderPrefs = z.infer<typeof readerPrefsSchema>;
export type ReaderTheme = (typeof READER_THEMES)[number];
export type ReaderFont = (typeof READER_FONTS)[number];

export const DEFAULT_READER_PREFS: ReaderPrefs = {
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

/**
 * The settings that describe a screen, not a taste.
 *
 * Size, leading and margins are how big the text has to be to read at this
 * distance; mode and columns are what the shape of the screen allows;
 * brightness is the room; the progress bar is how much chrome fits. Everything
 * NOT listed here — theme, typeface, weight, justification, hyphenation — is
 * what the reader likes, and follows them everywhere.
 */
export const PER_DEVICE_READER_KEYS = [
  'size',
  'lineHeight',
  'margin',
  'mode',
  'columns',
  'brightness',
  'progressBar',
] as const satisfies readonly (keyof ReaderPrefs)[];

const perDevice = new Set<string>(PER_DEVICE_READER_KEYS);

/** What is stored per account: one shared bucket, one bucket per device class. */
export const syncedReaderPrefsSchema = z.object({
  shared: readerPrefsSchema.partial(),
  // An explicit object rather than a record keyed by the enum: a record over
  // an enum requires every key, and a reader who has only ever used a phone
  // has no desktop bucket to store.
  byDevice: z
    .object({
      phone: readerPrefsSchema.partial(),
      tablet: readerPrefsSchema.partial(),
      desktop: readerPrefsSchema.partial(),
    })
    .partial(),
  /** Last write, ISO. Ties are broken in favour of the server's copy. */
  updatedAt: z.string(),
});

export type SyncedReaderPrefs = z.infer<typeof syncedReaderPrefsSchema>;

export const EMPTY_SYNCED_READER_PREFS: SyncedReaderPrefs = {
  shared: {},
  byDevice: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/**
 * The preferences to actually use on this device: defaults, overlaid with
 * what the reader likes anywhere, overlaid with what they chose on a screen
 * like this one.
 */
export function mergeReaderPrefs(
  synced: SyncedReaderPrefs | null | undefined,
  device: DeviceClass,
): ReaderPrefs {
  if (!synced) return { ...DEFAULT_READER_PREFS };
  return {
    ...DEFAULT_READER_PREFS,
    ...synced.shared,
    ...(synced.byDevice[device] ?? {}),
  };
}

/**
 * Fold a complete set of preferences back into the two buckets.
 *
 * Only the keys that differ from the defaults are stored, so a reader who
 * never touched the margins does not pin them — and a later change to a
 * default reaches them instead of being silently overridden by a copy of the
 * old one.
 */
export function splitReaderPrefs(
  next: ReaderPrefs,
  device: DeviceClass,
  previous: SyncedReaderPrefs | null | undefined,
  now: string,
): SyncedReaderPrefs {
  const shared: Partial<ReaderPrefs> = {};
  const mine: Partial<ReaderPrefs> = {};
  for (const key of Object.keys(DEFAULT_READER_PREFS) as (keyof ReaderPrefs)[]) {
    const value = next[key];
    if (value === DEFAULT_READER_PREFS[key]) continue;
    if (perDevice.has(key)) Object.assign(mine, { [key]: value });
    else Object.assign(shared, { [key]: value });
  }
  return {
    shared,
    // Other device classes are carried through untouched: choosing a bigger
    // type on a phone must not reach across and change the desktop.
    byDevice: { ...(previous?.byDevice ?? {}), [device]: mine },
    updatedAt: now,
  };
}

/**
 * Reconcile a local copy with the server's.
 *
 * Preferences are small, rarely contended, and cheap to get wrong in a way
 * nobody notices for weeks, so this stays deliberately simple: the newer
 * write wins as a whole. Merging key-by-key across two devices that were both
 * edited offline would produce a set of preferences neither person chose.
 */
export function reconcileReaderPrefs(
  local: SyncedReaderPrefs | null | undefined,
  remote: SyncedReaderPrefs | null | undefined,
): SyncedReaderPrefs {
  if (!local) return remote ?? EMPTY_SYNCED_READER_PREFS;
  if (!remote) return local;
  return Date.parse(remote.updatedAt) >= Date.parse(local.updatedAt) ? remote : local;
}

/* ------------------------------------------------------------- playback */

/**
 * How a book sounds, which is about the narrator and not about the phone —
 * so all of it is shared. Per-book speed is capped: it is a convenience, not
 * a record worth growing without limit.
 */
export const PER_BOOK_SPEED_LIMIT = 100;

export const playbackPrefsSchema = z.object({
  /** Default rate for a book with no setting of its own. */
  speed: z.number().min(0.5).max(3),
  skipBack: z.number().int().min(5).max(120),
  skipForward: z.number().int().min(5).max(120),
  /** bookId → { rate, when it was set } so the oldest can be pruned. */
  perBook: z.record(z.string(), z.object({ rate: z.number().min(0.5).max(3), at: z.string() })),
  updatedAt: z.string(),
});

export type PlaybackPrefs = z.infer<typeof playbackPrefsSchema>;

export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = {
  speed: 1,
  skipBack: 15,
  skipForward: 30,
  perBook: {},
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/** Keep the most recently set per-book speeds and drop the rest. */
export function prunePerBookSpeeds(prefs: PlaybackPrefs): PlaybackPrefs {
  const entries = Object.entries(prefs.perBook);
  if (entries.length <= PER_BOOK_SPEED_LIMIT) return prefs;
  entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return { ...prefs, perBook: Object.fromEntries(entries.slice(0, PER_BOOK_SPEED_LIMIT)) };
}
