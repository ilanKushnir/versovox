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

TandemLeaf bundles **no speech model** and requires **no cloud API**.

| Provider         | Status                | What it does                                                                                                                                                                                                                                  |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none` (default) | stable                | No transcription. Pairs can link; switching stays unavailable.                                                                                                                                                                                |
| `fixture`        | stable, deterministic | Reads a sidecar `transcript.tandemleaf.json` next to the audio (or `<file>.tandemleaf-transcript.json` for single files). Used by the bundled samples and by anyone producing word timestamps out of band (e.g. WhisperX on another machine). |
| `whisper-cli`    | **experimental**      | Shells out to a user-installed whisper.cpp-compatible binary per track and stitches absolute timestamps.                                                                                                                                      |

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

TandemLeaf invokes:

```
<TL_WHISPER_BIN> -m <TL_WHISPER_MODEL> -l <language> -ojf -of <prefix> <trackfile>
```

and expects whisper.cpp "full JSON" output (`transcription[].tokens[]` with
`offsets`). Tested against whisper.cpp `whisper-cli`; other CLIs may need a
small wrapper script. Transcription runs per track with a persisted
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
