import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { normalizeForMatch } from '../util/text.js';
import { type TranscriptWord } from '../alignment/align.js';

const execFileP = promisify(execFile);

/**
 * Transcription adapter seam. TandemLeaf does NOT bundle a speech model and
 * requires no cloud API. Providers:
 *
 *  - "none":     transcription disabled (default). Pairs can still be linked
 *                by metadata; sentence-exact switching stays unavailable.
 *  - "fixture":  reads a sidecar `*.tandemleaf-transcript.json` next to the
 *                audio (used by the bundled sample library and by anyone who
 *                produces word timestamps out of band). Deterministic.
 *  - "whisper-cli" (EXPERIMENTAL): shells out to a user-installed
 *                whisper.cpp-compatible binary with word timestamps.
 *                See docs/alignment.md for the exact contract.
 */

export const transcriptFileSchema = z.object({
  language: z.string(),
  model: z.string().default('external'),
  /** Words with absolute milliseconds across the whole audiobook. */
  words: z.array(
    z.object({
      w: z.string(),
      s: z.number().int().min(0),
      e: z.number().int().min(0),
    }),
  ),
});
export type TranscriptFile = z.infer<typeof transcriptFileSchema>;

export interface TranscriptionRequest {
  /** Absolute paths of the book's audio files, in playback order. */
  trackPaths: string[];
  /** Absolute start offset of each track (ms). */
  trackStartMs: number[];
  language: string;
  /**
   * TandemLeaf-owned writable directory for intermediate transcription
   * output. Source libraries are read-only mounts and must NEVER be written
   * to; all whisper output prefixes live in a private temp dir under here.
   */
  workDir: string;
  /** For the whisper-cli provider. */
  whisperBin?: string;
  whisperModel?: string;
  /** Resumable checkpoint: index of the next track to process. */
  checkpoint?: { nextTrack: number; words: TranscriptWord[] };
  onCheckpoint?: (cp: { nextTrack: number; words: TranscriptWord[] }) => void;
  /** Abort external processes (e.g. the job lease was lost). */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  language: string;
  model: string;
  words: TranscriptWord[];
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(req: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Locate the sidecar transcript for a book (dir-level or file-level). */
export function findSidecarTranscript(trackPaths: string[]): string | null {
  if (trackPaths.length === 0) return null;
  const first = trackPaths[0]!;
  const dirSidecar = path.join(path.dirname(first), 'transcript.tandemleaf.json');
  if (fs.existsSync(dirSidecar)) return dirSidecar;
  const fileSidecar = first.replace(/\.[^.]+$/, '') + '.tandemleaf-transcript.json';
  if (fs.existsSync(fileSidecar)) return fileSidecar;
  return null;
}

export class FixtureProvider implements TranscriptionProvider {
  readonly name = 'fixture';

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const sidecar = findSidecarTranscript(req.trackPaths);
    if (!sidecar) {
      throw new Error(
        'No sidecar transcript found (expected transcript.tandemleaf.json next to the audio). ' +
          'The "fixture" provider only reads pre-computed word timestamps.',
      );
    }
    const parsed = transcriptFileSchema.parse(JSON.parse(fs.readFileSync(sidecar, 'utf8')));
    const words = parsed.words
      .map((w) => ({ w: normalizeForMatch(w.w), s: w.s, e: w.e }))
      .filter((w) => w.w.length > 0);
    return { language: parsed.language, model: parsed.model, words };
  }
}

/** Longest a single whisper run may take before it is killed (per track). */
const WHISPER_TIMEOUT_MS = 6 * 3600_000;
/** Longest an ffmpeg decode to 16 kHz WAV may take (per track). */
const TRANSCODE_TIMEOUT_MS = 30 * 60_000;

interface WhisperToken {
  text?: unknown;
  offsets?: { from?: unknown; to?: unknown };
}
interface WhisperSegment {
  offsets?: { from?: unknown; to?: unknown };
  tokens?: WhisperToken[];
}

/**
 * Merge whisper.cpp's sub-word BPE tokens into whole words. A token that
 * begins with whitespace starts a new word; the rest of the pieces (e.g.
 * " light" "house") are glued to it. Special tokens such as `[_BEG_]` and
 * `[_TT_123]` are skipped. Timings span the first to the last piece.
 * Exported for tests.
 */
export function mergeWhisperTokens(segments: WhisperSegment[], offsetMs: number): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let current: { raw: string; s: number; e: number } | null = null;
  const flush = () => {
    if (!current) return;
    const w = normalizeForMatch(current.raw);
    if (w) out.push({ w, s: current.s, e: current.e });
    current = null;
  };
  for (const seg of segments) {
    for (const tok of seg.tokens ?? []) {
      const raw = String(tok.text ?? '');
      if (!raw || /^\[_[A-Z_0-9]+\]$/.test(raw.trim())) continue;
      const s = Number(tok.offsets?.from ?? seg.offsets?.from ?? 0) + offsetMs;
      const e = Number(tok.offsets?.to ?? seg.offsets?.to ?? s) + offsetMs;
      const startsWord = /^\s/.test(raw) || current === null;
      if (startsWord) {
        flush();
        current = { raw: raw.trim(), s, e: Math.max(s, e) };
      } else {
        current!.raw += raw.trim();
        current!.e = Math.max(current!.e, e);
      }
    }
    // Segment boundaries always end a word.
    flush();
  }
  flush();
  return out;
}

