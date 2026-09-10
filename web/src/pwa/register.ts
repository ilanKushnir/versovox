export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // dev server has no built sw
  // Register immediately (not after `load`): the first online visit must
  // install the app-shell precache so a subsequent offline standalone launch
  // works even though this first page load itself was not intercepted.
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}
