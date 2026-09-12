import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashFileChunks, trackSourceVersion } from './integrity.js';

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-integrity-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('hashFileChunks', () => {
  it('hashes each fixed-size chunk exactly, including a short tail', async () => {
    const data = Buffer.alloc(2_500_000);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const p = path.join(tmp, 'a.bin');
    fs.writeFileSync(p, data);
    const chunk = 1024 * 1024;
    const hashes = await hashFileChunks(p, chunk);
    expect(hashes.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      const expected = createHash('sha256')
        .update(data.subarray(i * chunk, Math.min((i + 1) * chunk, data.length)))
        .digest('hex');
      expect(hashes[i]).toBe(expected);
    }
  });

  it('an empty file has no chunks', async () => {
    const p = path.join(tmp, 'empty.bin');
    fs.writeFileSync(p, '');
    expect(await hashFileChunks(p, 1024)).toEqual([]);
  });
});

describe('trackSourceVersion', () => {
  it('is stable for identical size/mtime/path and changes when the file changes', () => {
    const a = trackSourceVersion({ size: 100, mtimeMs: 1000.7 }, 'x/a.mp3');
    expect(a).toBe(trackSourceVersion({ size: 100, mtimeMs: 1000.2 }, 'x/a.mp3')); // sub-ms noise ignored
    expect(a).not.toBe(trackSourceVersion({ size: 101, mtimeMs: 1000.7 }, 'x/a.mp3'));
    expect(a).not.toBe(trackSourceVersion({ size: 100, mtimeMs: 2000 }, 'x/a.mp3'));
    expect(a).not.toBe(trackSourceVersion({ size: 100, mtimeMs: 1000.7 }, 'x/b.mp3'));
  });
});
