import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathEscapeError, realResolveWithin, resolveWithin } from './paths.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-paths-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-outside-'));
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'inner.txt'), 'inner');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'sneaky.txt'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveWithin', () => {
  it('resolves normal relative paths', () => {
    expect(resolveWithin(root, 'ok.txt')).toBe(path.join(root, 'ok.txt'));
    expect(resolveWithin(root, 'sub/inner.txt')).toBe(path.join(root, 'sub', 'inner.txt'));
  });

  it('rejects .. traversal', () => {
    expect(() => resolveWithin(root, '../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, 'sub/../../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveWithin(root, '..')).toThrow(PathEscapeError);
  });

  it('rejects absolute paths', () => {
    expect(() => resolveWithin(root, '/etc/passwd')).toThrow(PathEscapeError);
  });

  it('rejects prefix-sibling escapes (root vs root-suffix)', () => {
    // /tmp/vx-paths-x must not authorize /tmp/vx-paths-x-evil
    const sibling = root + '-evil';
    fs.mkdirSync(sibling, { recursive: true });
    try {
      expect(() => resolveWithin(root, `../${path.basename(sibling)}/f.txt`)).toThrow(
        PathEscapeError,
      );
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe('realResolveWithin', () => {
  it('follows symlinks only when they stay inside the root', () => {
    expect(() => realResolveWithin(root, 'sneaky.txt')).toThrow(PathEscapeError);
    expect(realResolveWithin(root, 'ok.txt')).toBe(fs.realpathSync(path.join(root, 'ok.txt')));
  });
});
