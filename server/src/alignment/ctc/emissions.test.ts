import { describe, expect, it } from 'vitest';
import {
  type CtcEmission,
  type CtcSession,
  type DecodedChar,
  MS_PER_FRAME,
  SAMPLE_RATE,
  TrackDecoder,
  assertFrameCount,
  collapseChunk,
  decodeTrackSamples,
  frameCount,
  parseVocab,
} from './emissions.js';

/** Blank at 0, one special, two letters — the shape of the real 31-token vocab. */
const VOCAB = ['<blank>', 'a', 'b', '<unk>'];
const FRAME_HOP = 320;

/** One-hot-ish log-probabilities for a scripted argmax path. */
function emissionOf(ids: number[], vocab = VOCAB.length): CtcEmission {
  const logits = new Float32Array(ids.length * vocab).fill(-9);
  ids.forEach((id, f) => {
    logits[f * vocab + id] = 3;
  });
  return { frames: ids.length, vocab, logits };
}

/**
 * Fake acoustic model: every sample carries the token id of the frame it
 * belongs to, so the session can reconstruct the scripted path from whatever
 * segment the decoder hands it. That makes the chunk/context arithmetic — not
 * a mock's call order — the thing under test.
 */
function samplesForScript(frames: number, idAt: (frame: number) => number): Float32Array {
  const n = (frames - 1) * FRAME_HOP + 400;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = idAt(Math.min(frames - 1, Math.floor(i / FRAME_HOP)));
  return samples;
}

const scriptSession: CtcSession = {
  run(samples: Float32Array): Promise<CtcEmission> {
    const frames = frameCount(samples.length);
    const ids: number[] = [];
    for (let f = 0; f < frames; f++) ids.push(Math.round(samples[f * FRAME_HOP]!));
    return Promise.resolve(emissionOf(ids));
  },
};

describe('frame geometry', () => {
  it('matches the model stride (400-sample window, 320-sample hop)', () => {
    expect(MS_PER_FRAME).toBe(20);
    expect(frameCount(400)).toBe(1);
    expect(frameCount(719)).toBe(1); // one hop short of a second frame
    expect(frameCount(720)).toBe(2);
    expect(frameCount(SAMPLE_RATE)).toBe(49);
    expect(frameCount(399)).toBe(0);
  });

  it('assertFrameCount accepts the expected count and rejects any other stride', () => {
    expect(() => assertFrameCount(SAMPLE_RATE, 49)).not.toThrow();
    // A model with a 160-sample hop would report 98 frames here.
    expect(() => assertFrameCount(SAMPLE_RATE, 98)).toThrow(/expected 49/);
    expect(() => assertFrameCount(SAMPLE_RATE, 98)).toThrow(/different frame rate/);
  });
});

describe('parseVocab', () => {
  it('inverts token -> id into a dense id -> token table', () => {
    expect(parseVocab({ '<blank>': 0, a: 1, b: 2 })).toEqual(['<blank>', 'a', 'b']);
  });

  it('rejects a vocabulary the greedy collapse would silently mis-decode', () => {
    expect(() => parseVocab({ '<blank>': 0, a: 1, b: 3 })).toThrow(/not dense/);
    expect(() => parseVocab({ a: 0, '<blank>': 1 })).toThrow(/expected the blank/);
    expect(() => parseVocab({ a: 1, b: 1 })).toThrow(/duplicate id/);
    expect(() => parseVocab({ a: 'x' })).toThrow();
  });
});

describe('collapseChunk', () => {
  const collapse = (ids: number[], prevId = -1, core = { lo: -Infinity, hi: Infinity }) => {
    const out: DecodedChar[] = [];
    const next = collapseChunk({
      emission: emissionOf(ids),
      segStartMs: 0,
      coreLoMs: core.lo,
      coreHiMs: core.hi,
      idToToken: VOCAB,
      prevId,
      out,
    });
    return { out, next };
  };

  it('drops blanks and repeated frames, keeping the first frame of each run', () => {
    // a a _ a b b _ b
    const { out } = collapse([1, 1, 0, 1, 2, 2, 0, 2]);
    expect(out).toEqual([
      { c: 'a', ms: 0 },
      { c: 'a', ms: 60 },
      { c: 'b', ms: 80 },
      { c: 'b', ms: 140 },
    ]);
  });

  it('drops <specials> from the output but still counts them as the previous id', () => {
    const { out } = collapse([3, 1, 3, 3, 1]);
    expect(out).toEqual([
      { c: 'a', ms: 20 },
      { c: 'a', ms: 80 },
    ]);
  });

  it('carries prevId across chunks so a held token is not emitted twice', () => {
    const first = collapse([0, 2]);
    expect(first.next).toBe(2);
    const second = collapse([2, 2, 1], first.next);
    expect(second.out).toEqual([{ c: 'a', ms: 40 }]);
  });

  it('ignores frames outside the core window and does not let them set prevId', () => {
    // Frames at 0/20/40 ms are left context; the core is [60, 100) ms.
    const { out, next } = collapse([1, 1, 1, 1, 2, 1], -1, { lo: 60, hi: 100 });
    // 'a' is emitted at the first core frame even though its run started in the
    // context, and the 100 ms frame belongs to the next chunk's core.
    expect(out).toEqual([
      { c: 'a', ms: 60 },
      { c: 'b', ms: 80 },
    ]);
    expect(next).toBe(2);
  });

  it('skips ids with no token (a vocab shorter than the model output)', () => {
    const out: DecodedChar[] = [];
    collapseChunk({
      emission: emissionOf([4, 1], 6),
      segStartMs: 0,
      coreLoMs: -Infinity,
      coreHiMs: Infinity,
      idToToken: VOCAB,
      prevId: -1,
      out,
    });
    expect(out).toEqual([{ c: 'a', ms: 20 }]);
  });
});

