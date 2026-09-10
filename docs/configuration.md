# Configuration

## Precedence

1. **Environment variables** (`TL_*`) — pin values in Compose; shown as
   read-only ("set by environment") in the admin UI.
2. **In-app admin settings** — stored in the database, editable in
   Settings; only for keys not pinned by env.
3. **Built-in defaults.**

Every `TL_*` variable also accepts a `TL_*_FILE` variant whose value is a
path to a file containing the secret (Docker secrets friendly), e.g.
`TL_SESSION_SECRET_FILE=/run/secrets/tl_session_secret`.

## Variables

| Variable                 | Default                            | Description                                                                                                                                                                                             |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TL_PORT`                | `8383`                             | HTTP port.                                                                                                                                                                                              |
| `TL_HOST`                | `127.0.0.1` (image sets `0.0.0.0`) | Bind address.                                                                                                                                                                                           |
| `TL_DATA_DIR`            | `./data` (image: `/data`)          | SQLite + derived indexes. Local disk only.                                                                                                                                                              |
| `TL_CACHE_DIR`           | `./cache` (image: `/cache`)        | Covers, transcripts. Reproducible.                                                                                                                                                                      |
| `TL_MODELS_DIR`          | `./models` (image: `/models`)      | Optional speech model packs.                                                                                                                                                                            |
| `TL_EBOOK_DIRS`          | —                                  | Comma-separated ebook roots (mounted `:ro`).                                                                                                                                                            |
| `TL_AUDIOBOOK_DIRS`      | —                                  | Comma-separated audiobook roots (mounted `:ro`).                                                                                                                                                        |
| `TL_SESSION_SECRET`      | auto-generated                     | HMAC key for session tokens. Set explicitly in production; rotating it signs everyone out. If unset, one is generated and persisted at `<data>/session-secret` (0600).                                  |
| `TL_SETUP_TOKEN`         | auto-generated                     | One-time first-run bootstrap token required to create the admin account. If unset, generated on first start, printed in the log, stored at `<data>/setup-token` (0600). Consumed when the admin exists. |
| `TL_TRUST_PROXY`         | `0`                                | Proxy trust for client IPs. `0` (default): forwarded headers ignored. `1`: trust local/private-network proxies. Otherwise: comma-separated proxy IPs/CIDRs.                                             |
| `TL_TRUST_HTTPS`         | `0`                                | Set `1` behind HTTPS: marks session cookies `Secure`.                                                                                                                                                   |
| `TL_SESSION_DAYS`        | `30`                               | Session lifetime.                                                                                                                                                                                       |
| `TL_INLINE_WORKER`       | `1`                                | Run background jobs in the web process. Set `0` when using the dedicated worker container.                                                                                                              |
| `TL_JOB_CONCURRENCY`     | `2`                                | Max simultaneous background jobs (1–8).                                                                                                                                                                 |
| `TL_TRANSCRIBE_PROVIDER` | `none`                             | `none`, `fixture` (sidecar transcripts), or `whisper-cli` (experimental). See docs/alignment.md.                                                                                                        |
| `TL_WHISPER_BIN`         | —                                  | Path to a whisper.cpp-compatible binary (whisper-cli provider).                                                                                                                                         |
| `TL_WHISPER_MODEL`       | —                                  | Path to its model file.                                                                                                                                                                                 |
| `TL_DEFAULT_LANGUAGE`    | `en`                               | BCP-47 language used when book metadata has none.                                                                                                                                                       |
| `TL_LOG_LEVEL`           | `info`                             | fatal/error/warn/info/debug/trace.                                                                                                                                                                      |
| `PUID` / `PGID` / `TZ`   | `1000`/`1000`/`Etc/UTC`            | Container user mapping and timezone (entrypoint).                                                                                                                                                       |

## In-app settings (Settings page)

`defaultLanguage`, `transcribeProvider`, `whisperBin`, `whisperModel`,
`jobConcurrency` (all env-pinnable), plus `autoPairThreshold` (default 0.92 —
candidates below it always require manual review) and `storageBudgetMb`
(reserved for future server-side caches).
