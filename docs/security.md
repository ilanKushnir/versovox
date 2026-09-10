# Security model

## Authentication

- **First-run setup requires a one-time bootstrap token.** Creating the
  admin account needs `TL_SETUP_TOKEN` (or `TL_SETUP_TOKEN_FILE`); when
  unset, the server generates a random token on first start, prints it in
  its log, and stores it at `<data>/setup-token` (0600). Whoever merely
  reaches a freshly started instance first therefore cannot take it over.
  The token is compared in constant time, consumed atomically the moment
  the admin account is created (racing setup requests are serialized in a
  transaction), and there is no default token anywhere in the code, image,
  or docs.
- Passwords are hashed with **scrypt** (N=32768, r=8, p=1, 64-byte keys,
  per-password random salt) via `node:crypto`, verified with
  constant-time comparison. Hashing/verification run asynchronously off the
  event loop, and unknown usernames verify against a fixed dummy hash so
  response timing does not reveal whether an account exists.
- Sessions are opaque 256-bit random tokens in an `HttpOnly`,
  `SameSite=Lax` cookie (`Secure` when `TL_TRUST_HTTPS=1`). The database
  stores only an HMAC of the token keyed by `TL_SESSION_SECRET`, so a stolen
  database/backup cannot be replayed as live sessions, and rotating the
  secret invalidates all sessions.
- Login is throttled **per (account, client IP)** (10 attempts / 5 minutes)
  and **per client IP** (30 / 5 minutes); counters persist in SQLite across
  restarts and expired windows are pruned daily. Keying the account limit
  on the caller's IP means a remote attacker cannot lock the real owner out
  of a known username. Forwarded headers (`X-Forwarded-For`) are ignored
  unless the operator explicitly trusts a proxy via `TL_TRUST_PROXY`, so a
  direct attacker cannot rotate spoofed IPs past the limit.
- Sessions expire (default 30 days) and are deleted on logout.
- **Route guarding is keyed on the matched route, not the raw URL.** The
  router matches the percent-decoded path, so a guard that inspected
  `req.url` could be bypassed with `/%61pi/...`. TandemLeaf checks the
  resolved route pattern and the decoded path, marks the four public routes
  explicitly (`config.public`), and rejects malformed encodings with 400;
  a regression test covers the encoded-prefix case.
- Pairing decisions (link/unlink/confirm/reject/align), rescans, job
  control, settings changes, and library root paths are admin-only.

## Offline data and logout

Logout is revocation. Signing out (or discovering the session invalid)
purges this browser's per-user offline data: the downloaded-books Cache
Storage bucket and the per-user IndexedDB state (queued progress events,
cached server state, the download registry). Active downloads are aborted
and awaited before the purge, so a logout racing a download cannot leave
freshly written content behind. Downloaded books therefore do not remain
readable in a browser profile after logout; sign in again and re-download
to restore offline copies. Device-level reader preferences (font, theme)
are not user content and are kept. An encrypted survive-logout offline
mode is not implemented in V1 and is not claimed.

Revocation fails closed while online, through two independent paths:

- Every API request answered 401 (not just `/api/auth/me`) runs a global
  unauthorized handler in the app that aborts downloads and awaits the
  offline purge before the error is surfaced. The purge is single-flight:
  concurrent 401s all await the same in-flight purge promise — including
  requests initiated after the purge already began — so no caller sees
  its error while cleanup is still running. (The handler is contractually
  non-recursive: it never calls the API wrapper itself, so the universal
  barrier cannot deadlock.) Credential-entry
  endpoints (`/api/auth/login`, `/api/setup*`) are exempt — a wrong
  password is not a revocation.
- The service worker gates cache-first book content behind a short-lived
  session revalidation (at most one `/api/auth/me` check per 30 seconds
  while such content is being served). A 401/403 verdict purges the
  offline cache from inside the service worker, notifies open pages
  (which clear their IndexedDB state and drop to the login screen), and
  cached serving stops — so an app that was already open when the session
  was revoked server-side cannot keep reading cached books online.

Deliberate airplane-mode offline access is preserved: when the network is
unreachable, the service worker keeps its last known authorization state
and downloaded books stay readable.

**Exact limitation:** a device that is already offline cannot learn about
a server-side revocation until it reconnects. Offline access on such a
device continues (by design — that is what offline downloads are for)
until the first moment the app can reach the server again, at which point
the 401 triggers the purge. There is no cryptographic offline expiry in
V1 and none is claimed.

## CSRF

Defense in depth for cookie-authenticated calls:

1. `SameSite=Lax` cookies;
2. every mutating request must carry the custom header `x-tl-csrf: 1`
   (unsettable cross-origin without CORS preflight, which same-origin-only
   `connect-src` and no CORS headers prevent);
3. `Origin` / `Sec-Fetch-Site` headers, when present, must be same-origin.

## Book content sandboxing

