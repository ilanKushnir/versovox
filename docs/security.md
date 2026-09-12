# Security model

## Authentication

- **First-run setup requires a one-time bootstrap token.** Creating the
  admin account needs `VX_SETUP_TOKEN` (or `VX_SETUP_TOKEN_FILE`); when
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
  `SameSite=Lax` cookie (`Secure` when `VX_TRUST_HTTPS=1`). The database
  stores only an HMAC of the token keyed by `VX_SESSION_SECRET`, so a stolen
  database/backup cannot be replayed as live sessions, and rotating the
  secret invalidates all sessions.
- Login is throttled **per (account, client IP)** (10 attempts / 5 minutes)
  and **per client IP** (30 / 5 minutes); counters persist in SQLite across
  restarts and expired windows are pruned daily. Keying the account limit
  on the caller's IP means a remote attacker cannot lock the real owner out
  of a known username. Forwarded headers (`X-Forwarded-For`) are ignored
  unless the operator explicitly trusts a proxy via `VX_TRUST_PROXY`, so a
  direct attacker cannot rotate spoofed IPs past the limit.
- Sessions expire (default 30 days) and are deleted on logout.
- **Route guarding is keyed on the matched route, not the raw URL.** The
  router matches the percent-decoded path, so a guard that inspected
  `req.url` could be bypassed with `/%61pi/...`. Versovox checks the
  resolved route pattern and the decoded path, marks every route that may
  answer without a session explicitly (`config.public`: health, login, the
  two invite endpoints, and the first-run wizard and preflight helpers, each
  of which then applies its own gate), and rejects malformed encodings with
  400; a regression test covers the encoded-prefix case.
- **Roles.** `admin` (everything: people, libraries, models, settings),
  `curator` (pairing decisions — link/unlink/confirm/reject/align — and job
  cancel/retry), `reader` (read and listen). Rescans, settings, model
  downloads, the bulk import and export of alignment files, and people
  management stay admin-only. Every account keeps its own progress,
  annotations, and offline copies; nothing is shared between users.
- **No open registration.** Accounts exist only because an admin created
  them (with a password told in person) or issued a one-time **invite
  link** (`/join/<token>`). Invite tokens are 192-bit random values stored
  only as a SHA-256 hash, carry a preset role, expire (1–30 days, default
  7), are consumed atomically on acceptance, and can be revoked. Reading an
  invite reveals only its role and display name; the endpoints are rate
  limited per IP.
- **Disabling** an account deletes its sessions immediately and refuses
  login (`403 account-disabled`); role changes and admin password resets
  also sign the user out everywhere. The last active admin can be neither
  demoted, disabled, nor deleted, and admins cannot lock themselves out.
- **Setup wizard helpers** (`/api/setup/test-paths`, `/api/setup/browse`,
  `/api/preflight`) answer only for an admin session or, before an admin
  exists, a request carrying the bootstrap token in the `x-vx-setup-token`
  header. They report what a folder is (existence, readability, a capped
  shallow count of book files) and what the server has (audio tools, the
  alignment runtime, free space, whether its own volumes are writable). All
  of it is read-only but for one deliberate write: asked about a folder of
  kind `alignment`, the check creates a zero-byte
  `.versovox-write-test-<pid>` and deletes it again. Permission bits cannot
  answer the question that matters there — a `:ro` bind mount shows exactly
  the bits it would show read-write and then refuses the write — and an
  operator should find that out during setup rather than after the first
  alignment has nowhere to go.

## Reverse-proxy single sign-on (optional)

Self-hosters who already front their services with Authentik, Authelia, or
oauth2-proxy can let that proxy sign users in:

- `VX_PROXY_AUTH_HEADER=x-authentik-username` names the header the proxy
  sets after authenticating the user.
- `VX_PROXY_AUTH_SOURCES=192.168.1.50/32` lists the proxy's addresses. The
  header is honoured **only when the TCP peer that delivered the request is
  in this list** — checked on the socket, not on forwarded headers — so a
  client that reaches Versovox directly (a LAN port, a break-glass URL) can
  never forge it and simply sees the password login page. If the header is
  configured without sources, sign-in stays disabled and a warning is
  logged (fail closed).
