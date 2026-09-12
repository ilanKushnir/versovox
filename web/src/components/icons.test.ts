import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - the logo geometry is plain JS, shared with the icon script.
import { PLAY, RIBBON } from '../../../design/logo/mark.mjs';

/**
 * The mark's geometry lives in design/logo/mark.mjs, which the icon script
 * rasterizes. The React component carries the same two paths inline so it
 * needs no build step — which means the two can drift, and a drift would ship
 * one logo in the tab and a different one in the header. This catches it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'icons.tsx'), 'utf8');

describe('ReadPortMark', () => {
  it('draws exactly the path design/logo/mark.mjs defines', () => {
    expect(source).toContain(`d="${RIBBON} ${PLAY}"`);
  });

  it('punches the play triangle out rather than drawing it on top', () => {
    // Without evenodd the triangle fills solid and the mark reads as a blob
    // on any ground but the tile's.
    expect(source).toContain('fillRule="evenodd"');
  });
});

describe('the committed favicon', () => {
  it('carries the same geometry as the component', () => {
    const svg = fs.readFileSync(
      path.join(here, '..', '..', 'public', 'icons', 'favicon.svg'),
      'utf8',
    );
    expect(svg).toContain(RIBBON);
    expect(svg).toContain(PLAY);
  });
});
