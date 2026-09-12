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
import { idbAll, idbClear, idbDelete, idbGet, idbPut, STORES } from './idb';

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

/**
 * Queue ownership.
 *
 * The un-synced queue is the reader's own writing, not cached server
 * content: an expired or revoked session must NOT destroy it, or an hour of
 * offline reading dies with the session. It is therefore kept across
 * revocation and delivered once the SAME account signs back in. The account
 * that recorded it is stamped here so a DIFFERENT person signing in on this
 * browser can never inherit — or silently publish — someone else's reading
 * positions.
 */
const OWNER_KEY = 'vx-progress-owner';
/** Fallback when storage is unavailable (private mode): at least keep the
 *  owner right for the lifetime of this page. */
let ownerFallback: string | null = null;
/** Set while a foreign account's backlog is being discarded, so the
 *  background flusher cannot deliver it under the new session first. */
let queueSuspended = false;

function readOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return ownerFallback;
  }
}

function writeOwner(id: string | null): void {
  ownerFallback = id;
  try {
    if (id === null) localStorage.removeItem(OWNER_KEY);
    else localStorage.setItem(OWNER_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/** Discard the un-synced queue. Deliberate logout and a change of account
 *  only — never session revocation. */
export async function purgeProgressQueue(): Promise<void> {
  writeOwner(null);
  try {
    await idbClear(STORES.pendingEvents);
  } catch {
    /* indexeddb unavailable */
  }
}

/**
 * Hand the queue to the signed-in account. The same person returning — after
 * a logout-less session expiry, a re-login, or a week offline — keeps every
 * queued checkpoint; anybody else starts empty.
 */
export async function claimProgressQueue(userId: string): Promise<void> {
  const previous = readOwner();
  if (previous === userId) return;
  if (previous !== null) {
    queueSuspended = true;
    try {
      await purgeProgressQueue();
    } finally {
      queueSuspended = false;
    }
  }
  writeOwner(userId);
}

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
 * Last-gasp stash.
 *
 * pagehide can be followed by freeze or termination before an IndexedDB
 * transaction commits, and the keepalive request cannot help when there is
 * no network — exactly the case offline reading depends on. localStorage
 * writes synchronously, so the live position survives even a page that never
 * runs again; the next start puts it back in the queue. Events are
 * idempotent (eventId), so a stash that turns out to have been stored or
 * delivered already costs nothing.
 */
const STASH_KEY = 'vx-progress-stash';
const STASH_MAX = 20;

function readStash(): ProgressEvent[] {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ProgressEvent => progressEventSchema.safeParse(e).success);
  } catch {
    return [];
  }
}

function writeStash(events: ProgressEvent[]): void {
  try {
    if (events.length === 0) localStorage.removeItem(STASH_KEY);
    else localStorage.setItem(STASH_KEY, JSON.stringify(events.slice(-STASH_MAX)));
  } catch {
    /* storage unavailable or full; IndexedDB remains the primary queue */
  }
}

function stashEvent(event: ProgressEvent): void {
  writeStash([...readStash().filter((e) => e.eventId !== event.eventId), event]);
}

function unstashEvent(eventId: string): void {
  const rest = readStash().filter((e) => e.eventId !== eventId);
  writeStash(rest);
}

/** Put anything the last page load could not commit back in the queue. */
export async function drainLastGasp(): Promise<number> {
  const stashed = readStash();
  if (stashed.length === 0) return 0;
  let restored = 0;
  for (const event of stashed) {
    try {
      await idbPut(STORES.pendingEvents, event.eventId, event);
      restored += 1;
    } catch {
      return restored; // storage is down; keep the stash for the next start
    }
  }
  writeStash([]);
  return restored;
}

/**
 * visibilitychange/pagehide path. The page may be frozen or killed within
 * milliseconds, so the live position is stashed SYNCHRONOUSLY, sent
 * IMMEDIATELY with a keepalive request (no IndexedDB round-trip first) and
 * written to IndexedDB in parallel; the queued copy is removed only once the
 * server acknowledges it. Everything already queued is flushed the same way.
 */
export function persistActiveLocatorAndFlush(): void {
  const current = activeLocatorProvider?.();
  if (current) {
    const event = buildEvent(current.bookId, 'heartbeat', current.locator);
    stashEvent(event);
    const stored = idbPut(STORES.pendingEvents, event.eventId, event)
      .then(() => unstashEvent(event.eventId))
      .catch(() => {});
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
  // Every book the batch touched, not just the last: falling back to `state`
  // keeps this working against a server that predates `states`.
  const states = ack.states?.length ? ack.states : ack.state ? [ack.state] : [];
  for (const state of states) {
    knownRevision.set(state.bookId, state.revision);
    await idbPut(STORES.serverState, state.bookId, state);
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

/**
 * Fetch caps in-flight keepalive bodies at 64 KiB per origin — a budget this
 * batch shares with the single-event request the pagehide path just issued.
 * Over quota the fetch rejects, which reads as "offline" and delivers
 * nothing, precisely when the backlog is largest. Trim to a batch that fits;
 * whatever is left over stays queued for the next flush.
 */
const KEEPALIVE_BUDGET_BYTES = 48 * 1024;

export function withinKeepaliveBudget(events: ProgressEvent[]): ProgressEvent[] {
  let bytes = '{"events":[]}'.length;
  let n = 0;
  for (const ev of events) {
    bytes += JSON.stringify(ev).length + 1;
    if (bytes > KEEPALIVE_BUDGET_BYTES) break;
    n += 1;
  }
  return n === events.length ? events : events.slice(0, Math.max(1, n));
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
  if (queueSuspended) return;
  const ownsGuard = !flushing;
  flushing = true;
  let events: ProgressEvent[] = [];
  try {
    const pending = await idbAll<ProgressEvent>(STORES.pendingEvents);
    if (pending.length === 0) return;
    if (queueSuspended) return; // a different account signed in mid-read
    events = pending
      .map((p) => p.value)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.seq - b.seq)
      .slice(0, 200);
    if (useKeepalive) events = withinKeepaliveBudget(events);
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
  // A position stashed as the app was killed must be part of THIS resume,
  // not only of the next background flush.
  await drainLastGasp();
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
  void drainLastGasp().then(() => flushPending());
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('online', onOnline);
    clearInterval(interval);
  };
}
