import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@versovox/shared';
import { api } from '../api/client';
import { Cover, EmptyState, useToast } from '../components/ui';
import { useSession } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLibrary,
  IconLink,
  IconOffline,
  IconPlay,
  IconSearch,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';
import { cachedBookSummary, listDownloads } from '../offline/downloads';

type Kind = 'all' | 'ebook' | 'audio';
type Shelf = 'none' | 'paired' | 'in-progress' | 'downloaded';
type Sort = 'title' | 'author' | 'recent' | 'added';

interface LibraryData {
  books: BookSummary[];
  continueRail: string[];
  scanActive: boolean;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LibraryPage() {
  const { user } = useSession();
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offlineBooks, setOfflineBooks] = useState<BookSummary[] | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 220);
  const [kind, setKind] = useState<Kind>('all');
  const [shelf, setShelf] = useState<Shelf>('none');
  const [sort, setSort] = useState<Sort>('title');
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestSeq = useRef(0);

  const loadDownloads = useCallback(async () => {
    const list = await listDownloads();
    setDownloaded(new Set(list.filter((d) => d.status === 'done').map((d) => d.bookId)));
    return list;
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const params = new URLSearchParams();
      if (debouncedQuery.trim()) params.set('query', debouncedQuery.trim());
      if (kind !== 'all') params.set('kind', kind);
      if (shelf === 'paired' || shelf === 'in-progress') params.set('filter', shelf);
      params.set('sort', sort);
      const res = await api<LibraryData>(`/api/library?${params}`);
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setData(res);
      setError(null);
      setOfflineBooks(null);
    } catch {
      if (seq !== requestSeq.current) return;
      // Offline (or server down): fall back to the titles downloaded into
      // this browser, read entirely from local storage.
      const list = await loadDownloads();
      const summaries = await Promise.all(
        list.filter((d) => d.status === 'done').map((d) => cachedBookSummary(d.bookId)),
      );
      const books = summaries.filter((b): b is BookSummary => !!b);
      setOfflineBooks(books);
      setError(
        books.length > 0
          ? 'You appear to be offline. Showing the titles downloaded to this device.'
          : 'Could not load the library. Check the server connection.',
      );
    }
  }, [debouncedQuery, kind, shelf, sort, loadDownloads]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadDownloads();
  }, [loadDownloads]);

  // Poll while a scan is active so states progress live.
  useEffect(() => {
    if (data?.scanActive && !pollRef.current) {
      pollRef.current = setInterval(() => void load(), 2500);
    } else if (!data?.scanActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.scanActive, load]);

  const rescan = async () => {
    try {
      await api('/api/library/rescan', { method: 'POST' });
      toast.show('Library rescan started');
      void load();
    } catch {
      toast.show('Rescan failed — admin required');
    }
  };

  const books = useMemo(() => {
    const source = data?.books ?? offlineBooks ?? [];
    return shelf === 'downloaded' ? source.filter((b) => downloaded.has(b.id)) : source;
  }, [data, offlineBooks, shelf, downloaded]);

  const continueBooks = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.books.map((b) => [b.id, b]));
    return data.continueRail.map((id) => byId.get(id)).filter((b): b is BookSummary => !!b);
  }, [data]);
  const hero = continueBooks[0] ?? null;
  const rail = continueBooks.slice(1);
  const showContinue = shelf === 'none' && kind === 'all' && !query && continueBooks.length > 0;

  const stats = useMemo(() => {
    const all = data?.books ?? [];
    return {
      ebooks: all.filter((b) => b.kind === 'ebook').length,
      audio: all.filter((b) => b.kind === 'audio').length,
      paired: all.filter((b) => b.pair && b.pair.status !== 'candidate').length / 2,
    };
  }, [data]);

  return (
    <main className="app-main">
      <h1 className="visually-hidden">Library</h1>

      {error && (
        <div className={`banner ${offlineBooks ? '' : 'banner--error'}`} role="alert">
          {offlineBooks ? <IconOffline size={18} /> : <IconAlert size={18} />}
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {showContinue && hero && (
        <section className="hero" aria-label="Continue">
          <HeroCard book={hero} />
          {rail.length > 0 && (
            <div className="continue-rail">
              {rail.map((b) => (
                <ContinueCard key={b.id} book={b} />
              ))}
            </div>
          )}
        </section>
      )}

      <div className="toolbar">
        <div className="searchbox">
          <IconSearch size={17} />
          <input
            className="input"
            type="search"
            placeholder="Search title, author, series"
            aria-label="Search library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="segmented segmented--inline" role="group" aria-label="Library type">
          <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            All
          </button>
          <button aria-pressed={kind === 'ebook'} onClick={() => setKind('ebook')}>
            <IconBookOpen size={15} /> Ebooks
          </button>
          <button aria-pressed={kind === 'audio'} onClick={() => setKind('audio')}>
            <IconHeadphones size={15} /> Audiobooks
          </button>
        </div>
        <label className="visually-hidden" htmlFor="lib-sort">
          Sort by
        </label>
        <select
          id="lib-sort"
          className="input"
          style={{ width: 'auto', flex: '0 0 auto' }}
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
        >
          <option value="title">Title</option>
          <option value="author">Author</option>
          <option value="recent">Recently active</option>
          <option value="added">Recently added</option>
        </select>
      </div>
      <div className="chip-row" role="group" aria-label="Shelves">
        {(
          [
            ['none', 'Everything', null],
            ['in-progress', 'In progress', <IconPlay size={13} key="p" />],
            ['paired', 'Paired editions', <IconLink size={13} key="l" />],
            ['downloaded', 'Downloaded', <IconDownload size={13} key="d" />],
          ] as [Shelf, string, React.ReactNode][]
        ).map(([value, label, icon]) => (
          <button
            key={value}
            className="chip"
            aria-pressed={shelf === value}
            onClick={() => setShelf(value)}
          >
            {icon}
            {label}
            {value === 'downloaded' && downloaded.size > 0 ? ` · ${downloaded.size}` : ''}
          </button>
        ))}
      </div>

      {data?.scanActive && (
        <div className="banner" role="status" style={{ marginBlockStart: 'var(--sp-4)' }}>
          <div className="spinner" style={{ width: 16, height: 16 }} />
          Scanning your libraries — new books appear as they are indexed.
        </div>
      )}

      {!data && !offlineBooks ? (
        <div className="book-grid" aria-busy="true" style={{ marginBlockStart: 'var(--sp-5)' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton" style={{ aspectRatio: '2/3' }} />
            </div>
          ))}
        </div>
      ) : books.length === 0 ? (
        query || kind !== 'all' || shelf !== 'none' ? (
          <EmptyState
            icon={shelf === 'downloaded' ? <IconDownload size={40} /> : <IconSearch size={40} />}
            title={shelf === 'downloaded' ? 'Nothing downloaded yet' : 'No matches'}
          >
            {shelf === 'downloaded'
              ? 'Open a book and tap Download to keep it on this device for flights and dead zones.'
              : 'Nothing in your library matches this search or filter.'}
          </EmptyState>
        ) : (
          <EmptyState icon={<IconLibrary size={44} />} title="Your library is empty">
            Versovox reads existing ebook and audiobook folders without changing them. Mount your
            libraries (VX_EBOOK_DIRS / VX_AUDIOBOOK_DIRS) and run a scan.
          </EmptyState>
        )
      ) : (
        <>
          <h2 className="section-title">
            {shelf === 'downloaded'
              ? 'Downloaded'
              : shelf === 'in-progress'
                ? 'In progress'
                : shelf === 'paired'
                  ? 'Paired editions'
                  : kind === 'ebook'
                    ? 'Ebooks'
                    : kind === 'audio'
                      ? 'Audiobooks'
                      : 'All books'}{' '}
            <span className="section-title__count">{books.length}</span>
            {shelf === 'none' && kind === 'all' && !query && data && (
              <span className="section-title__stats">
                {stats.ebooks} ebooks · {stats.audio} audiobooks
                {stats.paired > 0 ? ` · ${Math.round(stats.paired)} paired` : ''}
              </span>
            )}
          </h2>
          <div className="book-grid">
            {books.map((b) => (
              <BookCard key={b.id} book={b} offline={downloaded.has(b.id)} />
            ))}
          </div>
        </>
      )}
      {user?.role === 'admin' && data && (
        <div style={{ marginBlockStart: 'var(--sp-7)', textAlign: 'center' }}>
          <button className="btn btn--ghost" onClick={() => void rescan()}>
            Rescan libraries
          </button>
        </div>
      )}
    </main>
  );
}

