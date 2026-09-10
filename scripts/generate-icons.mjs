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
  <g transform="translate(${pad} ${pad}) scale(${inner / 24})" fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">
    <g stroke-width="1.35">
      <path d="M12 7.6C10.4 6.2 8 5.5 5.2 5.5H3.9C3.2 5.5 2.7 6 2.7 6.7V16.8C2.7 17.4 3.2 18 3.9 18H5.2C8 18 10.4 18.7 12 20.1"/>
      <path d="M12 7.6C13.6 6.2 16 5.5 18.8 5.5H20.1C20.8 5.5 21.3 6 21.3 6.7V16.8C21.3 17.4 20.8 18 20.1 18H18.8C16 18 13.6 18.7 12 20.1"/>
      <path d="M12 7.6V20.1"/>
    </g>
    <path d="M5.8 10.2H9.4M5.8 12.8H9.4M5.8 15.4H8.2" stroke-width="1.3"/>
    <path d="M14.5 11.0V14.6M16.1 9.4V16.2M17.7 10.1V15.5M19.3 11.4V14.2" stroke-width="1.3"/>
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
