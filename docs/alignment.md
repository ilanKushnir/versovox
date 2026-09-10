# Pairing, transcription, and alignment

## What "switchable" means

A pair of editions goes through three independent gates:

1. **Candidate** — normalized title/author/series/identifier/language and
   length heuristics produce a score. Below 0.55 nothing is created; between
   0.55 and the auto threshold (default 0.92) the pair waits for **your**
   review; at/above it the pair links automatically (evidence stays visible,
   unlink is one click). Contradictory languages hard-cap the score
   (translation guard). Identifier matches raise it.
2. **Edition compatibility** — once a transcript exists, sampled ebook
   passages are checked against transcript windows from three regions of the
   book. Low overlap flags abridged/translated/dramatized editions on the
   pairing screen.
3. **Alignment readiness** — sentence-exact switching is offered only when
   alignment coverage ≥ 50% and mean confidence ≥ 0.25, and each individual
   switch degrades honestly: `sentence` → `paragraph` (nearest aligned
   sentence) → refusal with a reason. Low-confidence regions are never
   presented as exact.

Metadata alone can _link_ editions but never enables sentence-exact
switching — that always requires a word-timestamped transcript plus
alignment.

## Transcription providers

Versovox bundles **no speech model** and requires **no cloud API**.

| Provider         | Status                | What it does                                                                                                                                                                                                                              |
| ---------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | stable                | No transcription. Pairs can link; switching stays unavailable.                                                                                                                                                                            |
| `fixture`        | stable, deterministic | Reads a sidecar `transcript.versovox.json` next to the audio (or `<file>.versovox-transcript.json` for single files). Used by the bundled samples and by anyone producing word timestamps out of band (e.g. WhisperX on another machine). |
| `whisper-cli`    | **experimental**      | Shells out to a user-installed whisper.cpp-compatible binary per track and stitches absolute timestamps.                                                                                                                                  |

### Sidecar transcript format

```json
{
  "language": "en",
  "model": "whatever-produced-this",
  "words": [ { "w": "The", "s": 400, "e": 640 }, ... ]
}
```

`s`/`e` are **absolute milliseconds across the whole audiobook** (multi-file
books: cumulative across tracks in playback order).

### whisper-cli contract (experimental)

The Docker image ships `whisper-cli` (whisper.cpp, CPU build) at
`/usr/local/bin/whisper-cli` and defaults `VX_WHISPER_BIN` to it. Models come
from a **per-language catalog** in Settings → Speech models (admin): one click
downloads the recommended ggml model for each of ten languages into
`VX_MODELS_DIR`, with progress, resume, and removal; `versovox-model <id|lang>`
does the same from the CLI.

What "best" means here (September 2026): whisper.cpp runs OpenAI's Whisper
family, where `large-v3` is the most accurate general model and
`large-v3-turbo` reaches it within 1–2 WER points at ~5× the CPU speed — so
turbo is the default for English, German, French, Spanish, Italian,
Portuguese, Russian, and Dutch, with `large-v3` selectable per language
(and preferred for Arabic). Language fine-tunes beat both on their own
language: **Hebrew uses ivrit.ai's whisper-large-v3-turbo** (trained on ~390 h
of transcribed Hebrew), with their large-v3 fine-tune as the slower, most
accurate option. No newer Whisper generation exists as of this writing; the
catalog is a single file to extend when one does.

**Which language?** Per pair: a user override on the Pairing page → the
EPUB's `dc:language` → the audio tags → whisper's own detector on a 40 s clip
(needs any multilingual model installed) → `VX_DEFAULT_LANGUAGE`. The chosen
language picks the model. If that model is not installed, the alignment job
fails with a structured `model-missing` error that the Pairing page turns into
a one-click download; the alignment re-queues itself when the model lands.

Each track is first decoded with the bundled ffmpeg to the 16 kHz mono
16-bit WAV that whisper.cpp expects (so m4b/m4a/mp3/flac all work without
manual transcoding; the WAV lives in a private temp dir and is deleted
afterwards), then Versovox invokes:

```
<VX_WHISPER_BIN> -m <VX_WHISPER_MODEL> -l <language> -ojf -of <prefix> <track.wav>
```

and expects whisper.cpp "full JSON" output (`transcription[].tokens[]` with
`offsets`). whisper.cpp emits sub-word BPE tokens; Versovox merges them
into whole words (a token starting with whitespace begins a word, special
`[_BEG_]`/`[_TT_n]` tokens are dropped) before alignment. Tested against
whisper.cpp `whisper-cli`; other CLIs may need a small wrapper script. A
single run is killed after six hours. Paths set from the web UI must live
inside `VX_MODELS_DIR` (see docs/security.md); mount your binary and
`ggml-*.bin` models there, e.g. `-v ./models:/models`. Pick the model per
language (`ggml-large-v3` handles Hebrew far better than `base`). Transcription runs per track with a persisted
checkpoint, so an interrupted job resumes at the next track instead of
restarting. Results are cached in `/cache` keyed by source content hash +
language, so rescans never re-transcribe unchanged audio. This path is
honest about its status: it is a seam for local speech tooling, not a tuned
production pipeline (VAD chunking, GPU builds, and language-specific forced
alignment are future work — see the roadmap in
docs/research-and-architecture.md).

## The aligner

`server/src/alignment/align.ts` — deterministic and fully unit-tested:

1. **Anchor seeding**: 4-token shingles unique in both the ebook token
   stream and the transcript seed candidate anchors; a longest-increasing-
   subsequence pass keeps only a globally monotonic set.
2. **Banded DP**: between consecutive anchors, Needleman–Wunsch over tokens
   (exact +3 / fuzzy +2 via edit-distance similarity / gap −1), with a
   greedy fallback above a cell-count cap.
3. **Sentence timing** from first/last aligned word; confidence from match
   rate and exactness; monotonicity enforced; short unmatched runs are
   interpolated **and marked as such** (capped confidence); long unmatched
   spans become explicit `narration-only` gaps.
4. Output: per-sentence segments with confidence + provenance, stored as a
   new alignment version (previous versions retained).

## The bundled sample pair

The samples are original stories written for this repository. Narration is
synthesized with espeak-ng (deliberately robotic but real, word-for-word
speech) and its transcript sidecar has **exact sentence boundaries** with
proportionally interpolated word timings. The narration also includes a
spoken intro and chapter headings that are _not_ in the ebook text, so the
demo exercises narration-only material rather than a suspiciously perfect
input. This is a deterministic correctness fixture, not a claim that novel-
length commercial audiobooks transcribe themselves — that path requires the
experimental provider and real compute.
