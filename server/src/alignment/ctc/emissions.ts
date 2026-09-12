import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { probeAudio } from '../../audio/probe.js';

/**
 * CTC emission front end: turns a book's audio tracks into one continuous
 * stream of romanized characters, each stamped with the absolute millisecond
 * of the acoustic frame that emitted it.
 *
 * This replaces ASR (whisper) as the acoustic side of alignment. We do not
 * need a transcript — we need a *timed character stream* that the matcher can
 * anchor against the ebook's own characters. A 300M CTC forced-aligner model
 * produces that ~6x faster than whisper and, measured on real human narration,
 * with far better anchor quality (see docs/alignment.md and the validation
 * notes: 18,913 shared 14-grams, 99.94% monotone).
 *
 * Shape of the model output: [1, frames, vocab] log-probabilities, one frame
 * per 320 input samples (20.0 ms at 16 kHz) over a 400-sample window. The
 * vocabulary has ~31 entries: a blank at id 0, a few `<...>` specials, and the
 * romanized letters. There is no space token, so the decode is one
 * uninterrupted character stream — exactly what the n-gram matcher wants.
 *
 * Streaming is not an optimisation here, it is a requirement: a 6-hour book is
 * 1.4 GB of float32 PCM. ffmpeg's output is consumed chunk-by-chunk and only a
 * ~32 s window is ever resident.
 */

/** One decoded character with its absolute position in the book's audio. */
export interface DecodedChar {
  c: string;
  ms: number;
}

export interface EmissionOptions {
  /** Path to the ONNX model file (int8 build; measured faster than q4f16 on CPU). */
  modelPath: string;
  /** Path to the model's `vocab.json` (token -> id). */
  vocabPath: string;
  /** Absolute paths of the book's audio files, in playback order. */
  trackPaths: string[];
  /** Absolute start offset of each track (ms), parallel to `trackPaths`. */
  trackStartMs: number[];
  /** ONNX intra-op thread count. */
  threads: number;
  /** Abort the decode (e.g. the job lease was lost); kills ffmpeg promptly. */
  signal?: AbortSignal;
  /** Live progress in decoded audio milliseconds. */
  onProgress?: (info: { doneMs: number; totalMs: number }) => void;
}

export interface DecodedBook {
  chars: DecodedChar[];
  /** Absolute end of the decoded audio (ms), i.e. the last track's offset + its length. */
  audioMs: number;
  /** Provenance string for the model that produced these emissions. */
  model: string;
}

/** Sample rate the model was trained at; ffmpeg resamples every track to it. */
export const SAMPLE_RATE = 16_000;
/** Frame hop in samples (320 @ 16 kHz = 20.0 ms). */
const FRAME_HOP = 320;
/** Frame window in samples. */
const FRAME_WINDOW = 400;
/** Milliseconds advanced by one emission frame. */
export const MS_PER_FRAME = (FRAME_HOP / SAMPLE_RATE) * 1000;

/** Core audio decoded per inference call. */
const CHUNK_SAMPLES = 30 * SAMPLE_RATE;
/**
 * Context fed on each side of a chunk and then discarded. The model's
 * receptive field means frames near a hard cut decode badly; one second of
 * overlap is enough that the kept (core) frames are identical to what a
 * whole-file decode would have produced.
 */
const CONTEXT_SAMPLES = 1 * SAMPLE_RATE;
/** Segments shorter than this carry no usable frames; the tail is dropped. */
const MIN_SEGMENT_SAMPLES = 4000;
/** CTC blank. Never emitted. */
const BLANK_ID = 0;

/**
 * Frames the model must emit for `sampleCount` input samples.
 *
 * This is the model's own geometry, not a guess: a 400-sample window advanced
 * by 320 samples. We assert it on every chunk so that swapping in a model with
 * a different stride fails loudly instead of silently shifting every timestamp.
 */
export function frameCount(sampleCount: number): number {
  if (sampleCount < FRAME_WINDOW) return 0;
  return Math.floor((sampleCount - FRAME_WINDOW) / FRAME_HOP) + 1;
}

