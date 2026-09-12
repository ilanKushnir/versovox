import path from 'node:path';
import { type DB } from './db/index.js';
import { type EnvConfig } from './config.js';
import { type SetupTokenHandle } from './auth/setupToken.js';

export interface AppContext {
  db: DB;
  config: EnvConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  /** First-run bootstrap token; null once an admin account exists. */
  setupToken?: SetupTokenHandle | null;
}

/**
 * Derived reading indexes are IMMUTABLE VERSIONED directories under
 * `derived/<bookId>/v-<jobId>`, with the active version recorded in
 * `books.derived_rev` and switched by a single atomic database UPDATE.
 * Readers therefore never observe a missing or half-replaced directory:
 * the old version stays on disk until after the pointer has moved, and a
 * crash between extraction and the switch merely leaves an orphan version
 * that the next successful re-index sweeps. A NULL derived_rev resolves to
 * the legacy unversioned layout (content directly under `derived/<bookId>`),
 * so pre-versioning installs keep working and upgrade on their next index.
 */
export function derivedRoot(ctx: AppContext, bookId: string): string {
  return path.join(ctx.config.dataDir, 'derived', bookId);
}

const DERIVED_REV_RE = /^v-[A-Za-z0-9_-]+$/;

export function derivedVersionDir(ctx: AppContext, bookId: string, rev: string | null): string {
  const root = derivedRoot(ctx, bookId);
  if (rev === null) return root; // legacy unversioned layout
  if (!DERIVED_REV_RE.test(rev)) throw new Error(`Invalid derived revision: ${rev}`);
  return path.join(root, rev);
}

/** Resolve the ACTIVE derived directory for a book via its database pointer. */
export function activeDerivedDir(ctx: AppContext, bookId: string): string {
  const row = ctx.db.prepare('SELECT derived_rev FROM books WHERE id = ?').get(bookId) as
    { derived_rev: string | null } | undefined;
  return derivedVersionDir(ctx, bookId, row?.derived_rev ?? null);
}

export function coversDir(ctx: AppContext): string {
  return path.join(ctx.config.cacheDir, 'covers');
}

