# Reader and player: features and honest limitations

## Ebook reader (EPUB)

ReadPort renders its own **derived index** of each EPUB: the server parses
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
- Bookmarks, highlights in five colours, and notes on text selections,
  anchored to sentence IDs/character offsets (rendered with the CSS Custom
  Highlight API; on browsers without it the annotations still save and list,
  they just are not painted in the text). How a mark is made, recoloured and
  found again has a section of its own below.
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
- The Notes & marks page returns the 500 most recent marks and does not page
  past them. A reader who has passed that will still find everything in the
  book it belongs to; only the cross-book view is truncated.

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
  configurable skip amounts (10, 15, 30, 45 or 60 s, set independently for
  each direction), play/pause, keyboard controls (space/j/k/l/arrows). The
  page takes an ambient tint from the cover.
- The skip buttons are drawn around their number rather than beside it: a ring
  with a gap at the top, an arrowhead on the end the arc travels towards so
  back and forward are exact mirrors, and the digits centred in the ring with
  no stroke crossing them. That last constraint is the reason for the shape.
  The transport draws these at 36 px, and a number sharing its space with the
  arrow's tail is simply not readable at that size; only a three-digit label
  shrinks to fit.
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

## Marks: bookmarks, highlights, notes

In the reader the ribbon button bookmarks the first sentence on the current
page (or the passage at the top of the viewport in scroll mode), keeping a
short excerpt; the button fills and a ribbon hangs from the top edge while a
bookmarked page is shown, and tapping again removes it. A caret is joined to
the ribbon as one pill, because the two jobs are adjacent but not the same:
the ribbon marks this page, the caret opens everything already marked in this
book. It leads to Contents on its **Bookmarks & notes** tab, which lists
bookmarks, highlights and notes in book order with chapter, position and
excerpt, each with jump and delete. The caret exists only once there is
something behind it, so an unmarked book shows the ribbon on its own.

Selecting text offers five highlight colours — amber, rose, plum, sky and
sand — as five swatches, and picking one _is_ the act of highlighting: there
is no Highlight button to press first, so highlighting in a chosen colour is
one tap, the same as highlighting at all. They are muted tints of the app's own
warm palette rather than the saturated yellows most readers reach for, on the
grounds that a highlight has to leave the text under it legible; the night and
dark reader themes carry their own values for the three that would otherwise
glow. The colour is stored on the annotation, so it is the same colour on
every device.

A note is drawn differently on purpose — a dashed underline in the accent
colour rather than a wash — because a note marks a place to come back to and
a highlight marks a passage worth re-reading, and the two have to be tellable
apart without being read.

Tapping a mark opens it, which is less trivial than it sounds. Marks are
painted with the CSS Custom Highlight API rather than by wrapping the text in
elements: the chapter's DOM comes from the book and must not be rewritten, and
a wrapper would shift the character offsets that everything else in the reader
is addressed by. The cost of that choice is that a highlight is paint, with
nothing under the finger to receive a click, so the hit test runs the other
way round — the point becomes a character offset and the reader asks which
mark covers it (`web/src/reader/marks.ts`). Where marks overlap the shortest
wins: a note written inside a long highlight is both the more specific target
and the one that cannot be reached any other way. A tap that lands on a mark
opens it instead of toggling the chrome, or a highlight would be unreachable
on a phone. The popover shows the quoted passage and the note, and offers the
swatches again so a highlight can be recoloured after the fact, Edit for a
note, and Remove for either; it closes on a page turn or a chapter change,
since it belongs to the mark and not to the page.

The **Notes & marks** page at `/notes` is the other half of the same problem.
The reader shows a book's own marks while you are inside it, which is no help
for the note you wrote six weeks ago in a book you have since finished. So
this page collects every mark from every book, grouped by book with the most
recently marked book first, filterable by kind and by highlight colour, and
searchable across the note, the quoted passage, the title and the author at
once; every entry opens its book at exactly the place it came from. The
filtering happens in the browser rather than on the server, because the whole
set is a few hundred rows at most and typing that filters instantly is the
entire point of a page like this.

Any deliberate jump (bookmark, chapter, search result, slider) that moves more
than a page away shows a **Back to where you were** pill naming the chapter you
left; it stays until used or dismissed.

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
creating bookmarks/highlights/notes needs the server, as does recolouring a
highlight or editing a note, and each fails with an honest message offline;
existing annotations are not part of the offline package. Logout removes
offline copies (see docs/security.md).
