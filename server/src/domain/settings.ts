import path from 'node:path';
import { settingsSchema, type Settings } from '@versovox/shared';
import { type DB, nowIso } from '../db/index.js';
import { type EnvConfig } from '../config.js';

/**
 * Admin-adjustable settings, stored in the database. Environment variables
 * always take precedence (documented in docs/configuration.md); the API
 * reports which keys are env-pinned so the UI can show them read-only.
 */

const DEFAULTS: Settings = {
  defaultLanguage: 'en',
  ebookDirs: [],
  audiobookDirs: [],
  alignmentDirs: [],
  alignPrecision: 'standard',
  autoAlign: true,
  alignSpeedRatio: 0,
};

/**
 * Confidence at which two files are taken to be the same work without being
 * asked. Fixed rather than exposed: nobody can pick a better number than this
 * one without data they do not have, and the alignment itself is the real
 * check — a wrong pairing produces no matches and is handed back undecided.
 */
export const AUTO_PAIR_THRESHOLD = 0.92;

/**
 * Remember how fast this machine actually aligns, so the time a book will take
 * comes from measurement rather than a guess. Exponential moving average;
 * samples too short to mean anything are ignored.
 */
export function recordAlignSpeed(db: DB, audioMs: number, wallMs: number): void {
  if (audioMs < 30_000 || wallMs < 1_000) return;
  const sample = audioMs / wallMs;
  if (!Number.isFinite(sample) || sample <= 0 || sample > 500) return;
  const stored = getStoredSettings(db).alignSpeedRatio ?? 0;
  // A sample this far from the average is not noise — the precision setting
  // changed, or the machine did. Blending would leave the estimate wrong for
  // the next several books, so start again from the truth.
  const changed = stored > 0 && (sample > stored * 3 || sample * 3 < stored);
  const next = stored > 0 && !changed ? stored * 0.7 + sample * 0.3 : sample;
  saveSettings(db, { alignSpeedRatio: Math.round(next * 1000) / 1000 });
}

/** Settings keys that can be pinned by env vars, mapped to config fields. */
const ENV_MAP: Partial<Record<keyof Settings, keyof EnvConfig>> = {
  defaultLanguage: 'defaultLanguage',
  ebookDirs: 'ebookDirs',
  audiobookDirs: 'audiobookDirs',
  alignmentDirs: 'alignmentDirs',
};

/**
 * Library roots: VX_EBOOK_DIRS / VX_AUDIOBOOK_DIRS when set, otherwise the
 * folders chosen in the setup wizard or Settings. Always read through here
 * so the scanner, the API and the boot sequence agree.
 */
export function libraryRoots(
  db: DB,
  env: EnvConfig,
): { ebookDirs: string[]; audiobookDirs: string[] } {
  const { values } = resolveSettings(db, env);
  // Programmatic config (tests, embedding) may pass roots without env
  // pinning; they apply until the wizard/Settings store something.
  return {
    ebookDirs: values.ebookDirs.length ? values.ebookDirs : env.ebookDirs,
    audiobookDirs: values.audiobookDirs.length ? values.audiobookDirs : env.audiobookDirs,
  };
}

/**
 * Where alignments are saved as files.
 *
 * Always at least one, so no caller ever has an "if configured" branch: an
 * unset list resolves to a folder inside the app's own data directory. That is
 * enough to keep alignments across a container restart, but not across a
 * rebuild that discards the volume — which is why the setup wizard asks for a
 * folder in the library instead, and why this one is the fallback rather than
 * the recommendation.
 */
export function alignmentRoots(db: DB, env: EnvConfig): string[] {
  const { values } = resolveSettings(db, env);
  const chosen = values.alignmentDirs.length ? values.alignmentDirs : env.alignmentDirs;
  return chosen.length ? chosen : [path.join(env.dataDir, 'alignments')];
}

export function getStoredSettings(db: DB): Partial<Settings> {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string;
    value_json: string;
  }[];
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value_json);
    } catch {
      /* ignore corrupt row */
    }
  }
  const parsed = settingsSchema.partial().safeParse(out);
  if (!parsed.success) return {};
  // Same zod caveat as the settings route: `.partial()` still materialises
  // defaults for missing keys. Report only what the database really holds, so
  // callers can tell "unset" from "set to the default".
  const storedKeys = new Set(Object.keys(out));
  return Object.fromEntries(
    Object.entries(parsed.data).filter(([k]) => storedKeys.has(k)),
  ) as Partial<Settings>;
}

export function resolveSettings(db: DB, env: EnvConfig): { values: Settings; envPinned: string[] } {
  const stored = getStoredSettings(db);
  const values: Settings = { ...DEFAULTS, ...stored };
  const envPinned: string[] = [];
  for (const [settingKey, envKey] of Object.entries(ENV_MAP) as [
    keyof Settings,
    keyof EnvConfig,
  ][]) {
    if (env.envPinned.includes(envKey)) {
      (values as Record<string, unknown>)[settingKey] = env[envKey];
      envPinned.push(settingKey);
    }
  }
  return { values, envPinned };
}

export function saveSettings(db: DB, patch: Partial<Settings>): void {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(k, JSON.stringify(v), nowIso());
  }
}