- Users are provisioned on first sight with an unusable password hash;
  `VX_PROXY_AUTH_ADMINS` names the admins, and on an empty instance the
  first proxied user becomes admin (the proxy already decides who may reach
  Versovox at all); everyone else starts as a `reader` and an admin can
  promote them under Settings → People. Setup-token bootstrap is closed
  once any user exists.
- Proxied requests are authenticated per request (no Versovox cookie is
  issued); signing out is the proxy's job, and the UI says so.

Without a proxy, nothing changes: the setup token + password flow is the
default, and it stays available on the direct URL for accounts that have a
password.

## Offline data and logout

Logout is revocation. Signing out (or discovering the session invalid)
purges every copy of server **content** this browser holds: the
downloaded-books Cache Storage bucket, the cached server progress state and
the download registry. Active downloads are aborted and awaited before the
purge, so a logout racing a download cannot leave freshly written content
behind. Downloaded books therefore do not remain readable in a browser
profile after logout; sign in again and re-download to restore offline
copies. Device-level reader preferences (font, theme) are not user content
and are kept. An encrypted survive-logout offline mode is not implemented in
V1 and is not claimed.

One thing is deliberately **not** purged by revocation: reading positions
recorded on this device and not yet delivered. They are the reader's own
writing, not content they have lost the right to see, and an hour read on a
plane must not die because the session expired while the device was in the
air. The queue is stamped with the account that recorded it, so it is only
ever delivered to that account; it is discarded on a deliberate logout
(after a last flush attempt) and when a different account signs in on this
browser. Where a queue predates the stamp its ownership cannot be proven, and
it is adopted by the next account to sign in — the one case where an
account switch across that upgrade boundary can carry positions over.

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
- That same check reads **who** is signed in, not merely that someone is.
  The offline cache carries the account id it belongs to, and cached book
  content is served only to that account. This matters where no request
  ever fails: a reverse-proxy SSO deployment has no cookie and no logout, so
  a shared tablet moving from one reader to the next would otherwise hand
  the second one the first one's downloaded books, reading positions and
  bookmarks. Content belonging to another account — or predating the stamp,
  and so of unprovable ownership — is deleted from the device rather than
  served, and open pages are told so they stop advertising those titles as
  available offline. Upgrading to this behaviour purges any offline cache
  that has no stamp yet; those titles need downloading once more.

Deliberate airplane-mode offline access is preserved: when the network is
unreachable, the service worker keeps its last known authorization state
and downloaded books stay readable.

**Exact limitation:** a device that is already offline cannot learn about
a server-side revocation — or about a change of account — until it
reconnects. Offline access on such a
device continues (by design — that is what offline downloads are for)
until the first moment the app can reach the server again, at which point
the 401 triggers the purge. There is no cryptographic offline expiry in
V1 and none is claimed.

## CSRF

Defense in depth for cookie-authenticated calls:

1. `SameSite=Lax` cookies;
2. every mutating request must carry the custom header `x-vx-csrf: 1`
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
  become inert `data-vx-href` attributes the reader resolves itself;
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

- Source libraries are mounted read-only and Versovox never writes into
  them. The alignment folder is the one deliberate exception, and it has its
  own section below.
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
- Everything else Versovox derives — the extracted EPUB indexes, cover
  thumbnails, a cover extraction's temporary file — lives under its own data
  and cache volumes. The aligner itself writes nothing at all while it works:
  the narration is streamed through memory in chunks, never staged on disk.
- **The alignment model is the only thing fetched from the network, and its
  URL is a constant in the image rather than a setting.** No web session can
  aim the downloader anywhere else; an admin can start the download or delete
  the files, and that is the whole of it. The transfer is HTTPS to the
  published repository and the finished file is accepted on its size rather
  than a signature, so the trust here is trust in that repository and in TLS —
  one more reason nothing is downloaded until someone asks for it.
