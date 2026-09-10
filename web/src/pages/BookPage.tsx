import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@tandemleaf/shared';
import { api } from '../api/client';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { Cover, EmptyState, useToast } from '../components/ui';
import {
  IconAlert,
  IconBookmark,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLink,
  IconSwitch,
  IconTrash,
} from '../components/icons';
import { formatBytes, formatDuration, formatPct } from '../lib/format';
import {
  cancelDownload,
  getDownloadState,
  removeDownload,
  startDownload,
  type DownloadState,
} from '../offline/downloads';
import { bookAudioSupport } from '../lib/audioSupport';
import { pairStatusLabel } from '../lib/pairLabel';
import { ambientColorFromImage } from '../lib/ambient';
import { recordCheckpoint } from '../progress/engine';

export function BookPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [ambient, setAmbient] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const autoSwitched = useRef(false);

  const load = useCallback(async () => {
    try {
      const d = await api<BookDetail>(`/api/books/${id}`);
      setDetail(d);
      setError(null);
      const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
        () => ({ annotations: [] as Annotation[] }),
      );
      setAnnotations(anns.annotations);
    } catch {
      setError('Could not load this book.');
    }
    setDl(await getDownloadState(id));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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

  /**
   * Open the other edition AT THE SAME PLACE: resolve this book's saved
   * position through the pair alignment and hand off with a marker. Falls
   * back to plainly opening the other edition (at its own position) when the
   * pair is not aligned or nothing has been read yet.
   */
  const openOtherEdition = useCallback(async () => {
    if (!detail?.book.pair) return;
    const { pair, progress, kind } = detail.book;
    const otherRoute =
      kind === 'ebook' ? `/listen/${pair.otherBookId}` : `/read/${pair.otherBookId}`;
    if (!pair.switchable || !progress || progress.pct <= 0.001) {
      navigate(otherRoute);
      return;
    }
    setSwitching(true);
    try {
      const res = await api<ResolveResponse>(`/api/pairs/${pair.pairId}/resolve`, {
        method: 'POST',
        body: { from: progress.locator },
      });
      if (!res.to) {
        toast.show(
          res.resolution.reason ?? 'No aligned position here — opening the other edition.',
        );
        navigate(otherRoute);
        return;
      }
      void recordCheckpoint(id, 'switch', progress.locator);
      if (res.to.medium === 'audio') {
        const to = res.to as AudioLocator;
        navigate(
          `/listen/${pair.otherBookId}?track=${to.trackIdx}&pos=${to.positionMs}&handoff=1&granularity=${res.resolution.granularity}`,
        );
      } else {
        const to = res.to as EbookLocator;
        navigate(
          `/read/${pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
            to.sentenceId ? `&sentence=${to.sentenceId}` : ''
          }&handoff=1&granularity=${res.resolution.granularity}`,
        );
      }
    } catch {
      toast.show('Could not resolve the position — opening the other edition.');
      navigate(otherRoute);
    } finally {
      setSwitching(false);
    }
  }, [detail, id, navigate, toast]);

  // `?switch=1` (from the library's "Listen/Read instead") switches right away.
  useEffect(() => {
    if (!detail || autoSwitched.current || searchParams.get('switch') !== '1') return;
    autoSwitched.current = true;
    void openOtherEdition();
  }, [detail, searchParams, openOtherEdition]);

  if (error) {
    return (
      <main className="app-main">
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {error}
        </div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="app-main" aria-busy="true">
        <div className="book-hero">
          <div className="skeleton book-hero__cover" />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 32, maxWidth: 360 }} />
            <div className="skeleton" style={{ height: 18, maxWidth: 200, marginTop: 12 }} />
          </div>
        </div>
      </main>
    );
  }

  const { book } = detail;
  const isEbook = book.kind === 'ebook';
  const pct = book.progress?.pct ?? 0;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  const audioSupport = isEbook
    ? null
    : bookAudioSupport(
        detail.tracks.length > 0 ? detail.tracks.map((t) => t.format) : [book.format],
      );

  const download = async () => {
    try {
      toast.show('Downloading for offline…');
      await startDownload(id, setDl);
      const final = await getDownloadState(id);
      if (final?.status === 'done') toast.show('Available offline');
      else if (final?.status === 'error')
        toast.show(`Download failed: ${final.error ?? 'unknown'}`);
    } catch (err) {
      toast.show(
        (err as Error).message.includes('Cache Storage')
          ? 'Offline downloads need HTTPS (or localhost) — see docs/self-hosting.md.'
          : `Download failed: ${(err as Error).message}`,
      );
    }
  };

  return (
    <main
      className="app-main book-page"
      style={ambient ? ({ '--pl-ambient': ambient } as React.CSSProperties) : undefined}
    >
      <div className="book-hero__backdrop" aria-hidden="true" />
      <div className="book-hero">
        <span className="book-hero__coverwrap">
          <Cover book={book} className="book-hero__cover" />
        </span>
        <div className="book-hero__body">
          <div className="book-hero__eyebrow">
            {isEbook ? <IconBookOpen size={14} /> : <IconHeadphones size={14} />}
            {isEbook ? 'Ebook' : 'Audiobook'}
            {book.series && (
              <>
                {' · '}
                {book.series}
                {book.seriesIdx ? ` #${book.seriesIdx}` : ''}
              </>
            )}
          </div>
          <h1>{book.title}</h1>
          {book.author && <div className="book-hero__author">{book.author}</div>}
          <div className="book-hero__meta">
            <span>{isEbook ? 'EPUB' : book.format.toUpperCase()}</span>
            {book.language && <span>{book.language.toUpperCase()}</span>}
            {!isEbook && book.durationMs != null && <span>{formatDuration(book.durationMs)}</span>}
            {detail.chapters.length > 0 && <span>{detail.chapters.length} chapters</span>}
            <span>{formatBytes(book.sizeBytes)}</span>
          </div>
          {audioSupport && !audioSupport.supported && (
            <div className="banner" role="note">
              <IconAlert size={16} /> {audioSupport.reason}
            </div>
          )}
          {book.scanState === 'error' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> Indexing failed: {book.scanError}
            </div>
          )}
          {book.scanState === 'missing' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> The source files for this book are missing from the library
              mount.
            </div>
          )}
          {book.progress && pct > 0.001 && (
            <div className="book-hero__progress">
              <span className="progressbar" aria-hidden="true">
                <span style={{ width: `${pct * 100}%` }} />
              </span>
              <span>
                {book.progress.finished
                  ? 'Finished'
                  : `${formatPct(pct)} ${isEbook ? 'read' : 'listened'}`}
                {!isEbook && !book.progress.finished && book.durationMs
                  ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
                  : ''}
              </span>
            </div>
          )}
          <div className="book-hero__actions">
            {isEbook ? (
              <Link className="btn" to={`/read/${book.id}`}>
                <IconBookOpen size={18} /> {pct > 0.001 ? 'Continue reading' : 'Read'}
              </Link>
            ) : audioSupport && !audioSupport.supported ? (
              <button className="btn" disabled title={audioSupport.reason ?? undefined}>
                <IconHeadphones size={18} /> Listen
              </button>
            ) : (
              <Link className="btn" to={`/listen/${book.id}`}>
                <IconHeadphones size={18} /> {pct > 0.001 ? 'Continue listening' : 'Listen'}
              </Link>
            )}
            <DownloadButton
              dl={dl}
              onDownload={() => void download()}
              onCancel={() => cancelDownload(id)}
              onRemove={async () => {
                await removeDownload(id);
                setDl(await getDownloadState(id));
                toast.show('Offline copy removed');
              }}
            />
          </div>
        </div>
      </div>

      {pair && (
        <section className="tandem-card" aria-label="Tandem edition">
          <div className="tandem-card__icon">
            <IconSwitch size={22} />
          </div>
          <div className="tandem-card__body">
            <div className="tandem-card__title">
              {pair.switchable
                ? `Tandem ready — switch to the ${isEbook ? 'audiobook' : 'ebook'} at the same sentence`
                : `${isEbook ? 'Audiobook' : 'Ebook'} edition paired`}
            </div>
            <div className="tandem-card__sub">
              {pairStatusLabel(pair)} <Link to="/pairs">Review pairing</Link>
            </div>
          </div>
          <button
            className="btn btn--secondary"
            onClick={() => void openOtherEdition()}
            disabled={switching}
          >
            {isEbook ? <IconHeadphones size={17} /> : <IconBookOpen size={17} />}
            {switching
              ? 'Resolving…'
              : pair.switchable && pct > 0.001
                ? isEbook
                  ? 'Listen from here'
                  : 'Read from here'
                : isEbook
                  ? 'Open audiobook'
                  : 'Open ebook'}
          </button>
        </section>
      )}
      {book.pair && book.pair.status === 'candidate' && (
        <div className="banner" role="note">
          <IconLink size={16} />
          <span style={{ flex: 1 }}>
            A possible {isEbook ? 'audiobook' : 'ebook'} edition was found and is waiting for
            review.
          </span>
          <Link to="/pairs" className="btn btn--ghost" style={{ minHeight: 36 }}>
            Review
          </Link>
        </div>
      )}

      {detail.chapters.length > 0 && (
        <section className="list-card" aria-label="Chapters">
          <div className="list-card__head">Chapters ({detail.chapters.length})</div>
          {detail.chapters.map((c, i) => (
            <button
              key={c.idx}
              className="list-row"
              onClick={() =>
                isEbook
                  ? navigate(`/read/${book.id}?spine=${c.spineIdx ?? 0}`)
                  : navigate(`/listen/${book.id}?pos=${c.startMs ?? 0}`)
              }
            >
              <span className="soft" style={{ width: 24, textAlign: 'end' }}>
                {i + 1}
              </span>
              <span className="grow">{c.title}</span>
              {c.startMs != null && (
                <span className="soft">
                  {c.endMs != null
                    ? formatDuration(c.endMs - c.startMs)
                    : formatDuration(c.startMs)}
                </span>
              )}
            </button>
          ))}
        </section>
      )}

      {annotations.length > 0 && (
        <section className="list-card" aria-label="Bookmarks and highlights">
          <div className="list-card__head">Bookmarks & highlights ({annotations.length})</div>
          {annotations.map((a) => (
            <button
              key={a.id}
              className="list-row"
              onClick={() => {
                if (a.locator.medium === 'ebook') {
                  navigate(
                    `/read/${book.id}?spine=${a.locator.spineIdx}&char=${a.locator.charOffset ?? 0}`,
                  );
                } else {
                  navigate(
                    `/listen/${book.id}?track=${a.locator.trackIdx}&pos=${a.locator.positionMs}`,
                  );
                }
              }}
            >
              <IconBookmark size={16} filled={a.kind === 'bookmark'} />
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                {a.selectedText ?? a.note ?? (a.kind === 'bookmark' ? 'Bookmark' : a.kind)}
                {a.note && a.selectedText && (
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--tl-text-soft)' }}>
                    {a.note}
                  </span>
                )}
              </span>
              <span className="soft">{formatPct(a.locator.pct)}</span>
            </button>
          ))}
        </section>
      )}

      {detail.description && (
        <section style={{ maxWidth: '65ch' }}>
          <h2 className="section-title">About</h2>
          <p style={{ color: 'var(--tl-text-soft)' }}>{detail.description}</p>
        </section>
      )}
      {detail.chapters.length === 0 && annotations.length === 0 && !detail.description && (
        <EmptyState title="No chapters listed">
          This book has no chapter metadata; you can still {isEbook ? 'read' : 'listen'} normally.
        </EmptyState>
      )}
    </main>
  );
}

function DownloadButton({
  dl,
  onDownload,
  onCancel,
  onRemove,
}: {
  dl: DownloadState | null;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  if (dl?.status === 'downloading') {
    const pctDone = dl.totalUrls ? dl.doneUrls / dl.totalUrls : 0;
    return (
      <button className="btn btn--secondary" onClick={onCancel} aria-live="polite">
        <span className="spinner" style={{ width: 16, height: 16 }} />
        {Math.round(pctDone * 100)}% · {formatBytes(dl.storedBytes)} — Cancel
      </button>
    );
  }
  if (dl?.status === 'done') {
    return (
      <button className="btn btn--danger" onClick={onRemove} title="Remove offline copy">
        <IconTrash size={17} /> Offline · {formatBytes(dl.storedBytes)}
      </button>
    );
  }
  return (
    <button className="btn btn--secondary" onClick={onDownload}>
      {dl?.status === 'error' ? <IconAlert size={17} /> : <IconDownload size={17} />}
      {dl?.status === 'error' ? 'Retry download' : 'Download for offline'}
    </button>
  );
}
