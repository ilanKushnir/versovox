import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type TrackInfo } from '@readport/shared';
import { api } from '../api/client';
import { type SentenceIndexEntry } from '../lib/types';
import { recordCheckpoint } from '../progress/engine';
import { formatDuration } from '../lib/format';
import {
  IconClose,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSpeed,
  IconTarget,
} from '../components/icons';
import {
  type AlignedSegment,
  type Cue,
  type FollowState,
  buildCues,
  cueAt,
  cueForOffset,
  leadInFor,
  locateInTracks,
} from './readalong';

/**
 * Read-along: the narration playing while the book stays on screen.
 *
 * This is deliberately not the player. The player is a place you go; read-along
 * is something the reader does, so it owns the smallest transport that can
 * honestly be called one — play, back, speed, stop — and nothing else. Sleep
 * timers, chapter lists and bookmarks already have a home one tap away.
 *
 * The audio element lives here rather than in the reader so that turning
 * read-along off unmounts it, which is the only way to be sure a book stops
 * talking.
 */

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

/**
 * How far the back button goes, in seconds. The same preference the player
 * uses, so a reader who set it to 30 there does not find 15 here.
 */
function loadBackSeconds(): number {
  try {
    const raw = JSON.parse(localStorage.getItem('rp-skip') ?? '');
    if (typeof raw?.back === 'number' && raw.back > 0) return raw.back;
  } catch {
    /* default */
  }
  return 15;
}

/** Per-book speed, shared with the player so one setting follows the book. */
function loadSpeed(audioBookId: string): number {
  try {
    const perBook = Number(localStorage.getItem(`rp-speed:${audioBookId}`));
    if (perBook > 0) return perBook;
    return Number(localStorage.getItem('rp-speed')) || 1;
  } catch {
    return 1;
  }
}

export interface NarrationApi {
  /** True once the audiobook and this chapter's timings have loaded. */
  ready: boolean;
  /** Nothing in this chapter is timed — read-along has nothing to show. */
  emptyChapter: boolean;
  playing: boolean;
  /** The sentence being spoken, when there is one to point at. */
  cue: Cue | null;
  state: FollowState;
  bookMs: number;
  speed: number;
  error: string | null;
  toggle: () => void;
  setSpeed: (rate: number) => void;
  back: () => void;
  /** Start (or move) the narration at the sentence covering a char offset. */
  playFrom: (charOffset: number) => void;
  /** How far the back button goes, in seconds — the player's own setting. */
  backSeconds: number;
  /** The <audio> element to mount. */
  element: React.ReactNode;
}

export interface NarrationOptions {
  enabled: boolean;
  /** Whether the page is still following the voice; see readalong.shouldFollow. */
  following: boolean;
  pairId: string | null;
  audioBookId: string | null;
  spineIdx: number;
  sentences: SentenceIndexEntry[];
  /** Where the reader is now, used to place the needle when it starts. */
  startOffset: () => number;
  /** The narration has left this chapter; the reader should move. */
  onLeaveChapter: (direction: 'next' | 'prev') => void;
}

/**
 * The read-along engine.
 *
 * Positions are book-absolute milliseconds throughout — the unit the alignment
 * speaks — and turned into a file and an offset only at the moment the audio
 * element is told where to go.
 */
