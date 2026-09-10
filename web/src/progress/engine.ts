import {
  progressEventSchema,
  resolveResume,
  type Locator,
  type ProgressAck,
  type ProgressEvent,
  type ProgressIntent,
  type ProgressState,
} from '@versovox/shared';
import { api, ApiError, isOffline } from '../api/client';
import { idbAll, idbDelete, idbGet, idbPut, STORES } from './idb';

/**
 * Local-first progress engine.
 *
 * Every checkpoint is written to IndexedDB *before* any network I/O, as an
 * idempotent event (UUID + device/session/seq). A background flusher syncs
 * pending events whenever online; acknowledged events are removed and the
 * server's reconciled state is cached locally. Resume combines the newest
 * acknowledged server state with any newer unacknowledged local events using
 * the same decision function the server uses (shared/reconcile).
 */

function getDeviceId(): string {
  try {
    let id = localStorage.getItem('vx-device-id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('vx-device-id', id);
    }
    return id;
  } catch {
    return 'device-unknown';
  }
}

export const deviceId = getDeviceId();
export const sessionId = crypto.randomUUID();
let seq = 0;

type Listener = () => void;
const listeners = new Set<Listener>();
export function onProgressSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

/** Last server revision seen per book, mirrored in memory so an event can be
 *  built synchronously (pagehide gives us no time for an IndexedDB read). */
const knownRevision = new Map<string, number>();

/** Locators are validated server-side; keep them in range at the source so a
 *  slightly-over-duration audio position can never poison the queue. */
function sanitizeLocator(locator: Locator): Locator {
  const pct = Math.min(1, Math.max(0, Number.isFinite(locator.pct) ? locator.pct : 0));
  if (locator.medium === 'audio') {
    return {
      ...locator,
      pct,
      positionMs: Math.max(0, Math.round(locator.positionMs || 0)),
      bookMs: locator.bookMs === undefined ? undefined : Math.max(0, Math.round(locator.bookMs)),
    };
  }
  return {
    ...locator,
    pct,
    charOffset:
      locator.charOffset === undefined ? undefined : Math.max(0, Math.round(locator.charOffset)),
  };
}

function buildEvent(bookId: string, intent: ProgressIntent, locator: Locator): ProgressEvent {
  seq += 1;
  return {
    eventId: crypto.randomUUID(),
    bookId,
    deviceId,
    sessionId,
    seq,
    occurredAt: new Date().toISOString(),
    // Declare which server revision this action was based on (causal ordering
    // beats clock ordering during reconciliation; clocks are just a hint).
    baseRevision: knownRevision.get(bookId),
    intent,
    locator: sanitizeLocator(locator),
  };
}

export async function recordCheckpoint(
  bookId: string,
  intent: ProgressIntent,
  locator: Locator,
  opts: { flush?: boolean } = {},
): Promise<void> {
  if (!knownRevision.has(bookId)) {
    try {
      const known = await idbGet<ProgressState>(STORES.serverState, bookId);
      if (known) knownRevision.set(bookId, known.revision);
    } catch {
      /* no cached state */
    }
  }
  const event = buildEvent(bookId, intent, locator);
  // IndexedDB first — never lose a checkpoint to a dropped connection.
  await idbPut(STORES.pendingEvents, event.eventId, event);
  if (opts.flush !== false) scheduleFlush(intent !== 'heartbeat');
}

/**
 * The active reader/player surface registers a provider returning its CURRENT
 * position, so lifecycle events can persist the live locator — not just
 * whatever already made it past the debounce/heartbeat windows.
 */
export type ActiveLocatorProvider = () => { bookId: string; locator: Locator } | null;
let activeLocatorProvider: ActiveLocatorProvider | null = null;

export function setActiveLocatorProvider(fn: ActiveLocatorProvider): () => void {
  activeLocatorProvider = fn;
  return () => {
    if (activeLocatorProvider === fn) activeLocatorProvider = null;
  };
}

/**
 * visibilitychange/pagehide path. The page may be frozen or killed within
 * milliseconds, so the live position is sent IMMEDIATELY with a keepalive
 * request (no IndexedDB round-trip first) and written to IndexedDB in
 * parallel; the queued copy is removed only once the server acknowledges
 * it. Everything already queued is flushed the same way.
 */
