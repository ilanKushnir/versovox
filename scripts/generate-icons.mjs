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

/** The Versovox mark: an open book whose right page rises into a sound wave. `pad` insets it for maskable. */
function iconSvg(size, { pad = 0, bg = '#F6F1E8', ink = '#B4532A' } = {}) {
  const inner = size - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g transform="translate(${pad} ${pad}) scale(${inner / 24})">
    <path d="M12 6.2C10.6 4.9 8.6 4.2 6.3 4.2H3.4c-.5 0-.9.4-.9.9v12.6c0 .5.4.9.9.9h2.9c2.3 0 4.3.7 5.7 2V6.2z" fill="${ink}"/>
    <path d="M5.4 8.3h4M5.4 11.3h4M5.4 14.3h2.6" stroke="${bg}" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M14.4 12.8v3.6M17 10.2v8.2M19.6 12v4.6M22 13.4v2.2" stroke="${ink}" stroke-width="2.1" stroke-linecap="round"/>
    <path d="M12 6.2v14.4" stroke="${ink}" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
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
