# Product brief

## Product promise

ReadPort is the beautiful self-hosted place to read ebooks and listen to audiobooks from existing libraries, with one unusual capability: when an ebook and audiobook are the same work and compatible editions, a reader can switch modes at the same sentence or paragraph.

## Non-negotiable boundaries

- Do not become another library manager, downloader, or indexer.
- Mount source ebook and audiobook libraries read-only. Exactly one folder is mounted read-write — the alignment folder — and nothing but finished alignments is ever written into it.
- Coexist with Calibre-Web Automated, Calibre, Kavita, Audiobookshelf, Shelfmark, and plain filesystem libraries.
- Own only app state: users, settings, pair decisions, extracted text indexes, alignment data, offline manifests, progress events, bookmarks, highlights, and notes.
- An alignment belongs to the operator, not to the install that computed it. Hours of CPU must not be lost to a from-scratch redeploy, so a finished alignment is also written to the operator's own disk in a documented format they can read without us, and taken back after the next scan.
- Never auto-pair uncertain editions. False negatives are safer than false positives.
- No cloud service or proprietary API is required for core operation. The one model download is the only request that ever leaves the machine, and it is only made when someone asks for it.
- CPU-only, and one model for every language: no per-language packs, no accelerator path to maintain, and nothing for the operator to choose between.

## Core surfaces

1. Unified home/library view with ebooks, audiobooks, and clearly marked paired editions.
2. Ebook reader inspired by Apple Books: excellent typography, multiple themes, font family/size/weight/line-height/margins, paginated and continuous modes, table of contents, search, bookmarks, progress, and RTL support.
3. Marks worth keeping: highlights in five colours, the colour chosen in the same tap that makes the mark and changeable afterwards by tapping the highlight; notes drawn with a dashed underline, because an invisible mark is a lost one; and a Notes & marks page collecting every highlight, note and bookmark across every book, searchable across the note, the passage and the title at once. The reader's own panel only helps while you are in the book; the page is for what you wrote down six weeks ago.
4. Audiobook player: chapter navigation, speed, sleep timer, skip controls, bookmarks, CarPlay-friendly large controls, durable progress, and offline downloads.
5. Native-feeling installable PWA on iPhone Safari: standalone display, safe areas, proper icons/splash behavior, offline startup, local progress queue, and no browser chrome when launched from Home Screen.
6. Pairing review: high-confidence automatic candidates, explainable match evidence, manual link/unlink, edition-compatibility warning, alignment confidence/coverage, and what aligning this particular book will cost, shown beside the button that starts it.
7. Mode switch: ebook location to audiobook timestamp and audiobook timestamp to ebook sentence, with a temporary visible handoff marker. Reading to listening lands deliberately behind the reader, by however far the alignment admits it may be wrong: narration already read costs a few seconds, and a sentence not yet reached is a spoiler no precision elsewhere makes up for.
8. Settings and onboarding for mounted paths including the alignment folder, rescans, the alignment model, whether new matches align by themselves and how closely alignment listens, the language to assume, and the accounts, roles and invitations of the people who use it. A control the operator cannot meaningfully choose between is not a setting; it is a constant, and belongs in the code.
9. Shelves: a persistent list beside the library holding automatic shelves the server computes (reading now, finished, both formats, recently added), the reader's own named shelves, and an ordered reading list. Every one of them is per person — two people on one server share every book and no shelf. The list is a rail on a wide screen, a drawer on a tablet, and a bottom sheet plus a scrolling chip row on a phone, where moving between shelves should not cost a panel.

One shelf is per DEVICE rather than per person, and is named "On this device" so it never pretends otherwise. Downloaded titles live in one browser profile on one machine and are removed on sign-out, so the same account shows different contents on a phone and a laptop, the server cannot count them, and that shelf is the only one that still works with the server unreachable. Syncing download state to the server would fix the inconsistency by teaching the server what each person carries around; that is a different feature with real privacy consequences, not a bug fix.

## Progress correctness

Progress must be local-first and loss-resistant. Every checkpoint is written to IndexedDB before network sync and sent as an idempotent event with client ID, session ID, sequence, timestamp, locator, and explicit intent. Server state uses revision checks and an append-only event history. Automatic stale clients may not silently move a user backward; intentional seek/rewind is represented explicitly and remains valid. Resume logic reconciles acknowledged server state with newer unacknowledged local events.

## Pairing and alignment principles

- Candidate generation uses normalized title/author, identifiers, language, series, and a duration-against-length heuristic. Metadata alone can suggest a pair but must not authorize sentence-level switching.
- Extract ordered ebook text into stable chapter/paragraph/sentence anchors tied to EPUB CFI or equivalent source locators. Sentence ids are derived from the text itself, so two installs segmenting the same EPUB agree about which sentence is which — which is what makes an alignment portable at all.
- Do not transcribe. The words are already in the EPUB; only their timing is unknown. Segment the audiobook by its files and embedded chapters, run an acoustic model over the narration, and match its output against the book's own text.
- Anchor on evidence that cannot drift: agreements that occur exactly once on each side, ordered monotonically. Front matter, credits, chapter announcements and endnotes then produce no anchors rather than dragging the timeline off course.
- Never let an implementation limit silently become a claim about a book. A cap that truncates a long book, or a coverage figure that reports the fraction of audio sampled rather than the fraction of text narrated, is worse than no number at all.
- Store timestamp ranges, ebook anchors, confidence, per-segment uncertainty, provenance, model/version, and gaps. Claim sentence exactness only where the timing came from a real acoustic match, and never infer across low-confidence or abridged/translation boundaries.
- Alignments are portable: one self-contained file per aligned pair, matched back to a library by a fingerprint of the ebook's sentences and the audiobook's track durations rather than by path or id, and applied whole or not at all. A partial import would leave holes in the timeline and a coverage figure that lies about them.

## Formats

First-class: EPUB, and M4B/MP3/M4A/FLAC/OGG/Opus, single-file or multi-file. Architecture may detect PDF, MOBI/AZW3 and comic archives, but unsupported formats must be reported honestly rather than rendered poorly.

## Self-hosting contract

- Docker image and Docker Compose quick start.
- Explicit PUID/PGID, timezone, data/config/cache/model paths, read-only library mounts, one read-write alignment folder, health check, resource limits, reverse-proxy guidance, backup/restore, upgrades/migrations, and non-root runtime.
- SQLite default for simple single-host use if safe; optional PostgreSQL only if justified.
- Background worker with bounded concurrency for scans, indexing and alignment.
- No Docker socket mount.
- Configuration available through explicit environment variables and in-app admin settings, with documented precedence.

## Quality bar

The result must be a real runnable application, not static mock screens. It needs tests, demo/sample data that is legally redistributable or generated, responsive desktop/mobile behavior, accessible controls, keyboard navigation, reduced-motion support, clear empty/error/loading states, and visual QA at iPhone and desktop sizes.