function HeroCard({ book }: { book: BookSummary }) {
  const pct = book.progress?.pct ?? 0;
  const isEbook = book.kind === 'ebook';
  const primaryTo = isEbook ? `/read/${book.id}` : `/listen/${book.id}`;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  return (
    <div className="hero-card">
      <Link
        to={`/book/${book.id}`}
        className="hero-card__cover"
        aria-label={`${book.title} details`}
      >
        <Cover book={book} className="hero-card__img" />
      </Link>
      <div className="hero-card__body">
        <div className="hero-card__eyebrow">
          {isEbook ? <IconBookOpen size={14} /> : <IconHeadphones size={14} />}
          {isEbook ? 'Continue reading' : 'Continue listening'}
        </div>
        <h2 className="hero-card__title">{book.title}</h2>
        {book.author && <div className="hero-card__author">{book.author}</div>}
        <div className="hero-card__progress">
          <span className="progressbar" aria-hidden="true">
            <span style={{ width: `${pct * 100}%` }} />
          </span>
          <span className="hero-card__pct">
            {formatPct(pct)}
            {!isEbook && book.durationMs
              ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
              : ''}
          </span>
        </div>
        <div className="hero-card__actions">
          <Link className="btn" to={primaryTo}>
            {isEbook ? <IconBookOpen size={18} /> : <IconPlay size={18} />}
            {isEbook ? 'Resume reading' : 'Resume listening'}
          </Link>
          {pair && (
            <Link
              className="btn btn--secondary"
              to={`/book/${book.id}?switch=1`}
              title={
                pair.switchable
                  ? 'Continue in the other edition at the same place'
                  : 'The other edition of this book'
              }
            >
              {isEbook ? <IconHeadphones size={17} /> : <IconBookOpen size={17} />}
              {isEbook ? 'Listen instead' : 'Read instead'}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function ContinueCard({ book }: { book: BookSummary }) {
  const pct = book.progress?.pct ?? 0;
  return (
    <Link
      className="continue-card"
      to={book.kind === 'ebook' ? `/read/${book.id}` : `/listen/${book.id}`}
    >
      <span className="continue-card__cover">
        <Cover book={book} className="continue-card__img" />
      </span>
      <span className="continue-card__body">
        <span className="continue-card__title">{book.title}</span>
        <span className="continue-card__meta">
          {book.kind === 'ebook' ? <IconBookOpen size={12} /> : <IconHeadphones size={12} />}
          {formatPct(pct)}
          {book.kind === 'audio' && book.durationMs
            ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
            : ''}
        </span>
        <span className="progressbar" aria-hidden="true">
          <span style={{ width: `${pct * 100}%` }} />
        </span>
      </span>
    </Link>
  );
}

function BookCard({ book, offline }: { book: BookSummary; offline: boolean }) {
  const stateNote =
    book.scanState === 'error'
      ? 'Indexing failed'
      : book.scanState === 'indexing' || book.scanState === 'discovered'
        ? 'Indexing…'
        : null;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  return (
    <Link className="book-card" to={`/book/${book.id}`}>
      <span className="book-card__coverwrap">
        <Cover book={book} className="book-card__cover" />
        <span className="book-card__badges">
          <span className={`badge ${book.kind === 'audio' ? 'badge--audio' : ''}`}>
            {book.kind === 'ebook' ? <IconBookOpen size={11} /> : <IconHeadphones size={11} />}
            {book.kind === 'ebook'
              ? 'EPUB'
              : book.format === 'multi'
                ? 'AUDIO'
                : book.format.toUpperCase()}
          </span>
          {pair && (
            <span
              className={`badge badge--paired ${pair.switchable ? 'badge--sync' : ''}`}
              title={pair.switchable ? 'Synced — exact switching ready' : 'Paired edition'}
            >
              <IconLink size={11} />
              {pair.switchable ? 'SYNC' : 'PAIR'}
            </span>
          )}
        </span>
        {offline && (
          <span className="book-card__offline" title="Downloaded to this device">
            <IconDownload size={12} />
          </span>
        )}
        {book.progress && book.progress.pct > 0.001 && !book.progress.finished && (
          <span className="book-card__progress" aria-hidden="true">
            <span style={{ width: `${book.progress.pct * 100}%` }} />
          </span>
        )}
        {book.progress?.finished && <span className="book-card__done">Finished</span>}
      </span>
      <span>
        <span className="book-card__title">{book.title}</span>
        <span className="book-card__author" style={{ display: 'block' }}>
          {stateNote ?? book.author ?? ' '}
        </span>
      </span>
    </Link>
  );
}
