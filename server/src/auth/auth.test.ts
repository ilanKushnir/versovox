import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMemoryDatabase, nowIso, type DB } from '../db/index.js';
import { ensureSetupToken } from './setupToken.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './passwords.js';
import { LoginThrottle } from './sessions.js';

let tmp: string;
const silentLog = { info: () => {}, warn: () => {} };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-auth-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function freshDb(): DB {
  return openMemoryDatabase();
}

describe('setup token', () => {
  it('uses the env token when provided and never writes it to disk', () => {
    const dataDir = path.join(tmp, 'env-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = ensureSetupToken(
      { dataDir, setupToken: 'operator-chosen-token' },
      freshDb(),
      silentLog,
    )!;
    expect(handle.source).toBe('env');
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
    expect(handle.matches('operator-chosen-token')).toBe(true);
    expect(handle.matches('wrong')).toBe(false);
    expect(handle.matches('')).toBe(false);
  });

  it('generates and persists a random token when none is configured', () => {
    const dataDir = path.join(tmp, 'gen-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = ensureSetupToken({ dataDir, setupToken: undefined }, freshDb(), silentLog)!;
    expect(handle.source).toBe('generated');
    const stored = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
    expect(stored.length).toBeGreaterThanOrEqual(16);
    expect(handle.matches(stored)).toBe(true);
    // Restart before setup: same token is reused, not rotated.
    const again = ensureSetupToken({ dataDir, setupToken: undefined }, freshDb(), silentLog)!;
    expect(again.matches(stored)).toBe(true);
  });

  it('consume() disables the token and removes the generated file', () => {
    const dataDir = path.join(tmp, 'consume-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const handle = ensureSetupToken({ dataDir, setupToken: undefined }, freshDb(), silentLog)!;
    const stored = fs.readFileSync(path.join(dataDir, 'setup-token'), 'utf8').trim();
    handle.consume();
    expect(handle.matches(stored)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
  });

  it('returns null (and cleans up) once users exist', () => {
    const dataDir = path.join(tmp, 'done-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'setup-token'), 'leftover-token');
    const db = freshDb();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','a','h','admin',?)`,
    ).run(nowIso());
    expect(ensureSetupToken({ dataDir, setupToken: undefined }, db, silentLog)).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'setup-token'))).toBe(false);
  });
});

describe('async passwords', () => {
  it('hash/verify round-trips; wrong password fails', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('dummy verification (unknown-user path) completes and burns real scrypt work', async () => {
    const t0 = performance.now();
    await verifyAgainstDummy('any password');
    // scrypt N=32768 cannot complete instantaneously; this guards against
    // the dummy path being optimized into a no-op (timing oracle).
    expect(performance.now() - t0).toBeGreaterThan(2);
  });
});

describe('LoginThrottle (durable)', () => {
  it('limits per key, resets, and persists across instances sharing the DB', () => {
    const db = freshDb();
    const throttle = new LoginThrottle(db, 3, 60_000);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(true);
    expect(throttle.allow('acct:alice')).toBe(false);
    // A different key is unaffected.
    expect(throttle.allow('acct:bob')).toBe(true);
    // A new instance (process restart) sees the same counters.
    const restarted = new LoginThrottle(db, 3, 60_000);
    expect(restarted.allow('acct:alice')).toBe(false);
    // Successful login clears the account counter.
    restarted.reset('acct:alice');
    expect(restarted.allow('acct:alice')).toBe(true);
  });

  it('window expiry re-admits', () => {
    const db = freshDb();
    const throttle = new LoginThrottle(db, 1, 60_000);
    expect(throttle.allow('k')).toBe(true);
    expect(throttle.allow('k')).toBe(false);
    db.prepare('UPDATE login_throttle SET reset_at = ? WHERE key = ?').run(Date.now() - 1, 'k');
    expect(throttle.allow('k')).toBe(true);
  });
});
