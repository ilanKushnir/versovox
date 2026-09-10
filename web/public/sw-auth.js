/* Authorization gate for cache-first private content, shared by the service
   worker (importScripts) and unit tests (CommonJS require).

   Contract (docs/security.md): downloaded book content may be served from
   the offline cache ONLY while the session is not known to be revoked.
   While the network is reachable, the gate revalidates the session against
   the server (at most once per TTL); an explicit 401/403 marks the session
   revoked, triggers the purge callback, and cached private content stops
   being served. When the network is unreachable the gate preserves
   deliberate airplane-mode offline access by keeping its LAST KNOWN state —
   which also means a device that is already offline cannot learn about a
   server-side revocation until it reconnects (documented limitation). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.tlAuth = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  /**
   * @param {Object} opts
   * @param {() => Promise<{status: number, ok: boolean}>} opts.fetchFn
   *   Performs the session check (e.g. GET /api/auth/me).
   * @param {() => number} [opts.now]
   * @param {number} [opts.ttlMs] How long one verdict stays fresh.
   * @param {() => Promise<void>|void} [opts.onRevoked]
   *   Runs once per transition into the revoked state (purge + notify).
   */
  function createAuthGate(opts) {
    const now = opts.now || Date.now;
    const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : 30000;
    // Start authorized-but-stale: the first cached-content request after a
    // service worker start triggers a real check when online.
    let state = { ok: true, at: -Infinity };
    let pending = null;

    async function check() {
      let res;
      try {
        res = await opts.fetchFn();
      } catch {
        // Network unreachable: keep the last known state (airplane mode
        // keeps working; a previously revoked session stays revoked).
        return state.ok;
      }
      if (res.status === 401 || res.status === 403) {
        const wasOk = state.ok;
        state = { ok: false, at: now() };
        if (wasOk && opts.onRevoked) {
          try {
            await opts.onRevoked();
          } catch {
            /* purge is best-effort; the refusal below still stands */
          }
        }
        return false;
      }
      // 2xx: authorized. Other statuses (5xx, redirects): inconclusive —
      // keep the last verdict but refresh the timestamp so a flapping
      // server is not hammered on every request.
      state = { ok: res.ok ? true : state.ok, at: now() };
      return state.ok;
    }

    return {
      /** May cached private (per-user) content be served right now? */
      allowCachedPrivate() {
        if (now() - state.at < ttlMs) return Promise.resolve(state.ok);
        if (!pending) {
          pending = check().finally(function () {
            pending = null;
          });
        }
        return pending;
      },
      /** Test hook. */
      _state() {
        return { ok: state.ok, at: state.at };
      },
    };
  }

  return { createAuthGate };
});
