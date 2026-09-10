import { describe, expect, it } from 'vitest';
import { ambientFromPixels } from './ambient';

function px(...rgba: number[][]): Uint8ClampedArray {
  return new Uint8ClampedArray(rgba.flat());
}

describe('ambientFromPixels', () => {
  it('returns null for transparent images and a neutral grey for monochrome ones', () => {
    expect(ambientFromPixels(px([0, 0, 0, 0]))).toBeNull();
    const mono = ambientFromPixels(px([255, 255, 255, 255], [0, 0, 0, 255]));
    const [r, g, b] = mono!.match(/\d+/g)!.map(Number);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });
  it('favours saturated mid-tones and softens the result', () => {
    const c = ambientFromPixels(px([200, 40, 40, 255], [128, 128, 128, 255]));
    expect(c).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    const [r, g] = c!.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(g!);
    // Softened toward mid-grey: never the raw saturated red.
    expect(r).toBeLessThan(200);
  });
});