/** Throws unless the model's reported frame count matches its documented stride. */
export function assertFrameCount(sampleCount: number, reportedFrames: number): void {
  const expected = frameCount(sampleCount);
  if (reportedFrames !== expected) {
    throw new Error(
      `CTC model emitted ${reportedFrames} frames for ${sampleCount} samples, expected ` +
        `${expected} (floor((n-${FRAME_WINDOW})/${FRAME_HOP})+1 = ${MS_PER_FRAME.toFixed(1)} ms ` +
        `per frame). This model has a different frame rate; timestamps would be wrong.`,
    );
  }
}

const vocabSchema = z.record(z.string(), z.number().int().min(0));

/**
 * Parse a `vocab.json` (token -> id) into an id -> token table.
 *
 * Ids must be dense and id 0 must be the blank, because the greedy collapse
 * hard-codes `BLANK_ID`; a vocabulary that violates either assumption would
 * decode into plausible-looking garbage.
 */
export function parseVocab(raw: unknown): string[] {
  const map = vocabSchema.parse(raw);
  const table: string[] = [];
  for (const [token, id] of Object.entries(map)) {
    if (table[id] !== undefined) throw new Error(`vocab has duplicate id ${id}`);
    table[id] = token;
  }
  for (let i = 0; i < table.length; i++) {
    if (table[i] === undefined) throw new Error(`vocab is not dense: no token for id ${i}`);
  }
  const blank = table[BLANK_ID];
  if (blank === undefined || !blank.startsWith('<')) {
    throw new Error(
      `vocab token at id ${BLANK_ID} is ${JSON.stringify(blank)}, expected the blank`,
    );
  }
  return table;
}

/** Per-frame log-probabilities for one chunk, flattened frame-major. */
export interface CtcEmission {
  frames: number;
  vocab: number;
  logits: ArrayLike<number>;
}

/**
 * The acoustic model, reduced to the one operation the decoder needs. Keeping
 * this seam lets the chunking and timestamp arithmetic be tested without the
 * 317 MB model (and without onnxruntime, which CI does not install).
 */
export interface CtcSession {
  run(samples: Float32Array): Promise<CtcEmission>;
}

export interface CollapseInput {
  emission: CtcEmission;
  /** Absolute ms of the first frame in this chunk. */
  segStartMs: number;
  /** Keep only frames in [coreLoMs, coreHiMs); the rest are context. */
  coreLoMs: number;
  coreHiMs: number;
  idToToken: readonly string[];
  /** Argmax id of the previous kept frame (-1 at the start of a track). */
  prevId: number;
  /** Appended in place — a book decodes to ~50k characters and copying adds up. */
  out: DecodedChar[];
}

/**
 * Greedy CTC collapse over one chunk. Returns the new `prevId`.
 *
 * Standard best-path decoding: take the argmax per frame, drop blanks, and
 * drop repeats of the previous frame's id (a held phoneme spans many frames).
 * `<...>` specials (pad, eos, unk) are dropped from the output but still count
 * as "the previous id", so a repeat across one of them stays suppressed.
 *
 * Context frames are skipped before the argmax, so `prevId` only ever tracks
 * frames that were actually kept — the same continuity a whole-file decode has.
 */
export function collapseChunk(input: CollapseInput): number {
  const { emission, segStartMs, coreLoMs, coreHiMs, idToToken, out } = input;
  const { frames, vocab, logits } = emission;
  let prevId = input.prevId;
  for (let f = 0; f < frames; f++) {
    const ms = segStartMs + f * MS_PER_FRAME;
    if (ms < coreLoMs || ms >= coreHiMs) continue;
    let best = 0;
    let bestVal = -Infinity;
    const base = f * vocab;
    for (let v = 0; v < vocab; v++) {
      const x = logits[base + v]!;
      if (x > bestVal) {
        bestVal = x;
        best = v;
      }
    }
    if (best !== prevId && best !== BLANK_ID) {
      const tok = idToToken[best];
      if (tok !== undefined && !tok.startsWith('<')) out.push({ c: tok, ms: Math.round(ms) });
    }
    prevId = best;
  }
  return prevId;
}

