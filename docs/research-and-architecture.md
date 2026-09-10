# Research and architecture

## Existing stack: what TandemLeaf should and should not own

| App                                                            | Existing responsibility                                                                                                             | Useful integration surface                                                                            | TandemLeaf boundary                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Calibre-Web Automated / Calibre                                | Ebook ingestion, conversion, metadata, shelves, OPDS, browser reading, send-to-device, library database                             | Read-only filesystem mount; OPDS as optional catalog source; Calibre metadata as an optional adapter  | Do not edit `metadata.db`, ingest, convert, rename, or reorganize files                                                                      |
| Kavita                                                         | Scanning and presenting EPUB/PDF/comics/manga, rich metadata, built-in readers, annotations, users, REST API, OPDS/OPDS-PS          | Optional REST/OPDS adapter; read-only library mount                                                   | Do not compete as a collection manager; TandemLeaf prioritizes prose reading, audio, offline PWA, and cross-medium sync                      |
| Audiobookshelf                                                 | Audiobook/podcast library management, metadata, chapter tools, playback sessions, per-user progress, native apps, offline listening | Optional official REST adapter for catalog/media; plain read-only audiobook mount remains first-class | Do not write ABS progress by default; TandemLeaf owns its own loss-resistant progress, with an opt-in bridge later                           |
| Shelfmark                                                      | Search/request/download hub using sources such as Prowlarr and download clients                                                     | Deep link or webhook later                                                                            | Do not download or index acquisition sources                                                                                                 |
| ebook2audiobook                                                | TTS conversion from ebooks to chaptered audio; optional voice/language models                                                       | Generated audiobook files can appear in an audiobook mount                                            | Do not duplicate TTS in the first product; alignment is for owned narrated audio, not voice generation                                       |
| Storyteller (direct competitor, not currently in Ilan's stack) | Imports/manages ebook+audiobook pairs, aligns them, produces EPUB 3 Media Overlays, mobile apps                                     | Treat EPUB 3 Media Overlays as an interoperability target and study its public algorithm              | Differentiate as a non-destructive overlay for existing libraries, stricter pairing review, resilient PWA progress, and reader/player polish |

The mounted-library contract must be explicit: source mounts default to `:ro`; the writable `/data`, `/cache`, and `/models` paths contain only TandemLeaf-owned state and derived artifacts. A direct filesystem adapter is mandatory. CWA/Calibre, Kavita, and Audiobookshelf adapters are optional conveniences, not required dependencies.

## Product wedge

TandemLeaf is not “another self-hosted library.” It is the **reading layer** missing from many self-hosted stacks:

- one elegant library surface for prose ebooks and audiobooks already managed elsewhere;
- an Apple-Books-quality ebook reader and a first-class audiobook player;
- installable iPhone PWA and explicit offline packages;
- conservative pair detection and transparent alignment confidence;
- exact read/listen handoff using stable text anchors and audio timestamps;
- durable local-first progress that cannot silently regress when devices reconnect;
- portable EPUB 3 Media Overlay export as a future standards-based escape hatch.

## Pairing pipeline

False pairings are more damaging than missed pairings. Pairing therefore has three gates.

### 1. Candidate generation

Normalize Unicode, punctuation, articles, edition markers, author names, series/volume, language, ISBN/ASIN and other identifiers. Generate candidates using weighted evidence:

- exact normalized identifiers;
- title + primary author;
- series and volume;
- language;
- publisher/year/edition;
- optional cover perceptual hash as supporting evidence only;
- ebook text fingerprint and audiobook transcript fingerprint once available.

### 2. Edition compatibility

Metadata can create a candidate but cannot approve sentence-level switching. Sample normalized phrases from the ebook and compare them with transcript windows from multiple regions. Detect common incompatibilities: abridged audio, translation mismatch, dramatization, foreword/afterword reordering, missing chapters, and anthology/omnibus differences.

- High confidence with broad content coverage: auto-link, but show evidence and allow unlink.
- Medium confidence: require user confirmation.
- Low confidence or contradictory identifiers/languages: do not pair.

### 3. Alignment readiness

A pair is “switchable” only after alignment coverage and confidence exceed configurable thresholds. Unsupported gaps remain explicit. Never interpolate across a large low-confidence region or claim exact switching where only chapter-level mapping exists.

## Alignment pipeline

### A. Stable ebook anchors

1. Parse the EPUB spine and retain the canonical reading order.
2. Extract visible text without flattening meaningful markup.
3. Segment into chapter, block/paragraph, sentence, and token layers using language-aware rules.
4. Give each sentence a stable content-derived ID and retain its source href plus EPUB CFI or equivalent DOM range.
5. Keep a normalized comparison string separate from the original rendered text.

### B. Incremental audio preparation

1. Read M4B chapters or ordered audio files; keep original absolute offsets.
2. Create restartable work units by embedded chapter and bounded silence/VAD segments, not arbitrary ten-second files.
3. Fingerprint source files. Cache every result by source hash + model/version + language + settings so rescans do not retranscribe unchanged audio.
4. Transcribe with a CPU-capable faster-whisper/whisper.cpp path and word timestamps. Offer optional WhisperX-style language-specific forced-alignment packs when supported and optional GPU acceleration.
5. Store original transcript, normalized tokens, word timing, confidence, and provenance.

Ten-second chunking alone is the wrong abstraction: it breaks words/context and produces boundary errors. VAD/chapter work units with overlap and deterministic stitching are safer.

### C. Monotonic sequence alignment

1. Find robust chapter/region seeds using distinctive multi-word shingles, approximate matching, and order constraints.
2. Use dynamic programming or a banded monotonic alignment between ebook tokens/sentences and timed transcript tokens.
3. Penalize skips, reordering, and implausible time slopes; allow narration-only and text-only gaps.
4. Derive sentence start/end from aligned timed words.
5. Compute per-sentence and per-region confidence from lexical similarity, timing continuity, seed support, and gap density.
6. Never map low-confidence sentences as exact. Fall back to paragraph/chapter, or refuse the switch with a clear reason.
7. User corrections add hard anchors; rerun only the affected bounded region.

This improves on a simple per-sentence fuzzy search because it preserves global order, makes edition drift visible, and avoids compounding local mistakes.

### D. Interoperability

Store a neutral internal alignment graph first. A future exporter can create sentence spans and SMIL overlays conforming to EPUB 3 Media Overlays. Do not mutate the mounted source EPUB; write an optional derived export under TandemLeaf data.

## Two-way handoff model

The canonical progress record contains both representations when alignment exists:

- `ebook`: publication hash, href, CFI/range, sentence ID, within-sentence token/ratio;
- `audio`: recording hash, track ID, absolute milliseconds;
- `alignment`: graph version, confidence, granularity and provenance;
- `event`: user, device, session, monotonic sequence, event ID, client/server times, intent.

Ebook → audio seeks to the aligned sentence start plus optional within-sentence interpolation only when word confidence permits. Audio → ebook opens the sentence anchor and paints a temporary handoff marker until the user scrolls, changes page, or resumes reading.

## Progress durability

A single mutable `currentTime` row is not enough.

1. Write each meaningful checkpoint to IndexedDB before network I/O.
2. Send idempotent events with a client-generated UUID and per-session sequence.
3. The server appends events transactionally and returns the accepted revision.
4. Reconciliation chooses the newest valid intent, not the greatest percentage. Explicit rewind/seek is valid; stale background heartbeats cannot override newer foreground intent.
5. Keep periodic checkpoints, lifecycle checkpoints (`pause`, `visibilitychange`, `pagehide`), and a final beacon only as one of several paths.
6. Resume from the newest acknowledged server event plus any newer unacknowledged local event.
7. Retain enough history for conflict repair and diagnostics, then compact safely.

## Reader requirements

- EPUB first; PDF is a later separate renderer, never a fake EPUB experience.
- Paginated and continuous vertical modes.
- Themes that preserve book semantics: light, paper/sepia, night, and high contrast.
- Font family, size, weight, line height, paragraph spacing, margins/column width, text alignment, hyphenation, and brightness-like dimming.
- Tap zones, swipe/page-turn animation, keyboard controls, table of contents, search, reading ruler optional, bookmarks, highlights, notes, definitions/share hooks, progress and time-left.
- Respect publisher styles selectively, sanitize content, sandbox book documents, and support RTL/bidirectional books.
- Calm chrome that disappears while reading; iPhone safe areas and no accidental browser-like framing in standalone mode.

## Audiobook player requirements

- Prominent cover and chapter context; large one-handed controls.
- Play/pause, ±15/30 seconds, chapter jump, scrubber with elapsed/remaining time, speed presets plus fine adjustment, sleep timer, bookmarks/notes, output/media-session metadata, and download state.
- Preserve-pitch playback, route changes, interruption handling, lock-screen Media Session controls where supported, and explicit errors when iOS limitations apply.
- Durable progress checkpoints independent of the browser's final unload event.

## Offline PWA

- `display: standalone`, icons and masks, theme/background colors, viewport-fit and safe-area CSS.
- App-shell precache; per-title offline package stored in IndexedDB/Cache Storage with size estimate, download progress, cancellation, integrity hashes, and removal. Audio tracks carry an immutable per-track source version plus one SHA-256 per 8 MiB chunk; every ranged response is verified (status, exact Content-Range, length, ETag = source version, chunk digest) before storage, resumes re-verify kept chunks and discard any downloaded under a different source version, and hashing is streaming/per-chunk — never one whole-file browser buffer.
- Ebook assets and selected audio tracks are explicit downloads. Never imply an entire large audiobook is offline when only streamed chunks are cached.
- Local auth/session behavior must be honest: already-downloaded books remain readable offline; privileged server actions wait for reconnect.
- Queue progress/highlight/bookmark mutations idempotently and reconcile on reconnect.

## Deployment shape

Prefer a small monorepo with a TypeScript web/API surface and an isolated Python alignment worker only where speech tooling requires Python. SQLite with WAL on a local writable volume is the simple default; do not place it on SMB/NFS. Make PostgreSQL an optional later adapter only if concurrent scale justifies it.

Compose should expose:

- `tandemleaf`: web + API, non-root, healthcheck;
- `worker`: bounded scan/transcription/alignment jobs, non-root, optional profile for GPU;
- named/local volumes for `/data`, `/cache`, `/models`;
- sample read-only mounts for `/library/ebooks` and `/library/audiobooks`;
- explicit environment/config file with precedence and secret-file support.

No Docker socket, no privileged container, no required cloud API, and no write access to source libraries.

## Delivery stages

### V1 foundation, required to be runnable now

- polished unified library using safe sample/demo data and filesystem scanning;
- working EPUB reader and audiobook player;
- PWA installability and offline package flow;
- pair candidate/review states and a deterministic alignment fixture demonstrating exact two-way switching;
- local-first idempotent progress API and tests;
- background-job architecture and honest transcription/model configuration even if production-scale transcription is behind an explicit experimental flag;
- Dockerfile, Compose, configuration, security and backup docs.

### V1.1 production alignment

- real ffmpeg chapter/VAD preprocessing;
- faster-whisper/whisper.cpp CPU path and downloadable packs;
- monotonic alignment, resumability, confidence heatmap and manual anchors;
- Hebrew and English validation corpora that are legally redistributable or generated.

### V1.2 ecosystem adapters

- Audiobookshelf REST adapter, Kavita REST/OPDS adapter, Calibre OPDS/metadata adapter;
- optional one-way import of catalog metadata and opt-in progress bridges;
- EPUB 3 Media Overlay export.

## Sources opened during research

- Calibre Content Server documentation: https://manual.calibre-ebook.com/server.html
- Calibre-Web Automated: https://github.com/crocodilestick/Calibre-Web-Automated
- Kavita product/API overview: https://www.kavitareader.com/
- Kavita OPDS guide: https://wiki.kavitareader.com/guides/features/opds/
- Audiobookshelf introduction: https://audiobookshelf.org/docs/documentation/introduction/
- Audiobookshelf API: https://api.audiobookshelf.org/
- Shelfmark: https://github.com/calibrain/shelfmark
- Storyteller: https://storyteller-platform.dev/
- Storyteller algorithm: https://storyteller-platform.dev/docs/the-algorithm
- EPUB 3 Media Overlays: https://www.w3.org/TR/epub-33/#sec-media-overlays
- WhisperX: https://github.com/m-bain/whisperX
- WhisperX paper: https://arxiv.org/abs/2303.00747
- Apple Books reader controls: https://support.apple.com/guide/ipad/read-books-ipadc8494b6b/ipados
