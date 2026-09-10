import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type BookSummary } from '@tandemleaf/shared';
import { api } from '../api/client';
import { ChipRow, Cover, EmptyState, useToast } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconHeadphones,
  IconLibrary,
  IconLink,
  IconSearch,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';

type Filter = 'all' | 'ebook' | 'audio' | 'paired' | 'in-progress';
type Sort = 'title' | 'author' | 'recent' | 'added';

interface LibraryData {
  books: BookSummary[];
  continueRail: string[];
  scanActive: boolean;
}

export function LibraryPage() {
  const [data, setData] = useState<LibraryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('title');
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('query', query.trim());
      if (filter === 'ebook' || filter === 'audio') params.set('kind', filter);
      if (filter === 'paired' || filter === 'in-progress') params.set('filter', filter);
      params.set('sort', sort);
      const res = await api<LibraryData>(`/api/library?${params}`);
      setData(res);
      setError(null);
    } catch {
      setError('Could not load the library. Check the server connection.');
    }
  }, [query, filter, sort]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const continueBooks = useMemo(() => {
    if (!data) return [];
    const byId = new Map(data.books.map((b) => [b.id, b]));
    return data.continueRail.map((id) => byId.get(id)).filter((b): b is BookSummary => !!b);
  }, [data]);

  if (error) {
    return (
      <main className="app-main">
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {error}
        </div>
        <button className="btn btn--secondary" onClick={() => void load()}>
          Try again
        </button>
      </main>
    );
  }

  return (
    <main className="app-main">
      <h1 className="visually-hidden">Library</h1>
      <div className="toolbar">
        <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 420 }}>
          <IconSearch
            size={17}
            style={{
              position: 'absolute',
              insetInlineStart: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--tl-text-soft)',
              pointerEvents: 'none',
            }}
          />
          <input
            className="input"
            style={{ paddingInlineStart: 38, maxWidth: 'none' }}
            type="search"
            placeholder="Search title, author, series"
            aria-label="Search library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
      <ChipRow<Filter>
        ariaLabel="Filter library"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'ebook', label: 'Ebooks' },
          { value: 'audio', label: 'Audiobooks' },
          { value: 'paired', label: 'Paired' },
          { value: 'in-progress', label: 'In progress' },
        ]}
      />

      {data?.scanActive && (
        <div className="banner" role="status" style={{ marginBlockStart: 'var(--sp-4)' }}>
          <div className="spinner" style={{ width: 16, height: 16 }} />
          Scanning your libraries — new books appear as they are indexed.
        </div>
      )}

      {!data ? (
        <div className="book-grid" aria-busy="true" style={{ marginBlockStart: 'var(--sp-5)' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i}>
              <div className="skeleton" style={{ aspectRatio: '2/3' }} />
            </div>
          ))}
        </div>
      ) : (
        <>
          {continueBooks.length > 0 && filter === 'all' && !query && (
            <>
              <h2 className="section-title">Continue</h2>
              <div className="continue-rail">
                {continueBooks.map((b) => (
                  <Link
                    key={b.id}
                    className="continue-card"
                    to={b.kind === 'ebook' ? `/read/${b.id}` : `/listen/${b.id}`}
                  >
                    <span
                      className="continue-card__cover"
                      style={{ position: 'relative', overflow: 'hidden', display: 'block' }}
                    >
                      <Cover book={b} className="continue-card__cover" />
                    </span>
                    <span className="continue-card__body">
                      <span className="continue-card__title">{b.title}</span>
                      <span style={{ fontSize: 12.5, color: 'var(--tl-text-soft)' }}>
                        {b.kind === 'ebook' ? 'Reading' : 'Listening'} ·{' '}
                        {formatPct(b.progress?.pct ?? 0)}
                        {b.kind === 'audio' && b.durationMs
                          ? ` · ${formatDuration(b.durationMs * (1 - (b.progress?.pct ?? 0)))} left`
                          : ''}
                      </span>
                      <span className="progressbar" aria-hidden="true">
                        <span style={{ width: `${(b.progress?.pct ?? 0) * 100}%` }} />
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}

          {data.books.length === 0 ? (
            query || filter !== 'all' ? (
              <EmptyState icon={<IconSearch size={40} />} title="No matches">
                Nothing in your library matches this search or filter.
              </EmptyState>
            ) : (
              <EmptyState icon={<IconLibrary size={44} />} title="Your library is empty">
                TandemLeaf reads existing ebook and audiobook folders without changing them. Mount
                your libraries (TL_EBOOK_DIRS / TL_AUDIOBOOK_DIRS) and run a scan.
                <br />
              </EmptyState>
            )
          ) : (
            <>
              <h2 className="section-title">
                {filter === 'all' ? 'All books' : 'Books'}{' '}
                <span style={{ color: 'var(--tl-text-soft)', fontSize: 14, fontWeight: 400 }}>
                  {data.books.length}
                </span>
              </h2>
              <div className="book-grid">
                {data.books.map((b) => (
                  <BookCard key={b.id} book={b} />
                ))}
              </div>
            </>
          )}
          <div style={{ marginBlockStart: 'var(--sp-7)', textAlign: 'center' }}>
            <button className="btn btn--ghost" onClick={() => void rescan()}>
              Rescan libraries
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function BookCard({ book }: { book: BookSummary }) {
  const stateNote =
    book.scanState === 'error'
      ? 'Indexing failed'
      : book.scanState === 'indexing' || book.scanState === 'discovered'
        ? 'Indexing…'
        : null;
  return (
    <Link className="book-card" to={`/book/${book.id}`}>
      <span className="book-card__coverwrap">
        <Cover book={book} className="book-card__cover" />
        <span className="book-card__badges">
          {book.kind === 'ebook' ? (
            <span className="badge" title="Ebook">
              <IconBookOpen size={11} /> EPUB
            </span>
          ) : (
            <span className="badge badge--audio" title="Audiobook">
              <IconHeadphones size={11} />{' '}
              {book.format === 'multi' ? 'AUDIO' : book.format.toUpperCase()}
            </span>
          )}
          {book.pair && book.pair.status !== 'candidate' && (
            <span
              className="badge badge--paired"
              title={book.pair.switchable ? 'Paired — exact switching ready' : 'Paired edition'}
            >
              <IconLink size={11} />
              {book.pair.switchable ? ' SYNC' : ' PAIR'}
            </span>
          )}
        </span>
        {book.progress && book.progress.pct > 0.001 && !book.progress.finished && (
          <span className="book-card__progress" aria-hidden="true">
            <span style={{ width: `${book.progress.pct * 100}%` }} />
          </span>
        )}
      </span>
      <span>
        <span className="book-card__title">{book.title}</span>
        <span className="book-card__author" style={{ display: 'block' }}>
          {stateNote ?? book.author ?? ' '}
        </span>
      </span>
    </Link>
  );
}
