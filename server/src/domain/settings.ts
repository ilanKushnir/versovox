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
  transcribeProvider: 'none',
  whisperBin: '',
  whisperModel: '',
  jobConcurrency: 2,
  autoPairThreshold: 0.92,
  storageBudgetMb: 0,
};

/** Settings keys that can be pinned by env vars, mapped to config fields. */
const ENV_MAP: Partial<Record<keyof Settings, keyof EnvConfig>> = {
  defaultLanguage: 'defaultLanguage',
  transcribeProvider: 'transcribeProvider',
  whisperBin: 'whisperBin',
  whisperModel: 'whisperModel',
  jobConcurrency: 'jobConcurrency',
};

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
  return parsed.success ? parsed.data : {};
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