export function useNarration(opts: NarrationOptions): NarrationApi {
  const {
    enabled,
    following,
    pairId,
    audioBookId,
    spineIdx,
    sentences,
    startOffset,
    onLeaveChapter,
  } = opts;

  const audioRef = useRef<HTMLAudioElement>(null);
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [segments, setSegments] = useState<AlignedSegment[] | null>(null);
  const [trackIdx, setTrackIdx] = useState(0);
  const [bookMs, setBookMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(() => loadSpeed(audioBookId ?? ''));
  const [error, setError] = useState<string | null>(null);
  const [backSeconds] = useState(loadBackSeconds);

  /** Applied once the target track reports a duration. */
  const pendingSeekRef = useRef<{ trackIdx: number; positionMs: number; play: boolean } | null>(
    null,
  );
  const lastHeartbeatRef = useRef(0);
  const startedRef = useRef(false);

  const cues = useMemo(() => buildCues(sentences, segments ?? []), [sentences, segments]);
  const lookup = useMemo(() => cueAt(cues, bookMs), [cues, bookMs]);

  /* ------------------------------------------------------------- loading */

  // The audiobook's own tracks. Read-along needs the file boundaries to turn
  // a book-absolute alignment position into something an element can seek to.
  useEffect(() => {
    if (!enabled || !audioBookId) return;
    let alive = true;
    void api<{ tracks: TrackInfo[] }>(`/api/books/${audioBookId}`)
      .then((d) => {
        if (alive) setTracks(d.tracks ?? []);
      })
      .catch(() => {
        if (alive) setError('The audiobook could not be loaded.');
      });
    return () => {
      alive = false;
    };
  }, [enabled, audioBookId]);

  // This chapter's timings. Refetched per chapter: a whole book's segments is
  // megabytes, and the reader only ever needs the page in front of them.
  useEffect(() => {
    if (!enabled || !pairId || spineIdx < 0) return;
    let alive = true;
    setSegments(null);
    void api<{ segments: AlignedSegment[] }>(`/api/pairs/${pairId}/segments/${spineIdx}`)
      .then((d) => {
        if (alive) setSegments(d.segments ?? []);
      })
      .catch(() => {
        // A chapter with no stored alignment is a normal answer, not a fault:
        // front matter and end matter are often unnarrated.
        if (alive) setSegments([]);
      });
    return () => {
      alive = false;
    };
  }, [enabled, pairId, spineIdx]);

  /* ------------------------------------------------------------- seeking */

  const applyPendingSeek = useCallback(() => {
    const el = audioRef.current;
    const target = pendingSeekRef.current;
    if (!el || !target || target.trackIdx !== trackIdx || el.readyState < 1) return;
    pendingSeekRef.current = null;
    el.currentTime = target.positionMs / 1000;
    if (target.play) void el.play().catch(() => {});
  }, [trackIdx]);

  const seekTo = useCallback(
    (absMs: number, play: boolean) => {
      const where = locateInTracks(tracks, absMs);
      pendingSeekRef.current = { ...where, play };
      setBookMs(absMs);
      if (where.trackIdx !== trackIdx) {
        setTrackIdx(where.trackIdx);
        return; // the src change will load, then applyPendingSeek runs
      }
      const el = audioRef.current;
      if (el && el.readyState >= 1) applyPendingSeek();
    },
    [tracks, trackIdx, applyPendingSeek],
  );

  /* ------------------------------------------------ starting and stopping */

  // On switch-on, put the needle where the reader is looking. Only once: after
  // that the reader may have moved the page and the narration should not jump.
  useEffect(() => {
    if (!enabled) {
      startedRef.current = false;
      return;
    }
    if (startedRef.current || cues.length === 0 || tracks.length === 0) return;
    startedRef.current = true;
    const cue = cueForOffset(cues, startOffset());
    if (!cue) return;
    const lead = leadInFor(segments?.find((s) => s.sentenceId === cue.id)?.uncertaintyMs);
    seekTo(Math.max(0, cue.startMs - lead), true);
  }, [enabled, cues, tracks, segments, startOffset, seekTo]);

  // Stopping means stopping. An element left playing behind a closed bar is
  // the kind of bug people report as "my phone won't shut up".
  useEffect(() => {
    if (enabled) return;
    const el = audioRef.current;
    el?.pause();
    setPlaying(false);
  }, [enabled]);

  /* ------------------------------------------------- crossing the chapter */

  const leaveRef = useRef(onLeaveChapter);
  leaveRef.current = onLeaveChapter;
  useEffect(() => {
    if (!enabled || !playing || !following || segments === null) return;
    // A chapter with no timings at all — front matter, or one the aligner
    // skipped — would otherwise dead-end the whole feature: the voice plays
    // on, the page never moves, and nothing says why. Walking forward is both
    // the honest guess and self-terminating at the last chapter.
    if (cues.length === 0) {
      leaveRef.current('next');
      return;
    }
    // Only while the narration still has the wheel. A reader who has gone off
    // to a different chapter must not be dragged back to this one.
    if (lookup.state === 'after') leaveRef.current('next');
    else if (lookup.state === 'before') leaveRef.current('prev');
  }, [enabled, playing, following, lookup.state, segments, cues.length]);

  /* --------------------------------------------------------- audio events */

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    const abs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + el.currentTime * 1000;
    setBookMs(abs);
    const now = Date.now();
    if (playing && audioBookId && now - lastHeartbeatRef.current > 15_000) {
      lastHeartbeatRef.current = now;
      // The audiobook's own position, so opening the player later resumes
      // where the reading got to rather than where listening last stopped.
      void recordCheckpoint(audioBookId, 'heartbeat', {
        medium: 'audio',
        trackIdx,
        positionMs: el.currentTime * 1000,
        bookMs: abs,
        pct: 0,
      });
    }
  };

  const onEnded = () => {
    if (trackIdx + 1 < tracks.length) {
      pendingSeekRef.current = { trackIdx: trackIdx + 1, positionMs: 0, play: true };
      setTrackIdx(trackIdx + 1);
    } else {
      setPlaying(false);
    }
  };

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = speed;
  }, [speed, trackIdx]);

  /* -------------------------------------------------------- Media Session */

  useEffect(() => {
    if (!enabled || !('mediaSession' in navigator)) return;
    const el = audioRef.current;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => void el?.play().catch(() => {})],
      ['pause', () => el?.pause()],
      ['seekbackward', () => seekTo(Math.max(0, bookMs - backSeconds * 1000), playing)],
      ['seekforward', () => seekTo(bookMs + 30_000, playing)],
    ];
    for (const [action, fn] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* not every action is supported everywhere */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [enabled, playing, bookMs, seekTo, backSeconds]);

  /* ------------------------------------------------------------- controls */

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => setError('This audio could not be played.'));
    else el.pause();
  }, []);

  const setSpeed = useCallback(
    (rate: number) => {
      setSpeedState(rate);
      try {
        if (audioBookId) localStorage.setItem(`rp-speed:${audioBookId}`, String(rate));
      } catch {
        /* private mode */
      }
    },
    [audioBookId],
  );

  const back = useCallback(
    () => seekTo(Math.max(0, bookMs - backSeconds * 1000), playing),
    [seekTo, bookMs, playing, backSeconds],
  );

  const playFrom = useCallback(
    (charOffset: number) => {
      const cue = cueForOffset(cues, charOffset);
      if (!cue) return;
      const lead = leadInFor(segments?.find((s) => s.sentenceId === cue.id)?.uncertaintyMs);
      seekTo(Math.max(0, cue.startMs - lead), true);
    },
    [cues, segments, seekTo],
  );

  const src =
    enabled && audioBookId && tracks.length > 0
      ? `/api/books/${audioBookId}/track/${trackIdx}`
      : undefined;

  const element = src ? (
    <audio
      ref={audioRef}
      src={src}
      preload="metadata"
      onLoadedMetadata={applyPendingSeek}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onTimeUpdate={onTimeUpdate}
      onEnded={onEnded}
      onError={() => setError('This audio format could not be played by your browser.')}
    />
  ) : null;

  return {
    ready: tracks.length > 0 && segments !== null,
    emptyChapter: segments !== null && cues.length === 0,
    playing,
    cue: lookup.cue,
    state: lookup.state,
    bookMs,
    speed,
    error,
    backSeconds,
    toggle,
    setSpeed,
    back,
    playFrom,
    element,
  };
}

