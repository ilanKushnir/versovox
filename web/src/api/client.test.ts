import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setUnauthorizedHandler } from './client';

/**
 * Revocation fails closed at the fetch wrapper: EVERY API 401 runs the
 * registered unauthorized handler — and AWAITS it — before the error is
 * surfaced. Credential-entry endpoints are exempt (a wrong password is not
 * a revocation).
 */

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('global unauthorized handling', () => {
  it('a GENERAL API 401 runs and awaits the handler before the caller sees the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: 'unauthorized' })),
    );
    const order: string[] = [];
    const unset = setUnauthorizedHandler(async () => {
      await new Promise((r) => setTimeout(r, 10)); // slow purge
      order.push('purged');
    });
    try {
      await expect(
        api('/api/books/abc123').catch((err) => {
          order.push('caller-saw-error');
          throw err;
        }),
      ).rejects.toBeInstanceOf(ApiError);
    } finally {
      unset();
    }
    // The purge completed BEFORE the error reached the caller.
    expect(order).toEqual(['purged', 'caller-saw-error']);
  });

  it('CONCURRENT 401s: every in-flight caller awaits the same single purge before surfacing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: 'unauthorized' })),
    );
    const order: string[] = [];
    let purgeRuns = 0;
    let releasePurge!: () => void;
    const purgeBlocked = new Promise<void>((r) => {
      releasePurge = r;
    });
    const unset = setUnauthorizedHandler(async () => {
      purgeRuns += 1;
      await purgeBlocked; // purge held open while both 401s land
      order.push('purged');
    });
    try {
      const a = api('/api/books/a').catch(() => {
        order.push('a-error');
      });
      const b = api('/api/books/b').catch(() => {
        order.push('b-error');
      });
      // Give both 401 responses time to arrive while the purge is blocked:
      // NEITHER error may surface yet.
      await new Promise((r) => setTimeout(r, 20));
      expect(order).toEqual([]);
      expect(purgeRuns).toBe(1); // single-flight: one purge for both
      releasePurge();
      await Promise.all([a, b]);
    } finally {
      unset();
    }
    // The purge completed BEFORE either caller saw its error.
    expect(order[0]).toBe('purged');
    expect(order.slice(1).sort()).toEqual(['a-error', 'b-error']);
    expect(purgeRuns).toBe(1);
  });

  it('a failed login does NOT trigger the revocation handler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: 'bad-credentials' })),
    );
    const handler = vi.fn();
    const unset = setUnauthorizedHandler(handler);
    try {
      await expect(
        api('/api/auth/login', { method: 'POST', body: { username: 'u', password: 'wrong' } }),
      ).rejects.toBeInstanceOf(ApiError);
      await expect(api('/api/setup/status')).rejects.toBeInstanceOf(ApiError);
    } finally {
      unset();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('successful responses and non-401 errors never invoke the handler', async () => {
    const handler = vi.fn();
    const unset = setUnauthorizedHandler(handler);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(200, { ok: true })),
      );
      await api('/api/books');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(500, { error: 'boom' })),
      );
      await expect(api('/api/books')).rejects.toBeInstanceOf(ApiError);
    } finally {
      unset();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  // NOTE: there is deliberately no "handler calls api() itself" test. The
  // handler contract is NON-RECURSIVE (see UnauthorizedHandler in
  // client.ts): every non-exempt 401 awaits the shared in-flight purge, so
  // an api() call from inside the handler that is answered 401 would await
  // the handler's own completion — a deadlock by construction. A handler
  // needing the network must use raw fetch(); the production handler only
  // purges local state.

  it('a request INITIATED AFTER the purge began still awaits it before surfacing (regression)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, { error: 'unauthorized' })),
    );
    const order: string[] = [];
    let purgeRuns = 0;
    let releasePurge!: () => void;
    const purgeBlocked = new Promise<void>((r) => {
      releasePurge = r;
    });
    let signalPurgeStarted!: () => void;
    const purgeStarted = new Promise<void>((r) => {
      signalPurgeStarted = r;
    });
    const unset = setUnauthorizedHandler(async () => {
      purgeRuns += 1;
      signalPurgeStarted();
      await purgeBlocked; // purge held open until the test releases it
      order.push('purged');
    });
    try {
      // Request A's 401 starts the purge.
      const a = api('/api/books/a').catch(() => {
        order.push('a-error');
      });
      await purgeStarted;
      // Request B is initiated only AFTER the purge is already running; its
      // 401 must join the same barrier, not bypass it.
      const b = api('/api/books/b').catch(() => {
        order.push('b-error');
      });
      await new Promise((r) => setTimeout(r, 20));
      // Purge still held open: NEITHER caller has surfaced its error.
      expect(order).toEqual([]);
      expect(purgeRuns).toBe(1); // single-flight: B joined A's purge
      releasePurge();
      await Promise.all([a, b]);
    } finally {
      unset();
    }
    // Both errors surfaced only after the shared purge completed, once.
    expect(order[0]).toBe('purged');
    expect(order.slice(1).sort()).toEqual(['a-error', 'b-error']);
    expect(purgeRuns).toBe(1);
  });

  it('a handler failure never masks the original 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(401, {})),
    );
    const unset = setUnauthorizedHandler(() => {
      throw new Error('purge exploded');
    });
    try {
      const err = await api('/api/books/x').catch((e) => e as ApiError);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
    } finally {
      unset();
    }
  });
});
