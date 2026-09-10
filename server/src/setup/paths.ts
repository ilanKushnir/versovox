import fs from 'node:fs';
import path from 'node:path';
import { type PathCheck } from '@versovox/shared';
import { AUDIO_EXTS, EBOOK_EXTS } from '../scanner/scan.js';

/**
 * Library folder checks for the setup wizard and Settings. Purely
 * read-only: a folder is "ok" when it exists, is a directory and is
 * readable; the match count is a shallow, capped walk so a network share
 * with a hundred thousand files answers in well under a second.
 */

const WALK_CAP = 4000;
const WALK_DEPTH = 4;

export function checkLibraryPath(p: string, kind?: 'ebook' | 'audio'): PathCheck {
  const abs = path.resolve(p);
  const base: PathCheck = {
    path: abs,
    ok: false,
    exists: false,
    isDirectory: false,
    readable: false,
    matches: null,
    sampled: false,
    problem: null,
  };
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ...base, problem: 'Folder does not exist (inside the container, if you run one)' };
  }
  base.exists = true;
  if (!st.isDirectory()) return { ...base, problem: 'Not a folder' };
  base.isDirectory = true;
  try {
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.X_OK);
  } catch {
    return { ...base, problem: 'Not readable by the server process' };
  }
  base.readable = true;
  const exts = kind === 'ebook' ? EBOOK_EXTS : kind === 'audio' ? AUDIO_EXTS : null;
  let matches = 0;
  let seen = 0;
  let sampled = false;
  const walk = (dir: string, depth: number) => {
    if (sampled) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > WALK_CAP) {
        sampled = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (depth < WALK_DEPTH) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!exts ? EBOOK_EXTS.has(ext) || AUDIO_EXTS.has(ext) : exts.has(ext)) matches++;
      }
    }
  };
  walk(abs, 0);
  const problem =
    matches === 0 && !sampled
      ? kind === 'ebook'
        ? 'Readable, but no .epub files found in the first few levels'
        : kind === 'audio'
          ? 'Readable, but no audio files (.m4b, .mp3, .m4a, .flac, .ogg, .opus) found in the first few levels'
          : 'Readable, but no books found in the first few levels'
      : null;
  return { ...base, ok: true, matches, sampled, problem };
}

export interface BrowseEntry {
  name: string;
  path: string;
  /** Rough hint for the picker: does it look like a library root? */
  books: number;
}

const ROOT_CANDIDATES = [
  '/library',
  '/books',
  '/audiobooks',
  '/ebooks',
  '/media',
  '/mnt',
  '/data',
  '/srv',
  '/home',
  '/Volumes',
  '/Users',
];

/** Directory listing for the folder picker (directories only, capped). */
export function browseDirectories(p: string | undefined): {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
} {
  if (!p) {
    const entries = ROOT_CANDIDATES.filter((c) => {
      try {
        return fs.statSync(c).isDirectory();
      } catch {
        return false;
      }
    });
    if (entries.length === 0) return browseDirectories('/');
    return {
      path: '',
      parent: null,
      entries: entries.map((e) => ({ name: e, path: e, books: quickCount(e) })),
    };
  }
  const abs = path.resolve(p);
  const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return { path: abs, parent, entries: [] };
  }
  const entries = names
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }))
    .slice(0, 300)
    .map((d) => {
      const full = path.join(abs, d.name);
      return { name: d.name, path: full, books: quickCount(full) };
    });
  return { path: abs, parent, entries };
}

/** One-level count of book-like files, for picker hints only. */
function quickCount(dir: string): number {
  try {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).slice(0, 400)) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (EBOOK_EXTS.has(ext) || AUDIO_EXTS.has(ext)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}
