import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { ensureSetupToken } from '../../auth/setupToken.js';
import { type AppContext } from '../../context.js';
import { type PreflightCheck } from './preflight.js';

/**
 * The wizard's server self-check. The interesting properties are the gate
 * (bootstrap token only while no account exists) and that the report is
 * honest about folders it was handed.
 */

const SETUP_TOKEN = 'preflight-test-setup-token';
let app: FastifyInstance;
let ctx: AppContext;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-preflight-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    modelsDir: path.join(tmp, 'models'),
    sessionSecret: 'preflight-test-secret-0123456789',
    setupToken: SETUP_TOKEN,
    logLevel: 'error',
  });
  const db = openMemoryDatabase();
  ctx = { db, config, log: { info: () => {}, warn: () => {}, error: () => {} } };
  ctx.setupToken = ensureSetupToken(config, db, { info: () => {}, warn: () => {} });
  app = buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (headers: Record<string, string>, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/preflight',
    payload: payload as never,
    headers: { 'x-vx-csrf': '1', 'content-type': 'application/json', ...headers },
  });

describe('preflight', () => {
  it('refuses without the bootstrap token', async () => {
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ 'x-vx-setup-token': 'wrong' })).statusCode).toBe(403);
  });

  it('reports every check and the aligner catalog entry', async () => {
    const res = await post({ 'x-vx-setup-token': SETUP_TOKEN });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      checks: PreflightCheck[];
      aligner: { id: string; licence: string | null; installed: boolean; sizeBytes: number };
    };
    expect(body.checks.map((c) => c.id)).toEqual([
      'audio-tools',
      'onnx-runtime',
      'aligner-model',
      'disk',
      'writable',
      'libraries',
      'whisper',
    ]);
    // No model was downloaded in this temp dir, and a missing aligner is a
    // warning rather than a failure: setup can continue without it.
    expect(body.aligner.installed).toBe(false);
    expect(body.aligner.licence).toMatch(/CC-BY-NC/);
    const model = body.checks.find((c) => c.id === 'aligner-model')!;
    expect(model.state).toBe('warn');
    expect(model.fix).toBeTruthy();
    // `ok` only tracks hard failures.
    expect(body.ok).toBe(!body.checks.some((c) => c.state === 'fail'));
  });

  it('checks the folders it is handed, not only the configured ones', async () => {
    const good = path.join(tmp, 'books');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'a.epub'), 'not really an epub');
    const ok = await post({ 'x-vx-setup-token': SETUP_TOKEN }, { ebookDirs: [good] });
    const okCheck = (ok.json() as { checks: PreflightCheck[] }).checks.find(
      (c) => c.id === 'libraries',
    )!;
    expect(okCheck.state).toBe('ok');
    expect(okCheck.detail).toContain('1 file visible');

    const bad = await post(
      { 'x-vx-setup-token': SETUP_TOKEN },
      { ebookDirs: [path.join(tmp, 'nope')] },
    );
    const badCheck = (bad.json() as { checks: PreflightCheck[] }).checks.find(
      (c) => c.id === 'libraries',
    )!;
    expect(badCheck.state).toBe('fail');
    expect(badCheck.fix).toBeTruthy();
  });

  it('rejects a malformed body', async () => {
    const res = await post({ 'x-vx-setup-token': SETUP_TOKEN }, { ebookDirs: 'not-an-array' });
    expect(res.statusCode).toBe(400);
  });
});