/**
 * Sliding PCM window over one track.
 *
 * ffmpeg hands us arbitrarily-sized byte runs that need not land on float
 * boundaries, and `Buffer.concat` gives no 4-byte alignment guarantee for a
 * `Float32Array` view. So bytes are copied into a byte view of an owned,
 * aligned Float32Array; samples are then read directly, and consumed audio is
 * shifted out so the window stays ~32 s regardless of track length.
 */
class PcmWindow {
  private scratch: Float32Array;
  private bytes: Uint8Array;
  private byteLen = 0;
  /** Absolute sample index of scratch[0]. */
  private base = 0;

  constructor(capacitySamples: number) {
    this.scratch = new Float32Array(capacitySamples);
    this.bytes = new Uint8Array(this.scratch.buffer);
  }

  /** Absolute index one past the last complete sample received. */
  get end(): number {
    return this.base + Math.floor(this.byteLen / 4);
  }

  pushBytes(chunk: Uint8Array): void {
    this.ensure(this.byteLen + chunk.length);
    this.bytes.set(chunk, this.byteLen);
    this.byteLen += chunk.length;
  }

  pushSamples(samples: Float32Array): void {
    if (this.byteLen % 4 !== 0) throw new Error('cannot push samples after a partial byte run');
    this.ensure(this.byteLen + samples.length * 4);
    this.scratch.set(samples, this.byteLen / 4);
    this.byteLen += samples.length * 4;
  }

  /** Zero-copy view of [fromAbs, toAbs); valid until the next trim. */
  view(fromAbs: number, toAbs: number): Float32Array {
    return this.scratch.subarray(fromAbs - this.base, toAbs - this.base);
  }

  /** Drop everything before `absStart`. */
  trimTo(absStart: number): void {
    const shift = Math.min(absStart, this.end) - this.base;
    if (shift <= 0) return;
    const shiftBytes = shift * 4;
    this.bytes.copyWithin(0, shiftBytes, this.byteLen);
    this.byteLen -= shiftBytes;
    this.base += shift;
  }

  private ensure(byteCapacity: number): void {
    if (byteCapacity <= this.bytes.length) return;
    const grown = new Float32Array(Math.ceil(Math.max(byteCapacity, this.bytes.length * 2) / 4));
    const grownBytes = new Uint8Array(grown.buffer);
    grownBytes.set(this.bytes.subarray(0, this.byteLen));
    this.scratch = grown;
    this.bytes = grownBytes;
  }
}

export interface TrackDecoderConfig {
  session: CtcSession;
  idToToken: readonly string[];
  /** Absolute ms of this track's first sample. */
  startMs: number;
  out: DecodedChar[];
  signal?: AbortSignal;
  /** Called after each chunk with the track-relative ms decoded so far (rounded). */
  onChunk?: (trackMs: number) => void;
}

/**
 * Chunked decoder for a single track. Audio is pushed in as it arrives (raw
 * ffmpeg bytes, which need not land on float boundaries, or samples); each
 * time a full chunk plus its right-hand context is available, one inference
 * runs and the chunk's core frames are collapsed into `out`.
 *
 * Exported so the streaming path can be driven from a test with a fake session
 * instead of the 317 MB model.
 */
export class TrackDecoder {
  private readonly win = new PcmWindow(CHUNK_SAMPLES + 2 * CONTEXT_SAMPLES + SAMPLE_RATE);
  private chunkIndex = 0;
  /** Reset per track: a new file starts a new CTC path, never a repeat of the old one. */
  private prevId = -1;

  constructor(private readonly cfg: TrackDecoderConfig) {}

  /** Total samples received for this track. */
  get sampleCount(): number {
    return this.win.end;
  }

  async pushBytes(chunk: Uint8Array): Promise<void> {
    this.win.pushBytes(chunk);
    await this.drain(false);
  }

  async pushSamples(samples: Float32Array): Promise<void> {
    this.win.pushSamples(samples);
    await this.drain(false);
  }

  /** Decode the trailing partial chunk. Call once the track's audio has ended. */
  async finish(): Promise<void> {
    await this.drain(true);
  }