- `ffprobe` and `ffmpeg` are the only subprocesses left. Both are invoked with
  argument arrays and no shell — `execFile` for metadata and cover extraction,
  `spawn` with `-nostdin` and no stdin for the decode stream — always on
  `realpath`-resolved absolute paths already proved to lie inside a library
  root. The short runs carry a timeout and a `SIGKILL`; the decode has no
  clock of its own, because a legitimate audiobook streams for hours, and is
  killed instead the moment the alignment job's lease is lost or the job is
  cancelled.

## The alignment folder

Finished alignments are written out as `.vxalign` files so that the hours of
CPU they cost survive a rebuild of the container. That makes one folder inside
a mount the operator supplies the only writable path Versovox has, and it is
worth being exact about what that buys and what it costs.

**Where it is is an admin decision, and it is not a contained path.** The
folder comes from `VX_ALIGNMENT_DIRS`, or from the list an admin sets in the
setup wizard or under Settings → Libraries; with neither, alignments go to
`<data>/alignments`, which survives a restart but not a rebuild that discards
the volume — and that folder catches them anyway if every configured one
refuses a write, because losing an alignment over a mount option would throw
away the expensive half of the work. These are absolute paths and they
deliberately do not go through the library containment checks — they name a
mount, they do not sit inside one — so an admin can point them at anything the
container user can write to. That is an admin capability by construction, the
same class of decision as choosing the library roots: a `curator` or a
`reader` cannot reach the setting, and pinning it in the environment takes it
away from the web UI entirely. What bounds it is the container — a non-root
user, `no-new-privileges`, and only the volumes the compose file mounts.

**What lands there.** One gzipped JSON document per aligned pair, named
`<author> - <title> [<pair key>].vxalign`, written first to a dot-prefixed
temporary in the same directory, fsynced, then renamed into place, so the sync
client or backup job watching that folder never replicates half a file. The
only file ever deleted is one whose name ends in the same bracketed pair key —
the stale copy a retitled book leaves behind — and the temporary itself.
Nothing else in the folder is read, moved or removed, and the entrypoint's
ownership fix-up does not touch it either, which is why a folder the container
user cannot write to is reported as a problem instead of being forced.

**What comes back out of it is untrusted input**, exactly as an EPUB is: the
folder belongs to the operator, their sync client, and whoever else can reach
the share. A file is used only if it ends in `.vxalign`, gunzips, parses as
JSON, carries the Versovox format tag, declares a format version this build
understands, satisfies the schema, uses fingerprint schemes this build
implements, and has segment columns that all agree on their length. Identity
is never taken from a filename, a path or an id — a file is matched to a pair
by a fingerprint of the ebook's sentence ids and one of the audiobook's track
durations. Import is all-or-nothing, an alignment already in the database
always wins over a file, and a pair that already holds segments rejects any
document naming a sentence it does not know. Nothing in a document is executed
or rendered: the timings are numbers, and the free-form provenance block is
only ever read back as a count.

What remains is worth saying plainly. On a fresh install a file whose
fingerprints match a real pair is believed, and the worst a planted one can do
is send a listener to the wrong place in the narration — visible immediately,
and undone by aligning the pair again. Decompression is bounded by the
container's memory limit rather than by a cap of its own, so a file crafted to
expand enormously costs an import job rather than being rejected outright.
Both are accepted V1 limitations of trusting a folder the operator chose.

## Container posture

- Runs as a non-root user (`PUID`/`PGID`), privileges dropped via `gosu`
  after volume ownership alignment (`chown -h`, never following symlinks, and
  never touching a library mount — the alignment folder included, which is
  why that one has to be writable by the container user already);
  `no-new-privileges` in compose.
- No Docker socket, no privileged mode, no host network.
- One native dependency, `onnxruntime-node`, which runs the alignment model;
  SQLite is Node's built-in `node:sqlite` and nothing else compiles. The
  supply-chain surface is therefore that one prebuilt runtime plus a short
  list of pure-JavaScript packages, all pinned by `package-lock.json` and
  installed with `--ignore-scripts` in both image stages, so no dependency's
  install script runs during the build.

## Secrets and logging

- `VX_SESSION_SECRET` supports `_FILE` (Docker secrets). If unset, a random
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
