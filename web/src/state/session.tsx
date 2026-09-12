import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isUnauthorized, setUnauthorizedHandler } from '../api/client';
import { purgeOfflineData } from '../offline/downloads';
import { idbClear, STORES } from '../progress/idb';
import { claimProgressQueue, flushPending, purgeProgressQueue } from '../progress/engine';

export interface User {
  id: string;
  username: string;
  role: string;
  displayName?: string | null;
}

/** How the current session was established (reverse-proxy SSO vs. password). */
export type AuthVia = 'session' | 'proxy';

interface SessionCtx {
  user: User | null;
  via: AuthVia;
  /** Signed in as an admin, but no library folders configured yet. */
  needsLibraries: boolean;
  /** 'loading' | 'setup' | 'login' | 'ready' | 'offline' */
  phase: 'loading' | 'setup' | 'login' | 'ready' | 'offline';
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  user: null,
  via: 'session',
  needsLibraries: false,
  phase: 'loading',
  refresh: async () => {},
  setUser: () => {},
  logout: async () => {},
});
export const useSession = () => useContext(Ctx);

/**
 * A network that accepts the connection but never answers — captive portal,
 * half-up VPN, a wedged server — makes fetch hang instead of rejecting. The
 * session check must not hold the whole app on a loading spinner for it:
 * downloaded titles are on this device and readable without an answer. Only
 * this request is bounded; content requests must stay open long enough for
 * the service worker to fall back to the offline copy.
 */
const SESSION_CHECK_TIMEOUT_MS = 10_000;
const sessionCheckSignal = (): AbortSignal | undefined =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS)
    : undefined;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [via, setVia] = useState<AuthVia>('session');
  const [needsLibraries, setNeedsLibraries] = useState(false);
  const [phase, setPhase] = useState<SessionCtx['phase']>('loading');

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; via?: AuthVia; needsLibraries?: boolean }>(
        '/api/auth/me',
        { signal: sessionCheckSignal() },
      );
      // Before anything can be delivered: queued checkpoints belong to the
      // account that recorded them. The same person keeps a backlog written
      // while their session was expired; a different person starts empty.
      await claimProgressQueue(me.user.id).catch(() => {});
      setUser(me.user);
      setVia(me.via ?? 'session');
      setNeedsLibraries(me.needsLibraries === true);
      setPhase('ready');
      return;
    } catch (err) {
      if (isUnauthorized(err)) {
        // Session expired or revoked: logout-as-revocation removes the
        // offline copies of server content this browser held for the
        // signed-out user (docs/security.md). Awaited — revocation fails
        // closed before the login screen appears. (The global unauthorized
        // handler has already purged once inside api(); this is idempotent
        // belt and braces for the /api/auth/me path.) Un-synced checkpoints
        // survive: they are the reader's own writes, and signing back in
        // delivers them.
        await purgeOfflineData().catch(() => {});
        try {
          const s = await api<{ needsSetup: boolean }>('/api/setup/status');
          setUser(null);
          setPhase(s.needsSetup ? 'setup' : 'login');
        } catch {
          setPhase('login');
        }
        return;
      }
      // Network failure: allow offline reading of downloaded titles.
      setPhase('offline');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fail-closed revocation, from either discovery path:
  //  - ANY API request answered 401 runs this handler (awaited inside the
  //    fetch wrapper) — downloads aborted, offline content purged — before
  //    the caller sees the error. It must never call api() (see the handler
  //    contract in api/client.ts), so no flush is attempted here; the queue
  //    is kept and delivered when this account signs in again.
  //  - The service worker's own online revocation check posts
  //    'rp-unauthorized' after purging the offline cache; the page then
  //    clears its IndexedDB state and drops to the login screen.
  useEffect(() => {
    const invalidate = async () => {
      await purgeOfflineData().catch(() => {});
      setUser(null);
      setPhase('login');
    };
    const unset = setUnauthorizedHandler(invalidate);
    const onSwMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string } | null;
      if (msg?.type === 'rp-unauthorized') void invalidate();
      // The service worker found this device's cached books belonged to a
      // different account and deleted them. Nothing is wrong, but the registry
      // still lists them as available offline, and a book that claims to be
      // downloaded and is not is worse than one that never claimed it.
      if (msg?.type === 'rp-offline-purged') void idbClear(STORES.downloads).catch(() => {});
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    return () => {
      unset();
      navigator.serviceWorker?.removeEventListener('message', onSwMessage);
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      // Best-effort: deliver any queued progress before the session dies.
      await flushPending().catch(() => {});
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // Logout removes this browser's offline book content and per-user
      // state; a fresh login re-downloads what is wanted (docs/security.md).
      // The queue goes too — but only here, after the flush above had its
      // chance, because signing out is a deliberate "leave nothing behind".
      await purgeOfflineData().catch(() => {});
      await purgeProgressQueue().catch(() => {});
      setUser(null);
      setPhase('login');
    }
  }, []);

  // Connectivity came back while the app was running in offline mode: pick
  // the session back up so the library, covers and sync resume on their own
  // instead of waiting for the reader to guess and reload. Coming back to
  // the tab counts too — a captive portal that has since been signed into
  // never fires an 'online' event.
  useEffect(() => {
    if (phase !== 'offline') return;
    const retry = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, [phase, refresh]);

  return (
    <Ctx.Provider
      value={{
        user,
        via,
        needsLibraries,
        phase,
        refresh,
        logout,
        setUser: (u) => {
          setUser(u);
          if (u) {
            // Claim before any flusher can run: a backlog left by whoever
            // used this browser last must never be posted to this account.
            void claimProgressQueue(u.id);
            setPhase('ready');
            // Pick up server-side setup state (needsLibraries) that only
            // /api/auth/me reports — otherwise a fresh sign-in lands on an
            // empty library instead of the unfinished wizard.
            void refresh();
          }
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