  private async drain(final: boolean): Promise<void> {
    for (;;) {
      throwIfAborted(this.cfg.signal);
      const coreLo = this.chunkIndex * CHUNK_SAMPLES;
      const total = this.win.end;
      // Mid-stream we wait until the right-hand context has arrived, so every
      // core frame is decoded with the same surroundings a full decode gives it.
      if (final ? coreLo >= total : total < coreLo + CHUNK_SAMPLES + CONTEXT_SAMPLES) return;

      const segLo = Math.max(0, coreLo - CONTEXT_SAMPLES);
      const segHi = Math.min(total, coreLo + CHUNK_SAMPLES + CONTEXT_SAMPLES);
      const coreHi = Math.min(total, coreLo + CHUNK_SAMPLES);
      const seg = this.win.view(segLo, segHi);
      if (seg.length < MIN_SEGMENT_SAMPLES) return;

      const emission = await this.cfg.session.run(seg);
      assertFrameCount(seg.length, emission.frames);
      this.prevId = collapseChunk({
        emission,
        segStartMs: this.cfg.startMs + (segLo / SAMPLE_RATE) * 1000,
        coreLoMs: this.cfg.startMs + (coreLo / SAMPLE_RATE) * 1000,
        coreHiMs: this.cfg.startMs + (coreHi / SAMPLE_RATE) * 1000,
        idToToken: this.cfg.idToToken,
        prevId: this.prevId,
        out: this.cfg.out,
      });

      this.chunkIndex++;
      this.win.trimTo(Math.max(0, this.chunkIndex * CHUNK_SAMPLES - CONTEXT_SAMPLES));
      this.cfg.onChunk?.(Math.round((coreHi / SAMPLE_RATE) * 1000));
    }
  }
}

export interface DecodeSamplesOptions {
  session: CtcSession;
  idToToken: readonly string[];
  samples: Float32Array;
  /** Absolute ms of `samples[0]` in the book's timeline. */
  startMs: number;
  out: DecodedChar[];
  signal?: AbortSignal;
  onChunk?: (trackMs: number) => void;
}

/**
 * Decode one in-memory track. Used by tests and by any caller that already
 * holds PCM; `decodeBook` drives the exact same decoder from an ffmpeg stream.
 * The samples are fed in small pushes so this path exercises the streaming
 * chunk boundaries rather than a convenient single-shot one.
 */
export async function decodeTrackSamples(opts: DecodeSamplesOptions): Promise<void> {
  const decoder = new TrackDecoder({
    session: opts.session,
    idToToken: opts.idToToken,
    startMs: opts.startMs,
    out: opts.out,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
  for (let off = 0; off < opts.samples.length; off += SAMPLE_RATE) {
    await decoder.pushSamples(opts.samples.subarray(off, off + SAMPLE_RATE));
  }
  await decoder.finish();
}

/* ------------------------------------------------------------------ */
/* onnxruntime-node (optional native dependency)                       */
/* ------------------------------------------------------------------ */

interface OrtValue {
  dims: readonly number[];
  data: Float32Array;
}

interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtValue>): Promise<Record<string, OrtValue>>;
  release?(): Promise<void>;
}

interface OrtModule {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtValue;
  InferenceSession: {
    create(
      modelPath: string,
      options: { intraOpNumThreads: number; graphOptimizationLevel: 'all' },
    ): Promise<OrtSession>;
  };
}

/**
 * Typed as `string` on purpose: the specifier must stay out of the static
 * import graph so a server without the native runtime still boots and reports
 * the CTC engine as unavailable instead of failing at module load.
 */
const ORT_PACKAGE: string = 'onnxruntime-node';

/**
 * Roots to `require` from when a bare import fails. In the container the
 * runtime is installed outside the app tree (it is a large optional native
 * dep) and, measured on node:26-slim, ESM resolution does not find it there —
 * neither a bare import nor NODE_PATH — while a CommonJS require rooted at the
 * install directory does.
 */
function ortRequireRoots(): string[] {
  const roots: string[] = [];
  const configured = process.env['VX_ORT_DIR'];
  if (configured) roots.push(configured.endsWith(path.sep) ? configured : configured + path.sep);
  roots.push('/opt/ort/lib/node_modules/');
  return roots;
}

let ortPromise: Promise<OrtModule> | null = null;

