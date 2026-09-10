import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractZipToDir, ZipLimitError, type ZipLimits } from './zip.js';

/**
 * Deterministic zip-bomb / resource-exhaustion tests for the bounded
 * DISK-streaming extractor. Bombs are constructed in-test with fflate.
 */

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-zip-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeZip(name: string, files: Record<string, Uint8Array>): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, zipSync(files));
  return p;
}

function destFor(name: string): string {
  const d = path.join(tmp, `out-${name}`);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}

/** Total bytes of all files currently in a directory. */
function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
}

const laxLimits: ZipLimits = {
  maxCompressedBytes: 50 * 1024 * 1024,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
  maxTotalRatio: 1_000_000,
};

describe('extractZipToDir', () => {
  it('extracts a normal archive faithfully to disk', async () => {
    const p = writeZip('ok.zip', {
      mimetype: strToU8('application/epub+zip'),
      'META-INF/container.xml': strToU8('<container/>'),
      'OEBPS/ch1.xhtml': strToU8('<html><body>hello</body></html>'),
    });
    const dest = destFor('ok');
    const index = await extractZipToDir(p, dest, laxLimits);
    expect(index.size).toBe(3);
    const entry = index.get('OEBPS/ch1.xhtml')!;
    expect(entry.size).toBeGreaterThan(0);
    expect(fs.readFileSync(entry.filePath, 'utf8')).toContain('hello');
    // Entry files live inside the destination dir under opaque names.
    expect(path.dirname(entry.filePath)).toBe(dest);
  });

  it('rejects an archive over the compressed-size limit without reading it', async () => {
    const p = path.join(tmp, 'big.bin');
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024));
    await expect(
      extractZipToDir(p, destFor('big'), { ...laxLimits, maxCompressedBytes: 1024 * 1024 }),
    ).rejects.toThrow(ZipLimitError);
  });

  it('rejects a single entry mid-stream and removes its partial file', async () => {
    const p = writeZip('entry-bomb.zip', { 'a.bin': new Uint8Array(8 * 1024 * 1024) });
    const dest = destFor('entry-bomb');
    await expect(
      extractZipToDir(p, dest, { ...laxLimits, maxEntryBytes: 1024 * 1024 }),
    ).rejects.toThrow(/per-file limit/);
    // Rejected BEFORE dangerous growth: nothing near the claimed 8MB landed,
    // and the partial entry file was deleted.
    expect(dirBytes(dest)).toBe(0);
  });

  it('rejects when the aggregate decompressed size exceeds the limit', async () => {
    const p = writeZip('agg-bomb.zip', {
      'a.bin': new Uint8Array(2 * 1024 * 1024),
      'b.bin': new Uint8Array(2 * 1024 * 1024),
      'c.bin': new Uint8Array(2 * 1024 * 1024),
    });
    const dest = destFor('agg');
    await expect(
      extractZipToDir(p, dest, {
        ...laxLimits,
        maxEntryBytes: 3 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toThrow(/decompressed size limit/);
    // Disk usage never exceeded the aggregate cap (plus nothing partial).
    expect(dirBytes(dest)).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('rejects too many entries', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 50; i++) files[`f${i}.txt`] = strToU8(`x${i}`);
    const p = writeZip('many.zip', files);
    await expect(
      extractZipToDir(p, destFor('many'), { ...laxLimits, maxEntries: 10 }),
    ).rejects.toThrow(/entries/);
  });

  it('rejects an implausibly high compression ratio (classic zip bomb shape)', async () => {
    // 16MB of zeros compresses to a few KB: enormous expansion ratio.
    const p = writeZip('ratio-bomb.zip', { 'zeros.bin': new Uint8Array(16 * 1024 * 1024) });
    await expect(
      extractZipToDir(p, destFor('ratio'), {
        ...laxLimits,
        maxEntryBytes: 64 * 1024 * 1024,
        maxTotalBytes: 64 * 1024 * 1024,
        maxTotalRatio: 100,
      }),
    ).rejects.toThrow(/zip bomb/);
  });

  it('drops absolute and upward-escaping entry names without extracting them', async () => {
    const p = writeZip('traversal.zip', {
      'ok.txt': strToU8('fine'),
      '../escape.txt': strToU8('evil'),
      '/abs.txt': strToU8('evil'),
      'a/../../up.txt': strToU8('evil'),
    });
    const dest = destFor('traversal');
    const index = await extractZipToDir(p, dest, laxLimits);
    expect([...index.keys()]).toEqual(['ok.txt']);
    // Nothing escaped the destination directory.
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
    expect(fs.existsSync('/abs.txt')).toBe(false);
    for (const f of fs.readdirSync(dest)) {
      expect(fs.readFileSync(path.join(dest, f), 'utf8')).not.toBe('evil');
    }
  });

  it('PEAK SHAPE: a book-sized archive streams to disk without aggregate retention', async () => {
    // 6 x 8MB incompressible entries = 48MB decompressed. The old extractor
    // retained every decompressed entry in a Map AND duplicated each into a
    // second allocation (>= 96MB peak). The streaming extractor holds at
    // most one inflate chunk, so sampled memory growth during extraction
    // must stay FAR below the archive's decompressed size while all 48MB
    // land on disk. (Stored, not deflated, so the input streams through the
    // chunked read loop and the sampler observes extraction in flight.)
    const crypto = await import('node:crypto');
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (let i = 0; i < 6; i++) {
      const data = new Uint8Array(8 * 1024 * 1024);
      crypto.randomFillSync(data);
      files[`OEBPS/media/f${i}.bin`] = [data, { level: 0 }];
    }
    const p = path.join(tmp, 'peak.zip');
    fs.writeFileSync(p, zipSync(files));
    const dest = destFor('peak');

    const usage = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.external + m.arrayBuffers;
    };
    const base = usage();
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, usage() - base);
    }, 2);
    try {
      const index = await extractZipToDir(p, dest, laxLimits);
      expect(index.size).toBe(6);
      for (const e of index.values()) expect(fs.statSync(e.filePath).size).toBe(8 * 1024 * 1024);
      expect(dirBytes(dest)).toBe(48 * 1024 * 1024);
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, usage() - base);
    // Streaming keeps peak growth to a few chunk buffers; retaining the
    // entries (48MB) or the old duplicate-and-retain shape (96MB) trips this.
    expect(peak).toBeLessThan(24 * 1024 * 1024);
  });

  it('a violating archive is rejected before dangerous allocations occur', async () => {
    // Entry inflates to 32MB but the aggregate cap is 1MB: the failure must
    // arrive after roughly one chunk past the cap, with memory untouched by
    // the remaining ~31MB.
    const p = writeZip('early.zip', { 'zeros.bin': new Uint8Array(32 * 1024 * 1024) });
    const dest = destFor('early');
    const before = process.memoryUsage().heapUsed;
    await expect(
      extractZipToDir(p, dest, { ...laxLimits, maxTotalBytes: 1024 * 1024 }),
    ).rejects.toThrow(ZipLimitError);
    const after = process.memoryUsage().heapUsed;
    expect(after - before).toBeLessThan(24 * 1024 * 1024);
    expect(dirBytes(dest)).toBe(0); // partial output removed
  });
});
