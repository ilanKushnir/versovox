import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type FacetGroup,
  type FacetKind,
  type SidebarPrefs,
  sidebarFacetsOf,
} from '@readport/shared';
import { api } from '../api/client';
import { useSession } from './session';

/**
 * The library's own groupings, and which of them this reader wants to see.
 *
 * Fetched once for the app, like the shelves beside them: two Sidebars are
 * mounted whenever the overlay is open, and a per-component fetch would
 * double every request for a list that changes only when the library is
 * rescanned.
 *
 * Two separate things live here on purpose. `groups` is what the library can
 * support — computed by the server from the books themselves, the same for
 * everyone. `prefs` is what one person chose to look at. Conflating them
 * would mean one reader hiding Narrators took it from everyone else.
 */

interface FacetsCtx {
  /** Every grouping this library supports, with counts. */
  groups: FacetGroup[];
  /** The kinds to show, in order — the reader's choice, or the defaults. */
  shown: FacetKind[];
  /** False until the reader has saved a choice of their own. */
  chosen: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  save: (facets: FacetKind[]) => Promise<void>;
}

const EMPTY: FacetsCtx = {
  groups: [],
  shown: [],
  chosen: false,
  loading: true,
  refresh: async () => {},
  save: async () => {},
};

const Ctx = createContext<FacetsCtx>(EMPTY);
export const useFacets = () => useContext(Ctx);

export function FacetsProvider({ children }: { children: ReactNode }) {
  const { user, phase } = useSession();
  const [groups, setGroups] = useState<FacetGroup[]>([]);
  const [prefs, setPrefs] = useState<SidebarPrefs | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setGroups([]);
      setPrefs(null);
      setLoading(false);
      return;
    }
    try {
      const [f, p] = await Promise.all([
        api<{ groups: FacetGroup[] }>('/api/facets'),
        api<{ sidebar: SidebarPrefs }>('/api/prefs/sidebar'),
      ]);
      setGroups(f.groups);
      setPrefs(p.sidebar);
    } catch {
      // Offline, or a server one version behind that has neither endpoint.
      // The sidebar's shelves do not depend on this, so the right answer is
      // to show no groups rather than an error nobody can act on.
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (phase === 'loading') return;
    void refresh();
  }, [refresh, phase]);

  const save = useCallback(async (facets: FacetKind[]) => {
    const next: SidebarPrefs = { facets, chosen: true };
    setPrefs(next); // optimistic: the sidebar redraws before the round trip
    try {
      await api<{ sidebar: SidebarPrefs }>('/api/prefs/sidebar', { method: 'PUT', body: next });
    } catch {
      // Left as chosen locally rather than snapping back mid-edit; the next
      // load reads the server's answer.
    }
  }, []);

  const value = useMemo<FacetsCtx>(() => {
    // Only kinds this library can actually support, in the reader's order. A
    // stored preference for Narrators survives a library that has none: it is
    // filtered out of the display but stays in the saved list, so it comes
    // back on its own the day an audiobook arrives with a narrator tag.
    const available = groups.map((g) => g.kind);
    return {
      groups,
      shown: sidebarFacetsOf(prefs, available),
      chosen: prefs?.chosen ?? false,
      loading,
      refresh,
      save,
    };
  }, [groups, prefs, loading, refresh, save]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
