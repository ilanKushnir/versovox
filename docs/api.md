# HTTP API

All endpoints are same-origin JSON under `/api`, authenticated by session
cookie except where noted. Mutating requests require the `x-vx-csrf: 1`
header. Schemas are zod-validated; canonical types live in
`shared/src` (`@versovox/shared`).

## Auth & setup

| Method | Path                    | Notes                                                                                |
| ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/health`           | public; liveness                                                                     |
| GET    | `/api/setup/status`     | public; `{needsSetup, libraries, languages}` (wizard prefill)                        |
| POST   | `/api/setup/verify`     | public until first user exists; checks the bootstrap token                           |
| POST   | `/api/setup/test-paths` | admin, or `x-vx-setup-token` header before setup; folder checks                      |
| GET    | `/api/setup/browse`     | admin, or `x-vx-setup-token` header before setup; folder picker                      |
| POST   | `/api/setup`            | public until first user exists; creates admin (+ roots, language), starts first scan |
| POST   | `/api/auth/login`       | rate limited; `403 account-disabled` for disabled accounts                           |
| POST   | `/api/auth/logout`      |                                                                                      |
| GET    | `/api/auth/me`          | `{user: {id, username, role, displayName}, via}`                                     |
| PATCH  | `/api/auth/me`          | own display name                                                                     |
| POST   | `/api/auth/password`    | own password (current + new); revokes other sessions                                 |

## People (admin)

| Method | Path                                 | Notes                                                               |
| ------ | ------------------------------------ | ------------------------------------------------------------------- |
| GET    | `/api/users`                         | accounts + pending invites                                          |
| POST   | `/api/users`                         | `{username, password, role, displayName?}`                          |
| PATCH  | `/api/users/:id`                     | `{role?, status?, displayName?, password?}`; last-admin/self guards |
| POST   | `/api/users/:id/sign-out-everywhere` |                                                                     |
| DELETE | `/api/users/:id`                     | removes the account and its personal data                           |
| POST   | `/api/invites`                       | `{role, displayName?, username?, expiresInDays}` → one-time link    |
| DELETE | `/api/invites/:id`                   | revoke                                                              |
| GET    | `/api/invites/:token`                | public, rate limited; what the link offers                          |
| POST   | `/api/invites/:token/accept`         | public; `{username, password, displayName?}` → account + session    |

## Library & books

| Method | Path                                  | Notes                                       |
| ------ | ------------------------------------- | ------------------------------------------- |
| GET    | `/api/library?query&kind&filter&sort` | books + continue rail + scan state          |
| POST   | `/api/library/rescan`                 | admin                                       |
| GET    | `/api/library/roots`                  | configured read-only roots                  |
| GET    | `/api/books/:id`                      | detail: chapters, tracks, pair, progress    |
| GET    | `/api/books/:id/cover`                | image                                       |
| GET    | `/api/books/:id/manifest`             | ebook derived manifest (spine/toc/pct math) |
| GET    | `/api/books/:id/chapter/:idx`         | sanitized chapter HTML fragment             |
| GET    | `/api/books/:id/sentences/:idx`       | sentence index (ids + char offsets)         |
| GET    | `/api/books/:id/asset/*`              | sanitized-referenced images only            |
| GET    | `/api/books/:id/search?q`             | in-book text search                         |
| GET    | `/api/books/:id/track/:idx`           | audio stream, HTTP Range                    |
| GET    | `/api/books/:id/offline-manifest`     | URLs+sizes for the PWA download             |

## Progress & annotations

| Method       | Path                            | Notes                                                      |
| ------------ | ------------------------------- | ---------------------------------------------------------- |
| POST         | `/api/progress/events`          | idempotent batch; returns per-event ack + reconciled state |
| GET          | `/api/progress/:bookId`         | current state                                              |
| GET          | `/api/progress/:bookId/history` | recent events incl. rejected + reasons                     |
| GET/POST     | `/api/books/:id/annotations`    | bookmarks/highlights/notes                                 |
| PATCH/DELETE | `/api/annotations/:annId`       |                                                            |

## Pairing & alignment

| Method | Path                                             | Notes                                                       |
| ------ | ------------------------------------------------ | ----------------------------------------------------------- |
| GET    | `/api/pairs`                                     | with evidence, compat, alignment summary, switchable        |
| GET    | `/api/pairs/:id` / `/api/pairs/:id/alignment`    | detail; per-minute confidence                               |
| POST   | `/api/pairs/link`                                | manual link `{ebookId,audioId}`                             |
| POST   | `/api/pairs/:id/confirm` \| `reject` \| `unlink` | decisions are durable                                       |
| POST   | `/api/pairs/:id/align`                           | queue alignment                                             |
| POST   | `/api/pairs/:id/resolve`                         | `{from: Locator}` → `{to, resolution}` — the two-way switch |

## Processing

| Method | Path                    | Notes                                                                          |
| ------ | ----------------------- | ------------------------------------------------------------------------------ |
| POST   | `/api/pairs/:id/align`  | curator; runs the pair's full alignment regardless of `processingMode`         |
| POST   | `/api/pairs/align-many` | curator; `{pairIds: []}` — the "Start all" / multi-select action               |
| GET    | `/api/pairs`            | also returns `summary`: pending pairs, pending audio, measured speed, estimate |

## Preflight

| Method | Path             | Notes                                                                           |
| ------ | ---------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/preflight` | admin, or `x-vx-setup-token` before setup; "can this container actually align?" |

Read-only: it probes binaries with `-version`, stats directories and asks the
catalog what is on disk. Nothing is written, downloaded or enqueued. It is a
POST because the setup wizard checks the folders the operator is _about_ to
save, which are not in the settings yet and must not travel in a query
string; with no body it checks the roots the server would use today.
`GET /api/health` remains the machine-readable liveness probe.

The response is `{ok, checks[], modelsDir, aligner}`. Each check is
`{id, label, state: 'ok'|'warn'|'fail', detail, fix?}` with a concrete
`detail` (a version, a path, a byte count) and a `fix` whenever the state is
not `ok`. `ok` is true when no check failed — a `warn` does not sink it. The
checks are `audio-tools` (ffmpeg/ffprobe), `onnx-runtime` (the native module
actually loads on this CPU), `aligner-model`, `disk`, `writable`,
`libraries` and `whisper`. `aligner` summarises the forced-aligner catalog
entry — id, label, `licence`, `sizeBytes` across **all** its files,
`installed`, live `download` state and `lastError`.

## Speech models

| Method | Path                       | Notes                                                               |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/models`              | `{modelsDir, whisperAvailable, models[], languages[]}`              |
| POST   | `/api/models/:id/download` | admin; queues a `model-download` job → `{queued, installed, jobId}` |
| DELETE | `/api/models/:id`          | admin; removes the model file and any partial download              |

Each entry in `models[]` is the catalog's `ModelSpec`
(`server/src/transcription/models.ts`) plus `installed`, `installedBytes`,
`download` (live job state or `null`) and `lastError`. The spec grew three
fields when the forced aligner landed:

| Field        | Meaning                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`       | `'whisper-ggml'` (speech recognition: language detection, the legacy engine) or `'ctc-onnx'` (the forced aligner). Absent on older whisper entries, which are `whisper-ggml` by default. |
| `licence`    | Shown on the card **before** the download button. Only present where it is not permissive — today the aligner's `CC-BY-NC-4.0 (non-commercial)`. Clients must display it.                |
| `extraFiles` | `ModelFile[]` — companion artefacts (vocabularies, configs) beyond the primary `file`.                                                                                                   |

**A model is now a multi-file artefact.** `file` may contain a
subdirectory (`mms-fa/model_int8.onnx`), and `extraFiles` carries the rest
(`mms-fa/vocab.json`, `mms-fa/config.json`). Consequences a client should
know about:

- `installed` is all-or-nothing: every file must exist and be at least 90% of
  its published size, so a truncated or partial download never reads as
  installed.
- The download job fetches the small companions first, then streams the large
  file to `<file>.part` with resumable HTTP Range and renames on completion —
  so a finished big file is never left without the metadata that makes it
  usable.
- `installedBytes` and `sizeBytes` describe the **primary file only**; the
  companions are kilobytes and are not counted.
- `DELETE` removes the primary file (and its `.part`), which is enough to
  make `installed` false; the companion files are left behind.

`GET /api/models` also re-queues any alignment that was blocked on a
`model-missing` error, so a model dropped into `VX_MODELS_DIR` by hand or by
the `versovox-model` CLI unblocks work without a restart.

## Jobs & settings

| Method  | Path                              | Notes                                                                                 |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| GET     | `/api/jobs`                       | recent background jobs, with `subject` (pair/book/model) and live `progress`/`detail` |
| POST    | `/api/jobs/:id/cancel` \| `retry` | admin or curator                                                                      |
| GET/PUT | `/api/settings`                   | env-pinned keys are read-only; `alignEngine` has no env var and lives here only       |
