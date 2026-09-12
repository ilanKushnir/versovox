<p align="center">
  <img src="design/logo/readport-tile.svg" alt="" width="88" height="88">
</p>

<h1 align="center">ReadPort</h1>

<p align="center">
  <strong>Read and listen in perfect tandem.</strong>
</p>

<p align="center">
  <a href="https://github.com/ilanKushnir/readport/actions/workflows/ci.yml"><img src="https://github.com/ilanKushnir/readport/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg" alt="License: AGPL-3.0-or-later"></a>
  <a href="https://github.com/ilanKushnir/readport/pkgs/container/readport"><img src="https://img.shields.io/badge/ghcr.io-readport-black.svg" alt="Container image"></a>
</p>

ReadPort is a self-hosted, open-source (AGPL-3.0) reading layer for the
libraries you already have. It mounts your existing ebook and audiobook
folders **read-only** and gives you a calm, installable app with a serious
EPUB reader, a resilient audiobook player, conservative edition pairing, and
— where alignment allows — **sentence-level switching between reading and
listening**.

It deliberately is _not_ another library manager. Calibre / Calibre-Web
Automated, Kavita, Audiobookshelf, and Shelfmark keep doing what they do;
ReadPort coexists with all of them (or with plain folders) and owns only
its own state: derived reading indexes, pair decisions, alignment data,
progress, annotations, and offline packages. (Synchronized text+audio
production itself isn't new — Storyteller pioneered self-hosted alignment
with EPUB Media Overlays; ReadPort's angle is being a **non-destructive
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
  RTL support (declared or inferred from the language), calm hideable
  chrome. Publisher CSS is intentionally not applied in V1 (see
  docs/reader-and-player.md for exact limitations).
- **Marks you can find again**: highlights in five colours, picked as you
  make one and changed afterwards by tapping the highlight; notes carried by
  a dashed underline rather than being invisible; bookmarks; and a **Notes &
  marks** page at `/notes` that collects every mark across every book and
  searches the note, the quoted passage, the title and the author at once.
- **Audiobook player**: chapters (embedded or per-file) with prev/next,
  scrubber with chapter ticks and time-left-in-chapter, configurable skips,
  0.5–3× speed with pitch preserved (remembered per book), sleep timer,
  bookmarks, lock-screen Media Session with live position, and an ambient
  tint taken from the cover.
- **Pairing review**: explainable evidence (title/author/identifiers/
  language/length/content overlap), manual link/unlink, alignment coverage
  and per-minute confidence. Metadata alone never links two editions — a
  strong match waits until the narration itself has been checked against the
  text, and a pair that fails that check is handed back undecided rather
  than aligned wrongly.
- **Read along**: the narration playing over the page you are reading, with
  the spoken sentence washed as it is read and the page turning itself to keep
  up. Tap any line to move the voice to it. Turning a page by hand hands the
  wheel back to you, and the page follows again by itself once the voice
  catches up to where you went — looking ahead costs nothing and needs no
  undoing. Where the alignment has nothing to say the wash is dropped and the
  bar says so, rather than guessing.
- **Two-way switching** on aligned pairs: reader ⇄ player at the same
  sentence — from inside the reader/player, from the book page, and from
  the library's "Listen/Read instead" — with a temporary handoff marker,
  degrading honestly (sentence → paragraph → refusal with a reason).
  Reading-to-listening deliberately lands _behind_ you, by however far the
  alignment admits it might be wrong: hearing a sentence twice is a
  nuisance, hearing one you have not reached is a spoiler.
- **Alignment by forced alignment, not transcription**: the words are
  already in the EPUB, so ReadPort does not try to discover them. One CTC
  acoustic model (317 MB, one download, every language) is run over the
  narration, greedy-decoded into romanized characters with 20 ms timestamps,
  and matched against the book's own characters. There is one engine and one
  model; nothing to choose between. On the target server for this project (a
  6-CPU LXC, `RP_ALIGN_THREADS=4`) the default `standard` precision puts
  about 7% of the audio through the model and timed a 67-minute book in 72
  seconds and a 36.7-hour one in 28.6 minutes — roughly six minutes for a
  six-hour audiobook. `exact` decodes every sample, takes some fifteen times
  as long, and on everything measured so far is no more accurate at the
  sentence level. The method, the numbers and the failure modes are in
  [docs/alignment.md](docs/alignment.md).
- **Alignments are files, and they outlive the container**: every finished
  alignment is written into an alignment folder you mount from your own
  library, as one gzipped JSON document per pair (`.rpalign`, readable with
  `gunzip`). It is the **only** folder ReadPort writes to. Files are matched
  back to books by a fingerprint of the ebook's sentences and the
  audiobook's track lengths — never by path or filename — so a from-scratch
  reinstall imports whatever it recognises after its first scan, and imports
  each file whole or not at all.
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
- **No cloud required**: nothing leaves the machine, and no model is
  bundled. The one download is Meta's MMS forced aligner, **CC-BY-NC-4.0
  (non-commercial)** — the only non-permissive thing here, and never fetched
  behind your back: the setup wizard offers it, Settings → Alignment has it
  with a progress bar, and `readport-model install` gets it on a server with
  no browser attached. What language a book is in is read from the book
  itself — its script, then its function words — so nothing is downloaded to
  answer that either.
- **Plays well with your reverse proxy**: optional header-based single
  sign-on from Authentik / Authelia / oauth2-proxy, trusted only from the
  proxy's own address (docs/security.md).
- **A household, not a single login**: a first-run wizard tests your library
  folders and creates the admin; after that you add people or send one-time
  invite links, with three roles (admin, curator, reader) and per-person
  progress, bookmarks and downloads. No open sign-up.

## What it needs

Docker, your existing library folders, and enough CPU to be patient with.
The image carries ffmpeg and the alignment runtime; the stock compose file
caps the app at 1 GB of memory and the optional dedicated worker at 2 GB.
Alignment is the only heavy thing here: give it as many threads as the
container really has (`RP_ALIGN_THREADS`, default 4) and 317 MB of disk for
the model. Reading and listening need none of that — a library with no model
installed still scans, reads, plays and pairs.

## Quick start

```bash
cp .env.example .env    # set RP_SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build
# open http://localhost:8383 — the setup wizard asks for the one-time token
# printed in the log, creates the admin, and tests your library folders
```

The wizard asks for three things: where your EPUBs are, where your
audiobooks are, and where alignments may be written. The third is the one
worth a thought — point it at a folder in your library and your alignments
survive a rebuild; leave it empty and they live in the app's data volume,
which a discarded volume takes with it. It also offers the 317 MB model
download, and shows the server's own check of ffmpeg, free space, folder
permissions and the alignment runtime before anything is saved.

The stock compose file mounts a bundled sample library — original short
stories with synthetic narration — so the reader, player and pairing review
are usable within a minute of starting; the samples align like any other
book once the model is here. Point the mounts at your real folders when
ready, and note that `./alignments` is mounted read-write on purpose while
the library mounts are `:ro`. Full guide:
[docs/self-hosting.md](docs/self-hosting.md) (reverse proxy/HTTPS for PWA
install, backups, upgrades, PUID/PGID, troubleshooting).

## From source

Node ≥ 22.5 and ffmpeg:

```bash
npm ci && npm run build
RP_EBOOK_DIRS=fixtures/library/ebooks \
RP_AUDIOBOOK_DIRS=fixtures/library/audiobooks \
RP_ALIGNMENT_DIRS=./alignments \
node server/dist/index.js
```

Alignment additionally wants the model in `RP_MODELS_DIR` (`./models` by
default); download it from Settings → Alignment once the server is up.

## Documentation

|                                                                                                       |                                                          |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [Self-hosting](docs/self-hosting.md)                                                                  | Compose, volumes, HTTPS/PWA, backup/restore, upgrades    |
| [Configuration](docs/configuration.md)                                                                | Every env var, precedence, secret files                  |
| [Security model](docs/security.md)                                                                    | Auth, CSRF, sanitization, containment, container posture |
| [Pairing & alignment](docs/alignment.md)                                                              | The three gates, forced alignment, failure modes         |
| [Reader & player](docs/reader-and-player.md)                                                          | Features and honest limitations                          |
| [Progress durability](docs/progress.md)                                                               | The event model and reconciliation rules                 |
| [HTTP API](docs/api.md)                                                                               | Endpoint reference                                       |
| [Contributing](CONTRIBUTING.md)                                                                       | Dev setup, tests, repo layout                            |
| [Product brief](docs/product-brief.md) · [Research & architecture](docs/research-and-architecture.md) | Why it is built this way                                 |

## Status

V1 foundation: the surfaces above are implemented, tested (unit +
integration + browser QA), and runnable today. Forced alignment has been
validated end to end on full-length, human-narrated audiobooks in English
and Russian — not on a corpus, and not across every language the romanizer
knows — so treat the numbers as evidence that the approach works rather than
as a guarantee for your library. [docs/alignment.md](docs/alignment.md) says
exactly where each line is.

## License

[AGPL-3.0-or-later](LICENSE). Bundled Literata font © The Literata Project
Authors, SIL OFL 1.1 (`web/public/fonts/OFL.txt`). Sample stories and
artwork are original works of this repository.
