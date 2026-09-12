import fs from 'node:fs';
import path from 'node:path';
import { type FolderKind, type PathCheck } from '@readport/shared';
import { AUDIO_EXTS, EBOOK_EXTS } from '../scanner/scan.js';

/**
 * Library folder checks for the setup wizard and Settings. Purely
 * read-only: a folder is "ok" when it exists, is a directory and is
 * readable; the match count is a shallow, capped walk so a network share
 * with a hundred thousand files answers in well under a second.
 */

const WALK_CAP = 4000;
const WALK_DEPTH = 4;

export function checkLibraryPath(p: string, kind?: FolderKind): PathCheck {
  const abs = path.resolve(p);
  const base: PathCheck = {
    path: abs,
    ok: false,
    exists: false,
    isDirectory: false,
    readable: false,
    writable: null,
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

  // An alignment folder is the one place ReadPort writes, and a read-only bind
  // mount is the likeliest mistake in the whole setup — every other library
  // line in the stock compose file ends in `:ro` and people copy the pattern.
  // Permission bits are not enough to tell: the only honest test is to write.
  if (kind === 'alignment') {
    let writable = false;
    const probe = path.join(abs, `.readport-write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      writable = true;
    } catch {
      writable = false;
    }
    const files = countAlignmentFiles(abs);
    return {
      ...base,
      ok: writable,
      writable,
      matches: files,
      sampled: false,
      problem: writable ? null : 'Readable, but ReadPort cannot save alignments here',
    };
  }

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

/** Saved alignments already sitting in a folder, for "found N of these". */
function countAlignmentFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n.endsWith('.rpalign')).length;
  } catch {
    return 0;
  }
}

export interface BrowseEntry {
  name: string;
  path: string;
  /** Rough hint for the picker: does it look like a library root? */
  books: number;
  /** This exact path is a volume mounted into the container. */
  mounted: boolean;
  /** How many mounted volumes live below this path. */
  mountsInside: number;
}

/**
 * Directories this container has mounted from the host, read from the kernel
 * rather than guessed. In a container these are the only places that can hold
 * anything ReadPort can see, so the picker points straight at them and the UI
 * marks them. Returns [] where mountinfo is unavailable (plain host runs).
 */
export function containerMounts(
  exclude: string[] = [],
  mountinfoPath = '/proc/self/mountinfo',
): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(mountinfoPath, 'utf8');
  } catch {
    return [];
  }
  const skip = /^\/(proc|sys|dev|run)(\/|$)/;
  const excluded = exclude.map((e) => path.resolve(e));
  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    // mountinfo field 5 is the mount point inside this namespace.
    const target = line.split(' ')[4];
    if (!target || target === '/' || skip.test(target)) continue;
    if (excluded.some((e) => target === e || target.startsWith(`${e}/`))) continue;
    // The runtime also bind-mounts single files (/etc/hosts, /etc/resolv.conf).
    try {
      if (!fs.statSync(target).isDirectory()) continue;
    } catch {
      continue;
    }
    out.add(target);
  }
  return [...out].sort();
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

/**
 * Directory listing for the folder picker (directories only, capped).
 * `appDirs` are the server's own data/cache/model volumes: they are mounts
 * too, but offering them as a library would be a footgun, so they are hidden.
 */
export function browseDirectories(
  p: string | undefined,
  appDirs: string[] = [],
): {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
} {
  const mounts = containerMounts(appDirs);
  const isMount = (dir: string) => mounts.includes(dir);
  const mountsInside = (dir: string) =>
    mounts.filter((m) => m !== dir && m.startsWith(`${dir.replace(/\/$/, '')}/`)).length;

  if (!p) {
    // Start from what the container actually has mounted, plus the parents
    // that group them (a compose file mounting /library/ebooks and
    // /library/audiobooks should offer /library), then the usual suspects.
    const parents = new Set(
      mounts.map((m) => path.dirname(m)).filter((d) => d !== '/' && mountsInside(d) > 1),
    );
    const seen = new Set<string>();
    const entries: BrowseEntry[] = [];
    for (const c of [...parents, ...mounts, ...ROOT_CANDIDATES]) {
      if (seen.has(c)) continue;
      seen.add(c);
      try {
        if (!fs.statSync(c).isDirectory()) continue;
      } catch {
        continue;
      }
      entries.push({
        name: c,
        path: c,
        books: quickCount(c),
        mounted: isMount(c),
        mountsInside: mountsInside(c),
      });
    }
    if (entries.length === 0) return browseDirectories('/', appDirs);
    return { path: '', parent: null, entries };
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
      return {
        name: d.name,
        path: full,
        books: quickCount(full),
        mounted: isMount(full),
        mountsInside: mountsInside(full),
      };
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