/**
 * The read-along bar: a strip along the bottom of the reader.
 *
 * It says what is happening in words as well as controls, because the states
 * that matter most are the ones where the highlight is *absent* — an unaligned
 * stretch, or a chapter the narrator skipped — and a bar that only ever shows
 * a play button leaves the reader wondering what broke.
 */
export function NarrationBar({
  n,
  following,
  onResume,
  onClose,
}: {
  n: NarrationApi;
  following: boolean;
  onResume: () => void;
  onClose: () => void;
}) {
  const [speedOpen, setSpeedOpen] = useState(false);

  const status = n.error
    ? n.error
    : !n.ready
      ? 'Finding the narration…'
      : n.emptyChapter
        ? 'No narration timed for this chapter'
        : n.state === 'gap'
          ? 'The narration is ahead of the timed text'
          : formatDuration(n.bookMs);

  return (
    <div className="readalong" role="group" aria-label="Read along">
      <button
        className="readalong__play"
        onClick={n.toggle}
        disabled={!n.ready || n.emptyChapter}
        aria-label={n.playing ? 'Pause narration' : 'Play narration'}
      >
        {n.playing ? <IconPause size={20} /> : <IconPlay size={20} />}
      </button>

      <button
        className="readalong__btn"
        onClick={n.back}
        disabled={!n.ready}
        aria-label={`Back ${n.backSeconds} seconds`}
        title={`Back ${n.backSeconds} seconds`}
      >
        <IconSkipBack size={18} label={String(n.backSeconds)} />
      </button>

      <span className={`readalong__status ${n.state === 'gap' || n.error ? 'is-warn' : ''}`}>
        {status}
      </span>

      {!following && n.cue && (
        <button className="readalong__resume" onClick={onResume}>
          <IconTarget size={15} />
          <span>Back to the voice</span>
        </button>
      )}

      <div className="readalong__speed">
        <button
          className="readalong__btn"
          onClick={() => setSpeedOpen((v) => !v)}
          aria-expanded={speedOpen}
          aria-label={`Speed ${n.speed}×`}
        >
          <IconSpeed size={18} />
          <small>{n.speed}×</small>
        </button>
        {speedOpen && (
          <div className="readalong__speeds" role="menu">
            {SPEEDS.map((s) => (
              <button
                key={s}
                role="menuitemradio"
                aria-checked={s === n.speed}
                className={s === n.speed ? 'is-on' : ''}
                onClick={() => {
                  n.setSpeed(s);
                  setSpeedOpen(false);
                }}
              >
                {s}×
              </button>
            ))}
          </div>
        )}
      </div>

      <button className="readalong__btn" onClick={onClose} aria-label="Stop reading along">
        <IconClose size={18} />
      </button>
    </div>
  );
}
