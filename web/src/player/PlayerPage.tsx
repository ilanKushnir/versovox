import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@readport/shared';
import { api, isOffline } from '../api/client';
import { cachedSwitch } from '../offline/downloads';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { recordCheckpoint, resumeLocator, setActiveLocatorProvider } from '../progress/engine';
import { bookAudioSupport } from '../lib/audioSupport';
import { Cover, Sheet, useToast } from '../components/ui';
import {
  IconBack,
  IconClose,
  IconTrash,
  IconBookmark,
  IconBookOpen,
  IconChapterNext,
  IconChapterPrev,
  IconMoon,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipFwd,
  IconSpeed,
  IconToc,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';
import { ambientColorFromImage } from '../lib/ambient';

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SKIP_CHOICES = [10, 15, 30, 45, 60];
const SLEEP_OPTIONS = [
  { label: 'Off', minutes: 0 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '45 min', minutes: 45 },
  { label: '1 hour', minutes: 60 },
  { label: 'End of chapter', minutes: -1 },
];

type SheetKind = 'none' | 'chapters' | 'playback' | 'sleep' | 'bookmarks';

interface SkipPrefs {
  back: number;
  fwd: number;
}

function loadSkip(): SkipPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem('rp-skip') ?? '');
    if (SKIP_CHOICES.includes(raw.back) && SKIP_CHOICES.includes(raw.fwd)) return raw;
  } catch {
    /* defaults */
  }
  return { back: 15, fwd: 30 };
}

/** Per-book speed override, falling back to the global default. */
function loadSpeed(bookId: string): number {
  try {
    const perBook = Number(localStorage.getItem(`rp-speed:${bookId}`));
    if (perBook > 0) return perBook;
    return Number(localStorage.getItem('rp-speed')) || 1;
  } catch {
    return 1;
  }
}

