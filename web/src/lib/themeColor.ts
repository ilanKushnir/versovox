/**
 * Status-bar / browser-chrome colour. iOS home-screen web apps paint the
 * status bar from the `theme-color` meta; WebKit watches the meta element,
 * but standalone launches have been seen to keep the launch value when only
 * the `content` attribute of a media-scoped meta changes. So ReadPort keeps
 * a SINGLE un-scoped meta and replaces the element on every change — the
 * form WebKit is documented to observe — and mirrors the colour onto the
 * root background so nothing behind the bar can flash the old colour.
 */
const APP_LIGHT = '#f6f1e8';
const APP_DARK = '#16120f';

export function setThemeColor(color: string): void {
  if (typeof document === 'undefined') return;
  for (const m of Array.from(document.querySelectorAll('meta[name="theme-color"]'))) m.remove();
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = color;
  document.head.appendChild(meta);
  document.documentElement.style.backgroundColor = color;
}

/** Colour for the app shell given the app theme preference. */
export function appThemeColor(pref: string | null): string {
  if (pref === 'light') return APP_LIGHT;
  if (pref === 'dark') return APP_DARK;
  const dark =
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
  return dark ? APP_DARK : APP_LIGHT;
}

/** Apply the app-shell colour (call on boot, on theme change, on system change). */
export function applyAppThemeColor(): void {
  let pref: string | null = null;
  try {
    pref = localStorage.getItem('rp-app-theme');
  } catch {
    /* private mode */
  }
  setThemeColor(appThemeColor(pref));
}
