import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';
import { registerServiceWorker } from './pwa/register';
import { applyAppThemeColor } from './lib/themeColor';

// App theme + status-bar colour before first paint (the reader overrides
// both while open and restores them on exit).
try {
  const pref = localStorage.getItem('rp-app-theme');
  if (pref === 'light' || pref === 'dark')
    document.documentElement.setAttribute('data-app-theme', pref);
} catch {
  /* private mode */
}
applyAppThemeColor();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.querySelector('.reader-page')) applyAppThemeColor();
});

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
