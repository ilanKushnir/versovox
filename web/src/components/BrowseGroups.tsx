import { useId, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { FACET_SPECS, type FacetGroup, type FacetKind } from '@readport/shared';
import { useFacets } from '../state/facets';
import { Sheet } from './ui';
import {
  IconChevronDown,
  IconChevronRight,
  IconLibrary,
  IconList,
  IconOffline,
  IconPeople,
  IconShelf,
  IconStar,
  IconTag,
  IconType,
} from './icons';

/**
 * Browsing the library the way its own metadata already describes it.
 *
 * Every value under here was written by whoever built the library — Calibre
 * tags, an audiobook's genre, a narrator, a publisher — and ReadPort neither
 * invents categories nor writes any of it back. Which groups appear is the
 * reader's own choice, kept per person, because two people sharing a server
 * browse it differently.
 *
 * Groups are collapsed by default and their values capped: an Authors group
 * with three hundred names is a directory, not navigation, so the first
 * dozen are shown and the rest are one press away.
 */

const FACET_ICONS: Record<FacetKind, typeof IconTag> = {
  genre: IconTag,
  author: IconPeople,
  series: IconList,
  narrator: IconOffline,
  publisher: IconShelf,
  language: IconType,
  year: IconLibrary,
  rating: IconStar,
};

const FIRST_SHOWN = 12;

function Group({ group, onNavigate }: { group: FacetGroup; onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const uid = useId();
  const Icon = FACET_ICONS[group.kind];
  const values = all ? group.values : group.values.slice(0, FIRST_SHOWN);
  const hidden = group.values.length - values.length;

  return (
    <li className="sidebar__item sidebar__item--group">
      <button
        className="sidebar__row sidebar__row--group"
        aria-expanded={open}
        aria-controls={`${uid}-values`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        <Icon size={18} />
        <span className="sidebar__label">{group.label}</span>
        <span className="sidebar__count" aria-hidden="true">
          {group.values.length}
        </span>
        <span className="visually-hidden">
          {group.values.length} {group.values.length === 1 ? 'entry' : 'entries'}
        </span>
      </button>
      {open && (
        <ul className="sidebar__values" id={`${uid}-values`}>
          {values.map((v) => (
            <li key={v.value}>
              <NavLink
                to={`/browse/${group.kind}/${encodeURIComponent(v.value)}`}
                className={({ isActive }) => `sidebar__value${isActive ? ' is-active' : ''}`}
                onClick={onNavigate}
                title={v.label}
              >
                <span className="sidebar__valuename">{v.label}</span>
                <span className="sidebar__count" aria-hidden="true">
                  {v.count}
                </span>
                <span className="visually-hidden">
                  {v.count} {v.count === 1 ? 'book' : 'books'}
                </span>
              </NavLink>
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button className="sidebar__more" onClick={() => setAll(true)}>
                Show all {group.values.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** The Browse section: a heading, its groups, and the way to change them. */
export function BrowseGroups({ onNavigate }: { onNavigate?: () => void }) {
  const { groups, shown } = useFacets();
  const [customising, setCustomising] = useState(false);

  // Nothing to browse by. A library of six untagged books is not improved by
  // an empty heading explaining what could have been here.
  if (groups.length === 0) return null;

  const visible = shown
    .map((kind) => groups.find((g) => g.kind === kind))
    .filter((g): g is FacetGroup => !!g);

  return (
    <>
      <h2 className="sidebar__heading sidebar__heading--action">
        Browse
        <button
          className="sidebar__iconbtn sidebar__iconbtn--text"
          onClick={() => setCustomising(true)}
        >
          Edit
        </button>
      </h2>
      {visible.length === 0 ? (
        <p className="sidebar__empty">
          Nothing chosen. <button onClick={() => setCustomising(true)}>Pick what to show</button>.
        </p>
      ) : (
        <ul className="sidebar__group">
          {visible.map((g) => (
            <Group key={g.kind} group={g} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
      {customising && <CustomiseSheet onClose={() => setCustomising(false)} />}
    </>
  );
}

/**
 * Choosing what Browse offers.
 *
 * Every grouping this library can support is listed, with how many entries it
 * has and where those came from, so the choice is made against the library in
 * front of the reader rather than against a list of features. Groupings the
 * library cannot support are not listed at all — a Narrators row that would
 * always be empty is not an option, it is a puzzle.
 */
function CustomiseSheet({ onClose }: { onClose: () => void }) {
  const { groups, shown, save } = useFacets();
  const [picked, setPicked] = useState<FacetKind[]>(shown);
  const [saving, setSaving] = useState(false);

  const toggle = (kind: FacetKind) =>
    setPicked((p) => (p.includes(kind) ? p.filter((k) => k !== kind) : [...p, kind]));

  const commit = async () => {
    setSaving(true);
    // Saved in FACET_SPECS order rather than in the order they were ticked,
    // so the sidebar reads the same for everyone who chose the same groups.
    const order = FACET_SPECS.map((s) => s.kind);
    await save(order.filter((k) => picked.includes(k)));
    setSaving(false);
    onClose();
  };

  return (
    <Sheet title="What to browse by" onClose={onClose}>
      <p className="sheet__lede">
        These come from your own files — Calibre tags, audiobook genres, whatever your library
        already says. ReadPort never writes any of it back.
      </p>
      <ul className="facet-picker">
        {groups.map((g) => {
          const spec = FACET_SPECS.find((s) => s.kind === g.kind)!;
          const on = picked.includes(g.kind);
          return (
            <li key={g.kind}>
              <label className="facet-picker__row">
                <input type="checkbox" checked={on} onChange={() => toggle(g.kind)} />
                <span className="facet-picker__text">
                  <strong>{g.label}</strong>
                  <small>
                    {g.values.length} {g.values.length === 1 ? 'entry' : 'entries'} · {spec.source}
                  </small>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="sheet__actions">
        <button className="btn" onClick={() => void commit()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