describe('decodeTrackSamples', () => {
  // 1600 frames = 32.005 s: two chunks, so frame 1500 lands exactly on the
  // boundary between chunk 0's core and chunk 1's.
  const TRACK_A_FRAMES = 1600;
  const trackA = samplesForScript(TRACK_A_FRAMES, (f) => {
    if (f === 3 || f === 4) return 1; // repeat inside one chunk
    if (f === 1500) return 2; // first core frame of chunk 1
    if (f === 1501) return 3; // <unk>: dropped, but breaks the repeat run
    if (f === 1599) return 1; // last frame of the track
    return 0;
  });
  const trackB = samplesForScript(100, (f) => {
    if (f === 0) return 1; // same id the previous track ended on
    if (f === 10 || f === 11) return 2;
    if (f === 50) return 2;
    return 0;
  });

  it('stamps characters with absolute ms across a multi-track book', async () => {
    const chars: DecodedChar[] = [];
    const progress: number[] = [];
    await decodeTrackSamples({
      session: scriptSession,
      idToToken: VOCAB,
      samples: trackA,
      startMs: 0,
      out: chars,
      onChunk: (ms) => progress.push(ms),
    });
    // Track B starts at 40 s, which is NOT where track A ended: the caller's
    // offsets are authoritative (gapless re-timed books, skipped intros).
    await decodeTrackSamples({
      session: scriptSession,
      idToToken: VOCAB,
      samples: trackB,
      startMs: 40_000,
      out: chars,
    });

    expect(chars).toEqual([
      { c: 'a', ms: 60 },
      { c: 'b', ms: 30_000 },
      { c: 'a', ms: 31_980 },
      { c: 'a', ms: 40_000 },
      { c: 'b', ms: 40_200 },
      { c: 'b', ms: 41_000 },
    ]);
    // Chunk boundaries are seams, not holes: every core frame is decoded once.
    expect(progress).toEqual([30_000, 32_005]);
    for (let i = 1; i < chars.length; i++) expect(chars[i]!.ms).toBeGreaterThan(chars[i - 1]!.ms);
  });

  it('decodes a chunk boundary the same way a single-shot decode would', async () => {
    // One inference over the whole track, no chunking: same character stream.
    const whole = await scriptSession.run(trackA);
    const expected: DecodedChar[] = [];
    collapseChunk({
      emission: whole,
      segStartMs: 0,
      coreLoMs: -Infinity,
      coreHiMs: Infinity,
      idToToken: VOCAB,
      prevId: -1,
      out: expected,
    });
    const chars: DecodedChar[] = [];
    await decodeTrackSamples({
      session: scriptSession,
      idToToken: VOCAB,
      samples: trackA,
      startMs: 0,
      out: chars,
    });
    expect(chars).toEqual(expected);
  });

  it('decodes raw ffmpeg bytes that split across float boundaries', async () => {
    // ffmpeg hands over arbitrary byte runs; a sample can straddle two of them.
    const bytes = new Uint8Array(trackB.buffer.slice(0), 0, trackB.length * 4);
    const streamed: DecodedChar[] = [];
    const decoder = new TrackDecoder({
      session: scriptSession,
      idToToken: VOCAB,
      startMs: 7_000,
      out: streamed,
    });
    for (let off = 0; off < bytes.length; off += 4093) {
      await decoder.pushBytes(bytes.subarray(off, Math.min(off + 4093, bytes.length)));
    }
    await decoder.finish();
    expect(decoder.sampleCount).toBe(trackB.length);

    const direct: DecodedChar[] = [];
    await decodeTrackSamples({
      session: scriptSession,
      idToToken: VOCAB,
      samples: trackB,
      startMs: 7_000,
      out: direct,
    });
    expect(streamed).toEqual(direct);
    expect(streamed[0]).toEqual({ c: 'a', ms: 7_000 });
  });

  it('fails loudly when the model emits a different number of frames', async () => {
    const wrongStride: CtcSession = {
      async run(samples) {
        const real = await scriptSession.run(samples);
        return { ...real, frames: real.frames + 1 };
      },
    };
    await expect(
      decodeTrackSamples({
        session: wrongStride,
        idToToken: VOCAB,
        samples: trackB,
        startMs: 0,
        out: [],
      }),
    ).rejects.toThrow(/different frame rate/);
  });

  it('honours an abort signal', async () => {
    const signal = AbortSignal.abort();
    await expect(
      decodeTrackSamples({
        session: scriptSession,
        idToToken: VOCAB,
        samples: trackB,
        startMs: 0,
        out: [],
        signal,
      }),
    ).rejects.toThrow(/aborted/);
  });
});
