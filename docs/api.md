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
| POST   | `/api/pairs/:id/align`  | curator; forces the full transcription regardless of `processingMode`          |
| POST   | `/api/pairs/align-many` | curator; `{pairIds: []}` — the "Start all" / multi-select action               |
| GET    | `/api/pairs`            | also returns `summary`: pending pairs, pending audio, measured speed, estimate |

## Jobs & settings

| Method  | Path                              | Notes                                                                                 |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| GET     | `/api/jobs`                       | recent background jobs, with `subject` (pair/book/model) and live `progress`/`detail` |
| POST    | `/api/jobs/:id/cancel` \| `retry` | admin or curator                                                                      |
| GET/PUT | `/api/settings`                   | env-pinned keys are read-only                                                         |
