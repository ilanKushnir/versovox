import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
// The service worker's authorization gate (classic importScripts). Under the
// web package's ESM default the UMD wrapper registers on globalThis instead
// of module.exports; accept either.
const required = require('../../public/sw-auth.js') as Record<string, unknown>;
const tlAuth = (
  (required as { createAuthGate?: unknown }).createAuthGate
    ? required
    : (globalThis as Record<string, unknown>).tlAuth
) as {
  createAuthGate(opts: {
    fetchFn: () => Promise<{ status: number; ok: boolean }>;
    now?: () => number;
    ttlMs?: number;
    onRevoked?: () => Promise<void> | void;
  }): { allowCachedPrivate(): Promise<boolean>; _state(): { ok: boolean; at: number } };
};

describe('service-worker auth gate (online revocation fails closed)', () => {
  it('serves cached content while the server confirms the session', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    const gate = tlAuth.createAuthGate({ fetchFn });
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('REVOCATION: a 401 refuses cached serving and runs the purge exactly once', async () => {
    const onRevoked = vi.fn(async () => {});
    const fetchFn = vi.fn(async () => ({ status: 401, ok: false }));
    let t = 0;
    const gate = tlAuth.createAuthGate({ fetchFn, onRevoked, now: () => t, ttlMs: 1000 });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    // Later checks stay refused without re-running the purge.
    t = 5000;
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('403 is treated as revocation too', async () => {
    const onRevoked = vi.fn();
    const gate = tlAuth.createAuthGate({
      fetchFn: async () => ({ status: 403, ok: false }),
      onRevoked,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('TTL: a fresh verdict is reused without another network check', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, ok: true }));
    let t = 0;
    const gate = tlAuth.createAuthGate({ fetchFn, now: () => t, ttlMs: 30_000 });
    await gate.allowCachedPrivate();
    t = 10_000;
    await gate.allowCachedPrivate(); // inside TTL
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = 40_000;
    await gate.allowCachedPrivate(); // TTL expired: revalidate
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('AIRPLANE MODE: network failure keeps offline reading working', async () => {
    const gate = tlAuth.createAuthGate({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    // Never-checked session + unreachable network => cached books stay
    // readable (deliberate offline access).
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
  });

  it('a session already known revoked STAYS revoked when the device then goes offline', async () => {
    let offline = false;
    const gate = tlAuth.createAuthGate({
      fetchFn: async () => {
        if (offline) throw new TypeError('Failed to fetch');
        return { status: 401, ok: false };
      },
      now: (() => {
        let t = 0;
        return () => (t += 60_000); // every call is past the TTL
      })(),
      ttlMs: 1000,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
    offline = true;
    await expect(gate.allowCachedPrivate()).resolves.toBe(false);
  });

  it('a server error (5xx) is inconclusive: the last verdict stands', async () => {
    let status = 200;
    let t = 0;
    const gate = tlAuth.createAuthGate({
      fetchFn: async () => ({ status, ok: status >= 200 && status < 300 }),
      now: () => t,
      ttlMs: 1000,
    });
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
    status = 500;
    t = 5000;
    await expect(gate.allowCachedPrivate()).resolves.toBe(true);
  });
});
