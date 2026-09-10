# HTTP API

All endpoints are same-origin JSON under `/api`, authenticated by session
cookie except where noted. Mutating requests require the `x-tl-csrf: 1`
header. Schemas are zod-validated; canonical types live in
`shared/src` (`@tandemleaf/shared`).

## Auth & setup

| Method | Path                | Notes                                                            |
| ------ | ------------------- | ---------------------------------------------------------------- |
| GET    | `/api/health`       | public; liveness                                                 |
| GET    | `/api/setup/status` | public; `{needsSetup}`                                           |
| POST   | `/api/setup`        | public until first user exists; creates admin, starts first scan |
| POST   | `/api/auth/login`   | rate limited                                                     |
| POST   | `/api/auth/logout`  |                                                                  |
| GET    | `/api/auth/me`      |                                                                  |

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

## Jobs & settings

| Method  | Path                              | Notes                         |
| ------- | --------------------------------- | ----------------------------- |
| GET     | `/api/jobs`                       | recent background jobs        |
| POST    | `/api/jobs/:id/cancel` \| `retry` | admin                         |
| GET/PUT | `/api/settings`                   | env-pinned keys are read-only |