export function persistActiveLocatorAndFlush(): void {
  const current = activeLocatorProvider?.();
  if (current) {
    const event = buildEvent(current.bookId, 'heartbeat', current.locator);
    const stored = idbPut(STORES.pendingEvents, event.eventId, event).catch(() => {});
    void api<ProgressAck>('/api/progress/events', {
      method: 'POST',
      body: { events: [event] },
      keepalive: true,
    })
      .then(async (ack) => {
        await stored;
        await handleAck(ack);
      })
      .catch(() => {
        /* stays queued in IndexedDB; the next flush retries */
      });
  }
  void flushPending(true, /* bypassInFlightGuard */ true);
}

async function handleAck(ack: ProgressAck): Promise<void> {
  for (const r of ack.results) {
    // applied / recorded / duplicate are all durable server outcomes; a
    // rejected event is malformed and would be rejected forever.
    await idbDelete(STORES.pendingEvents, r.eventId);
  }
  if (ack.state) {
    knownRevision.set(ack.state.bookId, ack.state.revision);
    await idbPut(STORES.serverState, ack.state.bookId, ack.state);
  }
  listeners.forEach((l) => l());
}

/**
 * A batch the server refuses outright (4xx) would block every later event
 * for every book, forever. Drop only the events that fail the shared schema
 * locally; if all validate the failure is transient and they stay queued.
 */
async function quarantineInvalid(events: ProgressEvent[]): Promise<number> {
  let dropped = 0;
  for (const ev of events) {
    if (!progressEventSchema.safeParse(ev).success) {
      await idbDelete(STORES.pendingEvents, ev.eventId);
      dropped += 1;
    }
  }
  return dropped;
}

export function scheduleFlush(soon = false): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushPending(), soon ? 250 : 5000);
}

export async function flushPending(
  useKeepalive = false,
  bypassInFlightGuard = false,
): Promise<void> {
  if (flushing && !bypassInFlightGuard) return;
  const ownsGuard = !flushing;
  flushing = true;
  let events: ProgressEvent[] = [];
  try {
    const pending = await idbAll<ProgressEvent>(STORES.pendingEvents);
    if (pending.length === 0) return;
    events = pending
      .map((p) => p.value)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.seq - b.seq)
      .slice(0, 200);
    const ack = await api<ProgressAck>('/api/progress/events', {
      method: 'POST',
      body: { events },
      keepalive: useKeepalive,
    });
    await handleAck(ack);
  } catch (err) {
    if (isOffline(err)) return; // events stay queued; the next flush retries
    console.warn('progress flush failed', err);
    if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401) {
      const dropped = await quarantineInvalid(events);
      if (dropped > 0) console.warn(`dropped ${dropped} malformed progress event(s)`);
    }
  } finally {
    if (ownsGuard) flushing = false;
  }
}

/** Resume position: newest acked server state + newer local pending events. */
export async function resumeLocator(
  bookId: string,
): Promise<{ locator: Locator; source: 'server' | 'local' } | null> {
  let server: ProgressState | null = null;
  try {
    const res = await api<{ state: ProgressState | null }>(`/api/progress/${bookId}`);
    server = res.state;
    if (server) {
      knownRevision.set(bookId, server.revision);
      await idbPut(STORES.serverState, bookId, server);
    }
  } catch {
    server = (await idbGet<ProgressState>(STORES.serverState, bookId)) ?? null;
  }
  const pendingAll = await idbAll<ProgressEvent>(STORES.pendingEvents);
  const pending = pendingAll.map((p) => p.value).filter((e) => e.bookId === bookId);
  return resolveResume(server, pending);
}

export function startProgressLifecycle(): () => void {
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') persistActiveLocatorAndFlush();
  };
  const onPageHide = () => persistActiveLocatorAndFlush();
  const onOnline = () => scheduleFlush(true);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);
  const interval = setInterval(() => void flushPending(), 30_000);
  void flushPending();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    clearInterval(interval);
  };
}
