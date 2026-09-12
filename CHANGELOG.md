# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org);
while ReadPort is pre-1.0 a minor bump may still change a contract, and
anything that does is called out under **Upgrading**.

## 0.9.0 — 2026-09-13

The first public release. Everything before this was development under an
earlier working name and is not documented here.

### Reading and listening

- **EPUB reader**: paginated (two-page spreads on wide screens) and scroll
  modes, TOC with fragment and footnote links, in-book search, five themes,
  page dimming, seven typefaces, and full control over size, weight, leading,
  margins, justification and hyphenation. RTL is honoured when the book
  declares it and inferred from the language when it does not.
- **Audiobook player**: chapters from embedded metadata or per-file, a
  scrubber with chapter ticks, configurable skips, 0.5–3× with pitch
  preserved and remembered per book, a sleep timer, and a lock-screen Media
  Session that reports live position.
- **Read along**: the narration playing over the page you are reading. The
  spoken sentence is washed as it is read, the page turns itself to keep up,
  and tapping any line moves the voice to it. Turning a page by hand stops the
  page following; it starts again on its own once the voice reaches wherever
  you went.
- **Two-way switching** on aligned pairs, at the sentence: reader ⇄ player
  from either surface, from the book page, and from the library. Switching
  from reading to listening lands _behind_ you by however far the alignment
  admits it might be wrong, because hearing a sentence twice is a nuisance
  and hearing one you have not reached is a spoiler.

### Marks, shelves and lists

- Highlights in five colours, chosen as you make one and changed afterwards
  by tapping the highlight.
- Notes carried by a dashed underline in the text rather than being invisible,
  and a **Notes & marks** page that collects every mark across every book and
  searches note, quoted passage, title and author at once.
- A sidebar of shelves — automatic ones (Reading now, Finished, Both formats,
  Recently added, On this device) alongside shelves you make yourself — and a
  **reading list** you can order by hand.
- **Browse by what the library already says**: groups built from Calibre tags,
  audiobook genre tags, narrators, publishers, years, Calibre ratings, series,
  authors and languages, with counts, one click from the grid. A grouping the
  library cannot support is never offered, and each reader picks which ones
  they see. Nothing is written back to the files.

### Alignment

- Timing is done by **forced alignment**, not transcription: the words are
  already in the EPUB, so one CTC acoustic model (317 MB, one download, every
  language) is run over the narration and matched against the book's own
  characters.
- `standard` precision puts about 7% of the audio through the model — roughly
  six minutes for a six-hour audiobook on a 6-CPU host. `exact` decodes
  everything and takes some fifteen times as long.
- Every finished alignment is written to a mounted **alignment folder** as one
  gzipped JSON document per pair (`.rpalign`). Files are matched back to books
  by a fingerprint of the ebook's sentences and the audiobook's track lengths
  — never by path — so a from-scratch reinstall imports whatever it
  recognises after its first scan.
- The book's language is read off the book's own text, by script and then by
  function words. Nothing is downloaded to answer that.

### Offline

- Installable PWA with an offline app shell, explicit per-title downloads with
  real progress, size and removal, and a Downloaded shelf that works with no
  network at all. Downloaded pairs bring their alignment with them, so
  switching still works on a plane.
- Progress is written to IndexedDB first as idempotent events and replayed
  when the network returns; the server keeps append-only history with
  revisions, and a stale background tab can never override a deliberate
  rewind.

### Deployment

- Library folders are mounted **read-only**. The alignment folder is the only
  thing ReadPort writes to, and only through one module.
- Optional header-based SSO from Authentik, Authelia or oauth2-proxy, trusted
  only from the proxy's own address.
- A first-run wizard that tests the folders, checks ffmpeg, free space and
  permissions, creates the admin, and offers the model download; after that,
  invite links and three roles. No open sign-up.