/** Load onnxruntime-node once per process. Rejects with every path we tried. */
export function loadOnnxRuntime(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = loadOnnxRuntimeOnce();
    // A failure must not be cached: the operator can install the runtime and
    // retry the job without restarting the server.
    ortPromise.catch(() => {
      ortPromise = null;
    });
  }
  return ortPromise;
}

async function loadOnnxRuntimeOnce(): Promise<OrtModule> {
  const tried: string[] = [];
  try {
    const mod = (await import(ORT_PACKAGE)) as { default?: OrtModule } & OrtModule;
    return mod.default ?? mod;
  } catch (err) {
    tried.push(`import: ${(err as Error).message}`);
  }
  for (const root of ortRequireRoots()) {
    try {
      return createRequire(root)(ORT_PACKAGE) as OrtModule;
    } catch (err) {
      tried.push(`require(${root}): ${(err as Error).message}`);
    }
  }
  throw new Error(`onnxruntime-node is not installed or failed to load — ${tried.join('; ')}`);
}

export interface EngineStatus {
  available: boolean;
  error?: string;
}

/** Non-throwing probe for the settings UI / job preflight. */
export async function checkCtcEngine(): Promise<EngineStatus> {
  try {
    await loadOnnxRuntime();
    return { available: true };
  } catch (err) {
    return { available: false, error: (err as Error).message };
  }
}

async function createOrtSession(
  modelPath: string,
  threads: number,
): Promise<{ session: CtcSession; close: () => Promise<void> }> {
  const ort = await loadOnnxRuntime();
  const sess = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: Math.max(1, Math.floor(threads)),
    graphOptimizationLevel: 'all',
  });
  const inName = sess.inputNames[0];
  const outName = sess.outputNames[0];
  if (!inName || !outName) throw new Error(`model ${modelPath} exposes no input/output tensor`);

  const session: CtcSession = {
    async run(samples: Float32Array): Promise<CtcEmission> {
      // `samples` is a view into the sliding window; hand the native binding a
      // standalone, zero-offset buffer rather than relying on it honouring
      // byteOffset.
      const feeds = { [inName]: new ort.Tensor('float32', samples.slice(), [1, samples.length]) };
      const out = await sess.run(feeds);
      const tensor = out[outName];
      if (!tensor) throw new Error(`model produced no "${outName}" output`);
      const dims = tensor.dims;
      if (dims.length !== 3 || dims[0] !== 1) {
        throw new Error(`unexpected emission shape [${dims.join(', ')}], expected [1, frames, V]`);
      }
      return { frames: dims[1]!, vocab: dims[2]!, logits: tensor.data };
    },
  };
  const close = async (): Promise<void> => {
    await sess.release?.();
  };
  return { session, close };
}

/* ------------------------------------------------------------------ */
/* book decode                                                         */
/* ------------------------------------------------------------------ */

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('CTC decode aborted');
}

/** Short provenance id, e.g. `mms-300m-1130-forced-aligner/model_int8.onnx`. */
function modelId(modelPath: string): string {
  const base = path.basename(modelPath);
  const dir = path.basename(path.dirname(modelPath));
  return dir && dir !== '.' && dir !== path.sep ? `${dir}/${base}` : base;
}

/**
 * Total audio length for the progress bar. Derived from ffprobe rather than
 * from the decode itself, which only learns a track's length once it has
 * finished it. Best-effort: progress accuracy is not worth failing a job over.
 */
async function estimateTotalMs(trackPaths: string[], trackStartMs: number[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < trackPaths.length; i++) {
    try {
      const probe = await probeAudio(trackPaths[i]!);
      total = Math.max(total, (trackStartMs[i] ?? 0) + probe.durationMs);
    } catch {
      total = Math.max(total, trackStartMs[i] ?? 0);
    }
  }
  return total;
}

