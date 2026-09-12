# Pairing and alignment

## What "switchable" means

A pair of editions goes through three gates, and the middle one is the only
one that can actually link them.

1. **Candidate** — normalized title/author/series/identifier/language and
   length heuristics produce a score. Below 0.55 (`CANDIDATE_THRESHOLD`)
   nothing is created at all; above it a candidate appears and waits for your
   review. Contradictory languages hard-cap the score (translation guard);
   identifier matches raise it. At or above `AUTO_PAIR_THRESHOLD` — 0.92, a
   constant rather than a setting, because nobody can choose a better number
   without data they do not have — the pair is additionally queued for
   alignment on the spot (unless `autoAlign` is off), and its evidence says
   what is happening: "Strong metadata match — waiting to be checked against
   the narration."
2. **The narration itself** — the density of the acoustic match _is_ the
   edition check (see [The refusal signal](#the-refusal-signal)). A pair is
   linked only once the audio has been heard and found to be reading this
   text; the alignment job is what promotes a candidate to a link. The
   evidence stays visible afterwards and unlinking is one click.
3. **Alignment readiness** — sentence-exact switching is offered only when
   alignment coverage ≥ 50% and mean confidence ≥ 0.25, and each individual
   switch degrades honestly: `sentence` → `paragraph` (nearest aligned
   sentence) → refusal with a reason. Low-confidence regions are never
   presented as exact.

Metadata alone can put two editions in front of you, but it never links them
and it certainly never enables sentence-exact switching — that always requires
timings computed from the audio, or restored from a file that holds them.

## Forced alignment, not transcription

Speech recognition answers a much harder question than the one we have. **We
are not trying to discover the words — they are sitting in the EPUB.** We only
need to know _when_ each one is spoken. Transcribing the whole audiobook to
find that out costs hours of CPU and a multi-gigabyte model per language, and
every word it invents is a word the matcher then has to forgive.

So the engine (`server/src/alignment/ctc/`) runs a CTC acoustic model over the
audio, greedy-decodes its emissions into a stream of romanized characters with
20 ms timestamps, and then finds where that stream and the book's own
romanized characters agree. There is one model, it covers every supported
language, and it needs the ebook's text — which we always have.

And it does not listen to all of it. The timeline is built from anchors —
places where the audio and the text provably agree — and a few seconds of
narration every couple of minutes produces plenty of them. Everything between
two anchors is interpolated, and a second pass re-listens wherever the implied
reading rate says the interpolation would be a lie.

`alignPrecision` chooses between the two:

- **`standard`** (the default) samples the narration on a schedule and
  interpolates between the matches. Measured on the target server (a 6-CPU
  LXC with `VX_ALIGN_THREADS=4`): a 67-minute book in 72 seconds, a 36.7-hour
  book in 28.6 minutes — i.e. a six-hour audiobook in about six minutes. It
  decodes around 7% of the audio.
- **`exact`** puts every sample through the model. Roughly fifteen times the
  wall clock, and on everything measured so far no more accurate at the
  sentence level.

The server does not guess at any of this when it quotes you a time: the worker
records seconds of audio aligned per second of wall clock after every run
(`alignSpeedRatio`), and the estimate on the Pairing page is that measurement.

### Sampling, and what it costs

Every measurement below is the same book: a 67-minute human-narrated
audiobook of 880 ebook sentences. `standard` times 817 of them, which is where
that denominator keeps coming from; the contiguous decode of the same audio,
which is what `exact` would have produced, is the reference the sampled run is
scored against.

|                                       | `standard`          |
| ------------------------------------- | ------------------- |
| Audio decoded                         | 7.0%                |
| Wall clock                            | 72 s                |
| Sentences timed                       | 92.8%               |
| Median timing error                   | −0.5 s              |
| Worst error                           | +8.8 s / −19.8 s    |
| Sentences still late after the margin | 2 of 817 (≤ +2.0 s) |

The error is not the interesting number; the _sign_ is. A reader switching
from the page to the narration can tolerate hearing a sentence again, and
cannot tolerate hearing one they have not reached — so every segment carries
its own `uncertaintyMs`, and the handoff subtracts it (see "Staying behind the
reader" below). That costs a median rewind of 7.6 seconds, which is roughly
the line that just scrolled off the top of the page.

Shorter windows are also cheaper per second of audio than long ones, because
the model's attention is quadratic in frames: measured on this server, 6–8
second windows cost ~125 ms per second of audio against ~189 ms for the
30-second chunks the whole-book path uses. Sampling is therefore better than
its duty cycle suggests.

### The pipeline

1. **Romanize the ebook** (`romanize.ts`). The model's vocabulary is 31
   tokens: four specials (`<blank> <pad> </s> <unk>`), the 26 lowercase
   Latin letters, and an apostrophe. There is **no space token**, so its
   output is one uninterrupted character stream — and the ebook has to be
   pushed through the same funnel. Latin text is NFKD-folded and stripped to
   `[a-z']`; Cyrillic, Greek, Hebrew and Arabic are transliterated (schemes
   and their deliberate deviations are documented at the top of
   `romanize.ts`). Script mapping is keyed on the character, not the book's
   language, so a Russian name in an English novel still produces letters.
2. **Choose where to listen** (`sparse.ts`). Under `standard`, one 8-second
   probe every 150 seconds to start with. Then, for each stretch between two
   consecutive anchors wider than 50 seconds, the implied reading rate (book
   characters per millisecond) is compared against the book's median: a
   stretch off by more than a factor of 1.2 either way, or that produced no
   anchors at all, gets another probe placed in the middle of the widest part
   of it that nothing has listened to yet. Up to three rounds, with a probe
   budget of 60% of the first pass. A chapter break shows up as a stretch that
   is too slow, a passage the narration skips as one that is too fast, and a
   probe that landed in music as one with no anchors — all three are the same
   signal, and all three are exactly where interpolation goes wrong. The
   unanchored head and tail of the book are always suspect: there is no rate
   to judge them by, and they are every bit as unmapped.
3. **Decode the audio** (`emissions.ts`). The bundled ffmpeg resamples every
   track to 16 kHz mono. `exact` consumes it as a stream in 30-second chunks
   with one second of context on each side (frames near a hard cut decode
   badly, and the context is discarded afterwards); streaming is a requirement
   there, not an optimisation, since six hours of float32 PCM is 1.4 GB and
   only a ~32-second window is ever resident. The sampling path seeks to each
   probe instead, again with a second of context on each side, and holds the
   ONNX session open across rounds. The model emits one frame per 320 samples
   over a 400-sample window — exactly 20.0 ms — and the code asserts that
   frame count on every chunk, so swapping in a model with a different stride
   fails loudly instead of silently shifting every timestamp. Greedy CTC
   collapse (skip blank, skip repeats) turns the emissions into stamped
   characters. Probes are spliced together in playback order with a space
   between them: a space is outside the model's alphabet and outside anything
   romanization can produce, so no n-gram can straddle the seam between two
   probes minutes apart and anchor on a phrase nobody said.
4. **Anchor** (`anchors.ts`, `ngram-index.ts`). Find every 14-character
   n-gram that occurs **exactly once on each side**. Those pairs are
   unambiguous by construction, so no similarity threshold is needed. A
   longest-increasing-subsequence pass discards any candidate that would
   require the narrator to jump backwards.
5. **Interpolate, and say how much that is worth.** Linear interpolation
   between consecutive anchors maps any book character position to a
   millisecond. A sentence whose nearest anchor is more than 3000 characters
   away is reported as a gap instead of a timing; closer than that, its score
   falls linearly from 1 at an anchor to 0 at the cut-off. Each timing also
   carries an `uncertaintyMs`: 2 seconds plus 15% of the _audio_ distance to
   the nearer bracketing anchor, or — outside the anchored range, where the
   timing is not an interpolation but an edge anchor's time held while the
   narration kept going — 2 seconds plus the whole extrapolated distance.
6. **Decide what may be claimed** (`../timings.ts`). `segmentsFromTimings()`
   is the only function in the codebase that constructs an
   `AlignmentSegment`. The engine reports evidence; that module enforces
   monotonicity, interpolates runs of at most three unplaced sentences (and
   marks them `interpolated`, capped at confidence 0.35), drops anything it
   trusts less than that, emits explicit `narration-only` gaps for unaligned
   stretches over 15 seconds, and computes coverage and mean confidence. An
   engine cannot mint an over-confident segment by accident.

### Why anchors rather than a global warp

The anchor approach makes **no proportionality assumption** between position
in the text and position in the audio. Front matter, credits, a spoken
chapter announcement, endnotes, an index — anything the narrator did or did
not say that the other side lacks — simply produces no anchors there, rather
than dragging the whole mapping off course.

That is not a theoretical preference. A prototype that force-aligned with
fixed windows sized by a uniform characters-per-second rate drifted badly on
the same real book and put **every** spot check on the wrong sentence.

## The n-gram index, and which side gets indexed

Finding the grams that occur exactly once on each side is the whole of the
matching, and the obvious implementation of it had a length limit hiding
inside it. Indexing both sides into a `Map<string, number>` allocates one
14-character string per position — around ninety bytes each in V8 — so both
sides had to be capped at 1.2 million characters to keep the index near
110 MB a side. A long book quietly ran past that: on a 36.7-hour Russian
audiobook the last 7% of the text was never even offered to the matcher, and
the job reported 92% coverage as though that were the honest answer.

`ngram-index.ts` inverts the problem. Only the **decoded** side is indexed —
under sampling that is a few tens of thousands of characters against a book's
million-plus — into flat `Int32Array`s addressed by a rolling polynomial hash
with a murmur3 finaliser. The book is then **streamed** past that index and
never allocated at all, so it has no length limit. Every hash hit is confirmed
character by character before it becomes a match, which means a collision
costs one wasted comparison and can never produce a wrong anchor, and a gram's
multiplicity on the book side falls out of counting how many book positions
landed in the same slot — the "unique on both sides" rule survives intact.

The guard that remains is on the decoded side alone: `maxIndexChars`, eight
million characters, with an `indexTruncated` flag when it is hit. It is
reachable only by an `exact` decode of about 180 hours of narration, which is
longer than any audiobook that exists. Sampling a six-hour book indexes
around ninety thousand characters and a few megabytes of typed array.

## The refusal signal

On the validated book, 18,913 candidate anchors were found and 18,902 of
them (99.94%) survived the monotonicity pass — about 386 anchors per
thousand characters of text. A wrong pairing does not produce a worse
alignment; it produces almost no anchors at all.

So the density is the edition check. Below **2 monotone anchors per thousand
characters** the matcher returns no timings at all — deliberately empty
rather than sparse, because a caller that trusted a handful of coincidental
anchors would scatter the reader across the wrong audio — and the engine
raises `AlignmentRefusedError`. The job does not fail: it records
`Narration check failed — …` in the pair's evidence, sets the content score
to zero, leaves the pair undecided, and waits for you.

The margin between "correct book" and "refuse" is roughly two orders of
magnitude, which is why the threshold can be set so low without becoming a
guess. It is also why there is no separate content probe: an edition check
that costs nothing beyond the alignment you were going to run anyway is
strictly better than one that has to be paid for up front.

## Which language this is

Alignment needs a language for one narrow purpose: the romanizer uses it to
spell out numbers and abbreviations ("25" → "twenty five", or "vingt-cinq").
Script transliteration is keyed on the characters themselves, so a wrong
answer costs anchors around numbers and nowhere else.

That is far too modest a requirement to justify a model. `detect-language.ts`
reads the ebook's own text instead, over the first 200,000 characters:

- **Script settles it outright.** If more than 30% of the letters are
  Cyrillic, Hebrew, Arabic or Greek, that is the answer, with no further
  argument. A minimum of 120 letters keeps a Russian name in an English novel
  from deciding anything. (Greek is the one loose end: its characters
  transliterate, but it is not one of the ten book languages, so a book
  detected as Greek gets the English number rules.)
- **Function words separate the Latin languages.** A few dozen of them per
  language — `il` and `gli` are only Italian, `het` only Dutch, `los`/`las`
  only Spanish. Function words are the most frequent words in any language and
  they barely overlap between these seven. Content words would be a far worse
  signal, because a translated novel shares its proper nouns with every
  edition of itself.
- **It abstains rather than guess.** Fewer than 60 words, a winning rate under
  2%, or a lead of less than 1.4× over the runner-up, and it returns nothing.
  Spanish, Portuguese and Italian share enough that a narrow win between them
  is a coin toss, and a coin toss is worse than the operator's own default.

The resolution order in `runAlign` is: the pair's own override → the EPUB's
`dc:language` → the audio tags → the ebook's text → `defaultLanguage`. The
progress line says which of those answered ("Language: German (from the
ebook)"), because the one thing worse than a wrong language is a wrong
language nobody can trace.

## Honest failure modes

- **Un-narrated matter becomes a gap, not an error.** Title pages,
  copyright, dedications, "end of part one", an index: no anchors, so those
  sentences are reported as gaps and the reader refuses the handoff there
  rather than landing somewhere plausible-looking. Decoding the validated
  book contiguously — hearing every second of it — still timed only 830 of its
  880 sentences; the other 50 were gaps or too far from an anchor to trust.
  Those fifty are not what sampling costs. They are what the narration does
  not contain.
- **Abridged editions are refused,** not silently half-aligned. A softer
  version of the same signal is surfaced before refusal: when the narration
  ratio — the decoded characters, divided back out by the fraction of the
  audio that was actually decoded, so the number means the same thing at
  either precision — falls below 0.7, the pairing page warns that the
  narration covers noticeably less text than the ebook. (The validated ratio
  on a matching pair was 0.937.)
- **Digits and abbreviations are not in the model's alphabet.** The narrator
  says "twenty five" where the ebook has "25", and the model cannot spell
  "25". The romanizer therefore expands numbers, currency, percent, "&" and
  a table of abbreviations into words in the book's own language before
  transliterating them. The expansions are deliberately conservative — a
  wrong expansion injects letters the narrator never said, which is worse
  than no expansion — so there are known gaps, listed in full at the top of
  `server/src/alignment/ctc/romanize.ts`. The notable ones: integers above
  9999, years read as digit pairs ("1984" spells as a cardinal, the narrator
  probably said "nineteen eighty four"), Roman numerals, times, phone
  numbers and version strings, German ordinals (written "1.", which is
  indistinguishable from a sentence-final number), and no abbreviation table
  at all for Russian, Hebrew and Arabic. Each gap costs anchors in that
  neighbourhood and nothing else.
- **Romanization is orthographic, not phonetic.** French _garçon_ becomes
  `garcon` while the narrator says /ɡaʁsɔ̃/. Deep orthographies (English,
  French) therefore anchor on fewer, longer words than shallow ones. Hebrew
  is aligned on its consonant skeleton, because unpointed text gives no way
  to recover the vowels — long words still anchor well, short ones do not, so
  Hebrew yields fewer anchors than a Latin-script book of the same length.
- **Empty sentences are never timed.** A heading, or a sentence that
  romanized to nothing, has no characters to anchor.
- **Distance from an anchor decides what may be claimed.** A sentence has to
  be within 300 characters of one _and_ carry an uncertainty of 2.5 seconds
  or less to be called `exact`; beyond roughly 1950 characters its score falls
  under the trust floor and the timings layer drops it altogether, even though
  the matcher scored it. Both halves matter under sampling: 300 characters is
  twenty seconds of narration, so the character score alone would let an
  interpolation across a third of a minute call itself exact. On the sampled
  run, that second condition is what took the `exact` count from 335 of 817
  sentences down to an honest 70.
- **A timing is where the sentence starts, interpolated linearly.** Between
  two anchors we assume the narrator kept a steady pace. Over a few hundred
  characters that is a good assumption; a long pause, a sound effect, or a
  sip of water inside an un-anchored stretch will push a sentence's start
  out by as much as that pause. Which is one more reason `exact` is reserved
  for sentences sitting on top of an anchor.

## Staying behind the reader

Switching from the page to the narration is not symmetric. Landing a few
seconds early costs the reader a sentence they have already read. Landing a
few seconds late plays them a plot turn they have not reached — and no amount
of precision elsewhere makes up for that.

So every segment carries `uncertaintyMs`, the aligner's own account of how far
its start could be wrong, and `resolveEbookToAudio` subtracts it before handing
a position to the player (capped at 45 seconds, past which it is not a safety
margin but a different scene). The reader page already sends the _first_
sentence visible on the page rather than the last, so the two together put the
handoff at or slightly above the top of the screen — the line that just
scrolled away.

Measured on the sampled run of the validated book, that leaves 2 sentences out
of 817 landing later than the truth, by at most 2.0 seconds, for a median
rewind of 7.6 seconds. Going the other way (narration to page) needs no margin:
the segment containing the current instant is the sentence being spoken, and
erring toward the earlier one is already what the lookup does.

## Alignments that outlive the container

An alignment is expensive and, kept only in SQLite, it is also disposable: a
from-scratch redeploy throws away every CPU-hour the user has ever paid for.
So a finished alignment is also written out as a file, into an **alignment
folder** the operator mounts from their own library — the one folder Versovox
ever writes to. A fresh install reads that folder back after its first scan
and is immediately as capable as the install that was wiped.

The write target is the first configured folder (`alignmentDirs` /
`VX_ALIGNMENT_DIRS`) that will actually accept a file. If none will, the
alignment is not lost — it falls back to `alignments/` inside the data
directory and logs what to fix. That fallback survives a container restart but
not a rebuild that discards the volume, which is exactly why the setup wizard
asks for a folder in the library instead.

### The file

One gzipped JSON document per aligned pair, extension `.vxalign`, named
`<author> - <title> [<first 12 of the pair key>].vxalign`. The slugs are
ASCII-folded and capped at 60 characters each, because these files get copied
between a NAS, a Windows box and a phone's SMB mount and non-ASCII names do
not survive that trip reliably. The slugs are a courtesy to whoever is looking
at the folder; the bracketed key is the identifier, which is why a retitled
book gets its stale file swept away rather than accumulating one copy per
title it has ever had.

```json
{
  "format": "versovox-alignment",
  "formatVersion": 1,
  "writtenAt": "2026-09-01T12:00:00.000Z",
  "writtenBy": "versovox",
  "ebook": { "title": "…", "author": "…", "language": "en",
             "sentenceCount": 880, "spineCount": 12, "sizeBytes": 412000,
             "textFingerprint": "t1:…" },
  "audio": { "title": "…", "narrator": "…", "trackCount": 4,
             "durationMs": 4020000, "trackDurationsMs": [ … ],
             "timelineFingerprint": "a1:…" },
  "alignment": { "version": 3, "createdAt": "…", "language": "en",
                 "model": "…", "coverage": 0.94, "meanConfidence": 0.71,
                 "provenance": { … }, "gaps": [ … ] },
  "pairKey": "…",
  "segmentCount": 16000,
  "segments": {
    "sentenceIds": [ … ], "spineIdx": [ … ], "sentenceOrd": [ … ],
    "startMs": [ … ], "endMs": [ … ], "confidence": [ … ],
    "source": [ … ], "uncertaintyMs": [ … ]
  }
}
```

The segments are **columnar** — eight parallel arrays rather than an array of
objects. On a real 16,000-segment book that is 950 KiB raw / 309 KiB gzipped,
against 2450 KiB / 433 KiB for objects: the repeated key names dominate the
raw size and, because gzip is matching them over a 32 KiB window, much of the
compressed size too. It is deliberately **not** delta-encoded. Delta-encoding
the timestamps saves a further 82 KiB and costs the one property that makes a
portable format worth having: a self-hoster can gunzip the file and read it.

The counts and titles are not part of the file's identity. They are there so
an import can say "this file is for a 412-sentence book and yours has 1,208"
instead of a bare "no match", and `trackDurationsMs` is kept in full rather
than only hashed for the same reason — a near-miss should be diagnosable.

Files are written to a dotfile temporary in the same directory, fsynced, and
renamed into place. The folder is the user's library: it is watched by their
sync client and their backup job, so a half-written file is not a private
problem, it gets replicated.

### The two fingerprints

Matching a file back to a library is by **fingerprint, never by path, id or
filename** — none of those survive a reinstall. Each fingerprint carries its
algorithm as a prefix, so the algorithm can be replaced later without a format
bump: a reader that meets `t2:` knows only that it cannot compare it, which is
precisely what stops it from confidently mis-matching a book.

- **`t1:` the text.** SHA-256 over the ebook's sentence ids in reading order,
  newline-joined, with the count folded in first so a truncated id list cannot
  collide with the full one; the first 32 hex characters are kept. Sentence
  ids are content-derived (`segmentSentences` in `util/text.ts`), so the same
  EPUB segmented on another machine yields the same ids and the same
  fingerprint. That is the only reason an imported row means anything at all:
  a segment says "sentence `s3f9a` starts at 1:02:11", which is worth nothing
  unless the importing install agrees about which sentence `s3f9a` is. It is
  computed during indexing, where the sentence index is built, and stored on
  the book. An id folds in the spine index and the normalized sentence text,
  so a differently built EPUB of the same title produces different ids and so
  a different fingerprint — which is the right answer, because its sentences
  are not the ones these timings were measured against.
- **`a1:` the timeline.** SHA-256 over the track count and every track's
  duration rounded to 100 ms, comma-joined; again the first 32 hex characters.
  Duration-based and not byte-based on purpose: retagging an audiobook —
  fixing the narrator, embedding cover art, renaming chapters — rewrites every
  file and must not cost the user their alignment, because none of it moves a
  single word of narration. The rounding absorbs the last-frame disagreements
  between ffprobe versions and container remuxes, which are a few milliseconds
  at most and would otherwise invalidate an alignment on a server upgrade.

The **pair key** is SHA-256 of the two fingerprints joined by `|`, truncated
to 24 hex characters: the identity of this text read as this timeline. It is
what the filename carries and what an import looks up.

### Matching, and why an import is all-or-nothing

`import-alignments` runs after every pairing scan, at a higher priority than
the alignment jobs that scan just queued, so a redeploy restores rather than
recomputes. For every pair on this server that is a candidate or better and
whose ebook has a text fingerprint, it computes the pair key from the database
and looks for a file with that key. Then:

- **A database row always wins over a file.** A pair that already has an
  alignment here is skipped, which is what makes running this after every scan
  a no-op on every run but the first.
- **A file for a book this library does not have is not a problem.** It is
  counted as unmatched and passed over in silence. People will keep their
  `.vxalign` files alongside books they have not mounted.
- **A bad file is reported, not thrown.** These files come off a folder the
  user controls: truncated by a sync client, edited in a text editor, written
  by a Versovox two releases newer than this one. Each one is rejected with a
  sentence a self-hoster can act on, and the import carries on with the rest.
  A file is rejected when it will not gunzip, will not parse, carries the
  wrong `format` tag, declares a `formatVersion` this server does not
  understand, fails the schema, uses a fingerprint scheme this build does not
  implement, or has a segment column whose length disagrees with
  `segmentCount`.
- **A document is applied whole or not at all.** Before anything is inserted,
  every sentence id in the file is checked against the sentence ids this
  install already knows for that pair. A ragged column, or a file whose
  sentences have drifted from the local copy of the ebook, would otherwise
  import as a whole book of timings quietly shifted by one sentence, or as a
  timeline full of silent holes with a coverage figure that lies about them.
  Importing nothing and saying so is strictly better than either.

An imported pair is promoted from candidate to linked. A pair whose alignment
was computed elsewhere is as linked as one computed here, and leaving it a
suggestion would ask the user to re-decide something they already decided on
the machine the file came from. The provenance recorded with it says where it
came from and when.

Going the other way, `export-alignments` writes out every alignment this
server holds that is not already on disk — the one-click answer for an install
that has been aligning books since before there was anywhere to put them. It
skips by pair key, so running it twice is cheap.

Saving a file never fails an alignment job. The alignment succeeded, it is in
the database, and losing the expensive half over its copy would be absurd; a
copy that could not be written is worth a line in the log and nothing more.

## The model, and its licence

|             |                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Catalog id  | `alignment-model`                                                                                             |
| What it is  | Meta's MMS-300M forced aligner, exported to ONNX (int8) by `onnx-community/mms-300m-1130-forced-aligner-ONNX` |
| Size        | 317 MB, plus a 351-byte `vocab.json` and a 2.1 KB `config.json`                                               |
| Languages   | all ten, from the one download                                                                                |
| **Licence** | **CC-BY-NC-4.0 — non-commercial**                                                                             |

It is the only model Versovox uses and the only entry in the catalog. Because
it works on a romanized character stream rather than on words, the same file
times a Russian audiobook as happily as an English one, and unvocalized Hebrew
costs it nothing extra.

That licence is the only non-permissive thing in the project, and the only
term that is not AGPL-compatible in spirit. Versovox itself is AGPL-3.0 and
ships no model; this one is fetched from Hugging Face on an explicit admin
click, and the licence is shown on the card **before** the download starts.
For personal and household use it is fine. If you are running Versovox in a
commercial setting, do not install it — and note that without it nothing on
this server can compute an alignment; the only timings it will ever have are
the ones it imports from a folder of `.vxalign` files.

A book queued for alignment before the model has landed fails with a
structured `model-missing` error rather than a red stack trace: the Pairing
page turns it into a one-click download, and the job re-queues itself when the
file arrives.

int8 was chosen by measurement, not by habit: on the target CPU it decoded at
0.398× real time against 0.513 for the q4f16 build.

## The bundled sample pair

The samples are original stories written for this repository. Narration is
synthesized with espeak-ng (deliberately robotic but real, word-for-word
speech). The narration also includes a spoken intro and chapter headings that
are _not_ in the ebook text, so the demo exercises narration-only material
rather than a suspiciously perfect input.

It is a deterministic correctness fixture and nothing more. Note in
particular that a synthetic fixture cannot validate an acoustic engine: an
earlier design (espeak synthesis + MFCC + DTW) scored superbly against this
fixture and then failed completely against a real narrator, because the
fixture's narration _is_ espeak output and the test was measuring espeak
against itself. Every measurement in this document comes from a real
human-narrated audiobook instead; every threshold and size comes from the
source files named beside it.
