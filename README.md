# Versovox

**Read and listen in perfect tandem.**

Versovox is a self-hosted, open-source (AGPL-3.0) reading layer for the
libraries you already have. It mounts your existing ebook and audiobook
folders **read-only** and gives you a calm, installable app with a serious
EPUB reader, a resilient audiobook player, conservative edition pairing, and
— where alignment allows — **exact sentence-level switching between reading
and listening**.

It deliberately is _not_ another library manager. Calibre / Calibre-Web
Automated, Kavita, Audiobookshelf, and Shelfmark keep doing what they do;
Versovox coexists with all of them (or with plain folders) and owns only
its own state: derived reading indexes, pair decisions, alignment data,
progress, annotations, and offline packages. (Synchronized text+audio
production itself isn't new — Storyteller pioneered self-hosted alignment
with EPUB Media Overlays; Versovox's angle is being a **non-destructive
overlay** over unmodified existing libraries, with strict pairing review and
loss-resistant progress.)

## Highlights

- **Unified library** over read-only mounts: EPUB + m4b/mp3/m4a (flac/ogg/
  opus detected too), multi-file audiobooks, covers, search/filter/sort,
  continue rail, honest per-book scan states.
- **EPUB reader** in the Apple Books mould: paginated (two-page spreads on
  wide screens) & scroll modes, TOC with fragment/footnote links, in-book
  search, Auto/Paper/Sepia/Night/Contrast themes, page dimming, seven
  typefaces (bundled Literata plus system book faces), size stepper,
  weight/leading/margins/justify/hyphenation, "pages left in chapter",
  bookmarks/highlights/notes, RTL support (declared or inferred from the
  language), calm hideable chrome. Publisher CSS is intentionally not
  applied in V1 (see docs/reader-and-player.md for exact limitations).
- **Audiobook player**: chapters (embedded or per-file) with prev/next,
  scrubber with chapter ticks and time-left-in-chapter, configurable skips,
  0.5–3× speed with pitch preserved (remembered per book), sleep timer,
  bookmarks, lock-screen Media Session with live position, and an ambient
  tint taken from the cover.
- **Pairing review**: explainable evidence (title/author/identifiers/
  language/length/content overlap), automatic linking only above a
  conservative threshold, manual link/unlink, edition-mismatch warnings,
  alignment coverage & per-minute confidence.
- **Exact two-way switching** on aligned pairs: reader ⇄ player at the same
  sentence — from inside the reader/player, from the book page, and from
  the library's "Listen/Read instead" — with a temporary handoff marker,
  degrading honestly (sentence → paragraph → refusal with a reason).
- **Loss-resistant progress**: IndexedDB-first idempotent events, append-only
  server history with revisions, explicit-intent reconciliation — a stale
  background tab can never override your deliberate rewind.
- **Installable PWA**: offline app shell, explicit per-title downloads with
  real progress/size/removal, a Downloaded shelf that works with no
  network at all, offline reading & listening of downloaded titles, iPhone
  standalone polish (safe areas, status bar following the reader theme, no
  browser chrome).
- **Libraries refresh themselves**: periodic rescans (default hourly) pick
  up titles added through Calibre-Web Automated, Audiobookshelf, or plain
  folders; pairing waits for indexing to finish so nothing is missed.
- **No cloud required**: the image bundles whisper.cpp and a per-language
  speech-model catalog — one click in Settings downloads the best model for
  each of ten languages (Hebrew uses the ivrit.ai fine-tune), narration
  language is detected or set per pair, and a missing model turns into a
  download prompt instead of a silent failure. Sidecar word-timestamp
  transcripts work too — documented honestly in docs/alignment.md.
- **Plays well with your reverse proxy**: optional header-based single
  sign-on from Authentik / Authelia / oauth2-proxy, trusted only from the
  proxy's own address (docs/security.md).
- **A household, not a single login**: a first-run wizard tests your library
  folders and creates the admin; after that you add people or send one-time
  invite links, with three roles (admin, curator, reader) and per-person
  progress, bookmarks and downloads. No open sign-up.

## Quick start

```bash
cp .env.example .env    # set VX_SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build
# open http://localhost:8383 — the setup wizard asks for the one-time token
# printed in the log, creates the admin, and tests your library folders
```

The stock compose file mounts a bundled sample library — original short
stories with synthetic narration and a pre-aligned pair — so the reader,
player, pairing review, and sentence-exact switching are demonstrable
immediately. Point the mounts at your real folders when ready. Full guide:
[docs/self-hosting.md](docs/self-hosting.md) (reverse proxy/HTTPS for PWA
install, backups, upgrades, PUID/PGID, troubleshooting).

## From source

Node ≥ 22.5 and ffmpeg:

```bash
npm ci && npm run build
VX_EBOOK_DIRS=fixtures/library/ebooks \
VX_AUDIOBOOK_DIRS=fixtures/library/audiobooks \
VX_TRANSCRIBE_PROVIDER=fixture node server/dist/index.js
```

## Documentation

|                                                                                                       |                                                          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Self-hosting](docs/self-hosting.md)                                                                  | Compose, volumes, HTTPS/PWA, backup/restore, upgrades    |
| [Configuration](docs/configuration.md)                                                                | Every env var, precedence, secret files                  |
| [Security model](docs/security.md)                                                                    | Auth, CSRF, sanitization, containment, container posture |
| [Pairing & alignment](docs/alignment.md)                                                              | The three gates, providers, aligner, sample fixtures     |
| [Reader & player](docs/reader-and-player.md)                                                          | Features and honest limitations                          |
| [Progress durability](docs/progress.md)                                                               | The event model and reconciliation rules                 |
| [HTTP API](docs/api.md)                                                                               | Endpoint reference                                       |
| [Contributing](docs/contributing.md)                                                                  | Dev setup, tests, repo layout                            |
| [Product brief](docs/product-brief.md) · [Research & architecture](docs/research-and-architecture.md) | Why it is built this way                                 |

## Status

V1 foundation: the surfaces above are implemented, tested (unit +
integration + browser QA), and runnable today. Production-scale automatic
transcription of full-length audiobooks remains explicitly experimental —
see [docs/alignment.md](docs/alignment.md) for exactly where that line is.

## License

[AGPL-3.0-or-later](LICENSE). Bundled Literata font © The Literata Project
Authors, SIL OFL 1.1 (`web/public/fonts/OFL.txt`). Sample stories and
artwork are original works of this repository.
