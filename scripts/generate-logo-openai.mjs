#!/usr/bin/env node
/**
 * Generate Versovox logo candidates with OpenAI's image API.
 *
 *   OPENAI_API_KEY=sk-… node scripts/generate-logo-openai.mjs [outdir]
 *
 * Writes one PNG per concept plus a transparent variant of each, so the
 * winner can be traced to SVG for the in-app mark and rasterised into the
 * PWA icon set (scripts/generate-icons.mjs). Model preference newest-first;
 * `VX_IMAGE_MODEL` pins one.
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

const MODELS = process.env.VX_IMAGE_MODEL
  ? [process.env.VX_IMAGE_MODEL]
  : ['gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5'];

const STYLE =
  'Flat vector app icon, geometric, minimal, no gradients, no text, no letters, no words, ' +
  'no drop shadows, perfectly centred with generous margin, crisp rounded stroke ends, ' +
  'symmetric composition, single warm copper ink colour #B4532A on a warm cream paper ' +
  'background #F6F1E8, one small plum #5E4A8A accent at most. Looks correct at 32 pixels.';

const CONCEPTS = {
  'book-wave':
    'An open book seen straight on. The left page carries three short horizontal reading ' +
    'lines. The right page transforms into a rising audio waveform of five rounded vertical ' +
    'bars of increasing then decreasing height.',
  'spine-wave':
    'A single book standing upright, viewed from the front cover, whose vertical spine is ' +
    'replaced by a column of rounded audio-waveform bars, so the book and the sound meter ' +
    'read as one object.',
  'bookmark-wave':
    'A rounded square containing an open book; a ribbon bookmark falls from the top edge and ' +
    'its lower half becomes three rounded waveform bars, joining reading and listening.',
};

async function gen(name, prompt, transparent) {
  for (const model of MODELS) {
    const body = {
      model,
      prompt,
      n: 1,
      size: '1024x1024',
      quality: 'high',
      output_format: 'png',
    };
    if (transparent) body.background = 'transparent';
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn(
        `${name} · ${model}: ${data.error?.code ?? res.status} ${data.error?.message ?? ''}`,
      );
      if (data.error?.code === 'credit_balance_exhausted') process.exit(2);
      continue;
    }
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      console.warn(`${name} · ${model}: no image in response`);
      continue;
    }
    const file = path.join(out, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`${file}  (${model})`);
    return file;
  }
  return null;
}

const only = process.env.VX_LOGO_CONCEPT;
for (const [name, concept] of Object.entries(CONCEPTS)) {
  if (only && only !== name) continue;
  await gen(name, `${concept} ${STYLE}`, false);
}
if (process.env.VX_LOGO_TRANSPARENT) {
  const name = process.env.VX_LOGO_TRANSPARENT;
  await gen(
    `${name}-transparent`,
    `${CONCEPTS[name]} ${STYLE.replace('on a warm cream paper background #F6F1E8', 'on a fully transparent background')}`,
    true,
  );
}
