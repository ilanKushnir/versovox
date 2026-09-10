# Product brief

## Product promise

Versovox is the beautiful self-hosted place to read ebooks and listen to audiobooks from existing libraries, with one unusual capability: when an ebook and audiobook are the same work and compatible editions, a reader can switch modes at the same sentence or paragraph.

## Non-negotiable boundaries

- Do not become another library manager, downloader, or indexer.
- Mount source ebook and audiobook libraries read-only by default.
- Coexist with Calibre-Web Automated, Calibre, Kavita, Audiobookshelf, Shelfmark, and plain filesystem libraries.
- Own only app state: users, settings, pair decisions, extracted text indexes, alignment data, offline manifests, progress events, bookmarks, highlights, and annotations.
- Never auto-pair uncertain editions. False negatives are safer than false positives.
- No cloud service or proprietary API is required for core operation.
- CPU-first; optional hardware acceleration and downloadable speech model packs.

## Core surfaces

1. Unified home/library view with ebooks, audiobooks, and clearly marked paired editions.
2. Ebook reader inspired by Apple Books: excellent typography, multiple themes, font family/size/weight/line-height/margins, paginated and continuous modes, table of contents, search, bookmarks, highlights, notes, progress, and RTL support.
3. Audiobook player: chapter navigation, speed, sleep timer, skip controls, bookmarks, CarPlay-friendly large controls, durable progress, and offline downloads.
4. Native-feeling installable PWA on iPhone Safari: standalone display, safe areas, proper icons/splash behavior, offline startup, local progress queue, and no browser chrome when launched from Home Screen.
5. Pairing review: high-confidence automatic candidates, explainable match evidence, manual link/unlink, edition-compatibility warning, and alignment confidence/coverage.
6. Mode switch: ebook location to audiobook timestamp and audiobook timestamp to ebook sentence, with a temporary visible handoff marker.
7. Settings and onboarding for mounted paths, rescans, model/language packs, compute limits, storage budgets, users, security, backups, and integrations.

## Progress correctness

Progress must be local-first and loss-resistant. Every checkpoint is written to IndexedDB before network sync and sent as an idempotent event with client ID, session ID, sequence, timestamp, locator, and explicit intent. Server state uses revision checks and an append-only event history. Automatic stale clients may not silently move a user backward; intentional seek/rewind is represented explicitly and remains valid. Resume logic reconciles acknowledged server state with newer unacknowledged local events.

## Pairing and alignment principles

- Candidate generation uses normalized title/author, identifiers, language, series, duration/page heuristics, cover similarity only as supporting evidence, and content fingerprints.
- Metadata alone can suggest a pair but must not authorize sentence-level switching.
- Extract ordered ebook text into stable chapter/paragraph/sentence anchors tied to EPUB CFI or equivalent source locators.
- Segment audiobook by embedded chapters/silence; transcribe once with word timestamps using a selected language/model pack.
- Normalize both streams and align monotonically with seeded exact/fuzzy phrase matches plus dynamic sequence alignment.
- Store timestamp ranges, ebook anchors, confidence, provenance, model/version, and gaps. Never infer across low-confidence or abridged/translation boundaries.
- Manual correction creates durable anchors and supports incremental realignment.

## Formats

First-class: EPUB and M4B/MP3/M4A. Architecture may detect PDF, MOBI/AZW3, FLAC/OGG, and multi-file audiobooks, but unsupported formats must be reported honestly rather than rendered poorly.

## Self-hosting contract

- Docker image and Docker Compose quick start.
- Explicit PUID/PGID, timezone, data/config/cache/model paths, read-only library mounts, health check, resource limits, reverse-proxy guidance, backup/restore, upgrades/migrations, and non-root runtime.
- SQLite default for simple single-host use if safe; optional PostgreSQL only if justified.
- Background worker with bounded concurrency for scans/transcription/alignment.
- No Docker socket mount.
- Configuration available through explicit environment variables and in-app admin settings, with documented precedence.

## Quality bar

The result must be a real runnable application, not static mock screens. It needs tests, demo/sample data that is legally redistributable or generated, responsive desktop/mobile behavior, accessible controls, keyboard navigation, reduced-motion support, clear empty/error/loading states, and visual QA at iPhone and desktop sizes.
