import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useShelves } from '../state/shelves';
import { Sheet, useToast } from './ui';
import { IconCheck, IconList, IconPlus, IconShelf } from './icons';
import { ordinal } from '../lib/format';

/**
 * "Add to…": two taps to shelve a book, two to queue it. The panel STAYS
 * OPEN as rows are toggled, so putting one book on three shelves is three
 * taps rather than three trips through the menu.
 */

interface Membership {
  shelfIds: string[];
  onReadingList: boolean;
}

export function AddToSheet({
  bookId,
  title,
  onClose,
  onChanged,
}: {
  bookId: string;
  title: string;
  onClose: () => void;
  /** The book page redraws its membership chips from this. */
  onChanged?: () => void;
}) {
  const { overview, refresh, createShelf } = useShelves();
  const toast = useToast();
  const [member, setMember] = useState<Membership | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setMember(await api<Membership>(`/api/books/${bookId}/shelves`));
    } catch {
      setMember({ shelfIds: [], onReadingList: false });
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const after = useCallback(async () => {
    await load();
    await refresh();
    onChanged?.();
  }, [load, refresh, onChanged]);

  const toggleShelf = async (id: string, shelfName: string) => {
    if (!member || busy) return;
    const on = member.shelfIds.includes(id);
    setBusy(id);
    try {
      await api(`/api/shelves/${id}/books/${bookId}`, { method: on ? 'DELETE' : 'PUT' });
      await after();
      if (on) {
        toast.show(`Taken off ${shelfName}`, {
          label: 'Undo',
          onClick: () => {
            void api(`/api/shelves/${id}/books/${bookId}`, { method: 'PUT' }).then(after);
          },
        });
      } else {
        toast.show(`Added to ${shelfName}`, {
          label: 'Undo',
          onClick: () => {
            void api(`/api/shelves/${id}/books/${bookId}`, { method: 'DELETE' }).then(after);
          },
        });
      }
    } catch {
      toast.show('That did not save — check the connection.');
    } finally {
      setBusy(null);
    }
  };

  const queue = async (position: 'top' | 'end') => {
    if (!member || busy) return;
    setBusy('queue');
    try {
      if (member.onReadingList && position === 'end') {
        await api(`/api/reading-list/${bookId}`, { method: 'DELETE' });
        await after();
        toast.show('Taken off your reading list');
      } else {
        const res = await api<{ moved: boolean; position: number | null; count: number }>(
          `/api/reading-list/${bookId}`,
          { method: 'PUT', body: { position } },
        );
        await after();
        // The server reports where it actually landed, and the confirmation
        // repeats that rather than the intent. A book that was already 7th
        // and has now been moved to the front should say it moved.
        toast.show(
          position === 'top'
            ? res.moved
              ? 'Moved to the front of your reading list'
              : 'Next up on your reading list'
            : res.position !== null
              ? `Queued ${ordinal(res.position)} on your reading list`
              : 'Added to your reading list',
        );
      }
    } catch {
      toast.show('That did not save — check the connection.');
    } finally {
      setBusy(null);
    }
  };

  const submitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy('new');
    try {
      const shelf = await createShelf(wanted);
      await api(`/api/shelves/${shelf.id}/books/${bookId}`, { method: 'PUT' });
      await after();
      setName('');
      setCreating(false);
      toast.show(`Added to ${shelf.name}`);
    } catch (err) {
      toast.show(
        (err as Error).message.includes('shelf-name-taken')
          ? 'You already have a shelf with that name.'
          : 'Could not make that shelf just now.',
      );
    } finally {
      setBusy(null);
    }
  };

  const shelves = overview?.shelves ?? [];

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="addto">
        <button
          className="list-row"
          onClick={() => void queue('top')}
          disabled={busy !== null || !member}
        >
          <IconList size={17} />
          <span className="grow">Read next</span>
          <span className="soft">Front of the queue</span>
        </button>
        <button
          className="list-row"
          onClick={() => void queue('end')}
          disabled={busy !== null || !member}
          aria-pressed={member?.onReadingList ?? false}
        >
          <IconList size={17} />
          <span className="grow">
            {member?.onReadingList ? 'On your reading list' : 'Add to reading list'}
          </span>
          {member?.onReadingList && <IconCheck size={17} />}
        </button>

        <div className="addto__rule" role="presentation" />

        {shelves.length === 0 && !creating && (
          <p className="addto__empty">
            No shelves yet — a shelf is just a name and a pile of books.
          </p>
        )}
        {shelves.map((s) => {
          const on = member?.shelfIds.includes(s.id) ?? false;
          return (
            <button
              key={s.id}
              className="list-row"
              onClick={() => void toggleShelf(s.id, s.name)}
              disabled={busy !== null || !member}
              aria-pressed={on}
            >
              <IconShelf size={17} />
              <span className="grow">{s.name}</span>
              {on ? <IconCheck size={17} /> : <span className="soft">{s.count}</span>}
            </button>
          );
        })}

        {creating ? (
          <form className="addto__new" onSubmit={submitNew}>
            <label className="visually-hidden" htmlFor="addto-shelf-name">
              Shelf name
            </label>
            <input
              id="addto-shelf-name"
              ref={inputRef}
              className="input"
              value={name}
              maxLength={60}
              placeholder="Shelf name"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setCreating(false);
                  setName('');
                }
              }}
            />
            <button className="btn btn--secondary" type="submit" disabled={!name.trim()}>
              Add
            </button>
          </form>
        ) : (
          <button className="list-row" onClick={() => setCreating(true)}>
            <IconPlus size={17} />
            <span className="grow">New shelf…</span>
          </button>
        )}
      </div>
    </Sheet>
  );
}