export function PlayerPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const audioRef = useRef<HTMLAudioElement>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackIdx, setTrackIdx] = useState(0);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeed] = useState(() => loadSpeed(id));
  const [skip, setSkip] = useState<SkipPrefs>(loadSkip);
  const [sheet, setSheet] = useState<SheetKind>('none');
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepChapterEnd, setSleepChapterEnd] = useState(false);
  const [sleepTick, setSleepTick] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  /** Position before a deliberate jump (bookmark, chapter list, scrubber drag). */
  const [returnPoint, setReturnPoint] = useState<{ absMs: number } | null>(null);
  const returnArmedRef = useRef(true);
  const [handoffMarkerPct, setHandoffMarkerPct] = useState<number | null>(null);
  const [ambient, setAmbient] = useState<string | null>(null);

  /**
   * Seek to apply once the current track's metadata is loaded. Read at
   * event time (never snapshotted into an effect closure): the resume
   * position arrives after the element has already loaded track 0, so the
   * seek must be applied whenever it appears, not only on src changes.
   */
  const pendingSeekRef = useRef<{ trackIdx: number; positionMs: number; autoplay: boolean } | null>(
    null,
  );
  const [seekVersion, setSeekVersion] = useState(0);
  const lastHeartbeatRef = useRef(0);
  const lastPositionStateRef = useRef(0);
  const scrubbing = useRef(false);

  const tracks = detail?.tracks ?? [];
  const totalMs = useMemo(() => tracks.reduce((a, t) => a + t.durationMs, 0), [tracks]);
  const bookMs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + positionMs;
  const bookMsRef = useRef(bookMs);
  bookMsRef.current = bookMs;

  const chapters = detail?.chapters ?? [];
  const chapterIndex = useMemo(() => {
    let found = -1;
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]!;
      if (c.startMs != null && c.startMs <= bookMs + 250) found = i;
      else break;
    }
    return found;
  }, [chapters, bookMs]);
  const currentChapter = chapterIndex >= 0 ? chapters[chapterIndex]! : null;
  const chapterEndMs = currentChapter?.endMs ?? chapters[chapterIndex + 1]?.startMs ?? totalMs;
  const chapterStartMs = currentChapter?.startMs ?? 0;
  const chapterPct =
    chapterEndMs > chapterStartMs
      ? Math.min(1, Math.max(0, (bookMs - chapterStartMs) / (chapterEndMs - chapterStartMs)))
      : 0;

  const locatorNow = useCallback(
    (): AudioLocator => ({
      medium: 'audio',
      trackIdx,
      positionMs: Math.max(0, Math.round(positionMs)),
      bookMs: Math.max(0, Math.round(bookMs)),
      pct: totalMs > 0 ? Math.min(1, Math.max(0, bookMs / totalMs)) : 0,
    }),
    [trackIdx, positionMs, bookMs, totalMs],
  );
  const locatorFor = useCallback(
    (t: number, within: number): AudioLocator => {
      const abs = (tracks[t]?.startMsAbsolute ?? 0) + within;
      return {
        medium: 'audio',
        trackIdx: t,
        positionMs: Math.max(0, Math.round(within)),
        bookMs: Math.max(0, Math.round(abs)),
        pct: totalMs > 0 ? Math.min(1, Math.max(0, abs / totalMs)) : 0,
      };
    },
    [tracks, totalMs],
  );

  // Honest format support: detected-but-unplayable formats (e.g. FLAC/OGG on
  // Safari) get a clear explanation instead of a player that fails later.
  const support = useMemo(
    () =>
      bookAudioSupport(
        tracks.length > 0 ? tracks.map((t) => t.format) : detail ? [detail.book.format] : [],
      ),
    [tracks, detail],
  );

  // Lifecycle persistence: expose the LIVE playback position so
  // backgrounding records it even inside the 15s heartbeat window.
  useEffect(() => {
    if (!detail) return;
    return setActiveLocatorProvider(() => ({ bookId: id, locator: locatorNow() }));
  }, [detail, id, locatorNow]);

  /* ------------------------------------------------------------ loading */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api<BookDetail>(`/api/books/${id}`);
        if (!alive) return;
        setDetail(d);
        const total = d.tracks.reduce((a, x) => a + x.durationMs, 0);
        const pctOf = (t: number, p: number) =>
          total > 0
            ? Math.min(1, Math.max(0, ((d.tracks[t]?.startMsAbsolute ?? 0) + p) / total))
            : 0;
        const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
          () => ({ annotations: [] as Annotation[] }),
        );
        if (alive) setAnnotations(anns.annotations);

        const trackParam = searchParams.get('track');
        const posParam = searchParams.get('pos');
        const handoff = searchParams.get('handoff') === '1';
        if (posParam !== null) {
          let t = trackParam !== null ? Number(trackParam) || 0 : -1;
          let p = Math.max(0, Number(posParam) || 0);
          if (t < 0) {
            // pos interpreted as absolute bookMs (chapter links).
            t = 0;
            for (let i = 0; i < d.tracks.length; i++) {
              if (p >= d.tracks[i]!.startMsAbsolute) t = i;
            }
            p = p - d.tracks[t]!.startMsAbsolute;
          }
          t = Math.min(Math.max(0, t), Math.max(0, d.tracks.length - 1));
          pendingSeekRef.current = { trackIdx: t, positionMs: p, autoplay: handoff };
          if (handoff) {
            const abs = (d.tracks[t]?.startMsAbsolute ?? 0) + p;
            setHandoffMarkerPct(total > 0 ? abs / total : null);
            const gran = searchParams.get('granularity');
            // A handoff aims deliberately behind the reader, so an unexplained
            // rewind would read as a bug rather than as the safeguard it is.
            const back = Math.round(Number(searchParams.get('back') ?? 0) / 1000);
            toast.show(
              back >= 3
                ? `Starting ${back} seconds before your reading position, so nothing is spoiled`
                : gran === 'sentence'
                  ? 'Continuing from your reading position'
                  : 'Continuing near your reading position',
            );
          }
          void recordCheckpoint(id, handoff ? 'switch' : 'seek', {
            medium: 'audio',
            trackIdx: t,
            positionMs: Math.round(p),
            bookMs: Math.round((d.tracks[t]?.startMsAbsolute ?? 0) + p),
            pct: pctOf(t, p),
          });
        } else {
          const resume = await resumeLocator(id);
          if (!alive) return;
          if (resume && resume.locator.medium === 'audio') {
            pendingSeekRef.current = {
              trackIdx: Math.min(resume.locator.trackIdx, Math.max(0, d.tracks.length - 1)),
              positionMs: resume.locator.positionMs,
              autoplay: false,
            };
          } else {
            pendingSeekRef.current = { trackIdx: 0, positionMs: 0, autoplay: false };
          }
          const target = pendingSeekRef.current;
          void recordCheckpoint(id, 'open', {
            medium: 'audio',
            trackIdx: target.trackIdx,
            positionMs: Math.round(target.positionMs),
            bookMs: Math.round(
              (d.tracks[target.trackIdx]?.startMsAbsolute ?? 0) + target.positionMs,
            ),
            pct: pctOf(target.trackIdx, target.positionMs),
          });
        }
        const target = pendingSeekRef.current;
        if (target) {
          setTrackIdx(target.trackIdx);
          setPositionMs(target.positionMs);
          setSeekVersion((v) => v + 1);
        }
      } catch {
        if (alive) setError('Could not load this audiobook.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Ambient background tint from the cover.
  useEffect(() => {
    if (!detail?.book.hasCover) return;
    let cancelled = false;
    ambientColorFromImage(`/api/books/${id}/cover`).then((c) => {
      if (!cancelled && c) setAmbient(c);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, id]);

  /* -------------------------------------------------------- audio wiring */

  const src = tracks.length > 0 ? `/api/books/${id}/track/${trackIdx}` : undefined;

  /** Apply the pending seek if it targets the loaded track. */
  const applyPendingSeek = useCallback(() => {
    const el = audioRef.current;
    const target = pendingSeekRef.current;
    if (!el || !target || target.trackIdx !== trackIdx || el.readyState < 1) return;
    pendingSeekRef.current = null;
    el.currentTime = target.positionMs / 1000;
    setPositionMs(target.positionMs);
    if (target.autoplay) void el.play().catch(() => {});
  }, [trackIdx]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    // Metadata may already be loaded (resume arrived after track 0 loaded):
    // apply now, and otherwise as soon as it loads.
    applyPendingSeek();
    el.addEventListener('loadedmetadata', applyPendingSeek);
    return () => el.removeEventListener('loadedmetadata', applyPendingSeek);
  }, [src, trackIdx, seekVersion, applyPendingSeek]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    try {
      localStorage.setItem('rp-speed', String(speed));
      localStorage.setItem(`rp-speed:${id}`, String(speed));
    } catch {
      /* private mode */
    }
  }, [speed, id]);

  useEffect(() => {
    try {
      localStorage.setItem('rp-skip', JSON.stringify(skip));
    } catch {
      /* private mode */
    }
  }, [skip]);

  // Sleep countdown needs a clock even while paused/scrubbing.
  useEffect(() => {
    if (!sleepUntil) return;
    const t = setInterval(() => setSleepTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [sleepUntil]);

  const publishPositionState = useCallback(() => {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: el.duration,
        playbackRate: el.playbackRate,
        position: Math.min(el.duration, Math.max(0, el.currentTime)),
      });
    } catch {
      /* unsupported values */
    }
  }, []);

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el) return;
    const ms = el.currentTime * 1000;
    if (!scrubbing.current) setPositionMs(ms);
    const now = Date.now();
    if (now - lastPositionStateRef.current > 1000) {
      lastPositionStateRef.current = now;
      publishPositionState();
    }
    if (playing && now - lastHeartbeatRef.current > 15_000) {
      lastHeartbeatRef.current = now;
      void recordCheckpoint(id, 'heartbeat', locatorFor(trackIdx, ms));
    }
    // Sleep timer.
    if (sleepUntil && now >= sleepUntil) {
      el.pause();
      setSleepUntil(null);
      toast.show('Sleep timer: paused');
    }
    const abs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + ms;
    if (sleepChapterEnd && currentChapter && abs >= chapterEndMs - 400) {
      el.pause();
      setSleepChapterEnd(false);
      toast.show('End of chapter: paused');
    }
  };

  const onEnded = () => {
    if (trackIdx < tracks.length - 1) {
      pendingSeekRef.current = { trackIdx: trackIdx + 1, positionMs: 0, autoplay: true };
      setTrackIdx(trackIdx + 1);
      setPositionMs(0);
      setSeekVersion((v) => v + 1);
    } else {
      setPlaying(false);
      void recordCheckpoint(id, 'finish', { ...locatorNow(), pct: 1 });
      toast.show('Finished — nicely done');
    }
  };

  const seekTo = useCallback(
    (absMs: number, intent: 'seek' | 'heartbeat' = 'seek') => {
      if (tracks.length === 0) return;
      const clamped = Math.max(0, Math.min(absMs, Math.max(0, totalMs - 200)));
      if (
        intent === 'seek' &&
        returnArmedRef.current &&
        Math.abs(clamped - bookMsRef.current) > 90_000
      ) {
        const from = bookMsRef.current;
        setReturnPoint((rp) => rp ?? { absMs: from });
      }
      let t = 0;
      for (let i = 0; i < tracks.length; i++) {
        if (clamped >= tracks[i]!.startMsAbsolute) t = i;
      }
      const within = clamped - tracks[t]!.startMsAbsolute;
      const el = audioRef.current;
      if (t === trackIdx && el && el.readyState >= 1) {
        el.currentTime = within / 1000;
      } else {
        pendingSeekRef.current = { trackIdx: t, positionMs: within, autoplay: playing };
        setTrackIdx(t);
        setSeekVersion((v) => v + 1);
      }
      setPositionMs(within);
      if (intent === 'seek') void recordCheckpoint(id, 'seek', locatorFor(t, within));
    },
    [tracks, totalMs, trackIdx, playing, id, locatorFor],
  );
  const seekToRef = useRef(seekTo);
  seekToRef.current = seekTo;

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => toast.show('Playback blocked — tap play again'));
    else el.pause();
  }, [toast]);

  // Play → durable checkpoint with explicit intent. Pressing play is a
  // deliberate act, so it takes the progress claim back for this session:
  // without it, a tab that lost the claim to another device only emits
  // heartbeats, which are recorded and never applied — a whole listening
  // session would vanish if the tab is killed before it can pause.
  const onPlay = () => {
    setPlaying(true);
    lastHeartbeatRef.current = Date.now();
    const el = audioRef.current;
    const ms = el && Number.isFinite(el.currentTime) ? el.currentTime * 1000 : positionMs;
    void recordCheckpoint(id, 'seek', locatorFor(trackIdx, ms));
  };

  // Pause → durable checkpoint with explicit intent.
  const onPause = () => {
    setPlaying(false);
    publishPositionState();
    void recordCheckpoint(id, 'pause', locatorNow());
  };

  const goChapter = useCallback(
    (delta: number) => {
      if (chapters.length === 0) return;
      // "Previous" within the first few seconds of a chapter goes to the
      // chapter before; otherwise it restarts the current one.
      let target = chapterIndex + delta;
      if (delta < 0 && currentChapter && bookMs - chapterStartMs > 4000) target = chapterIndex;
      target = Math.max(0, Math.min(chapters.length - 1, target));
      const c = chapters[target];
      if (c?.startMs != null) seekTo(c.startMs);
    },
    [chapters, chapterIndex, currentChapter, bookMs, chapterStartMs, seekTo],
  );
  const goChapterRef = useRef(goChapter);
  goChapterRef.current = goChapter;

  /* -------------------------------------------------------- MediaSession */

  useEffect(() => {
    if (!('mediaSession' in navigator) || !detail) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentChapter?.title ?? detail.book.title,
      artist: detail.book.author ?? 'ReadPort',
      album: detail.book.title,
      artwork: detail.book.hasCover
        ? [{ src: `${location.origin}/api/books/${id}/cover`, sizes: '512x512' }]
        : [],
    });
  }, [detail, currentChapter, id]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !detail) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported on this platform */
      }
    };
    set('play', () => void audioRef.current?.play());
    set('pause', () => audioRef.current?.pause());
    set('seekbackward', (d) =>
      seekToRef.current(bookMsRef.current - (d.seekOffset ?? skip.back) * 1000),
    );
    set('seekforward', (d) =>
      seekToRef.current(bookMsRef.current + (d.seekOffset ?? skip.fwd) * 1000),
    );
    set('previoustrack', () => goChapterRef.current(-1));
    set('nexttrack', () => goChapterRef.current(1));
    set('seekto', (d) => {
      if (d.seekTime != null) {
        const start = tracks[trackIdx]?.startMsAbsolute ?? 0;
        seekToRef.current(start + d.seekTime * 1000);
      }
    });
    return () => {
      for (const a of [
        'play',
        'pause',
        'seekbackward',
        'seekforward',
        'previoustrack',
        'nexttrack',
        'seekto',
      ] as MediaSessionAction[]) {
        set(a, null);
      }
    };
  }, [detail, skip.back, skip.fwd, tracks, trackIdx]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  useEffect(publishPositionState, [speed, trackIdx, publishPositionState]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet !== 'none') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        seekTo(bookMs - skip.back * 1000);
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        seekTo(bookMs + skip.fwd * 1000);
      } else if (e.key === 'Escape') {
        navigate(`/book/${id}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, bookMs, sheet, navigate, id, skip]);

  const switchToText = useCallback(async () => {
    if (!detail?.book.pair) return;
    const from = locatorNow();
    try {
      let res: ResolveResponse;
      try {
        res = await api<ResolveResponse>(`/api/pairs/${detail.book.pair.pairId}/resolve`, {
          method: 'POST',
          body: { from },
        });
      } catch (err) {
        if (!isOffline(err)) throw err;
        // No network. The downloaded package carries the server's own
        // answers, so the handoff lands where it would online.
        const stored = await cachedSwitch(id, from);
        if (!stored) {
          toast.show('This spot was not stored for offline switching.');
          return;
        }
        res = stored;
      }
      if (!res.to || res.to.medium !== 'ebook') {
        // Never silently cross an alignment gap: explain, and point at the
        // nearest verified aligned passage instead.
        const anchor = res.anchors?.before ?? res.anchors?.after;
        const extra =
          anchor && anchor.to.medium === 'ebook'
            ? ` Nearest aligned passage: ${formatPct(anchor.to.pct)} through the book.`
            : '';
        toast.show((res.resolution.reason ?? 'No aligned text position here.') + extra);
        return;
      }
      audioRef.current?.pause();
      void recordCheckpoint(id, 'switch', from);
      const to = res.to as EbookLocator;
      navigate(
        `/read/${detail.book.pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
          to.sentenceId ? `&sentence=${to.sentenceId}` : ''
        }&handoff=1&granularity=${res.resolution.granularity}`,
      );
    } catch {
      toast.show('Switching failed — server unreachable?');
    }
  }, [detail, locatorNow, id, navigate, toast]);

  const audioBookmarks = annotations.filter((a) => a.locator.medium === 'audio');
  const bookmarkAbsMs = (a: Annotation): number =>
    a.locator.medium === 'audio'
      ? (tracks[a.locator.trackIdx]?.startMsAbsolute ?? 0) + a.locator.positionMs
      : 0;
  /** A bookmark within 20 s of the playhead counts as "this moment". */
  const nearBookmark =
    audioBookmarks.find((a) => Math.abs(bookmarkAbsMs(a) - bookMs) < 20_000) ?? null;

  const deleteBookmark = async (annId: string) => {
    try {
      await api(`/api/annotations/${annId}`, { method: 'DELETE' });
      setAnnotations((a) => a.filter((x) => x.id !== annId));
    } catch {
      toast.show('Could not delete — are you offline?');
    }
  };

  const toggleBookmark = async () => {
    if (nearBookmark) {
      await deleteBookmark(nearBookmark.id);
      toast.show('Bookmark removed');
      return;
    }
    try {
      const chapterTitle = currentChapter?.title ?? null;
      const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
        method: 'POST',
        body: {
          kind: 'bookmark',
          locator: locatorNow(),
          selectedText: chapterTitle ? `${chapterTitle} · ${formatDuration(bookMs)}` : null,
        },
      });
      setAnnotations((a) => [...a, res.annotation]);
      toast.show(`Bookmarked at ${formatDuration(bookMs)}`, {
        label: 'Bookmarks',
        onClick: () => setSheet('bookmarks'),
      });
    } catch {
      toast.show('Could not save bookmark');
    }
  };

  /* -------------------------------------------------------------- render */

  if (error) {
    return (
      <div className="player-page">
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>Cannot play</h2>
          <p>{error}</p>
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            Back to details
          </Link>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="player-page" aria-busy="true">
        <div style={{ margin: 'auto' }} className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }
  if (!support.supported) {
    return (
      <div className="player-page">
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>Format not playable in this browser</h2>
          <p>{support.reason}</p>
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            Back to details
          </Link>
        </div>
      </div>
    );
  }

  const remainingMs = Math.max(0, totalMs - bookMs);
  const chapterLeftMs = Math.max(0, chapterEndMs - bookMs);
  void sleepTick;
  const sleepLabel = sleepChapterEnd
    ? 'Chapter end'
    : sleepUntil
      ? formatDuration(Math.max(0, sleepUntil - Date.now()))
      : null;
  const pair =
    detail.book.pair && detail.book.pair.status !== 'candidate' ? detail.book.pair : null;

  return (
    <div
      className="player-page"
      style={ambient ? ({ '--pl-ambient': ambient } as React.CSSProperties) : undefined}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={onPlay}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
        onRateChange={publishPositionState}
        onError={() => setError('This audio format could not be played by your browser.')}
      />
      <div className="player-top">
        <button
          className="icon-btn"
          onClick={() => navigate(`/book/${id}`)}
          aria-label="Back to book"
        >
          <IconBack />
        </button>
        <span className="player-top__label">
          {chapters.length > 0 && chapterIndex >= 0
            ? `Chapter ${chapterIndex + 1} of ${chapters.length}`
            : tracks.length > 1
              ? `Part ${trackIdx + 1} of ${tracks.length}`
              : detail.book.format.toUpperCase()}
        </span>
        <button
          className={`icon-btn ${nearBookmark ? 'is-marked' : ''}`}
          onClick={() => void toggleBookmark()}
          aria-pressed={!!nearBookmark}
          aria-label={nearBookmark ? 'Remove bookmark at this moment' : 'Bookmark this moment'}
        >
          <IconBookmark filled={!!nearBookmark} />
        </button>
      </div>

      <div className="player-main">
        <div className={`player-coverwrap ${playing ? 'is-playing' : ''}`}>
          <Cover
            book={detail.book}
            className={detail.book.hasCover ? 'player-cover' : 'player-cover player-cover--book'}
          />
        </div>
        <div className="player-titles">
          <h1>{detail.book.title}</h1>
          <div className="player-titles__author">{detail.book.author ?? ''}</div>
          <div className="chapter">
            {currentChapter?.title ?? (buffering ? 'Buffering…' : '')}
            {buffering && currentChapter ? ' · buffering…' : ''}
          </div>
        </div>

        <div className="player-scrub">
          <div className="player-scrub__track" aria-hidden="true">
            {chapters.length > 1 &&
              totalMs > 0 &&
              chapters.map((c) =>
                c.startMs != null && c.startMs > 0 ? (
                  <span
                    key={c.idx}
                    className="player-scrub__tick"
                    style={{ insetInlineStart: `${(c.startMs / totalMs) * 100}%` }}
                  />
                ) : null,
              )}
            {totalMs > 0 && audioBookmarks.length > 0 && (
              <span className="player-scrub__bookmarks">
                {audioBookmarks.map((a) => (
                  <span
                    key={a.id}
                    className={`player-scrub__bookmark ${nearBookmark?.id === a.id ? 'is-near' : ''}`}
                    style={{ insetInlineStart: `${(bookmarkAbsMs(a) / totalMs) * 100}%` }}
                  />
                ))}
              </span>
            )}
            {handoffMarkerPct != null && (
              <span
                className="handoff-marker"
                style={{ insetInlineStart: `${handoffMarkerPct * 100}%` }}
                title="Handoff from reading"
              />
            )}
          </div>
          <input
            className="slider slider--player"
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={1000}
            value={Math.round(bookMs)}
            aria-label="Position in audiobook"
            aria-valuetext={`${formatDuration(bookMs)} of ${formatDuration(totalMs)}`}
            onPointerDown={() => (scrubbing.current = true)}
            onPointerUp={() => (scrubbing.current = false)}
            onPointerCancel={() => (scrubbing.current = false)}
            onLostPointerCapture={() => (scrubbing.current = false)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPositionMs(v - (tracks[trackIdx]?.startMsAbsolute ?? 0));
              seekTo(v);
            }}
          />
          <div className="player-times">
            <span>{formatDuration(bookMs)}</span>
            <span className="player-times__chapter">
              {currentChapter ? `${formatDuration(chapterLeftMs)} left in chapter` : ''}
            </span>
            <span>-{formatDuration(remainingMs)}</span>
          </div>
          {currentChapter && (
            <div className="player-chapterbar" aria-hidden="true">
              <span style={{ width: `${chapterPct * 100}%` }} />
            </div>
          )}
        </div>

        <div className="player-controls">
          <button
            className="icon-btn icon-btn--small"
            onClick={() => goChapter(-1)}
            aria-label="Previous chapter"
            disabled={chapters.length === 0}
          >
            <IconChapterPrev size={26} />
          </button>
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs - skip.back * 1000)}
            aria-label={`Back ${skip.back} seconds`}
          >
            <IconSkipBack size={36} label={String(skip.back)} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause size={38} /> : <IconPlay size={40} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs + skip.fwd * 1000)}
            aria-label={`Forward ${skip.fwd} seconds`}
          >
            <IconSkipFwd size={36} label={String(skip.fwd)} />
          </button>
          <button
            className="icon-btn icon-btn--small"
            onClick={() => goChapter(1)}
            aria-label="Next chapter"
            disabled={chapters.length === 0}
          >
            <IconChapterNext size={26} />
          </button>
        </div>

        <div className="player-secondary">
          <button className="chip" onClick={() => setSheet('playback')} aria-label="Playback speed">
            <IconSpeed size={15} /> {speed}×
          </button>
          <button
            className="chip"
            onClick={() => setSheet('sleep')}
            aria-pressed={sleepLabel != null}
          >
            <IconMoon size={15} /> {sleepLabel ?? 'Sleep'}
          </button>
          {chapters.length > 0 && (
            <button className="chip" onClick={() => setSheet('chapters')}>
              <IconToc size={15} /> Chapters
            </button>
          )}
          <button
            className="chip"
            onClick={() => setSheet('bookmarks')}
            aria-label={`Bookmarks (${audioBookmarks.length})`}
          >
            <IconBookmark size={15} /> {audioBookmarks.length || ''}
          </button>
        </div>

        {pair && (
          <button
            className="tandem-pill"
            onClick={() => void switchToText()}
            disabled={!pair.switchable}
            title={
              pair.switchable
                ? 'Open the ebook at this sentence'
                : 'Alignment not ready — switching unavailable'
            }
          >
            <IconBookOpen size={18} />
            <span>
              {pair.switchable ? 'Read from here' : 'Ebook edition · aligning…'}
              <small>
                {pair.switchable
                  ? 'Switch to the ebook at the same sentence'
                  : 'Switching unlocks once the pair is aligned'}
              </small>
            </span>
          </button>
        )}
      </div>

      {sheet === 'chapters' && (
        <Sheet title="Chapters" onClose={() => setSheet('none')}>
          {chapters.map((c, i) => (
            <button
              key={c.idx}
              className="list-row"
              aria-current={i === chapterIndex ? 'true' : undefined}
              onClick={() => {
                setSheet('none');
                if (c.startMs != null) seekTo(c.startMs);
              }}
            >
              <span className="soft" style={{ width: 24, textAlign: 'end' }}>
                {i + 1}
              </span>
              <span className="grow">{c.title}</span>
              <span className="soft">
                {c.startMs != null && c.endMs != null
                  ? formatDuration(c.endMs - c.startMs)
                  : c.startMs != null
                    ? formatDuration(c.startMs)
                    : ''}
              </span>
            </button>
          ))}
        </Sheet>
      )}
      {sheet === 'playback' && (
        <Sheet title="Playback" onClose={() => setSheet('none')}>
          <div className="rs-group">
            <div className="rs-label">Speed — {speed}×</div>
            <input
              className="slider"
              style={{ color: 'var(--rp-interactive)' }}
              type="range"
              min={0.5}
              max={3}
              step={0.05}
              value={speed}
              aria-label="Playback speed"
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
            <div className="chip-row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className="chip"
                  aria-pressed={Math.abs(speed - s) < 0.001}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
            <p style={{ fontSize: 13, color: 'var(--rp-text-soft)', margin: '8px 0 0' }}>
              Pitch is preserved at all speeds. Remembered per book.
            </p>
          </div>
          <div className="rs-group">
            <div className="rs-label">Skip back</div>
            <div className="segmented" role="group" aria-label="Skip back seconds">
              {SKIP_CHOICES.map((s) => (
                <button
                  key={s}
                  aria-pressed={skip.back === s}
                  onClick={() => setSkip({ ...skip, back: s })}
                >
                  {s}s
                </button>
              ))}
            </div>
            <div className="rs-label" style={{ marginTop: 12 }}>
              Skip forward
            </div>
            <div className="segmented" role="group" aria-label="Skip forward seconds">
              {SKIP_CHOICES.map((s) => (
                <button
                  key={s}
                  aria-pressed={skip.fwd === s}
                  onClick={() => setSkip({ ...skip, fwd: s })}
                >
                  {s}s
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      )}
      {sheet === 'sleep' && (
        <Sheet title="Sleep timer" onClose={() => setSheet('none')}>
          <div className="chip-row" style={{ flexWrap: 'wrap' }}>
            {SLEEP_OPTIONS.map((o) => (
              <button
                key={o.label}
                className="chip"
                aria-pressed={
                  o.minutes === 0
                    ? sleepUntil === null && !sleepChapterEnd
                    : o.minutes === -1
                      ? sleepChapterEnd
                      : false
                }
                onClick={() => {
                  if (o.minutes === 0) {
                    setSleepUntil(null);
                    setSleepChapterEnd(false);
                  } else if (o.minutes === -1) {
                    setSleepChapterEnd(true);
                    setSleepUntil(null);
                  } else {
                    setSleepUntil(Date.now() + o.minutes * 60_000);
                    setSleepChapterEnd(false);
                  }
                  setSheet('none');
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          {sleepUntil && (
            <button
              className="btn btn--secondary"
              style={{ marginTop: 12 }}
              onClick={() => setSleepUntil((s) => (s ?? Date.now()) + 15 * 60_000)}
            >
              Add 15 minutes
            </button>
          )}
        </Sheet>
      )}
      {returnPoint && (
        <button
          className="return-pill"
          onClick={() => {
            const rp = returnPoint;
            setReturnPoint(null);
            returnArmedRef.current = false;
            seekTo(rp.absMs);
            returnArmedRef.current = true;
          }}
        >
          <IconBack size={15} /> Back to {formatDuration(returnPoint.absMs)}
          <span
            className="return-pill__x"
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              setReturnPoint(null);
            }}
          >
            <IconClose size={14} />
          </span>
        </button>
      )}
      {sheet === 'bookmarks' && (
        <Sheet title="Bookmarks" onClose={() => setSheet('none')}>
          {audioBookmarks.length === 0 && (
            <p style={{ color: 'var(--rp-text-soft)', margin: 0 }}>
              No bookmarks yet. Tap the ribbon icon at the top while listening — tap it again at the
              same spot to remove the mark.
            </p>
          )}
          {[...audioBookmarks]
            .sort((a, b) => bookmarkAbsMs(a) - bookmarkAbsMs(b))
            .map((a) => (
              <div
                key={a.id}
                className="bm-row"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSheet('none');
                  seekTo(bookmarkAbsMs(a));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    setSheet('none');
                    seekTo(bookmarkAbsMs(a));
                  }
                }}
              >
                <span className="bm-row__icon">
                  <IconBookmark size={16} filled />
                </span>
                <span className="bm-row__body">
                  <span className="bm-row__where">
                    {formatDuration(bookmarkAbsMs(a))}
                    {nearBookmark?.id === a.id ? ' · here' : ''}
                  </span>
                  <span className="bm-row__text">{a.note ?? a.selectedText ?? 'Bookmark'}</span>
                </span>
                <button
                  className="icon-btn bm-row__delete"
                  style={{ width: 36, height: 36 }}
                  aria-label="Delete bookmark"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteBookmark(a.id);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
        </Sheet>
      )}
    </div>
  );
}
