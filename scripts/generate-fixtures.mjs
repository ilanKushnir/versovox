#!/usr/bin/env node
/**
 * Generates the committed sample library under fixtures/library/:
 *   - EPUBs built from original stories (fixture-content.mjs)
 *   - Audiobook narration synthesized with espeak-ng (text2wav, WASM) and
 *     encoded with the system ffmpeg
 *     (sentence boundaries are exact; word times are proportional within a
 *     sentence — documented honestly in docs/alignment.md)
 *
 * Requirements (development machine only; the generated fixtures are
 * committed): node >= 22, ffmpeg on PATH, `npm i` at the repo root.
 *
 * Usage: node scripts/generate-fixtures.mjs [outRoot]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import text2wav from 'text2wav';
import { boulevard, clockmaker, coverSvg, fieldNotes, lantern } from './fixture-content.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(process.argv[2] ?? path.join(here, '..', 'fixtures', 'library'));
const ebooksDir = path.join(outRoot, 'ebooks');
const audioDir = path.join(outRoot, 'audiobooks');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(ebooksDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });

const enc = new TextEncoder();

// ---------------------------------------------------------------- EPUB build

function xhtml(title, bodyHtml, lang = 'en', dir = 'ltr') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}" dir="${dir}">
<head><title>${title}</title></head>
<body dir="${dir}">
${bodyHtml}
</body>
</html>`;
}

function buildEpub({
  slug,
  title,
  author,
  language,
  isbn,
  // The metadata a real library carries. Written the way Calibre writes it,
  // so the sample library exercises the same parsing a real one will.
  subjects = [],
  series = null,
  seriesIdx = null,
  year = null,
  rating = null,
  direction = 'ltr',
  chaptersXhtml,
  extraFiles = {},
  coverName = 'cover.svg',
  coverContent,
}) {
  const files = {};
  files['mimetype'] = [enc.encode('application/epub+zip'), { level: 0 }];
  files['META-INF/container.xml'] = enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  const manifestItems = [];
  const spineItems = [];
  const navLis = [];
  chaptersXhtml.forEach((ch, i) => {
    const id = `ch${i + 1}`;
    files[`OEBPS/${id}.xhtml`] = enc.encode(ch.content);
    manifestItems.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${id}"/>`);
    navLis.push(`<li><a href="${id}.xhtml">${ch.title}</a></li>`);
  });
  for (const [name, content] of Object.entries(extraFiles)) {
    files[`OEBPS/${name}`] = typeof content === 'string' ? enc.encode(content) : content;
  }
  files[`OEBPS/${coverName}`] = enc.encode(coverContent);
  const extraManifest = Object.keys(extraFiles)
    .map((name, i) => {
      const mt = name.endsWith('.svg')
        ? 'image/svg+xml'
        : name.endsWith('.png')
          ? 'image/png'
          : 'text/plain';
      return `<item id="extra${i}" href="${name}" media-type="${mt}"/>`;
    })
    .join('\n    ');

  files['OEBPS/nav.xhtml'] = enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
<ol>
${navLis.map((l) => '  ' + l).join('\n')}
</ol>
</nav>
</body>
</html>`);

  files['OEBPS/content.opf'] = enc.encode(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id"${direction === 'rtl' ? '' : ''}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:isbn:${isbn}</dc:identifier>
    <dc:identifier scheme="ISBN">${isbn}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>${language}</dc:language>
    <dc:publisher>ReadPort Samples</dc:publisher>
    <dc:description>An original sample story bundled with ReadPort for demonstration and testing.</dc:description>
${subjects.map((t) => `    <dc:subject>${t}</dc:subject>`).join('\n')}
${year ? `    <dc:date>${year}-01-01</dc:date>` : ''}
${series ? `    <meta name="calibre:series" content="${series}"/>` : ''}
${seriesIdx ? `    <meta name="calibre:series_index" content="${seriesIdx}"/>` : ''}
${rating ? `    <meta name="calibre:rating" content="${rating * 2}"/>` : ''}
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-img" href="${coverName}" media-type="image/svg+xml" properties="cover-image"/>
    ${manifestItems.join('\n    ')}
    ${extraManifest}
  </manifest>
  <spine${direction === 'rtl' ? ' page-progression-direction="rtl"' : ''}>
    ${spineItems.join('\n    ')}
  </spine>
</package>`);

  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, Array.isArray(v) ? v : [v, { level: 6 }]]),
    ),
  );
  const out = path.join(ebooksDir, `${slug}.epub`);
  fs.writeFileSync(out, zipped);
  console.log(`epub  ${out} (${zipped.length} bytes)`);
}

// ------------------------------------------------------------- audio helpers

/** Parse a PCM WAV buffer: return {sampleRate, bytesPerSec, pcm} */
function parseWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav');
  const sampleRate = b.readUInt32LE(24);
  const byteRate = b.readUInt32LE(28);
  const blockAlign = b.readUInt16LE(32);
  const bitsPerSample = b.readUInt16LE(34);
  let off = 12;
  let pcm = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'data') {
      pcm = b.subarray(off + 8, off + 8 + size);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!pcm) throw new Error('wav without data chunk');
  return { sampleRate, byteRate, blockAlign, bitsPerSample, pcm };
}

