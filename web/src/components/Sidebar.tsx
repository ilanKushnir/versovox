import { useCallback, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { AUTO_SHELVES, type AutoShelfId } from '@versovox/shared';
import { useShelves } from '../state/shelves';
import { useToast } from './ui';
import {
  IconBookOpen,
  IconCheck,
  IconChevronLeft,
  IconGrip,
  IconLibrary,
  IconLink,
  IconList,
  IconOffline,
  IconPlus,
  IconShelf,
  IconMore,
} from './icons';
import { useReorder } from './reorder';

/**
 * One shelf list, rendered in three places: the persistent rail on a wide
 * screen, the drawer at tablet widths, and the bottom sheet on a phone. They
 * share this component rather than three near-copies that drift.
 */

const AUTO_ICONS: Record<AutoShelfId, typeof IconBookOpen> = {
  'reading-now': IconBookOpen,
  finished: IconCheck,
  'both-formats': IconLink,
  'recently-added': IconLibrary,
};

function Row({
  to,
  icon,
  label,
  count,
  sub,
  onNavigate,
  children,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  count: number | null;
  sub?: string | null;
  onNavigate?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li className="sidebar__item">
      <NavLink
        to={to}
        className={({ isActive }) =>
          `sidebar__row${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}`
        }
        onClick={onNavigate}
      >
        {icon}
        <span className="sidebar__label">
          {label}
          {sub && <span className="sidebar__sub">{sub}</span>}
        </span>
        {count !== null && (
          <>
            <span className="sidebar__count" aria-hidden="true">
              {count}
            </span>
            <span className="visually-hidden">
              {count} {count === 1 ? 'book' : 'books'}
            </span>
          </>
        )}
      </NavLink>
      {children}
    </li>
  );
}

export function Sidebar({
  onNavigate,
  onCollapse,
}: {
  /** Closes the drawer or sheet the list is inside; absent in the rail. */
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const { overview, deviceCount, createShelf, renameShelf, deleteShelf, moveShelf } = useShelves();
  const navigate = useNavigate();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shelves = overview?.shelves ?? [];
  const ids = shelves.map((s) => s.id);
  const nameOf = useCallback(
    (id: string) => shelves.find((s) => s.id === id)?.name ?? 'Shelf',
    [shelves],
  );
  const reorder = useReorder({
    ids,
    labelOf: nameOf,
    onCommit: (id, afterId) => void moveShelf(id, afterId),
  });
  const byId = new Map(shelves.map((s) => [s.id, s]));

  const submitNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    setBusy(true);
    try {
      const shelf = await createShelf(wanted);
      setName('');
      setCreating(false);
      navigate(`/shelf/u/${shelf.id}`);
      onNavigate?.();
    } catch (err) {
      toast.show(
        (err as Error).message.includes('shelf-name-taken')
          ? 'You already have a shelf with that name.'
          : 'Could not make that shelf just now.',
      );
    } finally {
      setBusy(false);
    }
  };

  const closeEdit = () => {
    setEditing(null);
    setConfirmRemove(false);
    setEditName('');
  };

  const saveName = async (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const wanted = editName.trim();
    const shelf = byId.get(id);
    if (!wanted || !shelf) return;
    if (wanted === shelf.name) {
      closeEdit();
      return;
    }
    try {
      await renameShelf(id, wanted);
      closeEdit();
    } catch (err) {
      toast.show(
        (err as Error).message.includes('shelf-name-taken')
          ? 'You already have a shelf with that name.'
          : 'Could not rename that shelf just now.',
      );
    }
  };

  const remove = async (id: string) => {
    const shelf = byId.get(id);
    if (!shelf) return;
    try {
      await deleteShelf(id);
      closeEdit();
      toast.show(`Removed ${shelf.name}`);
    } catch {
      toast.show('Could not remove that shelf just now.');
    }
  };

  const queue = overview?.readingList;

  return (
    <nav className="sidebar" aria-label="Shelves">
      <ul className="sidebar__group sidebar__group--queue">
        <Row
          to="/reading-list"
          icon={<IconList size={18} />}
          label="Reading list"
          count={queue?.count ?? 0}
          sub={queue?.nextTitle ? `Next: ${queue.nextTitle}` : null}
          onNavigate={onNavigate}
        />
      </ul>

      <h2 className="sidebar__heading">Shelves</h2>
      <ul className="sidebar__group">
        {AUTO_SHELVES.map((s) => {
          const Icon = AUTO_ICONS[s.id];
          const count = overview?.auto.find((a) => a.id === s.id)?.count ?? 0;
          return (
            <Row
              key={s.id}
              to={`/shelf/${s.id}`}
              icon={<Icon size={18} />}
              label={s.label}
              count={count}
              onNavigate={onNavigate}
            />
          );
        })}
        {/* The one row the server cannot count: downloads live in this
            browser only, so its number comes from here. */}
        <Row
          to="/shelf/on-this-device"
          icon={<IconOffline size={18} />}
          label="On this device"
          count={deviceCount}
          onNavigate={onNavigate}
        />
      </ul>

      <h2 className="sidebar__heading sidebar__heading--action">
        My shelves
        <button
          className="sidebar__iconbtn"
          aria-label="New shelf"
          title="New shelf"
          onClick={() => {
            setCreating(true);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          <IconPlus size={17} />
        </button>
      </h2>
      {shelves.length === 0 && !creating && (
        <p className="sidebar__empty">A shelf is just a name and a pile of books.</p>
      )}
      <ul className="sidebar__group">
        {reorder.ids.map((id) => {
          const shelf = byId.get(id);
          if (!shelf) return null;
          const grabbed = reorder.grabbed === id;
          return (
            <li
              key={id}
              className={`sidebar__item sidebar__item--own${grabbed ? ' is-grabbed' : ''}${
                editing === id ? ' is-editing' : ''
              }`}
              ref={(el) => reorder.register(id, el)}
            >
              {editing === id ? (
                <div className="sidebar__edit">
                  <form onSubmit={(e) => void saveName(e, id)}>
                    <label className="visually-hidden" htmlFor={`shelf-name-${id}`}>
                      Shelf name
                    </label>
                    <input
                      id={`shelf-name-${id}`}
                      className="input"
                      autoFocus
                      value={editName}
                      maxLength={60}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') closeEdit();
                      }}
                    />
                    <button className="btn btn--secondary btn--sm" type="submit">
                      Save
                    </button>
                  </form>
                  {confirmRemove ? (
                    <>
                      <p className="sidebar__confirm">
                        {shelf.count === 0
                          ? 'Remove this shelf?'
                          : `The ${shelf.count} ${
                              shelf.count === 1 ? 'book' : 'books'
                            } on it stay in your library.`}
                      </p>
                      <div className="sidebar__editactions">
                        <button className="btn btn--danger btn--sm" onClick={() => void remove(id)}>
                          Remove
                        </button>
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => setConfirmRemove(false)}
                        >
                          Keep it
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="sidebar__editactions">
                      <button
                        className="btn btn--danger btn--sm"
                        onClick={() => setConfirmRemove(true)}
                      >
                        Remove…
                      </button>
                      <button className="btn btn--ghost btn--sm" onClick={closeEdit}>
                        Done
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <NavLink
                    to={`/shelf/u/${id}`}
                    className={({ isActive }) =>
                      `sidebar__row${isActive ? ' is-active' : ''}${
                        shelf.count === 0 ? ' is-zero' : ''
                      }`
                    }
                    onClick={onNavigate}
                  >
                    <IconShelf size={18} />
                    <span className="sidebar__label">{shelf.name}</span>
                    <span className="sidebar__count" aria-hidden="true">
                      {shelf.count}
                    </span>
                    <span className="visually-hidden">
                      {shelf.count} {shelf.count === 1 ? 'book' : 'books'}
                    </span>
                  </NavLink>
                  <span className="sidebar__tools">
                    <button className="sidebar__grip" type="button" {...reorder.handleProps(id)}>
                      <IconGrip size={16} />
                    </button>
                    <button
                      className="sidebar__iconbtn"
                      aria-label={`Rename or remove the shelf ${shelf.name}`}
                      onClick={() => {
                        setEditing(id);
                        setConfirmRemove(false);
                        setEditName(shelf.name);
                      }}
                    >
                      <IconMore size={16} />
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {creating ? (
        <form className="sidebar__new" onSubmit={submitNew}>
          <label className="visually-hidden" htmlFor="new-shelf-name">
            Shelf name
          </label>
          <input
            id="new-shelf-name"
            ref={inputRef}
            className="input"
            value={name}
            maxLength={60}
            placeholder="Shelf name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setCreating(false);
                setName('');
              }
            }}
          />
          <button className="btn btn--secondary" type="submit" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>
      ) : (
        shelves.length === 0 && (
          <button className="btn btn--secondary sidebar__newbtn" onClick={() => setCreating(true)}>
            <IconPlus size={17} /> New shelf
          </button>
        )
      )}

      <p className="sidebar__live visually-hidden" role="status" aria-live="polite">
        {reorder.announcement}
      </p>

      {onCollapse && (
        <div className="sidebar__foot">
          <button
            className="btn btn--ghost"
            onClick={onCollapse}
            title="Hide shelves (keyboard shortcut: [)"
          >
            <IconChevronLeft size={17} /> Hide shelves
          </button>
        </div>
      )}
    </nav>
  );
}
