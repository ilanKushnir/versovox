import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { chunkCount, chunkKey, metaKey } from './downloads';

const require = createRequire(import.meta.url);
// The service worker's copy of the range/chunk math (classic importScripts).
// Under the web package's ESM default the UMD wrapper registers on
// globalThis instead of module.exports; accept either.
const required = require('../../public/sw-range.js') as Record<string, unknown>;
const vxRange = (
  (required as { parseRangeHeader?: unknown }).parseRangeHeader
    ? required
    : (globalThis as Record<string, unknown>).vxRange
) as {
  parseRangeHeader(
    header: string | null,
    size: number,
  ): { start: number; end: number } | null | undefined;
  chunkSpan(start: number, end: number, chunkSize: number): { first: number; last: number };
  chunkCount(size: number, chunkSize: number): number;
  chunkKey(url: string, i: number): string;
  metaKey(url: string): string;
  sliceWithin(
    i: number,
    chunkSize: number,
    chunkLength: number,
    start: number,
    end: number,
  ): { from: number; to: number };
};

describe('parseRangeHeader (cached 206 semantics)', () => {
  const SIZE = 1000;
  it('handles open-ended, bounded, and suffix ranges', () => {
    expect(vxRange.parseRangeHeader('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
    expect(vxRange.parseRangeHeader('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 });
    expect(vxRange.parseRangeHeader('bytes=-200', SIZE)).toEqual({ start: 800, end: 999 });
    // End beyond size is clamped, matching the server's behavior.
    expect(vxRange.parseRangeHeader('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('unsatisfiable ranges yield null (416)', () => {
    expect(vxRange.parseRangeHeader('bytes=1000-', SIZE)).toBeNull();
    expect(vxRange.parseRangeHeader('bytes=500-100', SIZE)).toBeNull();
    expect(vxRange.parseRangeHeader('bytes=-0', SIZE)).toBeNull();
    expect(vxRange.parseRangeHeader('bytes=-', SIZE)).toBeNull();
  });

  it('unhandled shapes yield undefined (serve 200)', () => {
    expect(vxRange.parseRangeHeader(null, SIZE)).toBeUndefined();
    expect(vxRange.parseRangeHeader('bytes=0-1,5-9', SIZE)).toBeUndefined();
    expect(vxRange.parseRangeHeader('items=0-5', SIZE)).toBeUndefined();
  });
});

describe('chunk math', () => {
  it('spans and slices reassemble exactly the requested window', () => {
    const CHUNK = 100;
    // Request bytes 250..449 from 100-byte chunks: chunks 2,3,4.
    const span = vxRange.chunkSpan(250, 449, CHUNK);
    expect(span).toEqual({ first: 2, last: 4 });
    let total = 0;
    for (let i = span.first; i <= span.last; i++) {
      const { from, to } = vxRange.sliceWithin(i, CHUNK, CHUNK, 250, 449);
      total += to - from;
    }
    expect(total).toBe(200);
    expect(vxRange.sliceWithin(2, CHUNK, CHUNK, 250, 449)).toEqual({ from: 50, to: 100 });
    expect(vxRange.sliceWithin(4, CHUNK, CHUNK, 250, 449)).toEqual({ from: 0, to: 50 });
  });

  it('final short chunk is handled', () => {
    expect(vxRange.chunkCount(1050, 100)).toBe(11);
    // Last chunk is 50 bytes long.
    expect(vxRange.sliceWithin(10, 100, 50, 0, 1049)).toEqual({ from: 0, to: 50 });
  });
});

describe('cache-key conventions stay in sync between downloader and service worker', () => {
  it('chunkKey/metaKey/chunkCount agree byte-for-byte', () => {
    const url = '/api/books/abc/track/0';
    expect(chunkKey(url, 7)).toBe(vxRange.chunkKey(url, 7));
    expect(metaKey(url)).toBe(vxRange.metaKey(url));
    expect(chunkCount(1050, 100)).toBe(vxRange.chunkCount(1050, 100));
    expect(chunkCount(0, 100)).toBe(vxRange.chunkCount(0, 100));
  });
});
