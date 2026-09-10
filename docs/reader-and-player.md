# Reader and player: features and honest limitations

## Ebook reader (EPUB)

TandemLeaf renders its own **derived index** of each EPUB: the server parses
the container/OPF/spine/TOC, sanitizes every chapter, and extracts a stable
sentence index (content-derived sentence IDs + character offsets) that
anchors progress, annotations, search, and alignment. The source file is
never modified.

Derived indexes are immutable versioned directories: each (re-)index
attempt extracts into its own directory and a single atomic database
pointer switch makes it active, so the book stays readable throughout a
re-index. Old versions are garbage-collected lazily — retired at the
switch and deleted only after a conservative grace period — so a request
that resolved the previous version just before the switch still reads it
successfully.

Implemented:

- Paginated (CSS multi-column with swipe/tap/keyboard page turns) and
  continuous-scroll modes.
- Table of contents (EPUB 3 nav with NCX fallback), in-book search with
  jump-to-result, book-position slider.
- Themes: Paper, Sepia, Night, High contrast — independent of the app theme.
- Typography: Literata (bundled, OFL) / system serif / sans, size, variable
  weight, line height, margins, ragged/justified, hyphenation toggle.
- Bookmarks, highlights, and notes on text selections, anchored to sentence
  IDs/character offsets (rendered with the CSS Custom Highlight API; on
  browsers without it the annotations still save and list, they just are not
  painted in the text).
- Progress with revision-checked sync, percent, page-within-chapter.
- RTL books (`page-progression-direction`), tested with the bundled Hebrew
  sample: mirrored pagination, RTL columns, direction-aware arrow keys.
- Hideable chrome, iPhone safe areas, reduced-motion support.
- Internal links navigate inside the book; external links open in a new tab
  with `rel=noopener`; images load from authenticated asset routes.

Known limitations (deliberate for V1, documented rather than half-built):

- **Publisher CSS is not applied.** Semantic structure (headings, emphasis,
  block quotes, tables, figures) is preserved and restyled by the reader's
  own typography. Heavily designed/fixed-layout EPUBs will look simplified.
- PDF, MOBI/AZW3, and comics are detected during scans but reported as
  unsupported instead of rendered badly.
- No dictionary/share popovers yet; no reading ruler.
- Sentence-range highlights spanning chapter boundaries are not supported.

## Audiobook player

- Formats: m4b, m4a, mp3, flac, ogg, opus are **detected**; playability is
  browser-specific and checked honestly per title (`canPlayType`). When a
  browser cannot decode a format (Safari/iOS lacks Ogg/Opus containers;
  some open-source Firefox/Chromium builds lack AAC for m4b/m4a), Listen is
  disabled with an explanation instead of failing after the player opens.
  Playback uses the browser's native decoder with HTTP Range streaming.
- Multi-file books play as one continuous timeline (absolute position across
  tracks), with automatic track advance.
- Chapters from embedded m4b/mp3 metadata, or one chapter per file for
  multi-file books; chapter sheet with jump.
- Scrubber with elapsed/remaining, −15s/+30s, play/pause, keyboard controls
  (space/j/k/l/arrows).
- Speed 0.75×–2× with pitch preserved (`preservesPitch`).
- Sleep timer: 15/30/45 minutes or end of chapter.
- Bookmarks at the current instant.
- Media Session integration (lock-screen metadata, play/pause/seek) where
  the platform supports it.
- Durable checkpoints: every heartbeat/pause/seek is written to IndexedDB
  before sync; a killed tab loses at most a few seconds and never regresses
  another device's explicit position (see docs/progress.md).

## Two-way switching

When a pair is aligned, the reader shows **Listen** and the player shows
**Read**. Switching resolves your position through the alignment graph and
reports its actual precision instead of a blanket "exact" claim:

- `sentence` granularity with `source: exact` only when the current sentence
  itself is verified at high confidence;
- `paragraph`/`approximate` when a nearby aligned sentence (within a bounded
  distance) is used instead;
- **refusal with surrounding anchors** when the position lies in an explicit
  alignment gap, past the drift bound, or too far from any verified
  sentence — the response then carries the nearest aligned points before and
  after, and the UI names them rather than silently jumping to an unrelated
  sentence.

Pair status shows the honest numbers: handoff availability plus the
percentage of sentences with sentence-exact coverage (the remainder is
approximate or unavailable). A temporary handoff marker is left after a
switch: a fading sentence highlight in the reader, a position tick on the
player scrubber. The switch is recorded as an explicit `switch` intent in
progress history.

## Offline packages

Per-title downloads verify every entry (byte size + SHA-256 from the
server's offline manifest) before caching, include every referenced derived
asset (illustrations), and only mark the package complete after everything
verified. Audio tracks download and store in bounded 8 MB chunks (no
whole-book buffering on iPhone) and are served offline with correct HTTP
Range (206/Content-Range) behavior. **Annotations are online-only in V1**:
creating bookmarks/highlights/notes needs the server and fails with an
honest message offline; existing annotations are not part of the offline
package. Logout removes offline copies (see docs/security.md).
