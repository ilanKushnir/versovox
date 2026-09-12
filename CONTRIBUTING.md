# Contributing

ReadPort is AGPL-3.0-or-later. By contributing you agree your work is
licensed the same way.

## Repo layout

```
shared/   @readport/shared — canonical contracts (locators, progress
          events + reconciliation, alignment types, the language list,
          API DTOs; zod schemas)
server/   @readport/server — Fastify API + background worker
  src/epub        EPUB parse / sanitize / derived-index extraction
  src/scanner     read-only library scans
  src/audio       ffprobe wrappers, offline-chunk integrity
  src/pairing     candidate scoring
  src/alignment   timing a book against its narration, and what follows:
    ctc/            the forced aligner — romanize, emissions, sparse
                    probing, anchors, and ngram-index, which indexes the
                    decoded side and streams the book past it so the book
                    is never truncated
    model.ts        the catalog: one entry, `alignment-model`
    detect-language.ts  the book's language, read off the book's own text
    timings.ts      the only place an AlignmentSegment is constructed
    service.ts      stored alignment versions, switch resolution
    portable.ts     the `.rpalign` file format
    library.ts      the alignment folder: export, import, fingerprint match
  src/jobs        SQLite job queue + handlers + worker loop
  src/progress    append-only progress pipeline
  src/api         routes, guards (auth/CSRF), app assembly
web/      @readport/web — React PWA (reader, player, library, pairing,
          notes and marks, settings, offline downloads, sw.js)
fixtures/ committed sample library (original stories, synthetic narration)
alignments/  empty and committed, so the stock compose file has somewhere
          to mount the alignment folder
design/   the logo geometry, and the marks generated from it
scripts/  fixture/icon generators, browser QA sweep
docker/   entrypoint, and the readport-model CLI that fetches the model
docs/     the reference docs; this file is the one at the repo root
```

## Development

Requirements: Node ≥ 22.5 (for `node:sqlite`; CI and the image run 26),
ffmpeg/ffprobe on PATH. There is one native dependency, `onnxruntime-node`,
and it ships prebuilt binaries for macOS, Linux and Windows inside the
package itself, so `npm ci` needs no compiler and nothing platform-specific.

```bash
npm ci
npm run build            # shared + server + web
```

The server workspace has a `dev` script that runs the TypeScript sources
directly, but on Node 22 it fails before it starts: type stripping does not
resolve a `.js` import specifier to the `.ts` file beside it, and that is how
every module in the server imports every other. The loop that does work is
tsc's own watcher with `node --watch` behind it:

```bash
# Terminal 1: recompile server + shared on change
npm run build --workspace @readport/server -- --watch

# Terminal 2: API + inline worker against the sample library
RP_EBOOK_DIRS=fixtures/library/ebooks \
RP_AUDIOBOOK_DIRS=fixtures/library/audiobooks \
RP_ALIGNMENT_DIRS=./alignments \
RP_SETUP_TOKEN=dev-setup-token \
node --watch server/dist/index.js

# Terminal 3: Vite dev server (proxies /api to :8383)
npm run dev:web          # http://localhost:5183
```

Database, cache and models default to `./data`, `./cache` and `./models`, all
gitignored; delete the first to start over from the first-run wizard.
`RP_SETUP_TOKEN` is what unlocks that wizard, and if you do not set one the
server generates one and prints it at startup. `RP_ALIGNMENT_DIRS` is the one
writable library root: point it at the committed `./alignments` folder and
you will see `.rpalign` files appear there as pairs finish, and get them
imported again on the next scan after you wipe the database.

Production-style run: `npm run build` then `node server/dist/index.js`
(serves the built web app itself).

Computing timings additionally needs the model — 317 MB into
`./models/mms-fa/`, from Settings → Alignment or copied in by hand
(docs/self-hosting.md). Everything else works without it: scanning, pairing,
the reader, the player, and the whole test suite, which stubs the acoustic
decode rather than downloading a model.

## Tests and checks

```bash
npm test                 # vitest across shared, server and web
npm run lint             # eslint
npm run format:check     # prettier
npm run typecheck
npm run qa               # Playwright sweep against a running server
```

CI runs the first four as format check, lint, tests, typecheck, and only then
builds. Tests come before the build on purpose: `npm test` has to pass from a
clean `npm ci`, building the shared workspace itself rather than inheriting a
`dist/` from an earlier step. The Playwright sweep is not part of CI — it wants
a running server — so it is on whoever changes the surfaces it walks.

The integration suite boots the real Fastify app against `fixtures/` in a temp
data dir and exercises setup→scan→pairing→alignment→two-way switch, plus
security paths (CSRF, rate limits, traversal attempts). The alignment it
switches against is a stored one, not a computed one. The aligner's own
decisions — romanization, anchoring, refusal, gaps, the handover to the timing
layer — are tested in `server/src/alignment/ctc/engine.test.ts` against a
synthetic character stream built from the book's own text, which is what makes
per-sentence millisecond assertions possible without the model.

## Regenerating bundled assets

- `npm run fixtures` — rebuilds the sample library (needs ffmpeg; speech via
  the `text2wav` espeak-ng WASM package).
- `npm run icons` — re-rasterizes the favicon and PWA icons from
  `design/logo/mark.mjs` (needs any installed Chrome or Chromium).

Both outputs are committed so users and CI never need these tools.

The fixture narration is espeak output, which makes it a fine correctness
fixture and a worthless acoustic one: an engine tuned against it is tuned
against espeak, not against a narrator. Claims about alignment quality come
from runs on real audiobooks, recorded in docs/alignment.md.

## Guidelines

- Contracts first: new client/server surface starts as a zod schema in
  `shared/`.
- The reconciliation, timing, sanitizer, and path-containment modules are
  security/correctness-critical: changes there need tests in the same PR.
- Exactly one library folder is written to, and only through
  `alignment/library.ts`. Everything else under a library root is read-only,
  and stays that way. Never add a required cloud dependency.
