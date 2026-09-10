import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type EnvConfig } from '../config.js';
import { type DB } from '../db/index.js';

/**
 * One-time first-run bootstrap token. /api/setup (admin creation) is only
 * accepted with this token, so a stranger who merely reaches a freshly
 * started instance first cannot take it over.
 *
 * Sources, in order:
 *   1. VX_SETUP_TOKEN / VX_SETUP_TOKEN_FILE (recommended; set it in .env).
 *   2. Otherwise a random token is generated on first boot and written to
 *      <dataDir>/setup-token (0600) and to the server log.
 * There is no default token. The token is consumed (file removed, in-memory
 * copy zeroed) the moment the first admin account is created.
 */

export interface SetupTokenHandle {
  source: 'env' | 'generated';
  /** Path of the generated token file (null when supplied via env). */
  generatedPath: string | null;
  matches(candidate: string): boolean;
  /** Permanently disable the token (first admin exists now). */
  consume(): void;
}

function hashed(v: string): Buffer {
  return createHash('sha256').update(v, 'utf8').digest();
}

export function ensureSetupToken(
  config: Pick<EnvConfig, 'dataDir' | 'setupToken'>,
  db: DB,
  log: { info: (m: string) => void; warn: (m: string) => void },
): SetupTokenHandle | null {
  const tokenPath = path.join(config.dataDir, 'setup-token');
  const users = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
  if (users > 0) {
    // Setup is closed; make sure no stale generated token lingers on disk.
    fs.rmSync(tokenPath, { force: true });
    return null;
  }

  let token: string;
  let source: SetupTokenHandle['source'];
  let generatedPath: string | null = null;
  if (config.setupToken) {
    token = config.setupToken;
    source = 'env';
    log.info('First-run setup is locked with VX_SETUP_TOKEN.');
  } else {
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch {
      existing = null;
    }
    if (existing && existing.length >= 16) {
      token = existing;
    } else {
      token = randomBytes(24).toString('base64url');
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    }
    source = 'generated';
    generatedPath = tokenPath;
    log.warn(
      `First-run setup token (required to create the admin account): ${token}\n` +
        `    Also stored at ${tokenPath}. Set VX_SETUP_TOKEN in .env to choose your own.`,
    );
  }

  let consumed = false;
  let expected: Buffer | null = hashed(token);
  return {
    source,
    generatedPath,
    matches(candidate: string): boolean {
      if (consumed || !expected || !candidate) return false;
      return timingSafeEqual(hashed(candidate), expected);
    },
    consume(): void {
      consumed = true;
      expected = null;
      if (generatedPath) fs.rmSync(generatedPath, { force: true });
    },
  };
}
