import { useEffect } from 'react';
import {
  createBrowserRouter,
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
} from 'react-router-dom';
import { SessionProvider, useSession } from './state/session';
import { ToastProvider } from './components/ui';
import { IconLibrary, IconLink, IconSettings, LeafMark } from './components/icons';
import { startProgressLifecycle } from './progress/engine';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { LibraryPage } from './pages/LibraryPage';
import { BookPage } from './pages/BookPage';
import { ReaderPage } from './reader/ReaderPage';
import { PlayerPage } from './player/PlayerPage';
import { PairsPage } from './pages/PairsPage';
import { SettingsPage } from './pages/SettingsPage';
import './styles/immersive.css';

function Shell() {
  const { phase } = useSession();
  const location = useLocation();

  useEffect(() => startProgressLifecycle(), []);

  if (phase === 'loading') {
    return (
      <div className="auth-page" aria-busy="true">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }
  if (phase === 'setup') return <SetupPage />;
  if (phase === 'login') return <LoginPage />;
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
    <div className="app-shell">
      {!immersive && (
        <header className="app-header">
          <Link to="/" className="brand" aria-label="TandemLeaf home">
            <LeafMark size={26} style={{ color: 'var(--tl-primary)' }} />
            <span className="brand__name">TandemLeaf</span>
          </Link>
          <nav className="app-nav" aria-label="Primary">
            {nav}
          </nav>
        </header>
      )}
      <Outlet />
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
      { path: '/book/:id', element: <BookPage /> },
      { path: '/read/:id', element: <ReaderPage /> },
      { path: '/listen/:id', element: <PlayerPage /> },
      { path: '/pairs', element: <PairsPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '*', element: <LibraryPage /> },
    ],
  },
]);

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </SessionProvider>
  );
}
