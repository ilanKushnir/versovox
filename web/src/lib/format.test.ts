import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatPct, ordinal } from './format';

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

describe('ordinal', () => {
  it('names the ordinary places', () => {
    expect([1, 2, 3, 4, 5].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '5th']);
  });

  it('gets the teens right, which is the whole reason this is not a lookup table', () => {
    expect([11, 12, 13].map(ordinal)).toEqual(['11th', '12th', '13th']);
    expect([21, 22, 23, 101, 111, 112].map(ordinal)).toEqual([
      '21st',
      '22nd',
      '23rd',
      '101st',
      '111th',
      '112th',
    ]);
  });
});
