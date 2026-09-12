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
| `VX_MODELS_DIR`            | `./models` (image: `/models`)      | Alignment and speech models (the 317 MB forced aligner lives in `mms-fa/`). Reproducible: safe to delete and re-download.                                                                               |
| `VX_EBOOK_DIRS`            | —                                  | Comma-separated ebook roots (mounted `:ro`). Optional: when unset, the setup wizard / Settings → Libraries store the roots in the database.                                                             |
| `VX_AUDIOBOOK_DIRS`        | —                                  | Comma-separated audiobook roots (mounted `:ro`). Optional, as above.                                                                                                                                    |
| `VX_SESSION_SECRET`        | auto-generated                     | HMAC key for session tokens. Set explicitly in production; rotating it signs everyone out. If unset, one is generated and persisted at `<data>/session-secret` (0600).                                  |
| `VX_SETUP_TOKEN`           | auto-generated                     | One-time first-run bootstrap token required to create the admin account. If unset, generated on first start, printed in the log, stored at `<data>/setup-token` (0600). Consumed when the admin exists. |
| `VX_TRUST_PROXY`           | `0`                                | Proxy trust for client IPs. `0` (default): forwarded headers ignored. `1`: trust local/private-network proxies. Otherwise: comma-separated proxy IPs/CIDRs.                                             |
| `VX_TRUST_HTTPS`           | `0`                                | Set `1` behind HTTPS: marks session cookies `Secure`.                                                                                                                                                   |
| `VX_SESSION_DAYS`          | `30`                               | Session lifetime.                                                                                                                                                                                       |
| `VX_INLINE_WORKER`         | `1`                                | Run background jobs in the web process. Set `0` when using the dedicated worker container.                                                                                                              |
| `VX_JOB_CONCURRENCY`       | `2`                                | Simultaneous **alignments** (1–8). Two more slots are always free: one for model downloads, one for scans/indexing/pairing, so a multi-hour alignment never blocks the library.                         |
| `VX_TRANSCRIBE_PROVIDER`   | `none`                             | Which **speech recognition** provider is available: `none`, `fixture` (sidecar transcripts), or `whisper-cli` (experimental). Not the same thing as `alignEngine` — see below.                          |
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
`jobConcurrency`, `ebookDirs`, `audiobookDirs` (all env-pinnable),
`alignEngine` and `processingMode` (see below), plus
`languageModels` / `autoDownloadDefaultModel` (Settings → Speech models),
`autoPairThreshold` (default 0.92 — candidates below it always require
manual review) and `storageBudgetMb` (reserved for future server-side
caches).

## Which engine computes the timings

`alignEngine` (default `forced-align`) chooses how a pair's sentence timings
are produced. It has no `VX_*` variable — it lives in the database only, so
it is set in Settings (or through `PUT /api/settings`) and can be changed
without restarting the container. Full descriptions in docs/alignment.md.

| `alignEngine`            | Needs                                                                                                          | What runs                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `forced-align` (default) | the `mms-forced-aligner` model (317 MB, one download for all ten languages, **CC-BY-NC-4.0 — non-commercial**) | One CTC pass over the audio, matched against the ebook text. Roughly 2–3 hours for a six-hour book on a 4-CPU server. |
| `fixture`                | a sidecar transcript next to the audio                                                                         | The legacy token aligner over your own word timestamps.                                                               |
| `whisper-cli`            | a whisper.cpp binary plus a 1.6–3.1 GB model **per language**                                                  | Full transcription, then fuzzy matching. Slower; kept as a rescue path.                                               |
| `none`                   | —                                                                                                              | Nothing. Pairs can still link; switching stays unavailable.                                                           |

### How it interacts with `transcribeProvider`

The two settings answer different questions. `alignEngine` is _how the
timings are computed_; `transcribeProvider` is _which speech-recognition
provider exists_ — used by the language detector, by the sidecar-transcript
path, and by the legacy engine.

Three rules, all of them visible in `server/src/jobs/handlers.ts`:

1. **A sidecar transcript always wins.** With
   `VX_TRANSCRIBE_PROVIDER=fixture`, a pair with a sidecar is aligned from
   those word timestamps whatever `alignEngine` says. Real timestamps you
   produced yourself are exact and free; no acoustic model improves on them.
2. **`transcribeProvider=none` disables alignment entirely** — including
   forced alignment. Library scans queue no alignment jobs, and a manually
   started one fails with "Transcription is disabled". To run the forced
   aligner today, set `VX_TRANSCRIBE_PROVIDER=whisper-cli`; the bundled
   binary is already at `/usr/local/bin/whisper-cli`. This coupling is a
   leftover from the transcription-first design and is worth removing.
   **Install the forced aligner first.** `autoDownloadDefaultModel` (on by
   default) fetches the 1.6 GB multilingual whisper model on first start when
   the provider is `whisper-cli` and _no_ multilingual model is installed
   yet — and the aligner counts as one, so having it on disk already
   suppresses that download. Otherwise turn the setting off in
   Settings → Speech models.
3. **Language detection is a whisper job.** When neither a pair override, the
   EPUB's `dc:language`, nor the audio tags give a language, the detector
   runs on a short clip and needs `transcribeProvider=whisper-cli` plus any
   installed multilingual model. Without it the language falls back to
   `VX_DEFAULT_LANGUAGE`. For `whisper-cli` that picks the wrong model and
   the transcript is ruined; for `forced-align` the damage is bounded —
   script transliteration is keyed on the characters themselves, so only
   numbers, currency and abbreviations get spelled out in the wrong
   language, costing anchors around those and nowhere else. Setting the
   language on the pair is still the reliable fix.

## How much runs on its own

`processingMode` decides what a library scan may start without being asked.

| Mode               | Runs a pair's alignment on its own    |
| ------------------ | ------------------------------------- |
| `auto`             | yes, including the long stage         |
| `verify` (default) | yes up to the point below             |
| `manual`           | never — every pair is started by hand |

What `verify` means depends on the engine, because the two engines pay for
verification very differently:

- **`forced-align`** has no separate verification stage: the alignment _is_
  the edition check, so the job runs end to end. On the measured hardware
  that is wall clock of roughly 0.33–0.46× the audio duration — about two to
  three hours for a six-hour book — and a mismatched pair refuses early with
  almost no anchors found.
- **`whisper-cli`** transcribes two 90-second clips first, links the pair if
  their words are really in the ebook, and then stops and waits for you
  unless the mode is `auto`. The hours-long full transcription is the part
  being deferred: budget two to three hours of computing per _hour_ of audio.

Verified pairs are linked and usable for browsing either way. Start the
remaining work from the Pairing page, individually or with multi-select, or
use "Start all". Time estimates there come from `transcribeSpeedRatio`,
which the worker measures from its own runs rather than guessing — today
only from whisper runs, so on a `forced-align`-only server it stays at 0
("not measured yet") and the Pairing page shows no estimate.

## First run

With no accounts yet, the app shows an eight-step wizard: welcome (bootstrap
token) → admin account → library folders (each folder is tested for
existence, readability and a shallow count of EPUB/audio files, with a folder
picker that lists what the server can see) → default narration language →
alignment (the readiness report from `POST /api/preflight`, and the aligner
model download) → processing mode → review → ready, which shows the first
scan's live progress. Folders pinned by `VX_EBOOK_DIRS` /
`VX_AUDIOBOOK_DIRS` are shown read-only in the wizard. Everything chosen
there is editable later under Settings.
