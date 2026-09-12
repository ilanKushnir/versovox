#!/usr/bin/env node
/**
 * Rasterizes the ReadPort mark into the favicon and the PWA/App icon set.
 *
 * The artwork comes from design/logo/mark.mjs — the one place the geometry
 * lives. Run this after changing it; the outputs are committed, so nobody
 * needs it to build or run ReadPort.
 *
 * Rasterizing is done by whichever Chrome or Chromium is already installed
 * rather than by a browser dependency of its own. Point CHROME at one if it
 * lives somewhere unusual.
 *
 * Usage: node scripts/generate-icons.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monoSvg, tileSvg } from '../design/logo/mark.mjs';

const CANDIDATES = [
  process.env.CHROME,
  process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CANDIDATES.find((c) => fs.existsSync(c));
if (!chrome) {
  console.error('No Chrome or Chromium found. Set CHROME=/path/to/chrome and retry.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'web', 'public', 'icons');
const logoDir = path.join(here, '..', 'design', 'logo');
fs.mkdirSync(outDir, { recursive: true });

// Standalone copies of the mark, for READMEs, release posts and anyone who
// wants the logo as a file rather than as code.
fs.writeFileSync(path.join(logoDir, 'readport-mark.svg'), `${monoSvg({ size: 512 })}\n`);
fs.writeFileSync(
  path.join(logoDir, 'readport-tile.svg'),
  `${tileSvg({ size: 512, pad: 80, radius: 112 })}\n`,
);
console.log('logo readport-mark.svg, readport-tile.svg');

// The favicon stays a vector — browsers scale it themselves. Rounded, because
// it sits in a tab next to other rounded things.
fs.writeFileSync(path.join(outDir, 'favicon.svg'), `${tileSvg({ size: 24, radius: 5 })}\n`);
console.log('icon favicon.svg');

// `any` icons keep a little breathing room; maskable ones are inset far enough
// that a platform's circle or squircle crop cannot bite into the ribbon.
const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 30 },
  { file: 'icon-512.png', size: 512, pad: 80 },
  { file: 'icon-maskable-192.png', size: 192, pad: 48 },
  { file: 'icon-maskable-512.png', size: 512, pad: 128 },
  { file: 'apple-touch-icon.png', size: 180, pad: 28 },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readport-icons-'));
try {
  for (const t of TARGETS) {
    const svg = path.join(tmp, `${t.file}.svg`);
    fs.writeFileSync(svg, tileSvg({ size: t.size, pad: t.pad }));
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${t.size},${t.size}`,
      `--screenshot=${path.join(outDir, t.file)}`,
      `file://${svg}`,
    ]);
    console.log('icon', t.file);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('Icons written to', outDir);
