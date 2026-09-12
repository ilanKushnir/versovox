import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type ReadingListItem } from '@versovox/shared';
import { api, isOffline } from '../api/client';
import { useSession } from '../state/session';
import { useShelves } from '../state/shelves';
import { Cover, EmptyState, useToast } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconGrip,
  IconHeadphones,
  IconList,
  IconMore,
  IconOffline,
  IconTrash,
} from '../components/icons';
import { formatPct } from '../lib/format';
import { useReorder } from '../components/reorder';

/**
 * The queue. Not a grid: the order is the content, so this is an ordered list
 * of rows that can be moved with the keyboard, with a pointer, with a finger,
 * or from a menu — whichever the reader has to hand.
 */

interface QueueResponse {
  items: ReadingListItem[];
  missingCount: number;
}

export function ReadingListPage() {
  const { phase } = useSession();
  const { refresh: refreshSidebar } = useShelves();
  const toast = useToast();
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const readOnly = phase === 'offline';
  const lastGood = useRef<ReadingListItem[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api<QueueResponse>('/api/reading-list');
      setData(res);
      lastGood.current = res.items;
      setError(null);
    } catch (err) {
      setError(
        isOffline(err)
          ? 'You appear to be offline. This is the queue as it last looked.'
          : 'Could not load your reading list.',
      );
      setData((d) => d ?? { items: lastGood.current, missingCount: 0 });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];
  const ids = useMemo(() => items.map((i) => i.book.id), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.book.id, i])), [items]);

  const commit = useCallback(
    (id: string, afterBookId: string | null, nextIds: string[]) => {
      const before = items;
      // Optimistic: the row is already where the reader put it.
      setData((d) => (d ? { ...d, items: nextIds.map((i) => byId.get(i)!).filter(Boolean) } : d));
      void api(`/api/reading-list/${id}/position`, {
        method: 'PATCH',
        body: { afterBookId },
      })
        .then(() => void refreshSidebar())
        .catch((err) => {
          if ((err as Error).message.includes('stale-order')) {
            // Another device moved the neighbour out from under us. Take the
            // server's picture and say nothing.
            void load();
            return;
          }
          setData((d) => (d ? { ...d, items: before } : d));
          toast.show('Could not save the new order — check the connection.');
        });
    },
    [items, byId, load, refreshSidebar, toast],
  );

  const reorder = useReorder({
    ids,
    labelOf: (id) => byId.get(id)?.book.title ?? 'this book',
    onCommit: commit,
    disabled: readOnly,
  });

  const remove = async (id: string) => {
    const item = byId.get(id);
    if (!item) return;
    const before = items;
    setData((d) => (d ? { ...d, items: d.items.filter((i) => i.book.id !== id) } : d));
    setMenu(null);
    try {
      await api(`/api/reading-list/${id}`, { method: 'DELETE' });
      await refreshSidebar();
      toast.show(`Taken off your reading list`, {
        label: 'Undo',
        onClick: () => {
          const at = before.findIndex((i) => i.book.id === id);
          void api(`/api/reading-list/${id}`, {
            method: 'PUT',
            body: { afterBookId: at > 0 ? before[at - 1]!.book.id : null },
          })
            .then(load)
            .then(refreshSidebar);
        },
      });
    } catch {
      setData((d) => (d ? { ...d, items: before } : d));
      toast.show('Could not remove that just now.');
    }
  };

  return (
    <main className="app-main" id="library-main">
      <div className="page-head">
        <h1>Reading list</h1>
        <p>What you plan to read next, in the order you plan to read it.</p>
      </div>

      {error && (
        <div className={`banner ${readOnly ? '' : 'banner--error'}`} role="alert">
          {readOnly ? <IconOffline size={18} /> : <IconAlert size={18} />}
          <span style={{ flex: 1 }}>{error}</span>
          <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {(data?.missingCount ?? 0) > 0 && (
        <div className="banner" role="note">
          <IconAlert size={16} />
          {data!.missingCount === 1
            ? '1 book is on a drive that is not mounted, so it is not shown here.'
            : `${data!.missingCount} books are on a drive that is not mounted, so they are not shown here.`}
        </div>
      )}

      {!data ? (
        <div className="queue" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton" style={{ height: 72, marginBlockEnd: 8 }} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<IconList size={40} />}
          title="Nothing queued yet"
          action={
            <Link className="btn" to="/">
              Browse the library
            </Link>
          }
        >
          Press Read next on any cover to put a book at the front of the line.
        </EmptyState>
      ) : (
        <ol className="queue">
          {reorder.ids.map((id, index) => {
            const item = byId.get(id);
            if (!item) return null;
            const book = item.book;
            const grabbed = reorder.grabbed === id;
            const pct = book.progress?.pct ?? 0;
            return (
              <li
                key={id}
                className={`queue-row${grabbed ? ' is-grabbed' : ''}`}
                ref={(el) => reorder.register(id, el)}
                style={
                  grabbed && reorder.dragging
                    ? { transform: `translateY(${reorder.offset}px)` }
                    : undefined
                }
                {...reorder.rowProps(id)}
              >
                <button
                  className="queue-handle"
                  type="button"
                  disabled={readOnly}
                  {...reorder.handleProps(id)}
                >
                  <IconGrip size={18} />
                </button>
                <span className="queue-row__pos" aria-hidden="true">
                  {index + 1}
                </span>
                <Link className="queue-row__cover" to={`/book/${book.id}`} tabIndex={-1}>
                  <Cover book={book} className="queue-row__img" />
                </Link>
                <span className="queue-row__body">
                  <Link className="queue-row__title" to={`/book/${book.id}`}>
                    {book.title}
                  </Link>
                  <span className="queue-row__meta">
                    {book.kind === 'ebook' ? (
                      <IconBookOpen size={12} />
                    ) : (
                      <IconHeadphones size={12} />
                    )}
                    {book.author ?? 'Unknown author'}
                    {pct > 0.001 && ` · ${formatPct(pct)}`}
                  </span>
                  {item.note && <span className="queue-row__note">{item.note}</span>}
                  {pct > 0.001 && (
                    <span className="progressbar" aria-hidden="true">
                      <span style={{ width: `${pct * 100}%` }} />
                    </span>
                  )}
                </span>
                <span className="queue-row__tools">
                  <button
                    className="sidebar__iconbtn"
                    aria-label={`More for ${book.title}`}
                    aria-expanded={menu === id}
                    onClick={() => setMenu(menu === id ? null : id)}
                  >
                    <IconMore size={18} />
                  </button>
                </span>
                {menu === id && (
                  <div className="queue-menu" role="group" aria-label={`Move ${book.title}`}>
                    <button
                      className="list-row"
                      disabled={readOnly || index === 0}
                      onClick={() => {
                        reorder.moveTo(id, 'top');
                        setMenu(null);
                      }}
                    >
                      Move to top
                    </button>
                    <button
                      className="list-row"
                      disabled={readOnly || index === 0}
                      onClick={() => {
                        reorder.moveTo(id, 'up');
                        setMenu(null);
                      }}
                    >
                      Move up
                    </button>
                    <button
                      className="list-row"
                      disabled={readOnly || index === items.length - 1}
                      onClick={() => {
                        reorder.moveTo(id, 'down');
                        setMenu(null);
                      }}
                    >
                      Move down
                    </button>
                    <button
                      className="list-row"
                      disabled={readOnly || index === items.length - 1}
                      onClick={() => {
                        reorder.moveTo(id, 'bottom');
                        setMenu(null);
                      }}
                    >
                      Move to bottom
                    </button>
                    <button className="list-row" onClick={() => void remove(id)}>
                      <IconTrash size={16} />
                      <span className="grow">Take off the list</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {reorder.announcement}
      </p>
    </main>
  );
}