function wavHeader({ sampleRate, blockAlign, bitsPerSample }, dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

const PAUSE_SENTENCE_MS = 350;
const PAUSE_CHAPTER_LEAD_MS = 600;

/**
 * Synthesize a list of sentences into one WAV; returns word timings relative
 * to the start of this unit. Sentence boundaries are exact (measured from
 * the synthesized clips); word times are proportional within each sentence.
 */
async function synthUnit(sentences, { leadSilenceMs = 0 } = {}) {
  const clips = [];
  let fmt = null;
  for (const s of sentences) {
    const wav = await text2wav(s, { voice: 'en' });
    const parsed = parseWav(wav);
    fmt = fmt ?? parsed;
    clips.push(parsed);
  }
  if (!fmt) throw new Error('no sentences');
  const msToBytes = (ms) => {
    const bytes = Math.round((fmt.sampleRate * ms) / 1000) * fmt.blockAlign;
    return bytes;
  };
  const parts = [];
  const words = [];
  let cursorMs = 0;
  if (leadSilenceMs > 0) {
    parts.push(Buffer.alloc(msToBytes(leadSilenceMs)));
    cursorMs += leadSilenceMs;
  }
  sentences.forEach((s, i) => {
    const clip = clips[i];
    const durMs = Math.round((clip.pcm.length / (fmt.sampleRate * fmt.blockAlign)) * 1000);
    const toks = s
      .split(/\s+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const weights = toks.map((w) => w.length + 1);
    const totalW = weights.reduce((a, b) => a + b, 0);
    let t = cursorMs;
    toks.forEach((w, wi) => {
      const wMs = (durMs * weights[wi]) / totalW;
      words.push({ w, s: Math.round(t), e: Math.round(t + wMs) });
      t += wMs;
    });
    parts.push(clip.pcm);
    cursorMs += durMs;
    parts.push(Buffer.alloc(msToBytes(PAUSE_SENTENCE_MS)));
    cursorMs += PAUSE_SENTENCE_MS;
  });
  const pcm = Buffer.concat(parts);
  const wav = Buffer.concat([wavHeader(fmt, pcm.length), pcm]);
  return { wav, words, durationMs: cursorMs };
}

function encodeMp3(wavPath, mp3Path, meta) {
  const args = ['-y', '-v', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '64k'];
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', `${k}=${v}`);
  args.push(mp3Path);
  execFileSync('ffmpeg', args);
}

function encodeM4b(wavPath, m4bPath, meta, chapters) {
  let ffmeta = ';FFMETADATA1\n';
  for (const [k, v] of Object.entries(meta)) ffmeta += `${k}=${v}\n`;
  for (const c of chapters) {
    ffmeta += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.startMs}\nEND=${c.endMs}\ntitle=${c.title}\n`;
  }
  const metaPath = m4bPath + '.ffmeta';
  fs.writeFileSync(metaPath, ffmeta);
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    wavPath,
    '-i',
    metaPath,
    '-map',
    '0:a',
    '-map_metadata',
    '1',
    '-codec:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'mp4',
    m4bPath,
  ]);
  fs.rmSync(metaPath);
}

// --------------------------------------------------------------------- build

async function main() {
  // --- Book A: The Lantern of Ash Harbor (paired: EPUB + 4 mp3)
  {
    const b = lantern;
    const chaptersXhtml = b.chapters.map((ch, i) => {
      const paras = ch.paragraphs.map((p) => `  <p>${p.join(' ')}</p>`).join('\n');
      const illustration =
        i === 0
          ? `  <figure><img src="img/lantern.svg" alt="A stylized lighthouse lantern"/><figcaption>The lantern room at Ash Harbor.</figcaption></figure>\n`
          : '';
      return {
        title: ch.title,
        content: xhtml(
          ch.title,
          `<section epub:type="chapter">\n  <h1>${ch.title}</h1>\n${illustration}${paras}\n</section>`,
          b.language,
        ),
      };
    });
    buildEpub({
      slug: b.slug,
      title: b.title,
      author: b.author,
      language: b.language,
      isbn: b.isbn,
      subjects: b.subjects,
      series: b.series,
      seriesIdx: b.seriesIdx,
      year: b.year,
      rating: b.rating,
      chaptersXhtml,
      extraFiles: {
        'img/lantern.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#F1EBE1"/><rect x="140" y="40" width="40" height="110" fill="#2F5D48"/><circle cx="160" cy="52" r="26" fill="#C9A227"/><rect x="120" y="150" width="80" height="12" fill="#1F2620"/></svg>`,
      },
      coverContent: coverSvg({
        title: b.title,
        author: b.author,
        bg: '#12332A',
        fg: '#F4EFE4',
        accent: '#C9A227',
      }),
    });

    // Audio: one mp3 per chapter. The narration opens with a spoken sample
    // notice that is NOT in the ebook text (exercises narration-only gaps).
    const dir = path.join(audioDir, 'Rivka Sharon', 'The Lantern of Ash Harbor');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < b.chapters.length; i++) {
      const ch = b.chapters[i];
      const sentences = [];
      if (i === 0) {
        sentences.push('This is a ReadPort sample narration of an original story.');
      }
      sentences.push(`Chapter ${i + 1}. ${ch.title}.`);
      for (const p of ch.paragraphs) sentences.push(...p);
      const unit = await synthUnit(sentences, {
        leadSilenceMs: i === 0 ? 400 : PAUSE_CHAPTER_LEAD_MS,
      });
      const wavPath = path.join(dir, `tmp_ch${i + 1}.wav`);
      fs.writeFileSync(wavPath, unit.wav);
      const mp3Path = path.join(
        dir,
        `${String(i + 1).padStart(2, '0')} - ${ch.title.replace(/[^\w\s-]/g, '')}.mp3`,
      );
      encodeMp3(wavPath, mp3Path, {
        title: ch.title,
        album: b.title,
        artist: b.author,
        track: `${i + 1}/${b.chapters.length}`,
        language: 'eng',
        genre: (b.subjects ?? []).join('; '),
        composer: b.narrator ?? '',
        date: String(b.year ?? ''),
      });
      fs.rmSync(wavPath);
      console.log(`audio ${mp3Path}`);
    }
    fs.writeFileSync(
      path.join(dir, 'cover.svg'),
      coverSvg({
        title: b.title,
        author: b.author,
        bg: '#1E3A31',
        fg: '#F4EFE4',
        accent: '#C9A227',
      }),
    );
  }

  // --- Book B: Hebrew RTL ebook only
  {
    const b = boulevard;
    const chaptersXhtml = b.chapters.map((ch) => ({
      title: ch.title,
      content: xhtml(
        ch.title,
        `<section epub:type="chapter">\n  <h1>${ch.title}</h1>\n${ch.paragraphs.map((p) => `  <p>${p.join(' ')}</p>`).join('\n')}\n</section>`,
        b.language,
        'rtl',
      ),
    }));
    buildEpub({
      slug: b.slug,
      title: b.title,
      author: b.author,
      language: b.language,
      isbn: '9780000000024',
      subjects: b.subjects,
      series: b.series,
      seriesIdx: b.seriesIdx,
      year: b.year,
      rating: b.rating,
      direction: 'rtl',
      chaptersXhtml,
      coverContent: coverSvg({
        title: b.title,
        author: b.author,
        bg: '#2B2440',
        fg: '#F2EEE4',
        accent: '#D8A45B',
        rtl: true,
      }),
    });
  }

  // --- Book C: multi-file audiobook only (no ebook)
  {
    const b = fieldNotes;
    const dir = path.join(audioDir, 'Tamar Bell', 'Field Notes from a Quiet Valley');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < b.parts.length; i++) {
      const part = b.parts[i];
      const unit = await synthUnit([`${part.title}.`, ...part.sentences]);
      const wavPath = path.join(dir, `tmp${i}.wav`);
      fs.writeFileSync(wavPath, unit.wav);
      const mp3Path = path.join(dir, `Part ${i + 1}.mp3`);
      encodeMp3(wavPath, mp3Path, {
        title: part.title,
        album: b.title,
        artist: b.author,
        track: `${i + 1}/${b.parts.length}`,
        genre: (b.subjects ?? []).join('; '),
        composer: b.narrator ?? '',
        date: String(b.year ?? ''),
      });
      fs.rmSync(wavPath);
      console.log(`audio ${mp3Path}`);
    }
    fs.writeFileSync(
      path.join(dir, 'cover.svg'),
      coverSvg({
        title: b.title,
        author: b.author,
        bg: '#31502F',
        fg: '#F1EFE2',
        accent: '#A9C47F',
      }),
    );
  }

  // --- Book D: single m4b with embedded chapters
  {
    const b = clockmaker;
    const dir = path.join(audioDir, 'Noa Adler', "The Clockmaker's Garden");
    fs.mkdirSync(dir, { recursive: true });
    const chapters = [];
    const parts = [];
    let fmt = null;
    let cursorMs = 0;
    for (const [i, ch] of b.chapters.entries()) {
      const unit = await synthUnit([`${ch.title}.`, ...ch.sentences]);
      const parsed = parseWav(unit.wav);
      fmt = fmt ?? parsed;
      chapters.push({ title: ch.title, startMs: cursorMs, endMs: cursorMs + unit.durationMs });
      parts.push(parsed.pcm);
      cursorMs += unit.durationMs;
      void i;
    }
    const pcm = Buffer.concat(parts);
    const wavPath = path.join(dir, 'tmp.wav');
    fs.writeFileSync(wavPath, Buffer.concat([wavHeader(fmt, pcm.length), pcm]));
    const m4bPath = path.join(dir, 'The Clockmakers Garden.m4b');
    encodeM4b(
      wavPath,
      m4bPath,
      {
        title: b.title,
        album: b.title,
        artist: b.author,
        genre: (b.subjects ?? []).join('; '),
        composer: b.narrator ?? '',
        date: String(b.year ?? ''),
      },
      chapters,
    );
    fs.rmSync(wavPath);
    fs.writeFileSync(
      path.join(dir, 'cover.svg'),
      coverSvg({
        title: b.title,
        author: b.author,
        bg: '#3A2E24',
        fg: '#F4EFE4',
        accent: '#C97F4E',
      }),
    );
    console.log(`audio ${m4bPath}`);
  }

  console.log('Fixtures generated at', outRoot);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
