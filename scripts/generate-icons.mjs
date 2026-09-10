#!/usr/bin/env node
/**
 * Rasterizes the Versovox mark into the PWA/App icon set using the
 * Playwright chromium already present on dev/CI machines. Outputs are
 * committed, so end users never need this script.
 *
 * Usage: node scripts/generate-icons.mjs
 * Env: AGENT_BROWSER_EXECUTABLE_PATH (optional chromium path)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Resolve playwright from the project if installed, else from the global
// install (dev/CI convenience).
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'web', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

/** The Versovox mark: a verso page whose edge becomes a sound wave. `pad` insets it for maskable. */
function iconSvg(size, { pad = 0, bg = '#FAF6EF', ink = '#2F5D48' } = {}) {
  const inner = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g transform="translate(${pad} ${pad}) scale(${inner / 24})">
    <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h6.2c.7 0 1.3.6 1.3 1.3V20c0 .6-.5 1-1 1H5.5A1.5 1.5 0 0 1 4 19.5z" fill="${ink}"/>
    <path d="M7 8h3.5M7 11.5h3.5M7 15h2.5" stroke="${bg}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M15.5 9.5v5M18 7.5v9M20.5 10v4" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>
  </g>
</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 14 },
  { file: 'icon-512.png', size: 512, pad: 36 },
  { file: 'icon-maskable-192.png', size: 192, pad: 34 },
  { file: 'icon-maskable-512.png', size: 512, pad: 92 },
  { file: 'apple-touch-icon.png', size: 180, pad: 16 },
];

const browser = await chromium.launch({
  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
});
const page = await browser.newPage();
for (const t of TARGETS) {
  const svg = iconSvg(t.size, { pad: t.pad });
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<style>*{margin:0}</style>${svg.replace('<svg ', '<svg style="display:block" ')}`,
  );
  await page.screenshot({
    path: path.join(outDir, t.file),
    clip: { x: 0, y: 0, width: t.size, height: t.size },
  });
  console.log('icon', t.file);
}
await browser.close();
console.log('Icons written to', outDir);
