import { describe, expect, it } from 'vitest';
import { type SentenceIndexEntry } from '../lib/types';
import {
  type AlignedSegment,
  HOLD_MS,
  buildCues,
  cueAt,
  cueForOffset,
  leadInFor,
  locateInTracks,
  shouldFollow,
} from './readalong';

/**
 * The read-along cue list, and the judgement calls in it: what to do between
 * two sentences, what to do where the alignment has nothing, and where to
 * start when the reader taps a line the aligner never timed.
 */

function sentence(id: string, start: number, end: number, ord = 0): SentenceIndexEntry {
  return { id, ord, start, end };
}
function segment(sentenceId: string, startMs: number, endMs: number): AlignedSegment {
  return { sentenceId, startMs, endMs };
}

/** Three sentences, spoken one after another with a breath between each. */
const SENTENCES = [sentence('s1', 0, 40, 0), sentence('s2', 40, 90, 1), sentence('s3', 90, 150, 2)];
const SEGMENTS = [
  segment('s1', 1_000, 4_000),
  segment('s2', 4_500, 9_000),
  segment('s3', 9_400, 15_000),
];
const CUES = buildCues(SENTENCES, SEGMENTS);

describe('buildCues', () => {
  it('joins a sentence to its timing by id', () => {
    expect(CUES).toHaveLength(3);
    expect(CUES[0]).toEqual({ id: 's1', charStart: 0, charEnd: 40, startMs: 1_000, endMs: 4_000 });
  });

  it('drops a sentence the aligner never timed rather than inventing one', () => {
    // An interpolated cue would put the highlight on a line with exactly the
    // same confidence as a measured one. Better to have no cue there.
    const cues = buildCues(SENTENCES, [SEGMENTS[0]!, SEGMENTS[2]!]);
    expect(cues.map((c) => c.id)).toEqual(['s1', 's3']);
  });

  it('drops a timing whose sentence is not in this chapter', () => {
    const cues = buildCues(SENTENCES, [...SEGMENTS, segment('elsewhere', 20_000, 21_000)]);
    expect(cues.map((c) => c.id)).toEqual(['s1', 's2', 's3']);
  });

  it('ignores a segment with a nonsense time', () => {
    const cues = buildCues(SENTENCES, [segment('s1', Number.NaN, 4_000), SEGMENTS[1]!]);
    expect(cues.map((c) => c.id)).toEqual(['s2']);
  });

  it('orders by the clock, which is what the lookup searches', () => {
    const shuffled = buildCues(SENTENCES, [SEGMENTS[2]!, SEGMENTS[0]!, SEGMENTS[1]!]);
    expect(shuffled.map((c) => c.startMs)).toEqual([1_000, 4_500, 9_400]);
  });

  it('gives an inverted or empty span enough width to be current', () => {
    const [cue] = buildCues([sentence('s1', 0, 40)], [segment('s1', 5_000, 5_000)]);
    expect(cue!.endMs).toBeGreaterThan(cue!.startMs);
  });
});

describe('cueAt', () => {
  it('finds the sentence being spoken', () => {
    expect(cueAt(CUES, 2_000).cue?.id).toBe('s1');
    expect(cueAt(CUES, 5_000).cue?.id).toBe('s2');
    expect(cueAt(CUES, 14_999).cue?.id).toBe('s3');
  });

  it('holds the last sentence through the breath after it', () => {
    // 4000 → 4500 is a pause between two sentences, not a hole. Letting go
    // there makes the highlight blink on every full stop.
    const got = cueAt(CUES, 4_200);
    expect(got.state).toBe('hold');
    expect(got.cue?.id).toBe('s1');
  });

  it('lets go where the alignment has nothing to say', () => {
    const sparse = buildCues(SENTENCES, [SEGMENTS[0]!, segment('s3', 60_000, 64_000)]);
    // Half a minute of narration this chapter cannot place.
    expect(cueAt(sparse, 30_000)).toEqual({ cue: null, state: 'gap', index: -1 });
  });

  it('holds rather than gapping for exactly the tolerated pause', () => {
    const two = buildCues(SENTENCES, [SEGMENTS[0]!, segment('s2', 4_000 + HOLD_MS + 500, 9_000)]);
    expect(cueAt(two, 4_000 + HOLD_MS).state).toBe('hold');
    expect(cueAt(two, 4_000 + HOLD_MS + 1).state).toBe('gap');
  });

  it('says the narration is before this chapter, but not for a hair', () => {
    expect(cueAt(CUES, 0).state).toBe('hold'); // 1s early — clock rounding
    expect(cueAt(CUES, 1_000 - HOLD_MS - 1).state).toBe('before');
  });

  it('says the narration has left this chapter', () => {
    expect(cueAt(CUES, 15_000 + HOLD_MS).state).toBe('hold');
    expect(cueAt(CUES, 15_000 + HOLD_MS + 1).state).toBe('after');
  });

  it('has an answer for a chapter with no alignment at all', () => {
    expect(cueAt([], 5_000)).toEqual({ cue: null, state: 'gap', index: -1 });
  });

  it('reports the index, so the caller can see what comes next', () => {
    expect(cueAt(CUES, 5_000).index).toBe(1);
  });
});

