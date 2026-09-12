# Reader and player: features and honest limitations

## Ebook reader (EPUB)

Versovox renders its own **derived index** of each EPUB: the server parses
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
  continuous-scroll modes. Pages are centred in a capped page box; on wide
  screens the paginated mode shows a **two-page spread** (Auto / One page /
  Two pages), and the scroll mode ends every chapter with a "Next chapter"
  control.
- Table of contents (EPUB 3 nav with NCX fallback, including sub-chapter
  fragment entries), footnote and internal fragment links, in-book search
  with jump-to-result, book-position slider, "N pages left in chapter".
- Progress indicator in three flavours (Reading settings → Progress bar): **Full**
  (slider, pages left, percentage), **Compact** (one thin line with a
  percentage, no chapter text), or **Hidden**. It tracks live in scroll mode
  as well as page mode.
- Themes: Auto (follows the system appearance), Paper, Sepia, Night, High
  contrast — independent of the app theme; the iPhone status bar follows the
  reader theme in standalone mode. A page-dimming slider (screen brightness
  without leaving the app) sits next to the text-size stepper.
- Typography: Literata (bundled, OFL), Iowan Old Style, Charter, Palatino,
  Georgia, Baskerville (system faces with fallbacks), system sans; size
  stepper, variable weight, line height, margins, ragged/justified,
  hyphenation toggle. The chapter is tagged with the book's language so
  hyphenation and RTL fallback are language-aware.
- Bookmarks, highlights, and notes on text selections, anchored to sentence
  IDs/character offsets (rendered with the CSS Custom Highlight API; on
  browsers without it the annotations still save and list, they just are not
  painted in the text).
- Progress with revision-checked sync, percent, page-within-chapter.
- RTL books (`page-progression-direction`, or inferred from a Hebrew /
  Arabic / Persian / Urdu language tag when the OPF declares no direction),
  tested with the bundled Hebrew sample: mirrored pagination, RTL columns,
  direction-aware arrow keys.
- Turning past the last page marks the book finished; a page turn after
  the tab regains focus re-claims progress for this device, and if another
  device has since read further a toast offers to jump there.
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
- Scrubber with chapter tick marks, elapsed/remaining, time left in the
  current chapter and a chapter progress line; previous/next chapter,
  configurable skip amounts (10–60 s each way), play/pause, keyboard
  controls (space/j/k/l/arrows). The page takes an ambient tint from the
  cover.
- Speed 0.5×–3× (fine slider plus presets) with pitch preserved
  (`preservesPitch`), remembered per book.
- Sleep timer: 15/30/45/60 minutes or end of chapter, extendable.
- Bookmarks: the ribbon button toggles a bookmark at the current instant
  (filled when the playhead is within 20 s of one); bookmarks appear as dots
  on the scrubber and in a sheet with jump and delete. Any jump of more than
  90 s (bookmark, chapter list, scrubber drag) leaves a **Back to m:ss** pill
  so the previous place is one tap away.
- The player is a fixed scene: it never scrolls, on iPad or anywhere else;
  the cover is the only element that gives way on short viewports.
- Media Session integration (lock-screen metadata, artwork, play/pause,
  seek, previous/next chapter, live position state) where the platform
  supports it.
- Durable checkpoints: every heartbeat/pause/seek is written to IndexedDB
  before sync; a killed tab loses at most a few seconds and never regresses
  another device's explicit position (see docs/progress.md).

## Bookmarks and getting back

In the reader the ribbon button bookmarks the first sentence on the current
page (or the passage at the top of the viewport in scroll mode), keeping a
short excerpt; the button fills and a ribbon hangs from the top edge while a
bookmarked page is shown, and tapping again removes it. Contents has a
**Bookmarks & notes** tab listing bookmarks, highlights and notes with
chapter, position and excerpt, each with jump and delete. Any deliberate jump
(bookmark, chapter, search result, slider) that moves more than a page away
shows a **Back to where you were** pill naming the chapter you left; it stays
until used or dismissed.

## Two-way switching

When a pair is aligned, the reader shows **Listen from here**, the player
shows **Read from here**, and the book page and library hero offer
**Listen/Read instead** — every one of them resolves your saved position
through the alignment graph, so opening the other edition lands at the
same place rather than at that edition's own last position. The precision
is reported honestly instead of a blanket "exact" claim:

- `sentence` granularity with `source: exact` only when the current sentence
  itself is verified at high confidence;
- `paragraph`/`approximate` when a nearby aligned sentence (within a bounded
  distance) is used instead;
- **refusal with surrounding anchors** when the position lies in an explicit
  alignment gap, past the drift bound, or too far from any verified
  sentence — the response then carries the nearest aligned points before and
  after, and the UI names them rather than silently jumping to an unrelated
  sentence.

Refusals are not rare edge cases and are not a defect. The default forced
aligner deliberately produces no timing where the narration and the text do
not both exist — a title page, a copyright notice, a spoken chapter
announcement, an index — so those regions are explicit gaps and the switch
says so instead of landing somewhere plausible but wrong. On the audiobook
the engine was validated against, 830 of 880 sentences had timings
(docs/alignment.md).

Pair status shows the honest numbers: handoff availability plus the
percentage of sentences with sentence-exact coverage (the remainder is
approximate or unavailable). A temporary handoff marker is left after a
switch: a fading sentence highlight in the reader, a position tick on the
player scrubber. The switch is recorded as an explicit `switch` intent in
progress history.

## Offline packages

Downloads start from the download icon on the book page, which first explains
what will be stored (size, offline behaviour, removal on sign-out) and asks
for confirmation; the same icon shows progress and later manages removal.
Per-title downloads verify every entry (byte size + SHA-256 from the
server's offline manifest) before caching, include every referenced derived
asset (illustrations), and only mark the package complete after everything
verified. With the server unreachable the library shows a **Downloaded**
shelf built entirely from local storage, so airplane mode starts from
something useful; the book detail JSON is served network-first so pairing
and progress state never freeze at download time. Audio tracks download and store in bounded 8 MB chunks (no
whole-book buffering on iPhone) and are served offline with correct HTTP
Range (206/Content-Range) behavior. **Annotations are online-only in V1**:
creating bookmarks/highlights/notes needs the server and fails with an
honest message offline; existing annotations are not part of the offline
package. Logout removes offline copies (see docs/security.md).
