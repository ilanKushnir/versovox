import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { type ShelfSummary, type ShelvesOverview } from '@versovox/shared';
import { api } from '../api/client';
import { listDownloads } from '../offline/downloads';
import { useSession } from './session';

/**
 * The sidebar's data, fetched ONCE for the whole app rather than per page.
 * The library page already polls every couple of seconds while a scan runs;
 * a per-page shelf fetch would multiply that poll by every route change.
 *
 * One row is deliberately not in the server's answer. "On this device" counts
 * the books downloaded into THIS browser, which lives in IndexedDB and which
 * the server has no way to know — see `deviceCount` below.
 */

interface ShelvesCtx {
  overview: ShelvesOverview | null;
  /** Downloaded into this browser. Client-side by nature, never from the server. */
  deviceCount: number;
  loading: boolean;
  refresh: () => Promise<void>;
  refreshDownloads: () => Promise<void>;
  createShelf: (name: string) => Promise<ShelfSummary>;
  renameShelf: (id: string, name: string) => Promise<void>;
  deleteShelf: (id: string) => Promise<void>;
  moveShelf: (id: string, afterShelfId: string | null) => Promise<void>;
}

const EMPTY: ShelvesCtx = {
  overview: null,
  deviceCount: 0,
  loading: true,
  refresh: async () => {},
  refreshDownloads: async () => {},
  createShelf: async () => {
    throw new Error('no provider');
  },
  renameShelf: async () => {},
  deleteShelf: async () => {},
  moveShelf: async () => {},
};

const Ctx = createContext<ShelvesCtx>(EMPTY);
export const useShelves = () => useContext(Ctx);

export function ShelvesProvider({ children }: { children: ReactNode }) {
  const { user, phase } = useSession();
  const [overview, setOverview] = useState<ShelvesOverview | null>(null);
  const [deviceCount, setDeviceCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refreshDownloads = useCallback(async () => {
    try {
      const list = await listDownloads();
      setDeviceCount(list.filter((d) => d.status === 'done').length);
    } catch {
      setDeviceCount(0);
    }
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await api<ShelvesOverview>('/api/shelves');
      if (mine !== seq.current) return;
      setOverview(res);
    } catch {
      // Offline, or the session went away. The sidebar keeps whatever it
      // last knew; the rows that need the server render dimmed.
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Shelf names are personal, so a sign-out must not leave the previous
  // person's sidebar on screen while the next one's request is in flight.
  useEffect(() => {
    setOverview(null);
    setLoading(true);
    seq.current++;
    if (!user) {
      setDeviceCount(0);
      setLoading(false);
      return;
    }
    void refresh();
    void refreshDownloads();
  }, [user, refresh, refreshDownloads]);

  const createShelf = useCallback(
    async (name: string) => {
      const res = await api<{ shelf: ShelfSummary }>('/api/shelves', {
        method: 'POST',
        body: { name },
      });
      await refresh();
      return res.shelf;
    },
    [refresh],
  );

  const renameShelf = useCallback(
    async (id: string, name: string) => {
      await api(`/api/shelves/${id}`, { method: 'PATCH', body: { name } });
      await refresh();
    },
    [refresh],
  );

  const deleteShelf = useCallback(
    async (id: string) => {
      await api(`/api/shelves/${id}`, { method: 'DELETE' });
      await refresh();
    },
    [refresh],
  );

  const moveShelf = useCallback(
    async (id: string, afterShelfId: string | null) => {
      // Optimistic: the row is already where the user dropped it. A failure
      // is corrected by the refresh below.
      setOverview((o) => {
        if (!o) return o;
        const rest = o.shelves.filter((s) => s.id !== id);
        const moving = o.shelves.find((s) => s.id === id);
        if (!moving) return o;
        const at = afterShelfId === null ? 0 : rest.findIndex((s) => s.id === afterShelfId) + 1;
        rest.splice(at, 0, moving);
        return { ...o, shelves: rest };
      });
      await api(`/api/shelves/${id}`, { method: 'PATCH', body: { afterShelfId } }).finally(
        () => void refresh(),
      );
    },
    [refresh],
  );

  const value = useMemo<ShelvesCtx>(
    () => ({
      overview,
      deviceCount,
      loading: loading && phase !== 'offline',
      refresh,
      refreshDownloads,
      createShelf,
      renameShelf,
      deleteShelf,
      moveShelf,
    }),
    [
      overview,
      deviceCount,
      loading,
      phase,
      refresh,
      refreshDownloads,
      createShelf,
      renameShelf,
      deleteShelf,
      moveShelf,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
