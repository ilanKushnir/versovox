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

/** The mark: two leaves forming an open book. `pad` insets it for maskable. */
function iconSvg(size, { pad = 0, bg = '#FAF6EF', leaf = '#2F5D48' } = {}) {
  const inner = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g transform="translate(${pad} ${pad}) scale(${inner / 64})">
    <path d="M31 54C31 34 19 25.5 8.5 25.5 8.5 40.5 17.5 51.5 31 54Z" fill="${leaf}" opacity="0.55"/>
    <path d="M31 54C31 29 41.5 15 55.5 8.5 57.5 26 50 45 31 54Z" fill="${leaf}"/>
    <path d="M31 54c0-15 6.5-30 18-40" stroke="${bg}" stroke-width="2" fill="none" opacity="0.55"/>
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