/** Decode one track through ffmpeg; returns the track's decoded length in ms. */
async function decodeTrackFile(
  filePath: string,
  decoder: TrackDecoder,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  const child = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on('close', (code) => resolve(code)),
  );
  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for await (const piece of child.stdout) {
      if (signal?.aborted) break;
      await decoder.pushBytes(piece as Buffer);
    }
  } catch (err) {
    // A decode failure (or abort) must not leave ffmpeg streaming a whole book
    // into a closed pipe.
    child.kill('SIGKILL');
    await exited;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const code = await exited;
  throwIfAborted(signal);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code} on ${filePath}: ${stderrTail.trim()}`);
  }
  await decoder.finish();
  return Math.round((decoder.sampleCount / SAMPLE_RATE) * 1000);
}

/**
 * Decode a whole book into one timestamped character stream.
 *
 * Timestamps are absolute across the book: each track's frames are offset by
 * its `trackStartMs`, so a multi-file audiobook produces the same monotone
 * stream a single file would.
 */
export async function decodeBook(opts: EmissionOptions): Promise<DecodedBook> {
  if (opts.trackPaths.length !== opts.trackStartMs.length) {
    throw new Error('trackPaths and trackStartMs must have the same length');
  }
  if (os.endianness() !== 'LE') {
    throw new Error('CTC decoding requires a little-endian host (ffmpeg emits f32le)');
  }
  throwIfAborted(opts.signal);

  const idToToken = parseVocab(JSON.parse(fs.readFileSync(opts.vocabPath, 'utf8')));
  const { session, close } = await createOrtSession(opts.modelPath, opts.threads);

  try {
    const totalMs = await estimateTotalMs(opts.trackPaths, opts.trackStartMs);
    const chars: DecodedChar[] = [];
    let audioMs = 0;
    let doneMs = 0;

    for (let i = 0; i < opts.trackPaths.length; i++) {
      const startMs = opts.trackStartMs[i]!;
      const base = doneMs;
      const decoder = new TrackDecoder({
        session,
        idToToken,
        startMs,
        out: chars,
        signal: opts.signal,
        onChunk: (trackMs) => {
          doneMs = base + trackMs;
          opts.onProgress?.({ doneMs, totalMs: Math.max(totalMs, doneMs) });
        },
      });
      const trackMs = await decodeTrackFile(opts.trackPaths[i]!, decoder, opts.signal);
      doneMs = base + trackMs;
      audioMs = Math.max(audioMs, startMs + trackMs);
      opts.onProgress?.({ doneMs, totalMs: Math.max(totalMs, doneMs) });
    }

    return { chars, audioMs: Math.round(audioMs), model: modelId(opts.modelPath) };
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ */
/* probe decode (sparse)                                               */
/* ------------------------------------------------------------------ */

/** A stretch of the book's audio to decode, in absolute book milliseconds. */
export interface ProbeWindow {
  startMs: number;
  durationMs: number;
}

/**
 * Emitted between two probes.
 *
 * Sparse decoding cuts the narration into islands, and two islands minutes
 * apart must never read as one continuous character run: an n-gram straddling
 * the seam would be a phrase the narrator never spoke, matched against a book
 * position that is nowhere near either probe. A space is outside the model's
 * alphabet (`a`-`z` and an apostrophe) and outside anything romanization can
 * produce, so every gram containing one fails to match the book by
 * construction — no matcher change, no boundary bookkeeping to get wrong.
 */
export const PROBE_BREAK = ' ';

export interface ProbeDecoderOptions {
  modelPath: string;
  vocabPath: string;
  trackPaths: string[];
  trackStartMs: number[];
  /**
   * Each track's length, if the caller already knows it. The library scan
   * measured these when it indexed the book, and asking ffprobe again costs a
   * process per file — thirty-one of them on a long audiobook, over whatever
   * mount the library lives on. Omit an entry and it is measured.
   */
  trackDurationMs?: (number | undefined)[];
  threads: number;
  signal?: AbortSignal;
}

export interface ProbeDecoder {
  /** Provenance string for the model. */
  readonly model: string;
  /** True length of the book's audio, from ffprobe. */
  readonly audioMs: number;
  /**
   * Decode `windows`, returning one character run per window, in the order the
   * windows were given. Runs are kept apart rather than concatenated because
   * probes arrive in schedule order, not playback order, and only the caller
   * knows how to interleave a refinement round with what it already has —
   * see `assembleProbes` in sparse.ts.
   */
  decode(
    windows: ProbeWindow[],
    onWindow?: (done: number, total: number) => void,
  ): Promise<DecodedChar[][]>;
  close(): Promise<void>;
}

/** Context decoded on each side of a probe and then discarded. */
const PROBE_CONTEXT_MS = 1000;
/** Longest core decoded in a single inference; longer probes are split. */
const PROBE_MAX_CORE_MS = 30_000;

interface Track {
  path: string;
  startMs: number;
  durationMs: number;
}

/**
 * Open a decoder that reads only the parts of the audio it is asked for.
 *
 * {@link decodeBook} streams every sample through the model, which costs about
 * a fifth of real time — over an hour of compute for a six-hour book.
 * Alignment does not need every sample. It needs enough anchors to pin the
 * text to the timeline, and those come from short probes spread across the
 * narration; everything between two anchors is interpolation, and interpolation
 * over a couple of minutes of steady reading is accurate to a few seconds.
 *
 * So this front end seeks instead of streaming, and keeps the ONNX session open
 * across rounds so that a refinement pass costs no model load.
 */
export async function openProbeDecoder(opts: ProbeDecoderOptions): Promise<ProbeDecoder> {
  if (opts.trackPaths.length !== opts.trackStartMs.length) {
    throw new Error('trackPaths and trackStartMs must have the same length');
  }
  if (os.endianness() !== 'LE') {
    throw new Error('CTC decoding requires a little-endian host (ffmpeg emits f32le)');
  }
  throwIfAborted(opts.signal);

  const idToToken = parseVocab(JSON.parse(fs.readFileSync(opts.vocabPath, 'utf8')));
  const tracks: Track[] = [];
  for (let i = 0; i < opts.trackPaths.length; i++) {
    const filePath = opts.trackPaths[i]!;
    const known = opts.trackDurationMs?.[i];
    const durationMs = known && known > 0 ? known : (await probeAudio(filePath)).durationMs;
    tracks.push({ path: filePath, startMs: opts.trackStartMs[i]!, durationMs });
  }
  const audioMs = tracks.reduce((a, t) => Math.max(a, t.startMs + t.durationMs), 0);
  const { session, close } = await createOrtSession(opts.modelPath, opts.threads);

  return {
    model: modelId(opts.modelPath),
    audioMs,
    async decode(windows, onWindow) {
      const runs: DecodedChar[][] = [];
      // ffmpeg and the model take turns on different resources — one seeks and
      // decodes an mp3, the other saturates the CPU — so reading the next
      // probe while the model works on this one is free. Exactly one read runs
      // ahead: two would double the memory for no further gain, since the
      // model is always the slower of the pair.
      let ahead = readProbe(tracks, windows[0], opts.signal);
      for (let i = 0; i < windows.length; i++) {
        throwIfAborted(opts.signal);
        const pcm = await ahead;
        ahead = readProbe(tracks, windows[i + 1], opts.signal);
        const out: DecodedChar[] = [];
        if (pcm) await decodeProbe(session, idToToken, pcm, out);
        runs.push(out);
        onWindow?.(i + 1, windows.length);
      }
      // A read started for a window we never reached (an abort, or the loop
      // ending) must still be awaited, or its ffmpeg outlives the decode.
      await ahead?.catch(() => null);
      return runs;
    },
    close,
  };
}

/** The track a book-timeline instant falls in, or null past the end. */
function trackAt(tracks: Track[], ms: number): Track | null {
  for (const t of tracks) {
    if (ms >= t.startMs && ms < t.startMs + t.durationMs) return t;
  }
  return null;
}

/** A probe's audio, with the offsets needed to stamp its frames. */
interface ProbePcm {
  samples: Float32Array;
  /** Absolute ms of samples[0], context included. */
  segStartMs: number;
  /** The part that is not context and whose characters are kept. */
  coreLoMs: number;
  coreHiMs: number;
}

/**
 * Read one probe's audio.
 *
 * A little more than asked for is read on each side and later thrown away,
 * because the model decodes badly across a hard cut and a probe is nothing but
 * two hard cuts.
 *
 * A probe that lands past the end of every track, or that yields too little
 * audio to carry a frame, returns null rather than failing the alignment: the
 * schedule comes from a duration estimate and has to tolerate being slightly
 * wrong at the seams.
 */
async function readProbe(
  tracks: Track[],
  win: ProbeWindow | undefined,
  signal: AbortSignal | undefined,
): Promise<ProbePcm | null> {
  if (!win) return null;
  const track = trackAt(tracks, win.startMs);
  if (!track) return null;
  // Clipped to the track: a probe never spans a file boundary, because the two
  // halves need separate seeks and the sliver lost at the join is worth nothing.
  const relStart = win.startMs - track.startMs;
  const coreMs = Math.min(win.durationMs, track.durationMs - relStart);
  if (coreMs < 1000) return null;

  const readStart = Math.max(0, relStart - PROBE_CONTEXT_MS);
  const readEnd = Math.min(track.durationMs, relStart + coreMs + PROBE_CONTEXT_MS);
  const samples = await readPcm(track.path, readStart, readEnd - readStart, signal);
  if (samples.length < MIN_SEGMENT_SAMPLES) return null;

  const coreLoMs = track.startMs + relStart;
  return {
    samples,
    segStartMs: track.startMs + readStart,
    coreLoMs,
    coreHiMs: coreLoMs + coreMs,
  };
}

/** Run the model over one probe's audio and collapse its core into `out`. */
async function decodeProbe(
  session: CtcSession,
  idToToken: readonly string[],
  pcm: ProbePcm,
  out: DecodedChar[],
): Promise<void> {
  const maxCore = Math.round((PROBE_MAX_CORE_MS / 1000) * SAMPLE_RATE);
  for (let off = 0; off < pcm.samples.length; off += maxCore) {
    const lo = Math.max(0, off - SAMPLE_RATE);
    const hi = Math.min(pcm.samples.length, off + maxCore + SAMPLE_RATE);
    const seg = pcm.samples.subarray(lo, hi);
    if (seg.length < MIN_SEGMENT_SAMPLES) break;
    const emission = await session.run(seg);
    assertFrameCount(seg.length, emission.frames);
    collapseChunk({
      emission,
      segStartMs: pcm.segStartMs + (lo / SAMPLE_RATE) * 1000,
      coreLoMs: Math.max(pcm.coreLoMs, pcm.segStartMs + (off / SAMPLE_RATE) * 1000),
      coreHiMs: Math.min(pcm.coreHiMs, pcm.segStartMs + ((off + maxCore) / SAMPLE_RATE) * 1000),
      idToToken,
      // Every probe starts a fresh CTC path: there is no previous frame to
      // suppress a repeat against when the audio before it was never decoded.
      prevId: -1,
      out,
    });
  }
}

/**
 * Decode `durationMs` of mono 16 kHz audio starting `startMs` into `filePath`.
 *
 * `-ss` before `-i` so ffmpeg seeks rather than decoding and discarding the
 * whole head — that is the entire point of probing. Measured against a
 * contiguous decode of the same book, the seek costs no timestamp accuracy
 * worth correcting for.
 */
async function readPcm(
  filePath: string,
  startMs: number,
  durationMs: number,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  throwIfAborted(signal);
  const child = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-ss',
      (startMs / 1000).toFixed(3),
      '-t',
      (durationMs / 1000).toFixed(3),
      '-i',
      filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      'f32le',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderrTail = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  const onAbort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', onAbort, { once: true });

  // ffmpeg's byte runs need not land on float boundaries, and Buffer.concat
  // gives no 4-byte alignment guarantee, so bytes are copied into a byte view
  // of an owned Float32Array exactly as the streaming path does.
  const win = new PcmWindow(Math.ceil(((durationMs + 2000) / 1000) * SAMPLE_RATE));
  try {
    for await (const piece of child.stdout) {
      if (signal?.aborted) break;
      win.pushBytes(piece as Buffer);
    }
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const code = await exited;
  throwIfAborted(signal);
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code} on ${filePath}: ${stderrTail.trim()}`);
  }
  // Copied out of the window: the view is only valid until the next trim, and
  // the caller keeps these samples across several inference calls.
  return win.view(0, win.end).slice();
}