/**
 * EXPERIMENTAL: invokes a whisper.cpp-style CLI per track and stitches
 * absolute timestamps. Expects the binary to accept:
 *   <bin> -m <model> -l <language> -ojf -of <outprefix> <audio.wav>
 * and to write `<outprefix>.json` in whisper.cpp "full JSON" layout
 * (transcription[].offsets + tokens[].text/offsets). Tested against
 * whisper.cpp `main`/`whisper-cli`; other CLIs may need a wrapper script.
 *
 * Each track is first decoded with ffmpeg to the 16 kHz mono PCM WAV that
 * whisper.cpp expects — so m4b/m4a (AAC), the dominant audiobook formats,
 * work without the user transcoding anything. If ffmpeg is unavailable or
 * fails, the original file is passed through unchanged.
 */
export class WhisperCliProvider implements TranscriptionProvider {
  readonly name = 'whisper-cli';

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    if (!req.whisperBin) throw new Error('TL_WHISPER_BIN is not configured');
    if (!fs.existsSync(req.whisperBin)) {
      throw new Error(`Whisper binary not found: ${req.whisperBin}`);
    }
    if (req.whisperModel && !fs.existsSync(req.whisperModel)) {
      throw new Error(`Whisper model not found: ${req.whisperModel}`);
    }
    const words: TranscriptWord[] = req.checkpoint?.words ? [...req.checkpoint.words] : [];
    const startTrack = req.checkpoint?.nextTrack ?? 0;
    // All whisper output lives in a private temp dir under the TandemLeaf
    // cache; source libraries are read-only and are never written to.
    fs.mkdirSync(req.workDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(req.workDir, 'whisper-'));
    try {
      for (let t = startTrack; t < req.trackPaths.length; t++) {
        const trackPath = req.trackPaths[t]!;
        const outPrefix = path.join(tmpDir, `track_${t}`);
        const input = await decodeForWhisper(trackPath, `${outPrefix}.wav`, req.signal);
        const args = ['-ojf', '-of', outPrefix, input];
        if (req.whisperModel) args.unshift('-m', req.whisperModel);
        if (req.language) args.unshift('-l', req.language);
        try {
          await execFileP(req.whisperBin, args, {
            maxBuffer: 64 * 1024 * 1024,
            timeout: WHISPER_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            signal: req.signal,
          });
        } finally {
          if (input !== trackPath) fs.rmSync(input, { force: true });
        }
        const jsonPath = `${outPrefix}.json`;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
          transcription?: WhisperSegment[];
        };
        fs.rmSync(jsonPath, { force: true });
        words.push(...mergeWhisperTokens(data.transcription ?? [], req.trackStartMs[t] ?? 0));
        req.onCheckpoint?.({ nextTrack: t + 1, words });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    return {
      language: req.language,
      model: `whisper-cli:${path.basename(req.whisperModel || 'default')}`,
      words,
    };
  }
}

/**
 * Decode any container/codec ffmpeg understands to 16 kHz mono 16-bit WAV.
 * Returns the WAV path, or the original path when ffmpeg is missing/fails
 * (already-WAV inputs are passed through as-is).
 */
async function decodeForWhisper(
  trackPath: string,
  wavPath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (/\.wav$/i.test(trackPath)) return trackPath;
  try {
    await execFileP(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-i',
        trackPath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'wav',
        wavPath,
      ],
      { maxBuffer: 1024 * 1024, timeout: TRANSCODE_TIMEOUT_MS, killSignal: 'SIGKILL', signal },
    );
    return wavPath;
  } catch {
    fs.rmSync(wavPath, { force: true });
    return trackPath;
  }
}

export function getProvider(name: string): TranscriptionProvider | null {
  if (name === 'fixture') return new FixtureProvider();
  if (name === 'whisper-cli') return new WhisperCliProvider();
  return null;
}
