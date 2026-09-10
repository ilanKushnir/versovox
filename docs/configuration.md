# Configuration

## Precedence

1. **Environment variables** (`VX_*`) — pin values in Compose; shown as
   read-only ("set by environment") in the admin UI.
2. **In-app admin settings** — stored in the database, editable in
   Settings; only for keys not pinned by env.
3. **Built-in defaults.**

Every `VX_*` variable also accepts a `VX_*_FILE` variant whose value is a
path to a file containing the secret (Docker secrets friendly), e.g.
`VX_SESSION_SECRET_FILE=/run/secrets/vx_session_secret`.

## Variables

| Variable                   | Default                            | Description                                                                                                                                                                                             |
| -------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VX_PORT`                  | `8383`                             | HTTP port.                                                                                                                                                                                              |
| `VX_HOST`                  | `127.0.0.1` (image sets `0.0.0.0`) | Bind address.                                                                                                                                                                                           |
| `VX_DATA_DIR`              | `./data` (image: `/data`)          | SQLite + derived indexes. Local disk only.                                                                                                                                                              |
| `VX_CACHE_DIR`             | `./cache` (image: `/cache`)        | Covers, transcripts. Reproducible.                                                                                                                                                                      |
| `VX_MODELS_DIR`            | `./models` (image: `/models`)      | Optional speech model packs.                                                                                                                                                                            |
| `VX_EBOOK_DIRS`            | —                                  | Comma-separated ebook roots (mounted `:ro`). Optional: when unset, the setup wizard / Settings → Libraries store the roots in the database.                                                             |
| `VX_AUDIOBOOK_DIRS`        | —                                  | Comma-separated audiobook roots (mounted `:ro`). Optional, as above.                                                                                                                                    |
| `VX_SESSION_SECRET`        | auto-generated                     | HMAC key for session tokens. Set explicitly in production; rotating it signs everyone out. If unset, one is generated and persisted at `<data>/session-secret` (0600).                                  |
| `VX_SETUP_TOKEN`           | auto-generated                     | One-time first-run bootstrap token required to create the admin account. If unset, generated on first start, printed in the log, stored at `<data>/setup-token` (0600). Consumed when the admin exists. |
| `VX_TRUST_PROXY`           | `0`                                | Proxy trust for client IPs. `0` (default): forwarded headers ignored. `1`: trust local/private-network proxies. Otherwise: comma-separated proxy IPs/CIDRs.                                             |
| `VX_TRUST_HTTPS`           | `0`                                | Set `1` behind HTTPS: marks session cookies `Secure`.                                                                                                                                                   |
| `VX_SESSION_DAYS`          | `30`                               | Session lifetime.                                                                                                                                                                                       |
| `VX_INLINE_WORKER`         | `1`                                | Run background jobs in the web process. Set `0` when using the dedicated worker container.                                                                                                              |
| `VX_JOB_CONCURRENCY`       | `2`                                | Max simultaneous background jobs (1–8).                                                                                                                                                                 |
| `VX_TRANSCRIBE_PROVIDER`   | `none`                             | `none`, `fixture` (sidecar transcripts), or `whisper-cli` (experimental). See docs/alignment.md.                                                                                                        |
| `VX_WHISPER_BIN`           | —                                  | Path to a whisper.cpp-compatible binary (whisper-cli provider).                                                                                                                                         |
| `VX_WHISPER_MODEL`         | —                                  | Optional custom model path, used only when no catalog model is installed for a language (Settings → Speech models manages the catalog).                                                                 |
| `VX_DEFAULT_LANGUAGE`      | `en`                               | BCP-47 language used when book metadata has none.                                                                                                                                                       |
| `VX_PROXY_AUTH_HEADER`     | —                                  | Reverse-proxy SSO: header carrying the signed-in username (e.g. `x-authentik-username`). Empty = disabled. See docs/security.md.                                                                        |
| `VX_PROXY_AUTH_SOURCES`    | —                                  | Comma-separated proxy IPs/CIDRs whose header is trusted (checked on the TCP peer). Required for proxy SSO.                                                                                              |
| `VX_PROXY_AUTH_ADMINS`     | —                                  | Comma-separated usernames (as sent by the proxy) that get the admin role. On an empty instance the first proxied user is admin regardless.                                                              |
| `VX_SCAN_INTERVAL_MINUTES` | `60`                               | Minutes between automatic library rescans so titles added in Calibre/Audiobookshelf appear on their own; `0` disables (manual/API rescans only).                                                        |
| `VX_LOG_LEVEL`             | `info`                             | fatal/error/warn/info/debug/trace.                                                                                                                                                                      |
| `PUID` / `PGID` / `TZ`     | `1000`/`1000`/`Etc/UTC`            | Container user mapping and timezone (entrypoint).                                                                                                                                                       |

## In-app settings (Settings page)

`defaultLanguage`, `transcribeProvider`, `whisperBin`, `whisperModel`,
`jobConcurrency`, `ebookDirs`, `audiobookDirs` (all env-pinnable), plus
`languageModels` / `autoDownloadDefaultModel` (Settings → Speech models),
`autoPairThreshold` (default 0.92 — candidates below it always require
manual review) and `storageBudgetMb` (reserved for future server-side
caches).

## First run

With no accounts yet, the app shows a six-step wizard: bootstrap token →
admin account → library folders (each folder is tested for existence,
readability and a shallow count of EPUB/audio files, with a folder picker
that lists what the server can see) → default narration language → review →
initialising, which shows the first scan's live progress. Folders pinned by
`VX_EBOOK_DIRS` / `VX_AUDIOBOOK_DIRS` are shown read-only in the wizard.
Everything chosen there is editable later under Settings.
