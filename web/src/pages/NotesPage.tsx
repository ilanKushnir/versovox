import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type Annotation } from '@versovox/shared';
import { api } from '../api/client';
import { useToast } from '../components/ui';
import { IconBookmark, IconSearch, IconTrash } from '../components/icons';
import { COLOR_LABELS, HIGHLIGHT_COLORS, colorOf, isHighlightColor } from '../reader/marks';
import { formatDate } from '../lib/format';

/**
 * Everything you have marked, in one place.
 *
 * The reader already shows a book's own marks while you are in it. This is the
 * other half: the thing you wrote down six weeks ago in a book you have since
 * finished, which is unreachable if the only way to a note is to be reading
 * the page it sits on. So it is organised the way that search actually goes —
 * newest first, filterable by what kind of mark it is, and searchable across
 * the note, the quoted passage and the book's title at once — and every entry
 * opens the book at exactly the place it came from.
 */

type Marked = Annotation & { bookTitle: string; bookAuthor: string | null };

type KindFilter = 'all' | 'note' | 'highlight' | 'bookmark';

const KINDS: [KindFilter, string][] = [
  ['all', 'Everything'],
  ['note', 'Notes'],
  ['highlight', 'Highlights'],
  ['bookmark', 'Bookmarks'],
];

export function NotesPage() {
  const [all, setAll] = useState<Marked[] | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [query, setQuery] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const res = await api<{ annotations: Marked[] }>('/api/annotations');
      setAll(res.annotations);
    } catch {
      setAll([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Filtering happens here rather than on the server: the whole set is at most
  // a few hundred rows, and typing that filters instantly is the entire point
  // of a page like this.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter((a) => {
      if (kind !== 'all' && a.kind !== kind) return false;
      if (color && (a.kind !== 'highlight' || colorOf(a) !== color)) return false;
      if (!q) return true;
      return (
        (a.note ?? '').toLowerCase().includes(q) ||
        (a.selectedText ?? '').toLowerCase().includes(q) ||
        a.bookTitle.toLowerCase().includes(q) ||
        (a.bookAuthor ?? '').toLowerCase().includes(q)
      );
    });
  }, [all, kind, query, color]);

  /** Grouped by book, because that is how a reader remembers where it was. */
  const byBook = useMemo(() => {
    const groups = new Map<string, { title: string; author: string | null; items: Marked[] }>();
    for (const a of shown) {
      const g = groups.get(a.bookId);
      if (g) g.items.push(a);
      else groups.set(a.bookId, { title: a.bookTitle, author: a.bookAuthor, items: [a] });
    }
    return [...groups.entries()];
  }, [shown]);

  const open = (a: Marked) => {
    if (a.locator.medium !== 'ebook') {
      navigate(`/listen/${a.bookId}?pos=${a.locator.bookMs ?? a.locator.positionMs}`);
      return;
    }
    const params = new URLSearchParams({ spine: String(a.locator.spineIdx) });
    if (a.locator.charOffset !== undefined) params.set('char', String(a.locator.charOffset));
    if (a.locator.sentenceId) params.set('sentence', a.locator.sentenceId);
    navigate(`/read/${a.bookId}?${params.toString()}`);
  };

  const remove = async (a: Marked) => {
    try {
      await api(`/api/annotations/${a.id}`, { method: 'DELETE' });
      setAll((list) => (list ?? []).filter((x) => x.id !== a.id));
    } catch {
      toast.show('Could not delete — are you offline?');
    }
  };

  const counts = useMemo(() => {
    const c = { note: 0, highlight: 0, bookmark: 0 };
    for (const a of all ?? []) if (a.kind in c) c[a.kind as keyof typeof c] += 1;
    return c;
  }, [all]);

  return (
    <main className="app-main notes-page">
      <header className="page-head">
        <h1>Notes &amp; marks</h1>
        <p>
          {all === null
            ? 'Loading…'
            : all.length === 0
              ? 'Nothing marked yet.'
              : `${counts.note} note${counts.note === 1 ? '' : 's'} · ${counts.highlight} highlight${
                  counts.highlight === 1 ? '' : 's'
                } · ${counts.bookmark} bookmark${counts.bookmark === 1 ? '' : 's'}`}
        </p>
      </header>

      {all !== null && all.length > 0 && (
        <div className="notes-filters">
          <div className="notes-search">
            <IconSearch size={16} />
            <input
              className="input"
              type="search"
              value={query}
              placeholder="Search your notes, quotes and books"
              aria-label="Search your marks"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="segmented" role="group" aria-label="Kind">
            {KINDS.map(([k, label]) => (
              <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {label}
              </button>
            ))}
          </div>
          {(kind === 'all' || kind === 'highlight') && (
            <div className="swatches" role="group" aria-label="Highlight colour">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch swatch--${c}`}
                  aria-pressed={color === c}
                  aria-label={`Only ${COLOR_LABELS[c].toLowerCase()} highlights`}
                  onClick={() => setColor((cur) => (cur === c ? null : c))}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {all !== null && all.length === 0 && (
        <div className="empty-state">
          <IconBookmark size={28} />
          <h2>Nothing marked yet</h2>
          <p>
            Select a passage while reading to highlight it or write a note, and tap the ribbon to
            bookmark a page. Everything you mark lands here.
          </p>
          <Link className="btn" to="/">
            Open the library
          </Link>
        </div>
      )}

      {all !== null && all.length > 0 && shown.length === 0 && (
        <p className="empty-state">Nothing matches that.</p>
      )}

      {byBook.map(([bookId, group]) => (
        <section className="notes-group" key={bookId} aria-label={group.title}>
          <h2 className="notes-group__head">
            <Link to={`/book/${bookId}`}>{group.title}</Link>
            {group.author && <span className="notes-group__author">{group.author}</span>}
          </h2>
          <ul className="notes-list">
            {group.items.map((a) => (
              <li key={a.id} className={`note-card note-card--${a.kind}`}>
                <button
                  className="note-card__body"
                  onClick={() => open(a)}
                  aria-label={`Open ${a.kind} in ${group.title}`}
                >
                  {a.kind === 'highlight' && isHighlightColor(a.color) && (
                    <span
                      className={`note-card__swatch swatch--${colorOf(a)}`}
                      aria-hidden="true"
                    />
                  )}
                  {a.selectedText && (
                    <blockquote className="note-card__quote">{a.selectedText}</blockquote>
                  )}
                  {a.note && <p className="note-card__note">{a.note}</p>}
                  {!a.selectedText && !a.note && (
                    <p className="note-card__note note-card__note--plain">
                      {a.kind === 'bookmark' ? 'Bookmarked page' : 'Marked passage'}
                    </p>
                  )}
                  <span className="note-card__meta">{formatDate(a.createdAt)}</span>
                </button>
                <button
                  className="icon-btn note-card__delete"
                  aria-label="Delete"
                  onClick={() => void remove(a)}
                >
                  <IconTrash size={15} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
