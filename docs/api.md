# HTTP API

All endpoints are same-origin JSON under `/api`, authenticated by session
cookie except where noted. Mutating requests require the `x-vx-csrf: 1`
header. Schemas are zod-validated; canonical types live in
`shared/src` (`@versovox/shared`). A role named below is a floor rather than
an exact match — roles rank reader, curator, admin, and anything a curator may
do an admin may do too.

## Auth & setup

| Method | Path                    | Notes                                                                                |
| ------ | ----------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/health`           | public; liveness — `{status, version, time}`                                         |
| GET    | `/api/setup/status`     | public; `{needsSetup, setupTokenSource, libraries, languages, defaultLanguage}`      |
| POST   | `/api/setup/verify`     | public until first user exists; rate limited; checks the bootstrap token             |
| POST   | `/api/setup/test-paths` | admin, or `x-vx-setup-token` header before setup; `{paths, kind?}` folder checks     |
| GET    | `/api/setup/browse`     | admin, or `x-vx-setup-token` header before setup; folder picker                      |
| POST   | `/api/setup`            | public until first user exists; creates admin (+ folders, language), starts the scan |
| POST   | `/api/auth/login`       | rate limited; `403 account-disabled` for disabled accounts                           |
| POST   | `/api/auth/logout`      |                                                                                      |
| GET    | `/api/auth/me`          | `{user, via, needsLibraries, librariesEnvPinned}`                                    |
| PATCH  | `/api/auth/me`          | own display name                                                                     |
| POST   | `/api/auth/password`    | own password (current + new); revokes other sessions                                 |

`libraries` in the status payload covers all three folder lists — `ebookDirs`,
`audiobookDirs` and `alignmentDirs` — each with a flag saying whether an
environment variable has pinned it, because the wizard shows a pinned folder
rather than offering to edit it. `test-paths` takes the same `kind` vocabulary:
an `alignment` folder is checked for writability as well as for readability,
by actually writing, since a bind mount can report the permission bits and
still refuse.

`GET /api/auth/me` answers one question the login response cannot: whether an
admin still has setup to finish. Behind reverse-proxy SSO the first account is
provisioned automatically and never sees the first-run screen, so
`needsLibraries` is how the client knows to resume the wizard at the Libraries
step.

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

| Method | Path                                  | Notes                                         |
| ------ | ------------------------------------- | --------------------------------------------- |
| GET    | `/api/library?query&kind&filter&sort` | `{books, continueRail, scanActive}`           |
| POST   | `/api/library/rescan`                 | admin                                         |
| GET    | `/api/library/roots`                  | admin; the configured read-only roots         |
| GET    | `/api/books/:id`                      | detail: chapters, tracks, pair, progress      |
| GET    | `/api/books/:id/cover`                | image                                         |
| GET    | `/api/books/:id/manifest`             | ebook derived manifest (spine/toc/pct math)   |
| GET    | `/api/books/:id/chapter/:idx`         | sanitized chapter HTML fragment               |
| GET    | `/api/books/:id/sentences/:idx`       | sentence index (ids + char offsets)           |
| GET    | `/api/books/:id/asset/*`              | sanitized-referenced images only              |
| GET    | `/api/books/:id/search?q`             | in-book text search                           |
| GET    | `/api/books/:id/track/:idx`           | audio stream, HTTP Range                      |
| GET    | `/api/books/:id/offline-manifest`     | URLs + sizes + integrity for the PWA download |
| GET    | `/api/books/:id/offline-switch`       | precomputed switch answers for that download  |

A book summary carries `pair`, and a pair carries both `switchable` and
`handoff`. They are not the same claim: `switchable` means a handoff is
available at all, while `handoff` reports the honest numbers behind it —
`coverage`, `meanConfidence` and `exactSentenceCoverage`. A client that shows
one without the other will over-promise.

The offline package is a list of URLs with sizes, and for audio a
`sourceVersion` plus a SHA-256 per 8 MiB chunk, so a download that silently
lost bytes is caught rather than cached. `offline-switch` is in that list
because a downloaded pair that can be read and listened to but not switched
between is missing the one thing owning both editions is for. It is a table of
precomputed answers rather than a copy of the alignment: for an audiobook it is
sampled on a five-second grid, and the client always takes the entry at or
before its position, so the rounding can only ever land the reader earlier in
the text — the same direction the resolver's own margin errs in.

## Progress & annotations

| Method       | Path                            | Notes                                                      |
| ------------ | ------------------------------- | ---------------------------------------------------------- |
| POST         | `/api/progress/events`          | idempotent batch; returns per-event ack + reconciled state |
| GET          | `/api/progress/:bookId`         | current state                                              |
| GET          | `/api/progress/:bookId/history` | recent events incl. rejected + reasons                     |
| GET          | `/api/annotations?q&kind`       | every mark this reader has made, across every book         |
| GET/POST     | `/api/books/:id/annotations`    | bookmarks/highlights/notes                                 |
| PATCH/DELETE | `/api/annotations/:annId`       | own marks only; `PATCH` takes `{note?, color?}`            |

A batch of progress events is a drained offline queue, not a form. Refusing all
two hundred because one is malformed would lose the other hundred and
ninety-nine and leave the client resending the same slice forever, so each bad
event comes back named and rejected instead — a durable verdict the client can
act on by dropping it.

`GET /api/annotations` exists separately from the per-book list because it
answers a different question: not "what did I mark in this book" but "where was
that thing I wrote down". So it joins the book in and returns `bookTitle` and
`bookAuthor` alongside each mark, orders newest first, and caps at 500. `q`
matches the note, the highlighted text or the book title; `kind` narrows to
`highlight`, `note` or `bookmark`. This is what the Notes & marks page reads.

A highlight's colour is a short lowercase word, not a hex value, so the reader
can restyle the palette without rewriting anyone's marks. `PATCH` is how a
colour is changed after the fact and how a note gets its text. Deletes are
soft: the row is tombstoned rather than removed.

## Pairing & alignment

| Method | Path                                             | Notes                                                       |
| ------ | ------------------------------------------------ | ----------------------------------------------------------- |
| GET    | `/api/pairs`                                     | `{pairs, summary}` — evidence, compat, handoff, last job    |
| GET    | `/api/pairs/:id` / `/api/pairs/:id/alignment`    | detail; per-minute confidence                               |
| POST   | `/api/pairs/link`                                | curator; manual link `{ebookId, audioId}`                   |
| POST   | `/api/pairs/:id/confirm` \| `reject` \| `unlink` | curator; decisions are durable                              |
| POST   | `/api/pairs/:id/language`                        | curator; `{language}` or `{language: null}` to clear        |
| POST   | `/api/pairs/:id/align`                           | curator; queue this pair → `{jobId, queued}`                |
| POST   | `/api/pairs/align-many`                          | curator; `{pairIds: []}` → `{queued, skipped}`              |
| POST   | `/api/pairs/:id/resolve`                         | `{from: Locator}` → `{to, resolution}` — the two-way switch |

Each pair reports its `language` as three values rather than one, because the
useful thing to show is not just the answer but where it came from: `override`
is what a curator set here, `detected` is what the alignment settled on, and
`effective` is the one that will actually be used, with `source` naming the
step that supplied it (`override`, `alignment`, `ebook-metadata`, `audio-tags`
or `unknown`). Posting to `/language` sets the override; posting `null` removes
it and lets detection speak again.

`/align` always sets `force`, because a person asking for a specific book
should get it even on a server configured to match and wait. Both it and
`align-many` are ordinary queued jobs, deduplicated per pair, so the same lane
and the same live progress apply; `queued: false` means one was already
waiting, not that anything failed.

`summary` on `GET /api/pairs` describes exactly what a "Start all" would queue —
linked pairs with no alignment and nothing already in the queue — as
`pendingPairs` and `pendingAudioMs`, with `candidatePairs` counting suggestions
still awaiting a decision. `speedRatio` is seconds of audio per second of wall
clock, measured from real runs on this machine; while it is `0` there has been
no run to measure and `estimatedMs` is `null` rather than a guess.

`/resolve` returns `{to: null}` with a `resolution` explaining why when the pair
has not been aligned yet, `409 not-linked` when the pair is a rejected or
unconfirmed suggestion, and `409 ebook-not-indexed` when the derived index is
missing. The resolution's `confidence` and `granularity` are what the reader
uses to decide how far to rewind before playing.

## Portable alignments

| Method | Path                     | Notes                                          |
| ------ | ------------------------ | ---------------------------------------------- |
| POST   | `/api/alignments/import` | admin; queues `import-alignments` → `{queued}` |
| POST   | `/api/alignments/export` | admin; queues `export-alignments` → `{queued}` |

Finished alignments live as files in a folder the operator mounts from their
own library, which is the only place Versovox writes. Both jobs run by
themselves — import after every scan, export when an alignment finishes — so
these two routes are for the operator who has just mounted another folder and
does not want to wait for the next scan. Both are deduplicated, so pressing the
button twice queues one job.

Where those files are, and whether they can be written, is reported by
`GET /api/settings` under `alignments`: `{dirs, writeDir, files, bytes,
problem}`. `writeDir` is the first folder that accepted a test write, and
`problem` is a sentence to show the operator when none of them did — alignments
then fall back to the data directory, so nothing is lost, but they stop being
portable until the mount is fixed.

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
actually loads on this CPU), `aligner-model`, `disk`, `writable`, `libraries`
and `alignments`. Two of them can only ever `warn`. A missing model is one:
everything else about the container is fine and the download is one click
away. An alignment folder that will not take a file is the other, and it is
the one people get wrong — every other library line in the stock compose file
ends in `:ro` — but a book still aligns without it, so the honest verdict is
that the timings will not survive the container, not that the container is
broken. `aligner`
summarises the catalog entry — id, label, `licence`, `note`, `sizeBytes` across
**all** its files, `installed`, live `download` state and `lastError`.

## The alignment model

| Method | Path                       | Notes                                                               |
| ------ | -------------------------- | ------------------------------------------------------------------- |
| GET    | `/api/models`              | `{modelsDir, alignerRuntime, models[], languages[]}`                |
| POST   | `/api/models/:id/download` | admin; queues a `model-download` job → `{queued, installed, jobId}` |
| DELETE | `/api/models/:id`          | admin; removes every artefact and any partial download              |

There is exactly one entry, `alignment-model`, and it covers every language:
it works on a romanized character stream rather than on words, so a Russian
audiobook costs it no more than an English one. The route keeps its plural
shape because the download machinery, the jobs list and the settings page all
want a list.

`alignerRuntime` is `{available, error?}` and answers a different question from
`installed`. The runtime is a native module, so a file on disk is not enough:
the settings page has to be able to tell "not downloaded" apart from
"downloaded, but this build cannot run it on this CPU".

`languages[]` is the shared language catalog (`code`, `label`, `native`). It
is not a list of things to download — the one model covers all of them — but
the set a client may offer as a default language or as a per-pair override,
and the set `POST /api/pairs/:id/language` validates against.

Each entry in `models[]` is the catalog's `ModelSpec`
(`server/src/alignment/model.ts` — `id`, `label`, `licence`, `url`, `file`,
`sizeBytes`, `extraFiles`, `note`) plus `installed`, `installedBytes`,
`download` (live job state or `null`) and `lastError`. `licence` is always
present and clients must display it before the download button: today's model
is `CC-BY-NC-4.0 (non-commercial)`.

**A model is a multi-file artefact.** `file` contains a subdirectory
(`mms-fa/model_int8.onnx`) and `extraFiles` carries the rest
(`mms-fa/vocab.json`, `mms-fa/config.json`). Consequences a client should know
about:

- `installed` is all-or-nothing: every file must exist and be at least 90% of
  its published size, so a truncated or partial download never reads as
  installed.
- The download job fetches the small companions first, then streams the large
  file to `<file>.part` with resumable HTTP Range and renames on completion —
  so a finished big file is never left without the metadata that makes it
  usable.
- `installedBytes` and `sizeBytes` describe the **primary file only**; the
  companions are kilobytes and are not counted. Preflight's `aligner.sizeBytes`
  counts all of them, which is why the two numbers differ slightly.
- `DELETE` removes every artefact and its `.part`, so nothing lingers on the
  volume after an uninstall.

`GET /api/models` also re-queues any alignment that was blocked on a
`model-missing` error, so a model dropped into `VX_MODELS_DIR` by hand or by
the `versovox-model` CLI unblocks work without a restart. That error is
structured (`model-missing:<id>|<message>`) and surfaces on a pair as
`lastAlignJob.modelMissing`, which is what lets the Pairing page offer a
download button instead of a red error.

## Jobs & settings

| Method  | Path                              | Notes                                                                                 |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| GET     | `/api/jobs`                       | recent background jobs, with `subject` (pair/book/model) and live `progress`/`detail` |
| POST    | `/api/jobs/:id/cancel` \| `retry` | curator                                                                               |
| GET/PUT | `/api/settings`                   | admin to write; env-pinned keys are read-only                                         |

`GET /api/settings` returns more than the settings, because the settings page
is also the dashboard: `settings`, `envPinned` (the keys an environment
variable has taken over), `stats` (library, pairing and queue counts in one
round trip), `paths` (`dataDir`, `cacheDir`, `modelsDir` and the folder lists),
the `alignments` summary described above, and a one-line `precedence` string
saying which layer wins.

There are eight settings: `defaultLanguage`, `jobConcurrency`, `ebookDirs`,
`audiobookDirs`, `alignmentDirs`, `alignPrecision` (`standard` or `exact`),
`autoAlign` and `alignSpeedRatio`. The first five can be pinned by environment
variables and then appear in `envPinned`; the other three exist only here.
Two of them are readable but not settable. `alignSpeedRatio` is written by the
worker from real runs, so a client that sends it is overwriting a measurement
with a guess; `jobConcurrency` is taken from `VX_JOB_CONCURRENCY` when the
worker starts and from nowhere else, so a value written here is stored and
never acted on. Both are in the schema because the settings page shows them.

`PUT` persists only the keys the request actually contained. This is not
politeness: `settingsSchema.partial()` still fills in every `.default()`, so a
request that changes one checkbox arrives at the handler carrying a full
settings object, and writing all of it would silently reset the library
folders. Send a patch, and expect `{settings, envPinned}` back.
