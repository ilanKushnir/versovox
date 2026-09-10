# Contributing

Versovox is AGPL-3.0-or-later. By contributing you agree your work is
licensed the same way.

## Repo layout

```
shared/   @versovox/shared — canonical contracts (locators, progress
          events + reconciliation, alignment types, API DTOs; zod schemas)
server/   @versovox/server — Fastify API + background worker
  src/epub        EPUB parse / sanitize / derived-index extraction
  src/scanner     read-only library scans
  src/audio       ffprobe wrappers, streaming
  src/pairing     candidate scoring
  src/alignment   monotonic aligner + switch resolution
  src/transcription  provider seam (fixture / whisper-cli)
  src/jobs        SQLite job queue + handlers + worker loop
  src/progress    append-only progress pipeline
  src/api         routes, guards (auth/CSRF), app assembly
web/      @versovox/web — React PWA (reader, player, library, pairing,
          settings, offline downloads, sw.js)
fixtures/ committed sample library (original stories, synthetic narration)
scripts/  fixture/icon generators, browser QA sweep
docker/   entrypoint
docs/     you are here
```

## Development

Requirements: Node ≥ 22.5 (for stable `node:sqlite`), ffmpeg/ffprobe on
PATH. No other system deps; there are no native npm modules.

```bash
npm ci
npm run build            # shared + server + web

# Terminal 1: API + inline worker against the sample library
VX_EBOOK_DIRS=fixtures/library/ebooks \
VX_AUDIOBOOK_DIRS=fixtures/library/audiobooks \
VX_TRANSCRIBE_PROVIDER=fixture \
npm run dev

# Terminal 2: Vite dev server (proxies /api to :8383)
npm run dev:web          # http://localhost:5183
```

Production-style run: `npm run build` then `node server/dist/index.js`
(serves the built web app itself).

## Tests and checks

```bash
npm test                 # vitest: shared + server (incl. API integration)
npm run lint             # eslint
npm run format:check     # prettier
npm run typecheck
node scripts/qa-browser.mjs   # Playwright sweep against a running server
```

The integration suite boots the real Fastify app against `fixtures/` in a
temp data dir and exercises setup→scan→pairing→alignment→two-way switch,
plus security paths (CSRF, rate limits, traversal attempts).

## Regenerating bundled assets

- `npm run fixtures` — rebuilds the sample library (needs ffmpeg; speech via
  the `text2wav` espeak-ng WASM package).
- `npm run icons` — re-rasterizes PWA icons (needs Playwright chromium).

Both outputs are committed so users and CI never need these tools.

## Guidelines

- Contracts first: new client/server surface starts as a zod schema in
  `shared/`.
- The reconciliation, aligner, sanitizer, and path-containment modules are
  security/correctness-critical: changes there need tests in the same PR.
- Never write into library mounts; never add a required cloud dependency.
