import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@tandemleaf/shared';
import { api } from '../api/client';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { recordCheckpoint, resumeLocator, setActiveLocatorProvider } from '../progress/engine';
import { bookAudioSupport } from '../lib/audioSupport';
import { Cover, Sheet, useToast } from '../components/ui';
import {
  IconBack,
  IconBookmark,
  IconBookOpen,
  IconMoon,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipFwd,
  IconSpeed,
  IconToc,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';

const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SLEEP_OPTIONS = [
  { label: 'Off', minutes: 0 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '45 min', minutes: 45 },
  { label: 'End of chapter', minutes: -1 },
];

type SheetKind = 'none' | 'chapters' | 'speed' | 'sleep' | 'bookmarks';

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
  const [speed, setSpeed] = useState(() => Number(localStorage.getItem('tl-speed')) || 1);
  const [sheet, setSheet] = useState<SheetKind>('none');
  const [sleepUntil, setSleepUntil] = useState<number | null>(null);
  const [sleepChapterEnd, setSleepChapterEnd] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [handoffMarkerPct, setHandoffMarkerPct] = useState<number | null>(null);

  const pendingSeekRef = useRef<{ trackIdx: number; positionMs: number; autoplay: boolean } | null>(
    null,
  );
  const lastHeartbeatRef = useRef(0);
  const scrubbing = useRef(false);

  const tracks = detail?.tracks ?? [];
  const totalMs = useMemo(() => tracks.reduce((a, t) => a + t.durationMs, 0), [tracks]);
  const bookMs = (tracks[trackIdx]?.startMsAbsolute ?? 0) + positionMs;

  const chapters = detail?.chapters ?? [];
  const currentChapter = useMemo(() => {
    let found: (typeof chapters)[number] | null = null;
    for (const c of chapters) {
      if (c.startMs != null && c.startMs <= bookMs + 250) found = c;
      else break;
    }
    return found;
  }, [chapters, bookMs]);

  const locatorNow = useCallback(
    (): AudioLocator => ({
      medium: 'audio',
      trackIdx,
      positionMs: Math.round(positionMs),
      bookMs: Math.round(bookMs),
      pct: totalMs > 0 ? Math.min(1, bookMs / totalMs) : 0,
    }),
    [trackIdx, positionMs, bookMs, totalMs],
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
        const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
          () => ({ annotations: [] as Annotation[] }),
        );
        if (alive) setAnnotations(anns.annotations);

        const trackParam = searchParams.get('track');
        const posParam = searchParams.get('pos');
        const handoff = searchParams.get('handoff') === '1';
        if (posParam !== null) {
          let t = trackParam !== null ? Number(trackParam) || 0 : -1;
          let p = Number(posParam) || 0;
          if (t < 0) {
            // pos interpreted as absolute bookMs (chapter links).
            t = 0;
            for (let i = 0; i < d.tracks.length; i++) {
              if (p >= d.tracks[i]!.startMsAbsolute) t = i;
            }
            p = p - d.tracks[t]!.startMsAbsolute;
          }
          pendingSeekRef.current = { trackIdx: t, positionMs: p, autoplay: handoff };
          if (handoff) {
            const total = d.tracks.reduce((a, x) => a + x.durationMs, 0);
            const abs = (d.tracks[t]?.startMsAbsolute ?? 0) + p;
            setHandoffMarkerPct(total > 0 ? abs / total : null);
            const gran = searchParams.get('granularity');
            toast.show(
              gran === 'sentence'
                ? 'Continuing from your reading position'
                : 'Continuing near your reading position',
            );
          }
          void recordCheckpoint(id, handoff ? 'switch' : 'seek', {
            medium: 'audio',
            trackIdx: t,
            positionMs: Math.round(p),
            pct: 0,
          });
        } else {
          const resume = await resumeLocator(id);
          if (!alive) return;
          if (resume && resume.locator.medium === 'audio') {
            pendingSeekRef.current = {
              trackIdx: Math.min(resume.locator.trackIdx, d.tracks.length - 1),
              positionMs: resume.locator.positionMs,
              autoplay: false,
            };
          } else {
            pendingSeekRef.current = { trackIdx: 0, positionMs: 0, autoplay: false };
          }
          void recordCheckpoint(
            id,
            'open',
            pendingSeekRef.current
              ? {
                  medium: 'audio',
                  trackIdx: pendingSeekRef.current.trackIdx,
                  positionMs: Math.round(pendingSeekRef.current.positionMs),
                  pct: 0,
                }
              : { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0 },
          );
        }
        const target = pendingSeekRef.current;
        if (target) {
          setTrackIdx(target.trackIdx);
          setPositionMs(target.positionMs);
        }
      } catch {
        if (alive) setError('Could not load this audiobook.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  /* -------------------------------------------------------- audio wiring */

  const src = tracks.length > 0 ? `/api/books/${id}/track/${trackIdx}` : undefined;

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    const target = pendingSeekRef.current;
    const onLoaded = () => {
      if (target && target.trackIdx === trackIdx) {
        el.currentTime = target.positionMs / 1000;
        pendingSeekRef.current = null;
        if (target.autoplay) void el.play().catch(() => {});
      }
    };
    el.addEventListener('loadedmetadata', onLoaded);
    return () => el.removeEventListener('loadedmetadata', onLoaded);
  }, [src, trackIdx, speed]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = speed;
    el.preservesPitch = true;
    localStorage.setItem('tl-speed', String(speed));
  }, [speed]);

  const onTimeUpdate = () => {
    const el = audioRef.current;
    if (!el || scrubbing.current) return;
    const ms = el.currentTime * 1000;
    setPositionMs(ms);
    const now = Date.now();
    if (playing && now - lastHeartbeatRef.current > 15_000) {
      lastHeartbeatRef.current = now;
      void recordCheckpoint(id, 'heartbeat', {
        medium: 'audio',
        trackIdx,
        positionMs: Math.round(ms),
        bookMs: Math.round((tracks[trackIdx]?.startMsAbsolute ?? 0) + ms),
        pct: totalMs > 0 ? ((tracks[trackIdx]?.startMsAbsolute ?? 0) + ms) / totalMs : 0,
      });
    }
    // Sleep timer.
    if (sleepUntil && now >= sleepUntil) {
      el.pause();
      setSleepUntil(null);
      toast.show('Sleep timer: paused');
    }
    if (sleepChapterEnd && currentChapter?.endMs != null && bookMs >= currentChapter.endMs - 400) {
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
    } else {
      setPlaying(false);
      void recordCheckpoint(id, 'finish', { ...locatorNow(), pct: 1 });
      toast.show('Finished — nicely done');
    }
  };

  const seekTo = useCallback(
    (absMs: number, intent: 'seek' | 'heartbeat' = 'seek') => {
      if (tracks.length === 0) return;
      const clamped = Math.max(0, Math.min(absMs, totalMs - 200));
      let t = 0;
      for (let i = 0; i < tracks.length; i++) {
        if (clamped >= tracks[i]!.startMsAbsolute) t = i;
      }
      const within = clamped - tracks[t]!.startMsAbsolute;
      const el = audioRef.current;
      if (t === trackIdx && el && el.readyState > 0) {
        el.currentTime = within / 1000;
      } else {
        pendingSeekRef.current = { trackIdx: t, positionMs: within, autoplay: playing };
        setTrackIdx(t);
      }
      setPositionMs(within);
      if (intent === 'seek') {
        void recordCheckpoint(id, 'seek', {
          medium: 'audio',
          trackIdx: t,
          positionMs: Math.round(within),
          bookMs: Math.round(clamped),
          pct: totalMs > 0 ? clamped / totalMs : 0,
        });
      }
    },
    [tracks, totalMs, trackIdx, playing, id],
  );

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => toast.show('Playback blocked — tap play again'));
    else el.pause();
  }, [toast]);

  // Pause → durable checkpoint with explicit intent.
  const onPause = () => {
    setPlaying(false);
    void recordCheckpoint(id, 'pause', locatorNow());
  };

  /* -------------------------------------------------------- MediaSession */

  useEffect(() => {
    if (!('mediaSession' in navigator) || !detail) return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({
      title: currentChapter?.title ?? detail.book.title,
      artist: detail.book.author ?? 'TandemLeaf',
      album: detail.book.title,
      artwork: detail.book.hasCover ? [{ src: `/api/books/${id}/cover`, sizes: '512x512' }] : [],
    });
    ms.setActionHandler('play', () => void audioRef.current?.play());
    ms.setActionHandler('pause', () => audioRef.current?.pause());
    ms.setActionHandler('seekbackward', () => seekTo(bookMs - 15000));
    ms.setActionHandler('seekforward', () => seekTo(bookMs + 30000));
    ms.setActionHandler('seekto', (d) => {
      if (d.seekTime != null) seekTo((tracks[trackIdx]?.startMsAbsolute ?? 0) + d.seekTime * 1000);
    });
    return () => {
      ms.setActionHandler('play', null);
      ms.setActionHandler('pause', null);
      ms.setActionHandler('seekbackward', null);
      ms.setActionHandler('seekforward', null);
      ms.setActionHandler('seekto', null);
    };
  }, [detail, currentChapter, bookMs, seekTo, id, tracks, trackIdx]);

  // Keyboard controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet !== 'none') return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') {
        seekTo(bookMs - 15000);
      } else if (e.key === 'ArrowRight' || e.key === 'l') {
        seekTo(bookMs + 30000);
      } else if (e.key === 'Escape') {
        navigate(`/book/${id}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [togglePlay, seekTo, bookMs, sheet, navigate, id]);

  const switchToText = useCallback(async () => {
    if (!detail?.book.pair) return;
    try {
      const res = await api<ResolveResponse>(`/api/pairs/${detail.book.pair.pairId}/resolve`, {
        method: 'POST',
        body: { from: locatorNow() },
      });
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
      void recordCheckpoint(id, 'switch', locatorNow());
      const to = res.to as EbookLocator;
      navigate(
        `/read/${detail.book.pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
          to.sentenceId ? `&sentence=${to.sentenceId}` : ''
        }&handoff=1`,
      );
    } catch {
      toast.show('Switching failed — server unreachable?');
    }
  }, [detail, locatorNow, id, navigate, toast]);

  const addBookmark = async () => {
    try {
      const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
        method: 'POST',
        body: { kind: 'bookmark', locator: locatorNow() },
      });
      setAnnotations((a) => [...a, res.annotation]);
      toast.show(`Bookmarked at ${formatDuration(bookMs)}`);
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
  const sleepLabel = sleepChapterEnd
    ? 'Chapter'
    : sleepUntil
      ? formatDuration(sleepUntil - Date.now())
      : null;

  return (
    <div className="player-page">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={onPause}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onWaiting={() => setBuffering(true)}
        onPlaying={() => setBuffering(false)}
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
        <span style={{ fontSize: 13, color: 'var(--tl-text-soft)', fontWeight: 600 }}>
          {tracks.length > 1
            ? `Part ${trackIdx + 1} of ${tracks.length}`
            : detail.book.format.toUpperCase()}
        </span>
        <button
          className="icon-btn"
          onClick={() => void addBookmark()}
          aria-label="Bookmark this moment"
        >
          <IconBookmark />
        </button>
      </div>

      <div className="player-main">
        <Cover
          book={detail.book}
          className={detail.book.hasCover ? 'player-cover' : 'player-cover player-cover--book'}
        />
        <div className="player-titles">
          <h1>{detail.book.title}</h1>
          <div className="chapter">
            {currentChapter?.title ?? detail.book.author ?? ''}
            {buffering ? ' · buffering…' : ''}
          </div>
        </div>

        <div className="player-scrub" style={{ position: 'relative' }}>
          {handoffMarkerPct != null && (
            <span
              className="handoff-marker"
              style={{ insetInlineStart: `${handoffMarkerPct * 100}%` }}
              title="Handoff from reading"
            />
          )}
          <input
            className="slider"
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={1000}
            value={Math.round(bookMs)}
            aria-label="Position in audiobook"
            aria-valuetext={`${formatDuration(bookMs)} of ${formatDuration(totalMs)}`}
            onPointerDown={() => (scrubbing.current = true)}
            onPointerUp={() => (scrubbing.current = false)}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPositionMs(v - (tracks[trackIdx]?.startMsAbsolute ?? 0));
              seekTo(v);
            }}
          />
          <div className="player-times">
            <span>{formatDuration(bookMs)}</span>
            <span>-{formatDuration(remainingMs)}</span>
          </div>
        </div>

        <div className="player-controls">
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs - 15000)}
            aria-label="Back 15 seconds"
          >
            <IconSkipBack size={34} />
          </button>
          <button className="play-btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause size={38} /> : <IconPlay size={40} />}
          </button>
          <button
            className="icon-btn"
            onClick={() => seekTo(bookMs + 30000)}
            aria-label="Forward 30 seconds"
          >
            <IconSkipFwd size={34} />
          </button>
        </div>

        <div className="player-secondary">
          <button className="chip" onClick={() => setSheet('speed')} aria-label="Playback speed">
            <IconSpeed size={15} /> {speed}×
          </button>
          {chapters.length > 0 && (
            <button className="chip" onClick={() => setSheet('chapters')}>
              <IconToc size={15} /> Chapters
            </button>
          )}
          <button
            className="chip"
            onClick={() => setSheet('sleep')}
            aria-pressed={sleepLabel != null}
          >
            <IconMoon size={15} /> {sleepLabel ?? 'Sleep'}
          </button>
          {annotations.length > 0 && (
            <button className="chip" onClick={() => setSheet('bookmarks')}>
              <IconBookmark size={15} /> {annotations.length}
            </button>
          )}
          {detail.book.pair && detail.book.pair.status !== 'candidate' && (
            <button
              className="chip"
              onClick={() => void switchToText()}
              disabled={!detail.book.pair.switchable}
              title={
                detail.book.pair.switchable
                  ? 'Switch to the ebook at this sentence'
                  : 'Alignment not ready — switching unavailable'
              }
            >
              <IconBookOpen size={15} /> Read
            </button>
          )}
        </div>
      </div>

      {sheet === 'chapters' && (
        <Sheet title="Chapters" onClose={() => setSheet('none')}>
          {chapters.map((c) => (
            <button
              key={c.idx}
              className="list-row"
              aria-current={c.idx === currentChapter?.idx ? 'true' : undefined}
              onClick={() => {
                setSheet('none');
                if (c.startMs != null) seekTo(c.startMs);
              }}
            >
              <span className="grow">{c.title}</span>
              <span className="soft">{c.startMs != null ? formatDuration(c.startMs) : ''}</span>
            </button>
          ))}
        </Sheet>
      )}
      {sheet === 'speed' && (
        <Sheet title="Playback speed" onClose={() => setSheet('none')}>
          <div className="chip-row" style={{ flexWrap: 'wrap' }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className="chip"
                aria-pressed={speed === s}
                onClick={() => {
                  setSpeed(s);
                  setSheet('none');
                }}
              >
                {s}×
              </button>
            ))}
          </div>
          <p style={{ fontSize: 13, color: 'var(--tl-text-soft)' }}>
            Pitch is preserved at all speeds.
          </p>
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
        </Sheet>
      )}
      {sheet === 'bookmarks' && (
        <Sheet title="Bookmarks" onClose={() => setSheet('none')}>
          {annotations
            .filter((a) => a.locator.medium === 'audio')
            .map((a) => (
              <button
                key={a.id}
                className="list-row"
                onClick={() => {
                  setSheet('none');
                  const l = a.locator;
                  if (l.medium === 'audio') {
                    seekTo((tracks[l.trackIdx]?.startMsAbsolute ?? 0) + l.positionMs);
                  }
                }}
              >
                <IconBookmark size={15} filled />
                <span className="grow">{a.note ?? 'Bookmark'}</span>
                <span className="soft">
                  {a.locator.medium === 'audio'
                    ? formatDuration(
                        (tracks[a.locator.trackIdx]?.startMsAbsolute ?? 0) + a.locator.positionMs,
                      )
                    : ''}
                </span>
              </button>
            ))}
        </Sheet>
      )}
    </div>
  );
}
