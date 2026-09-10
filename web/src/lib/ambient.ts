/**
 * Ambient tint for the player: a muted average of the cover's saturated
 * pixels, so the page takes on the book's palette the way Apple Music and
 * Books do. Same-origin covers only (canvas readback); resolves null when
 * the image cannot be read.
 */
export async function ambientColorFromImage(src: string): Promise<string | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    const size = 24;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);
    return ambientFromPixels(data);
  } catch {
    return null;
  }
}

/** Exported for tests: weighted average favouring colourful, mid-tone pixels. */
export function ambientFromPixels(data: Uint8ClampedArray): string | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]! / 255;
    if (a < 0.5) continue;
    const pr = data[i]!;
    const pg = data[i + 1]!;
    const pb = data[i + 2]!;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const sat = max === 0 ? 0 : (max - min) / max;
    const lum = (pr * 0.299 + pg * 0.587 + pb * 0.114) / 255;
    // Prefer saturated mid-tones; ignore near-white/near-black.
    const w = (0.15 + sat) * (1 - Math.abs(lum - 0.5) * 1.6);
    if (w <= 0) continue;
    r += pr * w;
    g += pg * w;
    b += pb * w;
    weight += w;
  }
  if (weight === 0) return null;
  r /= weight;
  g /= weight;
  b /= weight;
  // Pull toward a calm mid-tone so text stays readable on both themes.
  const soften = (c: number) => Math.round(c * 0.7 + 90 * 0.3);
  return `rgb(${soften(r)} ${soften(g)} ${soften(b)})`;
}
