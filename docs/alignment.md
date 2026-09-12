# Pairing and alignment

## What "switchable" means

A pair of editions goes through three independent gates:

1. **Candidate** — normalized title/author/series/identifier/language and
   length heuristics produce a score. Below 0.55 nothing is created; between
   0.55 and the auto threshold (default 0.92) the pair waits for **your**
   review; at/above it the pair links automatically (evidence stays visible,
   unlink is one click). Contradictory languages hard-cap the score
   (translation guard). Identifier matches raise it.
2. **Edition compatibility** — the two editions have to be the same work.
   With the forced aligner this is no longer a separate step: the density of
   the acoustic match _is_ the check (see
   [The refusal signal](#the-refusal-signal)). The legacy transcription path
   still uses the older two-clip content probe.
3. **Alignment readiness** — sentence-exact switching is offered only when
   alignment coverage ≥ 50% and mean confidence ≥ 0.25, and each individual
   switch degrades honestly: `sentence` → `paragraph` (nearest aligned
   sentence) → refusal with a reason. Low-confidence regions are never
   presented as exact.

Metadata alone can _link_ editions but never enables sentence-exact
switching — that always requires timings computed from the audio.

## Forced alignment, not transcription

Versovox used to transcribe the whole audiobook with whisper.cpp and
fuzzy-match the transcript against the ebook. That works, but it answers a
much harder question than the one we have. **We are not trying to discover
the words — they are sitting in the EPUB.** We only need to know _when_ each
one is spoken.

So the default engine (`server/src/alignment/ctc/`) runs a CTC acoustic model
over the audio, greedy-decodes its emissions into a stream of romanized
characters with 20 ms timestamps, and then finds where that stream and the
book's own romanized characters agree.

And it does not listen to all of it. The timeline is built from anchors —
places where the audio and the text provably agree — and a few seconds of
narration every couple of minutes produces plenty of them. Everything between
two anchors is interpolated, and a second pass re-listens wherever the implied
reading rate says the interpolation would be a lie.

|                         | Transcribe then match (`whisper-cli`) | Forced alignment, every sample (`thorough`)                  | Forced alignment, sampled (`fast`, default) |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| Model                   | 1.6–3.1 GB, one per language          | 317 MB, one for all ten (whisper models optional, see below) | the same 317 MB                             |
| Audio through the model | all of it                             | all of it                                                    | ~7%                                         |
| Measured speed          | 0.61× real time                       | 3.3× real time                                               | 56× real time                               |
| A six-hour book         | ≈ 11 hours                            | ≈ 1.8 hours                                                  | **≈ 6 minutes**                             |
| Edition check           | separate two-clip probe               | falls out of the alignment itself                            | falls out of the alignment itself           |
| Needs the ebook text    | no                                    | **yes** — it is the point                                    | **yes**                                     |

All measured on the same target server (a 4-CPU LXC) with the same 67-minute
human-narrated audiobook of 880 ebook sentences. They are not benchmarks of
the method in general; they are what this code did on that machine with that
book, and the host was carrying other work at the time — an idle box is about
a third faster again.

### Sampling, and what it costs

Scored against the contiguous decode of the same book, sentence by sentence:

|                                       | `fast` (every 150 s) | `careful` (every 75 s) |
| ------------------------------------- | -------------------- | ---------------------- |
| Audio decoded                         | 7.0%                 | 15.4%                  |
| Wall clock, 67-minute book            | 72 s                 | 150 s                  |
| Sentences timed                       | 92.8%                | 93.0%                  |
| Median timing error                   | −0.5 s               | −0.1 s                 |
| Worst error                           | +8.8 s / −19.8 s     | +5.1 s / −17.1 s       |
| Sentences still late after the margin | 2 of 817 (≤ +2.0 s)  | 6 of 818 (≤ +1.6 s)    |

The error is not the interesting number; the _sign_ is. A reader switching
from the page to the narration can tolerate hearing a sentence again, and
cannot tolerate hearing one they have not reached — so every segment carries
its own `uncertaintyMs`, and the handoff subtracts it (see "Staying behind the
reader" below). Under `fast` that costs a median rewind of 7.6 seconds, which
is roughly the line that just scrolled off the top of the page.

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
2. **Choose where to listen** (`sparse.ts`). One probe every 150 seconds to
   start with. Then, for each stretch between two consecutive anchors, the
   implied reading rate (book characters per millisecond) is compared against
   the book's median: a stretch that is more than 20% off, or that produced no
   anchors at all, gets another probe placed in the widest part of it that
   nothing has listened to yet. Up to three rounds, with a probe budget of 60%
   of the first pass. A chapter break shows up as a stretch that is too slow, a
   passage the narration skips as one that is too fast, and a probe that landed
   in music as one with no anchors — all three are the same signal, and all
   three are exactly where interpolation goes wrong.
3. **Decode the audio** (`emissions.ts`). The bundled ffmpeg resamples every
   track to 16 kHz mono. The whole-book path (`thorough`) consumes it as a
   stream in 30-second chunks with one second of context on each side (frames
   near a hard cut decode badly, and the context is discarded afterwards);
   streaming is a requirement there, not an optimisation, since six hours of
   float32 PCM is 1.4 GB and only a ~32-second window is ever resident. The
   sampling path seeks to each probe instead, again with a second of context
   on each side, and holds the ONNX session open across rounds. The model emits
   one frame per 320 samples over a 400-sample window — exactly 20.0 ms — and
   the code asserts that frame count on every chunk, so swapping in a model
   with a different stride fails loudly instead of silently shifting every
   timestamp. Greedy CTC collapse (skip blank, skip repeats) turns the
   emissions into stamped characters. Probes are spliced together in playback
   order with a space between them: a space is outside the model's alphabet
   and outside anything romanization can produce, so no n-gram can straddle
   the seam between two probes minutes apart and anchor on a phrase nobody
   said.
4. **Anchor** (`anchors.ts`). Index every 14-character n-gram of both
   strings and keep only the grams that occur **exactly once on each side**.
   Those pairs are unambiguous by construction, so no similarity threshold is
   needed. A longest-increasing-subsequence pass discards any candidate that
   would require the narrator to jump backwards.
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
   `AlignmentSegment`. Engines report evidence; that module enforces
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

This replaces the two-clip whisper content probe **for this engine only**.
The probe still runs on the `whisper-cli` path, where there is no anchor
density to consult until hours of transcription have already been spent.

The margin between "correct book" and "refuse" is roughly two orders of
magnitude, which is why the threshold can be set so low without becoming a
guess.

## Honest failure modes

- **Un-narrated matter becomes a gap, not an error.** Title pages,
  copyright, dedications, "end of part one", an index: no anchors, so those
  sentences are reported as gaps and the reader refuses the handoff there
  rather than landing somewhere plausible-looking. On the validated book,
  830 of 880 sentences got timings; the other 50 were gaps or too far from an
  anchor to trust.
- **Abridged editions are refused,** not silently half-aligned. A softer
  version of the same signal is surfaced before refusal: when the decoded
  character count falls below 0.7× the ebook's, the pairing page warns that
  the narration covers noticeably less text than the ebook. (The validated
  ratio on a matching pair was 0.937.)
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
- **The n-gram index is capped** at 1.2 million characters per side (~110 MB
  of index per side, the ceiling we are willing to pay on a 4-CPU home
  server). That covers roughly a 25-hour audiobook; past the cap, the tail of
  the book can only ever be a gap, and the matcher reports
  `indexTruncated` so this is visible rather than mysterious.
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

## The model, and its licence

|             |                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Catalog id  | `mms-forced-aligner`                                                                                          |
| What it is  | Meta's MMS-300M forced aligner, exported to ONNX (int8) by `onnx-community/mms-300m-1130-forced-aligner-ONNX` |
| Size        | 317 MB, plus a 351-byte `vocab.json` and a 2.1 KB `config.json`                                               |
| Languages   | all ten, from the one download                                                                                |
| **Licence** | **CC-BY-NC-4.0 — non-commercial**                                                                             |

That licence is the only non-permissive thing in the project, and the only
term that is not AGPL-compatible in spirit. Versovox itself is AGPL-3.0 and
ships no model; this one is fetched from Hugging Face on an explicit admin
click, and the licence is shown on the card **before** the download starts.
For personal and household use it is fine. If you are running Versovox in a
commercial setting, do not install this model — use sidecar transcripts or
the `whisper-cli` engine instead, and check the licence of whichever whisper
model you download.

int8 was chosen by measurement, not by habit: on the target CPU it decoded at
0.398× real time against 0.513 for the q4f16 build.

## whisper.cpp is still here

Nothing was deleted. The image still bundles `whisper-cli` and the
per-language model catalog, because three jobs still need speech
recognition:

- **Language detection.** When neither the pair override, the EPUB's
  `dc:language`, nor the audio tags say what language the narration is in,
  whisper's own detector runs on a short clip (any installed multilingual
  model will do). The detected language selects romanization conventions for
  the aligner, not a model.
- **The legacy engine.** `alignEngine: 'whisper-cli'` transcribes and
  fuzzy-matches, exactly as before. It is slower and needs a 1.6–3.1 GB
  model per language, but it is a real rescue path for a book the forced
  aligner refuses or aligns thinly — and it is the path the two-clip edition
  probe belongs to.
- **Hebrew.** The ivrit.ai fine-tunes (`whisper-large-v3-turbo` and
  `whisper-large-v3`, trained on ~390 h of transcribed Hebrew) stay in the
  catalog. Stock Whisper is weak on Hebrew, and Hebrew is the language where
  the forced aligner has least to work with (a consonant skeleton, no
  vowels), so having a good Hebrew recognizer available matters.

## Engines

`alignEngine` selects how timings are computed (see
docs/configuration.md for how it interacts with `transcribeProvider`):

| Engine                   | Status                      | What it does                                                                                                                                                                                                                              |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forced-align` (default) | validated on real narration | The pipeline above. One model, every language. Requires the ebook text, which we always have.                                                                                                                                             |
| `fixture`                | stable, deterministic       | Reads a sidecar `transcript.versovox.json` next to the audio (or `<file>.versovox-transcript.json` for single files). Used by the bundled samples and by anyone producing word timestamps out of band (e.g. WhisperX on another machine). |
| `whisper-cli`            | experimental                | Transcribes every track with a user-installed whisper.cpp-compatible binary, then fuzzy-matches the transcript against the ebook.                                                                                                         |
| `none`                   | —                           | No alignment. Pairs can link; switching stays unavailable.                                                                                                                                                                                |

**A sidecar transcript always wins.** If `transcribeProvider` is `fixture`,
the sidecar path runs whatever `alignEngine` says: real word timestamps you
produced yourself are exact and free, and no acoustic model can improve on
them.

### Sidecar transcript format

```json
{
  "language": "en",
  "model": "whatever-produced-this",
  "words": [{ "w": "The", "s": 400, "e": 640 }]
}
```

`s`/`e` are **absolute milliseconds across the whole audiobook** (multi-file
books: cumulative across tracks in playback order).

### whisper-cli contract (experimental)

The Docker image ships `whisper-cli` (whisper.cpp, CPU build) at
`/usr/local/bin/whisper-cli` and defaults `VX_WHISPER_BIN` to it. Models come
from the **per-language catalog** in Settings → Speech models (admin): one
click downloads the recommended ggml model for a language into
`VX_MODELS_DIR`, with progress, resume, and removal; `versovox-model <id|lang>`
does the same from the CLI.

What "best" means here (September 2026): whisper.cpp runs OpenAI's Whisper
family, where `large-v3` is the most accurate general model and
`large-v3-turbo` reaches it within 1–2 WER points at ~5× the CPU speed — so
turbo is the default for English, German, French, Spanish, Italian,
Portuguese, Russian, and Dutch, with `large-v3` selectable per language
(and preferred for Arabic). Language fine-tunes beat both on their own
language: **Hebrew uses ivrit.ai's whisper-large-v3-turbo**, with their
large-v3 fine-tune as the slower, most accurate option. No newer Whisper
generation exists as of this writing; the catalog is a single file to extend
when one does.

Each track is first decoded with the bundled ffmpeg to the 16 kHz mono
16-bit WAV that whisper.cpp expects (so m4b/m4a/mp3/flac all work without
manual transcoding; the WAV lives in a private temp dir and is deleted
afterwards), then Versovox invokes:

```
<VX_WHISPER_BIN> -m <VX_WHISPER_MODEL> -l <language> -ojf -of <prefix> <track.wav>
```

and expects whisper.cpp "full JSON" output (`transcription[].tokens[]` with
`offsets`). whisper.cpp emits sub-word BPE tokens; Versovox merges them into
whole words (a token starting with whitespace begins a word, special
`[_BEG_]`/`[_TT_n]` tokens are dropped) before alignment. Tested against
whisper.cpp `whisper-cli`; other CLIs may need a small wrapper script. A
single run is killed after six hours. Paths set from the web UI must live
inside `VX_MODELS_DIR` (see docs/security.md); mount your binary and
`ggml-*.bin` models there, e.g. `-v ./models:/models`. Transcription runs per
track with a persisted checkpoint, so an interrupted job resumes at the next
track instead of restarting. Results are cached in `/cache` keyed by source
content hash + language, so rescans never re-transcribe unchanged audio.
This path is honest about its status: it is a seam for local speech tooling,
not a tuned production pipeline.

**Which language?** Per pair: a user override on the Pairing page → the
EPUB's `dc:language` → the audio tags → whisper's own detector on a clip →
`VX_DEFAULT_LANGUAGE`. For `forced-align` the language chooses romanization
conventions; for `whisper-cli` it chooses the model. Either way a missing
model fails the job with a structured `model-missing` error that the Pairing
page turns into a one-click download, and the alignment re-queues itself
when the model lands.

## The legacy aligner

`server/src/alignment/align.ts` — used by the `fixture` and `whisper-cli`
engines, deterministic and fully unit-tested:

1. **Anchor seeding**: 4-token shingles unique in both the ebook token
   stream and the transcript seed candidate anchors; a longest-increasing-
   subsequence pass keeps only a globally monotonic set.
2. **Banded DP**: between consecutive anchors, Needleman–Wunsch over tokens
   (exact +3 / fuzzy +2 via edit-distance similarity / gap −1), with a
   greedy fallback above a cell-count cap.
3. Sentence timing from first/last aligned word; confidence from match rate
   and exactness.
4. Output goes through the same `segmentsFromTimings()` as the forced
   aligner, so both engines are held to the same honesty rules and produce
   the same segment shape. Previous alignment versions are retained.

## The bundled sample pair

The samples are original stories written for this repository. Narration is
synthesized with espeak-ng (deliberately robotic but real, word-for-word
speech) and its transcript sidecar has **exact sentence boundaries** with
proportionally interpolated word timings. The narration also includes a
spoken intro and chapter headings that are _not_ in the ebook text, so the
demo exercises narration-only material rather than a suspiciously perfect
input.

It is a deterministic correctness fixture and nothing more. Note in
particular that a synthetic fixture cannot validate an acoustic engine: an
earlier design (espeak synthesis + MFCC + DTW) scored superbly against this
fixture and then failed completely against a real narrator, because the
fixture's narration _is_ espeak output and the test was measuring espeak
against itself. Every measurement in this document comes from a real
human-narrated audiobook instead; every threshold and size comes from the
source files named beside it.
