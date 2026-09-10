#!/usr/bin/env node
/**
 * Generate a Versovox logo with OpenAI's image API (newest model first).
 *
 *   OPENAI_API_KEY=sk-… node scripts/generate-logo-openai.mjs [outdir]
 *
 * Writes icon-paper.png (cream background, app-icon ready) and
 * mark-transparent.png (PNG with alpha for in-app use). Requires an API key
 * with image-generation credit. Model preference: gpt-image-2.5-sunburst →
 * gpt-image-2 → gpt-image-1.5.
 */
import fs from 'node:fs';
import path from 'node:path';

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}
const out = process.argv[2] ?? 'logo-out';
fs.mkdirSync(out, { recursive: true });
const MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5'];
const PALETTE = 'single ink colour warm ember copper (#B4532A) on warm paper cream (#F6F1E8)';
const CONCEPT =
  'an open book seen from the front; the left page shows three short horizontal text lines; the right page dissolves into a rising sound wave of rounded vertical bars';

async function gen(name, prompt, transparent) {
  for (const model of MODELS) {
    const body = { model, prompt, n: 1, size: '1024x1024', quality: 'high', output_format: 'png' };
    if (transparent) body.background = 'transparent';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn(`${model}: ${data.error?.code ?? res.status}`);
      if (data.error?.code === 'credit_balance_exhausted') process.exit(2);
      continue;
    }
    const img = data.data[0];
    const file = path.join(out, `${name}.png`);
    if (img.b64_json) fs.writeFileSync(file, Buffer.from(img.b64_json, 'base64'));
    else fs.writeFileSync(file, Buffer.from(await (await fetch(img.url)).arrayBuffer()));
    console.log('wrote', file, 'via', model);
    return;
  }
  console.error(`no model could generate ${name}`);
}

await gen(
  'icon-paper',
  `Minimalist flat vector app icon mark for a reading app that syncs ebooks with audiobooks. Concept: ${CONCEPT}. ${PALETTE}. Flat, no gradients, no shadows, no text, no letters, generous margins, centered, crisp geometric shapes, suitable as an iOS home-screen icon.`,
  false,
);
await gen(
  'mark-transparent',
  `Minimalist flat vector logo mark, no background: ${CONCEPT}. Single colour warm ember copper (#B4532A). No text, no letters, no shadows, no gradients, crisp geometric shapes, centered with margins.`,
  true,
);
