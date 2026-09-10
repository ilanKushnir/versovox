import fs from 'node:fs';
import path from 'node:path';

/**
 * Safe path handling for read-only library roots. All file access derived
 * from database rel_paths or user input must go through resolveWithin() so a
 * crafted path ("../../etc/passwd", absolute paths, symlink escapes) can
 * never leave the configured root.
 */

export class PathEscapeError extends Error {
  constructor(root: string, requested: string) {
    super(`Path escapes library root: ${requested} (root ${root})`);
    this.name = 'PathEscapeError';
  }
}

/** Join `rel` under `root`, rejecting absolute paths and `..` escapes. */
export function resolveWithin(root: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new PathEscapeError(root, rel);
  const rootAbs = path.resolve(root);
  const joined = path.resolve(rootAbs, rel);
  if (joined !== rootAbs && !joined.startsWith(rootAbs + path.sep)) {
    throw new PathEscapeError(root, rel);
  }
  return joined;
}

/**
 * Like resolveWithin but additionally resolves symlinks and re-checks
 * containment, so a symlink inside the library cannot point outside it.
 */
export function realResolveWithin(root: string, rel: string): string {
  const joined = resolveWithin(root, rel);
  const rootReal = fs.realpathSync(path.resolve(root));
  const real = fs.realpathSync(joined);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new PathEscapeError(root, rel);
  }
  return real;
}
