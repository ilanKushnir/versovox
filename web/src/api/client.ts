/** Fetch wrapper: same-origin API with the CSRF header on every request. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
  }
}

/**
 * Global unauthorized hook: EVERY API 401 (not just /api/auth/me) runs the
 * registered handler — which aborts active downloads and awaits the offline
 * purge — BEFORE the error is surfaced to the caller. Session revocation
 * therefore fails closed no matter which request discovers it.
 *
 * Exempt: credential-entry endpoints where a 401 means "wrong password",
 * not "your session was revoked" (purging another prospective user's data
 * on a typo would be wrong).
 *
 * CONTRACT — the handler is NON-RECURSIVE: it must NOT call the api()
 * wrapper, directly or transitively. Every non-exempt 401 awaits the
 * in-flight cleanup promise (see below), so an api() call made from inside
 * the handler that is answered 401 would await the handler's own
 * completion — a deadlock. If cleanup ever needs the network it must use
 * raw fetch() or another non-intercepting path. The production handler
 * only purges local state (aborts downloads, clears offline data).
 */
export type UnauthorizedHandler = (info: { url: string }) => Promise<void> | void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
/**
 * SINGLE-FLIGHT cleanup: the first 401 starts the purge and EVERY other
 * non-exempt 401 — whether its request was already in flight when the
 * purge began or was initiated afterwards — awaits the SAME in-flight
 * promise, so no caller surfaces its error while the purge is still
 * running. The promise is cleared only after it settles
 * (identity-checked), so late awaiters always observe a completed purge.
 */
let unauthorizedCleanup: Promise<void> | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler): () => void {
  unauthorizedHandler = fn;
  return () => {
    if (unauthorizedHandler === fn) unauthorizedHandler = null;
  };
}

const UNAUTHORIZED_EXEMPT = [/^\/api\/auth\/login\b/, /^\/api\/setup\b/];

async function handleUnauthorized(url: string): Promise<void> {
  if (!unauthorizedHandler) return;
  if (UNAUTHORIZED_EXEMPT.some((re) => re.test(url))) return;
  if (!unauthorizedCleanup) {
    const handler = unauthorizedHandler;
    const run = (async () => {
      try {
        await handler({ url });
      } catch {
        /* revocation cleanup is best-effort; the 401 still surfaces */
      }
    })();
    unauthorizedCleanup = run;
    void run.finally(() => {
      if (unauthorizedCleanup === run) unauthorizedCleanup = null;
    });
  }
  // EVERY non-exempt 401 awaits the shared in-flight purge — including a
  // request that was initiated only after the purge began. The handler
  // contract (non-recursive, no api() calls) is what makes this safe.
  await unauthorizedCleanup;
}

export async function api<T>(
  url: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      signal: opts.signal,
      keepalive: opts.keepalive,
      headers: {
        'x-vx-csrf': '1',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, 'network', (err as Error).message);
  }
  if (!res.ok) {
    let code = `http-${res.status}`;
    let detail: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; detail?: string };
      code = data.error ?? code;
      detail = data.detail;
    } catch {
      /* non-JSON error body */
    }
    // Revocation fails closed: the purge is AWAITED before the caller sees
    // the error, on every unauthorized path — every CONCURRENT 401 shares
    // the same in-flight purge promise, including requests initiated after
    // the purge already began.
    if (res.status === 401) await handleUnauthorized(url);
    throw new ApiError(res.status, code, detail);
  }
  return (await res.json()) as T;
}

export const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0;
export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 401;
