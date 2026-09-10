import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, isUnauthorized, setUnauthorizedHandler } from '../api/client';
import { purgeOfflineData } from '../offline/downloads';
import { flushPending } from '../progress/engine';

export interface User {
  id: string;
  username: string;
  role: string;
}

/** How the current session was established (reverse-proxy SSO vs. password). */
export type AuthVia = 'session' | 'proxy';

interface SessionCtx {
  user: User | null;
  via: AuthVia;
  /** 'loading' | 'setup' | 'login' | 'ready' | 'offline' */
  phase: 'loading' | 'setup' | 'login' | 'ready' | 'offline';
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx>({
  user: null,
  via: 'session',
  phase: 'loading',
  refresh: async () => {},
  setUser: () => {},
  logout: async () => {},
});
export const useSession = () => useContext(Ctx);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [via, setVia] = useState<AuthVia>('session');
  const [phase, setPhase] = useState<SessionCtx['phase']>('loading');

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; via?: AuthVia }>('/api/auth/me');
      setUser(me.user);
      setVia(me.via ?? 'session');
      setPhase('ready');
      return;
    } catch (err) {
      if (isUnauthorized(err)) {
        // Session expired or revoked: logout-as-revocation removes the
        // offline copies this browser held for the signed-out user
        // (docs/security.md). Awaited — revocation fails closed before the
        // login screen appears. (The global unauthorized handler has
        // already purged once inside api(); this is idempotent belt and
        // braces for the /api/auth/me path.)
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
  //    fetch wrapper) — downloads aborted, offline data purged — before the
  //    caller sees the error.
  //  - The service worker's own online revocation check posts
  //    'vx-unauthorized' after purging the offline cache; the page then
  //    clears its IndexedDB state and drops to the login screen.
  useEffect(() => {
    const invalidate = async () => {
      await purgeOfflineData().catch(() => {});
      setUser(null);
      setPhase('login');
    };
    const unset = setUnauthorizedHandler(invalidate);
    const onSwMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'vx-unauthorized') void invalidate();
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
      await purgeOfflineData().catch(() => {});
      setUser(null);
      setPhase('login');
    }
  }, []);

  return (
    <Ctx.Provider
      value={{
        user,
        via,
        phase,
        refresh,
        logout,
        setUser: (u) => {
          setUser(u);
          if (u) setPhase('ready');
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
