/**
 * The ReadPort mark, as geometry.
 *
 * A bookmark ribbon with a play triangle knocked out of it: the two things the
 * app does, in one shape. It is drawn from numbers rather than traced from an
 * image so it stays crisp at 16px, and the triangle is a *hole* — punched with
 * the even-odd rule — so the mark reads correctly in one colour on any ground.
 *
 * This file is the single source of truth. `scripts/generate-icons.mjs` writes
 * the favicon and the PNG icon set from it, and `web/src/components/icons.tsx`
 * carries the same two paths inline for the React component; a unit test fails
 * if those two copies ever drift apart.
 */

// A 24-unit square, matching the rest of the icon set. The ribbon is inset so
// the mark has the same optical weight as the line icons beside it.
const X0 = 5.6;
const X1 = 18.4;
const TOP = 1.8;
const BOT = 22.2;
const NOTCH = 17.9;
const R = 2.3;
const MID = (X0 + X1) / 2; // the split, and the ribbon's spine

/** The ribbon: rounded shoulders, straight sides, a V bitten out of the foot. */
export const RIBBON = [
  `M${X0} ${TOP + R}`,
  `a${R} ${R} 0 0 1 ${R} ${-R}`,
  `h${X1 - X0 - 2 * R}`,
  `a${R} ${R} 0 0 1 ${R} ${R}`,
  `V${BOT}`,
  `L${MID} ${NOTCH}`,
  `L${X0} ${BOT}`,
  `Z`,
].join(' ');

const PLAY_L = 9.7;
const PLAY_R = 15.7;
const PLAY_T = 6.8;
const PLAY_B = 14.75;

/** The play triangle, centred on the split and on the ribbon's upper body. */
export const PLAY = `M${PLAY_L} ${PLAY_T} L${PLAY_R} ${(PLAY_T + PLAY_B) / 2} L${PLAY_L} ${PLAY_B} Z`;

/** Brand colours. The mark is cream and amber; the tile is the dark ground. */
export const CREAM = '#f4efe3';
export const AMBER = '#f5b31e';
export const INK = '#16120f';

/**
 * The two-tone mark: cream leading half, amber trailing half, play punched
 * through to whatever is behind. `x`/`y`/`span` place it inside a larger box.
 */
export function markArtwork({ x = 0, y = 0, span = 24, id = 'rp' } = {}) {
  const s = span / 24;
  return `<defs>
    <clipPath id="${id}-ribbon"><path d="${RIBBON}"/></clipPath>
    <mask id="${id}-play">
      <rect width="24" height="24" fill="#fff"/>
      <path d="${PLAY}" fill="#000"/>
    </mask>
  </defs>
  <g transform="translate(${x} ${y}) scale(${s})">
    <g mask="url(#${id}-play)" clip-path="url(#${id}-ribbon)">
      <rect x="${X0}" y="0" width="${MID - X0}" height="24" fill="${CREAM}"/>
      <rect x="${MID}" y="0" width="${X1 - MID}" height="24" fill="${AMBER}"/>
    </g>
  </g>`;
}

/** The mark on its tile, as a standalone SVG document. */
export function tileSvg({ size = 512, pad = 0, radius = 0, bg = INK } = {}) {
  const span = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="ReadPort">
  <rect width="${size}" height="${size}"${radius ? ` rx="${radius}"` : ''} fill="${bg}"/>
  ${markArtwork({ x: pad, y: pad, span })}
</svg>`;
}

/** The one-colour mark, for anywhere that inherits `currentColor`. */
export function monoSvg({ size = 24 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" role="img" aria-label="ReadPort">
  <path fill-rule="evenodd" d="${RIBBON} ${PLAY}"/>
</svg>`;
}
