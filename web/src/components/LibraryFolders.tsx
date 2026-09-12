import { useEffect, useRef, useState } from 'react';
import { type FolderKind, type PathCheck } from '@versovox/shared';
import { api } from '../api/client';
import { IconAlert, IconBack, IconCheck, IconClose, IconTrash } from './icons';

/**
 * Library folder list with "Test" and a folder picker. Used by the setup
 * wizard (before any account exists, authorised by the setup token header)
 * and by Settings (admin session). Never writes anything; it only asks the
 * server whether a folder exists, is readable and looks like a library.
 */

export interface FolderCheckApi {
  test: (paths: string[], kind: FolderKind) => Promise<PathCheck[]>;
  browse: (path?: string) => Promise<BrowseResponse>;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  entries: {
    name: string;
    path: string;
    books: number;
    /** A volume the container config mounts from the host. */
    mounted?: boolean;
    /** Mounted volumes below this folder. */
    mountsInside?: number;
  }[];
}

/** API bound to the setup token (wizard) or the session (settings). */
export function folderApi(setupToken?: string): FolderCheckApi {
  const headers = setupToken ? { 'x-vx-setup-token': setupToken } : undefined;
  return {
    test: async (paths, kind) =>
      (
        await api<{ results: PathCheck[] }>('/api/setup/test-paths', {
          method: 'POST',
          body: { paths, kind },
          headers,
        })
      ).results,
    browse: async (path) =>
      api<BrowseResponse>(`/api/setup/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`, {
        headers,
      }),
  };
}

export function LibraryFolders({
  kind,
  value,
  onChange,
  folders,
  disabled,
  pinnedNote,
}: {
  kind: FolderKind;
  value: string[];
  onChange: (next: string[]) => void;
  folders: FolderCheckApi;
  disabled?: boolean;
  pinnedNote?: string | null;
}) {
  const [draft, setDraft] = useState('');
  const [checks, setChecks] = useState<Record<string, PathCheck>>({});
  const [testing, setTesting] = useState(false);
  const [picker, setPicker] = useState(false);

  const test = async (paths = value) => {
    if (paths.length === 0) return;
    setTesting(true);
    try {
      const res = await folders.test(paths, kind);
      setChecks((c) => ({ ...c, ...Object.fromEntries(res.map((r) => [r.path, r])) }));
    } catch {
      /* the row shows "untested" */
    } finally {
      setTesting(false);
    }
  };
  // Test on first render so pre-filled folders show their state.
  const initial = useRef(value);
  useEffect(() => {
    if (initial.current.length) void test(initial.current);
  }, []);

  const add = (p: string) => {
    const clean = p.trim().replace(/\/+$/, '') || p.trim();
    if (!clean || value.includes(clean)) return;
    const next = [...value, clean];
    onChange(next);
    setDraft('');
    void test([clean]);
  };

  const label = kind === 'ebook' ? 'ebook' : kind === 'audio' ? 'audiobook' : 'alignment';
  return (
    <div className="folders">
      {pinnedNote && <p className="folders__pinned">{pinnedNote}</p>}
      {value.length === 0 && (
        <p className="folders__empty">
          No {label} folders yet. Add the folder as the server sees it.
        </p>
      )}
      <ul className="folders__list">
        {value.map((p) => {
          const c = checks[p] ?? checks[p.replace(/\/+$/, '')];
          return (
            <li key={p} className={`folders__row ${c ? (c.ok ? 'is-ok' : 'is-bad') : ''}`}>
              <span className="folders__icon" aria-hidden="true">
                {!c ? '·' : c.ok ? <IconCheck size={15} /> : <IconAlert size={15} />}
              </span>
              <span className="folders__body">
                <code className="folders__path">{p}</code>
                <span className="folders__meta">
                  {!c
                    ? 'Not tested yet'
                    : c.ok
                      ? c.matches === 0
                        ? c.problem
                        : kind === 'alignment'
                          ? c.matches === 0
                            ? 'Empty — new alignments will be saved here'
                            : `${c.matches} saved alignment${c.matches === 1 ? '' : 's'} here`
                          : `${c.matches}${c.sampled ? '+' : ''} ${kind === 'ebook' ? 'EPUB' : 'audio'} file${c.matches === 1 ? '' : 's'} found`
                      : c.problem}
                </span>
              </span>
              {!disabled && (
                <button
                  type="button"
                  className="icon-btn"
                  style={{ width: 36, height: 36 }}
                  aria-label={`Remove ${p}`}
                  onClick={() => onChange(value.filter((x) => x !== p))}
                >
                  <IconTrash size={15} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!disabled && (
        <div className="folders__add">
          <input
            className="input"
            placeholder={
              kind === 'ebook'
                ? '/library/ebooks'
                : kind === 'audio'
                  ? '/library/audiobooks'
                  : '/library/alignments'
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(draft);
              }
            }}
            aria-label={`Add ${label} folder`}
            spellCheck={false}
            autoCapitalize="off"
          />
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => add(draft)}
            disabled={!draft.trim()}
          >
            Add
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setPicker(true)}>
            Browse…
          </button>
          {value.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void test()}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test again'}
            </button>
          )}
        </div>
      )}
      {picker && (
        <FolderPicker
          folders={folders}
          onPick={(p) => {
            setPicker(false);
            add(p);
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}

function FolderPicker({
  folders,
  onPick,
  onClose,
}: {
  folders: FolderCheckApi;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [cur, setCur] = useState<BrowseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async (p?: string) => {
    try {
      setCur(await folders.browse(p));
      setError(null);
    } catch {
      setError('Could not list that folder.');
    }
  };
  useEffect(() => {
    void go();
  }, []);
  return (
    <div className="picker" role="dialog" aria-label="Choose a folder">
      <div className="picker__head">
        <button
          type="button"
          className="icon-btn"
          style={{ width: 36, height: 36 }}
          disabled={!cur?.parent && !cur?.path}
          onClick={() => void go(cur?.parent ?? undefined)}
          aria-label="Up one level"
        >
          <IconBack size={16} />
        </button>
        <code className="picker__path">{cur?.path || 'Common locations'}</code>
        <button
          type="button"
          className="icon-btn"
          style={{ width: 36, height: 36 }}
          onClick={onClose}
          aria-label="Close"
        >
          <IconClose size={16} />
        </button>
      </div>
      {error && <p className="folders__meta">{error}</p>}
      {!cur?.path && cur?.entries.some((e) => e.mounted || e.mountsInside) && (
        <p className="picker__hint">
          <span className="pill-mount">mounted</span> marks a folder your container config maps in
          from the host. Only those, and what is inside them, exist for this server.
        </p>
      )}
      <ul className="picker__list">
        {cur?.entries.length === 0 && <li className="folders__meta">No sub-folders here.</li>}
        {cur?.entries.map((e) => (
          <li key={e.path}>
            <button
              type="button"
              className={`picker__row ${e.mounted ? 'is-mounted' : ''}`}
              onClick={() => void go(e.path)}
            >
              <span className="grow">{e.name}</span>
              {e.mounted && <span className="pill-mount">mounted</span>}
              {!e.mounted && !!e.mountsInside && (
                <span className="soft">{e.mountsInside} mounted inside</span>
              )}
              {e.books > 0 && <span className="soft">{e.books} books</span>}
            </button>
          </li>
        ))}
      </ul>
      {cur?.path && (
        <div className="picker__foot">
          <button type="button" className="btn" onClick={() => onPick(cur.path)}>
            Use this folder
          </button>
        </div>
      )}
    </div>
  );
}
