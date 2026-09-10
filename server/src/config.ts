import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Environment configuration. Precedence (documented in docs/configuration.md):
 *   1. Environment variables (VX_*), including VX_*_FILE secret-file variants.
 *   2. In-app admin settings stored in the database (subset of keys).
 *   3. Built-in defaults.
 * Env always wins so operators can pin values in Compose.
 */

function readEnv(name: string): string | undefined {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    try {
      return fs.readFileSync(fileVar, 'utf8').trim();
    } catch (err) {
      throw new Error(`Failed to read ${name}_FILE=${fileVar}: ${(err as Error).message}`);
    }
  }
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

const envSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8383),
  host: z.string().default('127.0.0.1'),
  dataDir: z.string().default('./data'),
  cacheDir: z.string().default('./cache'),
  modelsDir: z.string().default('./models'),
  ebookDirs: z.array(z.string()).default([]),
  audiobookDirs: z.array(z.string()).default([]),
  sessionSecret: z.string().min(16).optional(),
  /** One-time first-run bootstrap token (VX_SETUP_TOKEN / VX_SETUP_TOKEN_FILE). */
  setupToken: z.string().min(8).optional(),
  /**
   * Proxy trust. Default: no proxy headers are trusted (X-Forwarded-For is
   * ignored). "1"/"true" trusts loopback/private-range proxies only; any
   * other value is a comma-separated list of addresses/CIDRs to trust.
   */
  trustProxy: z.union([z.boolean(), z.array(z.string().min(1))]).default(false),
  trustHttps: z.boolean().default(false),
  sessionDays: z.coerce.number().int().min(1).max(365).default(30),
  inlineWorker: z.boolean().default(true),
  jobConcurrency: z.coerce.number().int().min(1).max(8).default(2),
  transcribeProvider: z.enum(['none', 'fixture', 'whisper-cli']).default('none'),
  whisperBin: z.string().default(''),
  whisperModel: z.string().default(''),
  defaultLanguage: z.string().default('en'),
  /** Minutes between automatic library rescans; 0 disables (manual only). */
  scanIntervalMinutes: z.coerce.number().int().min(0).max(10_080).default(60),
  /**
   * Reverse-proxy SSO (see auth/proxyAuth.ts). Header carrying the
   * authenticated username, e.g. `x-authentik-username`; empty = disabled.
   */
  proxyAuthHeader: z.string().max(64).default(''),
  /** Proxy peer addresses/CIDRs whose header is trusted. Required when enabled. */
  proxyAuthSources: z.array(z.string()).default([]),
  /** Usernames (from the header) that are admins. */
  proxyAuthAdmins: z.array(z.string()).default([]),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type EnvConfig = z.infer<typeof envSchema> & {
  sessionSecret: string;
  /** Which keys were pinned by environment variables (shown in settings UI). */
  envPinned: string[];
};

function splitDirs(v: string | undefined): string[] | undefined {
  if (!v) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/**
 * VX_TRUST_PROXY: unset/0/false -> false (forwarded headers ignored);
 * 1/true -> trust local/private proxies only; otherwise a comma-separated
 * list of proxy addresses/CIDRs. Never trusts arbitrary forwarded headers.
 */
function parseTrustProxy(v: string | undefined): boolean | string[] | undefined {
  if (v === undefined || v === '') return undefined;
  const low = v.toLowerCase();
  if (low === '0' || low === 'false' || low === 'no') return false;
  if (low === '1' || low === 'true' || low === 'yes') {
    return ['loopback', 'linklocal', 'uniquelocal'];
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<Record<string, unknown>> = {}): EnvConfig {
  const raw: Record<string, unknown> = {
    port: readEnv('VX_PORT'),
    host: readEnv('VX_HOST'),
    dataDir: readEnv('VX_DATA_DIR'),
    cacheDir: readEnv('VX_CACHE_DIR'),
    modelsDir: readEnv('VX_MODELS_DIR'),
    ebookDirs: splitDirs(readEnv('VX_EBOOK_DIRS')),
    audiobookDirs: splitDirs(readEnv('VX_AUDIOBOOK_DIRS')),
    sessionSecret: readEnv('VX_SESSION_SECRET'),
    setupToken: readEnv('VX_SETUP_TOKEN'),
    trustProxy: parseTrustProxy(readEnv('VX_TRUST_PROXY')),
    trustHttps: bool(readEnv('VX_TRUST_HTTPS')),
    sessionDays: readEnv('VX_SESSION_DAYS'),
    inlineWorker: bool(readEnv('VX_INLINE_WORKER')),
    jobConcurrency: readEnv('VX_JOB_CONCURRENCY'),
    transcribeProvider: readEnv('VX_TRANSCRIBE_PROVIDER'),
    whisperBin: readEnv('VX_WHISPER_BIN'),
    whisperModel: readEnv('VX_WHISPER_MODEL'),
    defaultLanguage: readEnv('VX_DEFAULT_LANGUAGE'),
    scanIntervalMinutes: readEnv('VX_SCAN_INTERVAL_MINUTES'),
    proxyAuthHeader: readEnv('VX_PROXY_AUTH_HEADER'),
    proxyAuthSources: splitDirs(readEnv('VX_PROXY_AUTH_SOURCES')),
    proxyAuthAdmins: splitDirs(readEnv('VX_PROXY_AUTH_ADMINS')),
    logLevel: readEnv('VX_LOG_LEVEL'),
  };
  const envPinned = Object.entries(raw)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) delete raw[k];
  }
  Object.assign(raw, overrides);

  const parsed = envSchema.parse(raw);

  fs.mkdirSync(parsed.dataDir, { recursive: true });
  fs.mkdirSync(parsed.cacheDir, { recursive: true });

  let sessionSecret = parsed.sessionSecret;
  if (!sessionSecret) {
    // No default credentials, no hardcoded secret: generate one on first run
    // and persist it in the data dir (0600). Operators should still set
    // VX_SESSION_SECRET(_FILE) explicitly in production.
    const secretPath = path.join(parsed.dataDir, 'session-secret');
    if (fs.existsSync(secretPath)) {
      sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
    }
    if (!sessionSecret || sessionSecret.length < 16) {
      sessionSecret = randomBytes(32).toString('hex');
      fs.writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
    }
  }

  return { ...parsed, sessionSecret, envPinned };
}
