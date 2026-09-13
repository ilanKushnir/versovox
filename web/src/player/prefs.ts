import {
  DEFAULT_PLAYBACK_PREFS,
  type PlaybackPrefs,
  playbackPrefsSchema,
  prunePerBookSpeeds,
} from '@readport/shared';
import { api } from '../api/client';

/**
 * How a book sounds, kept in step across a reader's devices.
 *
 * All of this is shared rather than per-device, because none of it describes
 * a screen. A narrator who needs 1.25× to be comfortable needs it on the
 * phone and on the laptop; a reader who prefers a 30-second rewind prefers it
 * everywhere. That is the opposite of the reader's type size, and the reason
 * the two are stored separately — see @readport/shared/prefs.
 *
 * As with the reader's appearance, localStorage answers instantly and offline
 * and is what the UI reads; the server copy is the sync layer beneath it.
 */

const KEY = 'rp-playback-prefs';

/** Legacy keys, read once so nobody loses a setting to the new shape. */
const LEGACY_SPEED = 'rp-speed';
const LEGACY_SKIP = 'rp-skip';

function readLegacy(): PlaybackPrefs {
  const out: PlaybackPrefs = { ...DEFAULT_PLAYBACK_PREFS, perBook: {} };
  try {
    const speed = Number(localStorage.getItem(LEGACY_SPEED));
    if (speed >= 0.5 && speed <= 3) out.speed = speed;
    const skip = JSON.parse(localStorage.getItem(LEGACY_SKIP) ?? 'null');
    if (typeof skip?.back === 'number') out.skipBack = skip.back;
    if (typeof skip?.fwd === 'number') out.skipForward = skip.fwd;
    // Per-book rates were one key each, so they are collected by prefix.
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(`${LEGACY_SPEED}:`)) continue;
      const rate = Number(localStorage.getItem(k));
      if (rate >= 0.5 && rate <= 3) {
        out.perBook[k.slice(LEGACY_SPEED.length + 1)] = { rate, at: new Date(0).toISOString() };
      }
    }
  } catch {
    /* private mode, or nothing to migrate */
  }
  return out;
}

export function loadPlayback(): PlaybackPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return readLegacy();
    const ok = playbackPrefsSchema.safeParse(JSON.parse(raw));
    return ok.success ? ok.data : DEFAULT_PLAYBACK_PREFS;
  } catch {
    return DEFAULT_PLAYBACK_PREFS;
  }
}

/** The rate to start a particular book at. */
export function speedFor(prefs: PlaybackPrefs, bookId: string): number {
  return prefs.perBook[bookId]?.rate ?? prefs.speed;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PlaybackPrefs | null = null;

export function savePlayback(next: PlaybackPrefs): PlaybackPrefs {
  const pruned = prunePerBookSpeeds({ ...next, updatedAt: new Date().toISOString() });
  try {
    localStorage.setItem(KEY, JSON.stringify(pruned));
  } catch {
    /* private mode */
  }
  pending = pruned;
  if (timer) clearTimeout(timer);
  // Debounced: dragging a speed control fires continuously, and a reader
  // sliding from 1× to 1.5× is making one decision.
  timer = setTimeout(() => {
    const body = pending;
    pending = null;
    timer = null;
    if (body) void api('/api/prefs/playback', { method: 'PUT', body }).catch(() => {});
  }, 900);
  return pruned;
}

/** Set the rate for one book, leaving every other setting alone. */
export function setBookSpeed(bookId: string, rate: number): PlaybackPrefs {
  const now = loadPlayback();
  return savePlayback({
    ...now,
    perBook: { ...now.perBook, [bookId]: { rate, at: new Date().toISOString() } },
  });
}

/** Reconcile with the server; newer write wins, as with reader appearance. */
export async function syncPlayback(): Promise<PlaybackPrefs> {
  const local = loadPlayback();
  try {
    const res = await api<{ playback: PlaybackPrefs | null }>('/api/prefs/playback');
    const remote = res.playback;
    if (!remote) {
      if (Date.parse(local.updatedAt) > 0) {
        void api('/api/prefs/playback', { method: 'PUT', body: local }).catch(() => {});
      }
      return local;
    }
    if (Date.parse(remote.updatedAt) >= Date.parse(local.updatedAt)) {
      try {
        localStorage.setItem(KEY, JSON.stringify(remote));
      } catch {
        /* private mode */
      }
      return remote;
    }
    void api('/api/prefs/playback', { method: 'PUT', body: local }).catch(() => {});
    return local;
  } catch {
    return local;
  }
}