EPUB chapters are untrusted input. The server sanitizes every chapter with a
strict allowlist over a spec-compliant HTML parser (parse5):

- `script`, `style`, `iframe`, `object`, `embed`, `svg`, `form`, media and
  every unknown dangerous element are removed; unknown harmless containers
  are unwrapped.
- All `on*` handlers, `style` attributes, and non-allowlisted attributes are
  dropped.
- `javascript:` and any absolute-scheme URLs are stripped; internal links
  become inert `data-tl-href` attributes the reader resolves itself;
  internal images are rewritten to authenticated asset routes; external
  images are removed.
- EPUB archives are extracted by a **bounded streaming unzipper**: the
  compressed file is read in small chunks (never fully buffered) and every
  limit is enforced on actual streamed bytes — compressed size (100 MB),
  per-entry decompressed size (64 MB), total decompressed size (300 MB),
  entry count (4096), and an overall expansion-ratio bomb heuristic — plus
  per-chapter (4 MB), metadata-document (10 MB), spine-length, and asset
  caps. Entries are path-normalized; nothing from an archive is ever
  written under an attacker-controlled path, and re-indexing swaps a fresh
  derived directory in atomically so routes never serve a replaced
  edition's content. Each index attempt extracts into a directory unique
  to its job lease (a reclaimed job's overlapping attempts can never write
  or delete each other's output), and superseded versions are removed by
  deferred garbage collection after a short grace period — long enough
  that a request which resolved the old version just before the switch can
  still finish reading from it.
- The app shell ships a strict Content-Security-Policy
  (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), so
  even a sanitizer bypass has no script execution or exfiltration channel
  inside the app. Chapter fragments are fetched as text and injected into
  the reader's DOM under that policy; the chapter route itself answers with
  `Content-Security-Policy: sandbox; default-src 'none'`, so a browser
  pointed directly at a chapter URL gets an opaque-origin document with no
  cookies, no same-origin DOM, and no loads. SVG assets are served with
  their own `default-src 'none'` CSP.
- Publisher `id`/`class` attributes survive sanitization (they anchor TOC
  fragments and footnotes) and are scoped by the reader's own selectors;
  they cannot execute anything, but a book can in principle reuse an app
  class name for cosmetic effect. This is a known, accepted V1 limitation.

## Filesystem containment

- Library roots are mounted read-only; TandemLeaf never writes into them.
- Every path derived from the database or user input resolves through
  containment checks (`resolveWithin`/`realResolveWithin`) that reject
  absolute paths, `..` traversal, prefix-sibling escapes, and symlinks that
  point outside the root (covered by unit tests, including the API-level
  traversal attempts).
- Scans follow symlinks only when their target stays inside the library.
- Fallback folder covers (`cover.jpg` etc.) resolve through the same
  containment checks, are opened with `O_NOFOLLOW`, must be regular files,
  and must carry a genuine JPEG/PNG signature before any bytes are copied —
  a symlinked "cover" cannot exfiltrate files from outside (or inside) the
  library.
- Whisper transcription output lives in a private temp directory under the
  TandemLeaf cache and is removed in `finally`; source libraries are never
  written to, so read-only mounts work.
- The whisper binary and model paths an **admin** sets in the web UI must
  resolve (after symlinks) inside `TL_MODELS_DIR`. A web session can
  therefore only run executables the operator placed in the models volume,
  never arbitrary paths in the container. Environment-pinned paths
  (`TL_WHISPER_BIN`) are the operator's and are not restricted.
- External tools (`ffprobe`, `ffmpeg`, whisper) always run via `execFile`
  with argument arrays (no shell), on `realpath`-resolved absolute file
  paths, with timeouts and `SIGKILL`.

## Container posture

- Runs as a non-root user (`PUID`/`PGID`), privileges dropped via `gosu`
  after volume ownership alignment (`chown -h`, never following symlinks,
  and never touching library mounts); `no-new-privileges` in compose.
- No Docker socket, no privileged mode, no host network.
- No native Node modules (SQLite is Node's built-in `node:sqlite`), keeping
  the supply-chain surface small; dependencies are pinned via
  `package-lock.json`.

## Secrets and logging

- `TL_SESSION_SECRET` supports `_FILE` (Docker secrets). If unset, a random
  secret is generated once and stored with mode 0600 in the data dir.
- Tokens are never logged; session cookies never reach client-side
  JavaScript (`HttpOnly`); the web bundle contains no secrets.
- API error responses never carry internal messages: a global error
  handler logs 5xx details server-side and answers `{ "error": "internal" }`;
  query strings are schema-validated. Progress/history/annotation endpoints
  are scoped per authenticated user.
- Background jobs that repeatedly lose their lease (for example a
  pathological file that crashes the worker) are failed after three
  attempts rather than re-queued forever.

## Reporting

Please report suspected vulnerabilities privately via the repository's
security advisories rather than public issues.
