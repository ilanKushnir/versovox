import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { type Annotation, type BookDetail } from '../lib/types';
import { Cover, EmptyState, useToast } from '../components/ui';
import {
  IconAlert,
  IconBookmark,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLink,
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

export function BookPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [dl, setDl] = useState<DownloadState | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<BookDetail>(`/api/books/${id}`);
      setDetail(d);
      setError(null);
      const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`);
      setAnnotations(anns.annotations);
    } catch {
      setError('Could not load this book.');
    }
    setDl(await getDownloadState(id));
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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
  const audioSupport = isEbook
    ? null
    : bookAudioSupport(
        detail.tracks.length > 0 ? detail.tracks.map((t) => t.format) : [book.format],
      );

  const download = async () => {
    toast.show('Downloading for offline…');
    await startDownload(id, setDl);
    const final = await getDownloadState(id);
    if (final?.status === 'done') toast.show('Available offline');
    else if (final?.status === 'error') toast.show(`Download failed: ${final.error ?? 'unknown'}`);
  };

  return (
    <main className="app-main">
      <div className="book-hero">
        <span
          style={{ position: 'relative', display: 'block', flexShrink: 0 }}
          className="book-hero__coverwrap"
        >
          <Cover book={book} className="book-hero__cover" />
        </span>
        <div className="book-hero__body">
          <h1>{book.title}</h1>
          <div className="book-hero__meta">
            {book.author && <span>{book.author}</span>}
            {book.series && (
              <span>
                {book.series}
                {book.seriesIdx ? ` #${book.seriesIdx}` : ''}
              </span>
            )}
            <span>{isEbook ? 'EPUB' : book.format.toUpperCase()}</span>
            {book.language && <span>{book.language.toUpperCase()}</span>}
            {!isEbook && book.durationMs != null && <span>{formatDuration(book.durationMs)}</span>}
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
            <div style={{ fontSize: 13.5, color: 'var(--tl-text-soft)' }}>
              {book.progress.finished
                ? 'Finished'
                : `${formatPct(pct)} ${isEbook ? 'read' : 'listened'}`}
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
            {book.pair && book.pair.status !== 'candidate' && (
              <Link
                className="btn btn--secondary"
                to={isEbook ? `/listen/${book.pair.otherBookId}` : `/read/${book.pair.otherBookId}`}
              >
                {isEbook ? <IconHeadphones size={18} /> : <IconBookOpen size={18} />}
                {isEbook ? 'Audio edition' : 'Ebook edition'}
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
          {book.pair && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--tl-text-soft)',
                display: 'flex',
                gap: 6,
                alignItems: 'center',
              }}
            >
              <IconLink size={14} />
              {pairStatusLabel(book.pair)}
              <Link to="/pairs">Review</Link>
            </div>
          )}
        </div>
      </div>

      {detail.chapters.length > 0 && (
        <section className="list-card" aria-label="Chapters">
          <div className="list-card__head">Chapters ({detail.chapters.length})</div>
          {detail.chapters.map((c) => (
            <button
              key={c.idx}
              className="list-row"
              onClick={() =>
                isEbook
                  ? navigate(`/read/${book.id}?spine=${c.spineIdx ?? 0}`)
                  : navigate(`/listen/${book.id}?pos=${c.startMs ?? 0}`)
              }
            >
              <span className="grow">{c.title}</span>
              {c.startMs != null && <span className="soft">{formatDuration(c.startMs)}</span>}
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
              <span className="grow">
                {a.selectedText ?? a.note ?? (a.kind === 'bookmark' ? 'Bookmark' : a.kind)}
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
      {dl?.status === 'error' ? 'Retry download' : 'Download'}
    </button>
  );
}
