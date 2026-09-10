import {
  resolveResume,
  type Locator,
  type ProgressAck,
  type ProgressEvent,
  type ProgressIntent,
  type ProgressState,
} from '@tandemleaf/shared';
import { api, isOffline } from '../api/client';
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
    let id = localStorage.getItem('tl-device-id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('tl-device-id', id);
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

export async function recordCheckpoint(
  bookId: string,
  intent: ProgressIntent,
  locator: Locator,
  opts: { flush?: boolean } = {},
): Promise<void> {
  seq += 1;
  // Declare which server revision this action was based on (causal ordering
  // beats clock ordering during reconciliation; clocks are just a hint).
  let baseRevision: number | undefined;
  try {
    const known = await idbGet<ProgressState>(STORES.serverState, bookId);
    baseRevision = known?.revision;
  } catch {
    baseRevision = undefined;
  }
  const event: ProgressEvent = {
    eventId: crypto.randomUUID(),
    bookId,
    deviceId,
    sessionId,
    seq,
    occurredAt: new Date().toISOString(),
    baseRevision,
    intent,
    locator,
  };
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
 * visibilitychange/pagehide path: write the live position to IndexedDB
 * first (durable even if the tab dies mid-flush), then attempt a keepalive
 * network flush.
 */
export function persistActiveLocatorAndFlush(): void {
  const current = activeLocatorProvider?.();
  if (current) {
    void recordCheckpoint(current.bookId, 'heartbeat', current.locator, { flush: false }).then(() =>
      flushPending(true),
    );
  } else {
    void flushPending(true);
  }
}

export function scheduleFlush(soon = false): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushPending(), soon ? 250 : 5000);
}

export async function flushPending(useKeepalive = false): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const pending = await idbAll<ProgressEvent>(STORES.pendingEvents);
    if (pending.length === 0) return;
    const events = pending
      .map((p) => p.value)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.seq - b.seq)
      .slice(0, 200);
    const ack = await api<ProgressAck>('/api/progress/events', {
      method: 'POST',
      body: { events },
      keepalive: useKeepalive,
    });
    for (const r of ack.results) {
      // applied / recorded / duplicate are all durable server outcomes.
      if (r.status !== 'rejected') await idbDelete(STORES.pendingEvents, r.eventId);
    }
    if (ack.state) {
      await idbPut(STORES.serverState, ack.state.bookId, ack.state);
    }
    listeners.forEach((l) => l());
  } catch (err) {
    if (!isOffline(err)) console.warn('progress flush failed', err);
    // Events stay queued; the next flush retries.
  } finally {
    flushing = false;
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
    if (server) await idbPut(STORES.serverState, bookId, server);
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
