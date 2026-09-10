import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatPct } from './format';

describe('formatDuration', () => {
  it('formats sub-hour as m:ss', () => {
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(0)).toBe('0:00');
  });
  it('formats hours as h:mm:ss', () => {
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });
  it('handles null/invalid', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(Number.NaN)).toBe('–');
  });
});

describe('formatBytes', () => {
  it('scales units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toMatch(/^2\s?KB$/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/^5\s?MB$/);
  });
});

describe('formatPct', () => {
  it('clamps to 0..1', () => {
    expect(formatPct(1.5)).toBe(formatPct(1));
    expect(formatPct(-1)).toBe(formatPct(0));
  });
});
