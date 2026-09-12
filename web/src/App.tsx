import { useCallback, useEffect, useState } from 'react';
import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom';
import { AUTO_SHELVES } from '@readport/shared';
import { SessionProvider, useSession } from './state/session';
import { ShelvesProvider, useShelves } from './state/shelves';
import { Drawer, Sheet, ToastProvider } from './components/ui';
import { Sidebar } from './components/Sidebar';
import { IconLibrary, IconLink, IconSettings, IconShelf, ReadPortMark } from './components/icons';
import { startProgressLifecycle } from './progress/engine';
import { LoginPage } from './pages/AuthPages';
import { SetupWizard } from './pages/SetupWizard';
import { JoinPage } from './pages/JoinPage';
import { PeoplePage } from './pages/PeoplePage';
import { LibraryPage } from './pages/LibraryPage';
import { ReadingListPage } from './pages/ReadingListPage';
import { BookPage } from './pages/BookPage';
import { ReaderPage } from './reader/ReaderPage';
import { PlayerPage } from './player/PlayerPage';
import { NotesPage } from './pages/NotesPage';
import { PairsPage } from './pages/PairsPage';
import { SettingsPage } from './pages/SettingsPage';
import './styles/immersive.css';

/** Whether the rail is showing. Remembered per browser, like the theme. */
function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('rp-sidebar') === 'collapsed',
  );
  const set = useCallback((v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem('rp-sidebar', v ? 'collapsed' : 'shown');
    } catch {
      /* private browsing; the choice just does not persist */
    }
  }, []);
  return [collapsed, set];
}

/**
 * The shelf list, in whichever container this width calls for: the rail is
 * rendered in the layout grid, and this is the overlay the header button
 * opens — a drawer with room for it, a bottom sheet on a phone, which is the
 * object this app already uses for everything that slides in.
 */
function ShelfOverlay({ onClose }: { onClose: () => void }) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < 760,
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const body = <Sidebar onNavigate={onClose} />;
  return narrow ? (
    <Sheet title="Shelves" onClose={onClose}>
      {body}
    </Sheet>
  ) : (
    <Drawer title="Shelves" onClose={onClose}>
      {body}
    </Drawer>
  );
}

function ShelfHeaderButton({ onOpen }: { onOpen: () => void }) {
  const { overview } = useShelves();
  const location = useLocation();
  // The button doubles as a "you are here": on a phone the header is the only
  // place with room to say which shelf the grid belongs to.
  const current = (() => {
    const user = /^\/shelf\/u\/(.+)$/.exec(location.pathname);
    if (user) return overview?.shelves.find((s) => s.id === user[1])?.name ?? null;
    if (location.pathname === '/reading-list') return 'Reading list';
    if (location.pathname === '/shelf/on-this-device') return 'On this device';
    const auto = /^\/shelf\/([a-z-]+)$/.exec(location.pathname);
    return AUTO_SHELVES.find((s) => s.id === auto?.[1])?.label ?? null;
  })();
  return (
    <button className="btn btn--ghost app-header__shelves" onClick={onOpen} aria-haspopup="dialog">
      <IconShelf size={18} />
      <span className="app-header__shelvesname">{current ?? 'Shelves'}</span>
    </button>
  );
}

function Shell() {
  const { phase, needsLibraries } = useSession();
  const location = useLocation();
  const [setupSkipped, setSetupSkipped] = useState(
    () => localStorage.getItem('rp-setup-libraries-skipped') === '1',
  );
  const [collapsed, setCollapsed] = useSidebarCollapsed();
  const [overlay, setOverlay] = useState(false);

  useEffect(() => startProgressLifecycle(), []);

  // `[` toggles the rail, which is why the collapse button says so.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      if (typing) return;
      setCollapsed(!collapsed);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [collapsed, setCollapsed]);

  if (phase === 'loading') {
    return (
      <div className="auth-page" aria-busy="true">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }
  if (phase === 'setup') return <SetupWizard />;
  const join = /^\/join\/([A-Za-z0-9_-]+)$/.exec(location.pathname);
  if (phase === 'login') return join ? <JoinPage token={join[1]!} /> : <LoginPage />;
  // Signed in as an admin with no libraries configured — finish setup. Behind
  // reverse-proxy SSO this is the first thing the first user ever sees.
  if (phase === 'ready' && needsLibraries && !setupSkipped) {
    return <SetupWizard mode="libraries" onDone={() => setSetupSkipped(true)} />;
  }
  // 'offline' still renders the app: downloaded titles remain readable, and
  // privileged actions surface their own errors until reconnect.

  const immersive = /^\/(read|listen)\//.test(location.pathname);
  const nav = (
    <>
      <NavLink to="/" end>
        <IconLibrary size={18} /> Library
      </NavLink>
      <NavLink to="/pairs">
        <IconLink size={18} /> Pairing
      </NavLink>
      <NavLink to="/settings">
        <IconSettings size={18} /> Settings
      </NavLink>
    </>
  );

  return (
    <div className={`app-shell${collapsed ? ' is-railhidden' : ''}`}>
      {!immersive && (
        <>
          <a className="skip-link" href="#main-content">
            Skip to the content
          </a>
          <header className="app-header">
            <Link to="/" className="brand" aria-label="ReadPort home">
              <ReadPortMark size={26} style={{ color: 'var(--rp-primary)' }} />
              <span className="brand__name">ReadPort</span>
            </Link>
            <ShelfHeaderButton onOpen={() => setOverlay(true)} />
            <nav className="app-nav" aria-label="Primary">
              {nav}
            </nav>
          </header>
        </>
      )}
      {immersive ? (
        <Outlet />
      ) : (
        <div className="app-body">
          <div className="app-rail">
            <Sidebar onCollapse={() => setCollapsed(true)} />
          </div>
          <Outlet />
        </div>
      )}
      {overlay && !immersive && <ShelfOverlay onClose={() => setOverlay(false)} />}
      {!immersive && (
        <nav className="tabbar" aria-label="Primary">
          {nav}
        </nav>
      )}
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <LibraryPage /> },
      // The automatic shelves and the user's own shelves are both the library
      // page with a different source, so search, the format control and the
      // sort keep working inside a shelf.
      { path: '/shelf/u/:shelfId', element: <LibraryPage /> },
      { path: '/shelf/:autoShelf', element: <LibraryPage /> },
      { path: '/reading-list', element: <ReadingListPage /> },
      { path: '/book/:id', element: <BookPage /> },
      { path: '/read/:id', element: <ReaderPage /> },
      { path: '/listen/:id', element: <PlayerPage /> },
      { path: '/notes', element: <NotesPage /> },
      { path: '/pairs', element: <PairsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/settings/people', element: <PeoplePage /> },
      { path: '*', element: <LibraryPage /> },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <ShelvesProvider>
          <RouterProvider router={router} />
        </ShelvesProvider>
      </ToastProvider>
    </SessionProvider>
  );
}
