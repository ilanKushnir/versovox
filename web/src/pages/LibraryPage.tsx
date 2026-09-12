import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router-dom';
import { AUTO_SHELVES, type AutoShelfId, type BookSummary } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useShelves } from '../state/shelves';
import { AddToSheet } from '../components/AddToSheet';
import { Cover, EmptyState } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLibrary,
  IconLink,
  IconList,
  IconOffline,
  IconPlay,
  IconPlus,
  IconSearch,
  IconShelf,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';
import { cachedBookSummary, listDownloads } from '../offline/downloads';

type Kind = 'all' | 'ebook' | 'audio';
type Sort = 'title' | 'author' | 'recent' | 'added';

interface LibraryData {
  books: BookSummary[];
  continueRail: string[];
  scanActive: boolean;
}

/** Which shelf this page is showing, worked out from the route. */
type Showing =
  | { kind: 'library' }
  | { kind: 'auto'; id: AutoShelfId }
  | { kind: 'device' }
  | { kind: 'user'; id: string };

const AUTO_IDS = AUTO_SHELVES.map((s) => s.id) as string[];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function LibraryPage() {
  const params = useParams();
  const { overview, refreshDownloads } = useShelves();
  const showing = useMemo<Showing>(() => {
    if (params.shelfId) return { kind: 'user', id: params.shelfId };
    if (params.autoShelf === 'on-this-device') return { kind: 'device' };
    if (params.autoShelf && AUTO_IDS.includes(params.autoShelf)) {
      return { kind: 'auto', id: params.autoShelf as AutoShelfId };
    }
    return { kind: 'library' };
  }, [params.shelfId, params.autoShelf]);

  const [data, setData] = useState<LibraryData | null>(null);
  const [shelfName, setShelfName] = useState<string | null>(null);
  const [missingCount, setMissingCount] = useState(0);
  /** This shelf answered 404: it was removed, here or on another device. */
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineBooks, setOfflineBooks] = useState<BookSummary[] | null>(null);
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 220);
  const [kind, setKind] = useState<Kind>('all');
  const [sort, setSort] = useState<Sort>('title');
  const [addTo, setAddTo] = useState<BookSummary | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestSeq = useRef(0);
  const chipsRef = useRef<HTMLElement>(null);

  const shelfKey =
    showing.kind === 'library' ? 'library' : `${showing.kind}:${'id' in showing ? showing.id : ''}`;

  // Arriving at a different shelf starts fresh. Inside "Recently added" the
  // point IS recency, so that is where its sort starts.
  useEffect(() => {
    setSort(shelfKey === 'auto:recently-added' ? 'added' : 'title');
    setQuery('');
    setKind('all');
  }, [shelfKey]);

  // The chip you are on must be the chip you can see; a row that scrolls
  // sideways can otherwise hide the answer to "where am I".
  useEffect(() => {
    chipsRef.current
      ?.querySelector('.is-current')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [shelfKey, overview?.shelves.length]);

  const loadDownloads = useCallback(async () => {
    const list = await listDownloads();
    setDownloaded(new Set(list.filter((d) => d.status === 'done').map((d) => d.bookId)));
    return list;
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      setGone(false);
      if (showing.kind === 'user') {
        const res = await api<{
          shelf: { name: string };
          books: BookSummary[];
          missingCount: number;
        }>(`/api/shelves/${showing.id}/books?sort=${sort === 'recent' ? 'manual' : sort}`);
        if (seq !== requestSeq.current) return;
        setShelfName(res.shelf.name);
        setMissingCount(res.missingCount);
        setData({ books: res.books, continueRail: [], scanActive: false });
        setError(null);
        setOfflineBooks(null);
        return;
      }
      const params = new URLSearchParams();
      if (debouncedQuery.trim()) params.set('query', debouncedQuery.trim());
      if (kind !== 'all') params.set('kind', kind);
      if (showing.kind === 'auto') params.set('filter', showing.id);
      params.set('sort', sort);
      const res = await api<LibraryData>(`/api/library?${params}`);
      if (seq !== requestSeq.current) return;
      setData(res);
      setShelfName(null);
      setMissingCount(0);
      setError(null);
      setOfflineBooks(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      // A shelf that is not there is not a connection problem. Deleting a
      // shelf on another device used to leave this page telling you to check
      // the server.
      if (showing.kind === 'user' && err instanceof ApiError && err.status === 404) {
        setGone(true);
        setData({ books: [], continueRail: [], scanActive: false });
        setShelfName(null);
        setMissingCount(0);
        setError(null);
        setOfflineBooks(null);
        return;
      }
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
  }, [debouncedQuery, kind, sort, showing, loadDownloads]);

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

  const books = useMemo(() => {
    let source = data?.books ?? offlineBooks ?? [];
    // The one shelf the server cannot answer: what is downloaded lives in
    // this browser, so the filtering happens here and nowhere else.
    if (showing.kind === 'device') source = source.filter((b) => downloaded.has(b.id));
    if (showing.kind === 'user' || showing.kind === 'device') {
      const needle = debouncedQuery.trim().toLowerCase();
      if (needle) {
        source = source.filter(
          (b) =>
            b.title.toLowerCase().includes(needle) ||
            (b.author ?? '').toLowerCase().includes(needle) ||
            (b.series ?? '').toLowerCase().includes(needle),
        );
      }
      if (kind !== 'all') source = source.filter((b) => b.kind === kind);
    }
    return source;
  }, [data, offlineBooks, showing, downloaded, debouncedQuery, kind]);

  const continueBooks = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.books.map((b) => [b.id, b]));
    return data.continueRail.map((id) => byId.get(id)).filter((b): b is BookSummary => !!b);
  }, [data]);
  const hero = continueBooks[0] ?? null;
  const rail = continueBooks.slice(1);
  const showContinue =
    showing.kind === 'library' && kind === 'all' && !query && continueBooks.length > 0;

  const stats = useMemo(() => {
    const all = data?.books ?? [];
    return {
      ebooks: all.filter((b) => b.kind === 'ebook').length,
      audio: all.filter((b) => b.kind === 'audio').length,
      paired: all.filter((b) => b.pair && b.pair.status !== 'candidate').length / 2,
    };
  }, [data]);

  const heading =
    showing.kind === 'user'
      ? gone
        ? 'Shelf removed'
        : (shelfName ?? 'Shelf')
      : showing.kind === 'device'
        ? 'On this device'
        : showing.kind === 'auto'
          ? AUTO_SHELVES.find((s) => s.id === showing.id)!.label
          : 'Library';

  const showChips = showing.kind !== 'library' || (overview?.shelves.length ?? 0) > 0;
  const chips = [
    { to: '/', label: 'Library', end: true },
    { to: '/reading-list', label: 'Reading list', end: false },
    ...AUTO_SHELVES.map((s) => ({ to: `/shelf/${s.id}`, label: s.label, end: false })),
    { to: '/shelf/on-this-device', label: 'On this device', end: false },
    ...(overview?.shelves ?? []).map((s) => ({
      to: `/shelf/u/${s.id}`,
      label: s.name,
      end: false,
    })),
  ];

  return (
    <main className="app-main" id="main-content" tabIndex={-1}>
      <h1 className="visually-hidden">{heading}</h1>

      {/* Moving between shelves on a narrow screen: a swipe and a tap, no
          sheet. A reader with no shelves is not taxed with a control that
          does nothing yet. */}
      {showChips && (
        <nav className="shelf-chips chip-row" aria-label="Shelves" ref={chipsRef}>
          {chips.map((c) => (
            <NavLink
              key={c.to}
              to={c.to}
              end={c.end}
              className={({ isActive }) => `chip${isActive ? ' is-current' : ''}`}
            >
              {c.label}
            </NavLink>
          ))}
        </nav>
      )}

      {error && (
        <div className={`banner ${offlineBooks ? '' : 'banner--error'}`} role="alert">
          {offlineBooks ? <IconOffline size={18} /> : <IconAlert size={18} />}
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {missingCount > 0 && (
        <div className="banner" role="note">
          <IconAlert size={16} />
          {missingCount === 1
            ? '1 book on this shelf is on a drive that is not mounted.'
            : `${missingCount} books on this shelf are on a drive that is not mounted.`}
        </div>
      )}

      {showContinue && hero && (
        <section className="band band--continue" aria-labelledby="continue-h">
          <div className="band__head">
            <h2 id="continue-h" className="band__title">
              Continue
            </h2>
            {continueBooks.length > 1 && (
              <Link className="band__more" to="/shelf/reading-now">
                All in progress · {continueBooks.length}
              </Link>
            )}
          </div>
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

      <section className="band band--library" aria-labelledby="library-h">
        <div className="band__head">
          <h2 id="library-h" className="band__title">
            {heading}
            {books.length > 0 && <span className="section-title__count">{books.length}</span>}
          </h2>
          {showing.kind === 'library' && kind === 'all' && !query && data && (
            <span className="band__stats">
              {stats.ebooks} ebooks · {stats.audio} audiobooks
              {stats.paired > 0 ? ` · ${Math.round(stats.paired)} paired` : ''}
            </span>
          )}
        </div>
        {/* Nothing to search, filter or sort on a shelf that is not there. */}
        {gone ? null : (
          <div className="toolbar">
            <div className="searchbox">
              <IconSearch size={17} />
              <input
                className="input"
                type="search"
                placeholder="Search title, author, series"
                aria-label="Search this shelf"
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
              className="input input--select"
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
            >
              <option value="title">By title</option>
              <option value="author">By author</option>
              <option value="recent">
                {showing.kind === 'user' ? 'Shelf order' : 'Recently active'}
              </option>
              <option value="added">Recently added</option>
            </select>
          </div>
        )}

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
          <ShelfEmpty showing={showing} filtered={!!query || kind !== 'all'} gone={gone} />
        ) : (
          <div className="book-grid">
            {books.map((b) => (
              <BookCard
                key={b.id}
                book={b}
                offline={downloaded.has(b.id)}
                onAddTo={() => setAddTo(b)}
              />
            ))}
          </div>
        )}
      </section>

      {addTo && (
        <AddToSheet
          bookId={addTo.id}
          title={addTo.title}
          onClose={() => setAddTo(null)}
          onChanged={() => {
            void refreshDownloads();
            if (showing.kind === 'user') void load();
          }}
        />
      )}
    </main>
  );
}

function ShelfEmpty({
  showing,
  filtered,
  gone,
}: {
  showing: Showing;
  filtered: boolean;
  gone: boolean;
}) {
  if (gone) {
    return (
      <EmptyState
        icon={<IconShelf size={40} />}
        title="That shelf is no longer here"
        action={
          <Link className="btn" to="/">
            Back to the library
          </Link>
        }
      >
        It was removed — on this device or another one. The books that were on it are all still in
        your library.
      </EmptyState>
    );
  }
  if (filtered) {
    return (
      <EmptyState icon={<IconSearch size={40} />} title="No matches">
        Nothing here matches this search or filter.
      </EmptyState>
    );
  }
  if (showing.kind === 'device') {
    return (
      <EmptyState icon={<IconOffline size={40} />} title="Nothing downloaded in this browser">
        Downloads stay on the device that made them and are removed when you sign out. Open a book
        and choose Download to keep it here.
      </EmptyState>
    );
  }
  if (showing.kind === 'user') {
    return (
      <EmptyState
        icon={<IconShelf size={40} />}
        title="This shelf is empty"
        action={
          <Link className="btn" to="/">
            Browse the library
          </Link>
        }
      >
        Press the + on any cover in the library, then pick this shelf.
      </EmptyState>
    );
  }
  if (showing.kind === 'auto') {
    const copy: Record<AutoShelfId, string> = {
      'reading-now': 'Open anything and it appears here until you finish it.',
      finished: 'Books you read to the end collect here on their own.',
      'both-formats':
        'This fills up as ReadPort matches an ebook to its audiobook. The Pairing page shows what it is considering.',
      'recently-added': 'Nothing new has turned up in the last month.',
    };
    return (
      <EmptyState
        icon={showing.id === 'both-formats' ? <IconLink size={40} /> : <IconList size={40} />}
        title="Nothing here yet"
      >
        {copy[showing.id]}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={<IconLibrary size={44} />} title="Your library is empty">
      ReadPort reads ebook and audiobook folders you already have, and never writes to them. Choose
      those folders in Settings → Libraries; each one is tested before it is saved.
    </EmptyState>
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

/**
 * The card is a positioned wrapper with the link and the shelf button as
 * SIBLINGS. A button inside an anchor is invalid and swallows the keyboard,
 * so the plus cannot live inside the Link no matter how convenient that is.
 */
function BookCard({
  book,
  offline,
  onAddTo,
}: {
  book: BookSummary;
  offline: boolean;
  onAddTo: () => void;
}) {
  const stateNote =
    book.scanState === 'error'
      ? 'Indexing failed'
      : book.scanState === 'indexing' || book.scanState === 'discovered'
        ? 'Indexing…'
        : null;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  return (
    <div className="book-card">
      <Link className="book-card__link" to={`/book/${book.id}`}>
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
      <button
        className="book-card__add"
        onClick={onAddTo}
        aria-label={`Add ${book.title} to a shelf or your reading list`}
        title="Add to…"
      >
        <IconPlus size={17} />
      </button>
    </div>
  );
}