describe('cueForOffset', () => {
  it('finds the sentence under a tap', () => {
    expect(cueForOffset(CUES, 50)?.id).toBe('s2');
  });

  it('falls forward when the tapped sentence has no timing', () => {
    // Starting behind the reader replays what they just read; starting a
    // little ahead is visible in the highlight and easy to correct.
    const sparse = buildCues(SENTENCES, [SEGMENTS[0]!, SEGMENTS[2]!]);
    expect(cueForOffset(sparse, 60)?.id).toBe('s3');
  });

  it('returns nothing past the last timed sentence', () => {
    expect(cueForOffset(CUES, 500)).toBeNull();
  });

  it('returns nothing when the chapter has no cues', () => {
    expect(cueForOffset([], 10)).toBeNull();
  });
});

describe('leadInFor', () => {
  it('is nothing when the timing is certain', () => {
    expect(leadInFor(0)).toBe(0);
    expect(leadInFor(undefined)).toBe(0);
  });

  it('comes in early in proportion to the doubt', () => {
    expect(leadInFor(2_000)).toBe(500);
  });

  it('is bounded, because a badly aligned passage admits to tens of seconds', () => {
    expect(leadInFor(45_000)).toBe(1_200);
  });
});

describe('shouldFollow', () => {
  const cue = CUES[1]!;

  it('follows while the reader has not taken over', () => {
    expect(shouldFollow(true, cue, false)).toBe(true);
  });

  it('stops following when the reader has moved the page themselves', () => {
    expect(shouldFollow(false, cue, false)).toBe(false);
  });

  it('resumes on its own once the narration reaches the page they went to', () => {
    // Nothing to press: they turned ahead, the narration caught up, and the
    // spoken sentence is on screen again.
    expect(shouldFollow(false, cue, true)).toBe(true);
  });

  it('never follows nothing', () => {
    expect(shouldFollow(true, null, true)).toBe(false);
  });
});

describe('locateInTracks', () => {
  const tracks = [
    { durationMs: 60_000, startMsAbsolute: 0 },
    { durationMs: 90_000, startMsAbsolute: 60_000 },
    { durationMs: 30_000, startMsAbsolute: 150_000 },
  ];

  it('finds the file a book-absolute position falls in', () => {
    expect(locateInTracks(tracks, 0)).toEqual({ trackIdx: 0, positionMs: 0 });
    expect(locateInTracks(tracks, 59_999)).toEqual({ trackIdx: 0, positionMs: 59_999 });
    expect(locateInTracks(tracks, 60_000)).toEqual({ trackIdx: 1, positionMs: 0 });
    expect(locateInTracks(tracks, 155_000)).toEqual({ trackIdx: 2, positionMs: 5_000 });
  });

  it('clamps a position past the end of the book into the last file', () => {
    // An alignment that ran a little long must still be seekable, not silently
    // dropped on the floor.
    expect(locateInTracks(tracks, 999_999)).toEqual({ trackIdx: 2, positionMs: 30_000 });
  });

  it('never returns a negative position', () => {
    expect(locateInTracks(tracks, -5_000)).toEqual({ trackIdx: 0, positionMs: 0 });
  });

  it('survives a book whose tracks have not loaded yet', () => {
    expect(locateInTracks([], 4_000)).toEqual({ trackIdx: 0, positionMs: 4_000 });
  });
});
