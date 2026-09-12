import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import posix from 'node:path/posix';
import { parseEpub, makeZipDirStore, opfRelative, type ParsedEpub } from './parse.js';
import { extractZipToDir, EPUB_ZIP_LIMITS } from './zip.js';
import { sanitizeChapter } from './sanitize.js';
import { segmentSentences, type Sentence } from '../util/text.js';

/** Per-chapter raw XHTML cap: bigger than any real chapter, small enough to bound memory. */
export const MAX_CHAPTER_BYTES = 4 * 1024 * 1024;
/**
 * Aggregate sanitized-text cap across the whole book. The sentence index is
 * the one whole-book structure that must live in memory during indexing, so
 * it gets its own bound (~30x a very long novel) independent of the on-disk
 * zip limits.
 */
export const MAX_TOTAL_TEXT_BYTES = 24 * 1024 * 1024;
/** Per-asset (image) cap and total copied-assets cap. */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
export const MAX_COVER_BYTES = 20 * 1024 * 1024;

/**
 * Builds the derived, ReadPort-owned reading index for one EPUB:
 *   <outDir>/book.json        spine/toc/meta manifest
 *   <outDir>/ch_<idx>.html    sanitized chapter bodies
 *   <outDir>/sentences.json   per-chapter sentence index (stable ids)
 *   <outDir>/assets/...       referenced images, copied out
 *   <outDir>/cover.<ext>      cover image (when present)
 * The source EPUB is never modified.
 *
 * Memory shape: the zip is stream-extracted into a private temporary
 * directory next to `outDir` (same filesystem), then chapters are read,
 * sanitized and written back ONE AT A TIME, and assets/cover are copied
 * file-to-file. The aggregate decompressed EPUB is never resident in memory;
 * the temporary directory is always removed, success or failure.
 */

export interface ChapterManifest {
  idx: number;
  href: string;
  title: string | null;
  charCount: number;
  sentenceCount: number;
  /** Cumulative characters before this chapter (for pct math). */
  cumChars: number;
}

export interface BookManifest {
  bookId: string;
  title: string;
  author: string | null;
  language: string | null;
  direction: 'ltr' | 'rtl';
  directionDeclared?: boolean;
  totalChars: number;
  chapters: ChapterManifest[];
  toc: { title: string; spineIdx: number; fragment: string | null; depth: number }[];
}

export interface ExtractResult {
  manifest: BookManifest;
  meta: ParsedEpub['meta'];
  /** File inside outDir holding the cover image, when the EPUB declares one. */
  coverFile: string | null;
  coverExt: string | null;
  sentencesByChapter: Sentence[][];
}

export interface ExtractEpubOptions {
  /**
   * Ownership hook threaded in from the job lease: called immediately
   * before each batch of writes into outDir. Throwing aborts extraction, so
   * an attempt that lost its job lease stops writing mid-extraction instead
   * of running to completion.
   */
  assertOwnership?: () => void;
}

export async function extractEpub(
  epubPath: string,
  bookId: string,
  outDir: string,
  opts: ExtractEpubOptions = {},
): Promise<ExtractResult> {
  const assertOwnership = opts.assertOwnership ?? (() => {});
  fs.mkdirSync(outDir, { recursive: true });
  // Private unzip scratch: sibling of outDir when possible (same volume),
  // deleted in `finally` on every path.
  const unzipDir = fs.mkdtempSync(
    path.join(
      fs.existsSync(path.dirname(outDir)) ? path.dirname(outDir) : os.tmpdir(),
      '.rp-unzip-',
    ),
  );
  try {
    const index = await extractZipToDir(epubPath, unzipDir, EPUB_ZIP_LIMITS);
    const store = makeZipDirStore(index);
    const epub = parseEpub(store);

    const knownFiles = new Set<string>(store.names());
    const chapters: ChapterManifest[] = [];
    const sentencesByChapter: Sentence[][] = [];
    const assetSet = new Set<string>();
    let cum = 0;
    let totalTextBytes = 0;

    const lang = epub.meta.language ?? 'en';
    for (const item of epub.spine) {
      const zipPath = opfRelative(epub.opfDir, item.href);
      const size = store.size(zipPath);
      if (size !== null && size > MAX_CHAPTER_BYTES) {
        throw new Error(`EPUB chapter ${zipPath} exceeds the ${MAX_CHAPTER_BYTES} byte limit`);
      }
      const raw = store.read(zipPath, MAX_CHAPTER_BYTES);
      const html = raw ? raw.toString('utf8') : '';
      const clean = sanitizeChapter(html, zipPath, knownFiles);
      totalTextBytes += clean.text.length;
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
        throw new Error(`EPUB text exceeds the ${MAX_TOTAL_TEXT_BYTES} byte total limit`);
      }
      assertOwnership();
      fs.writeFileSync(path.join(outDir, `ch_${item.idx}.html`), clean.html);
      fs.writeFileSync(path.join(outDir, `text_${item.idx}.txt`), clean.text);
      const sentences = segmentSentences(clean.text, lang, item.idx);
      sentencesByChapter.push(sentences);
      for (const a of clean.assets) assetSet.add(a.split('#')[0]!);
      chapters.push({
        idx: item.idx,
        href: zipPath,
        title: null,
        charCount: clean.text.length,
        sentenceCount: sentences.length,
        cumChars: cum,
      });
      cum += clean.text.length;
      // One chapter at a time; yield so worker heartbeats stay live.
      await new Promise((r) => setImmediate(r));
    }

    // Copy referenced image assets out of the unzip scratch, file-to-file
    // (never through a whole-entry buffer; zip entry names were normalized
    // and path-checked at extraction time, and destination paths are rebuilt
    // from the normalized name here).
    const assetDir = path.join(outDir, 'assets');
    let assetTotal = 0;
    assertOwnership();
    for (const asset of assetSet) {
      const src = store.filePath(asset);
      const size = store.size(asset);
      if (!src || size === null) continue;
      if (size > MAX_ASSET_BYTES) continue; // skip pathological single assets
      assetTotal += size;
      if (assetTotal > MAX_TOTAL_ASSET_BYTES) break; // bound the derived dir size
      const dest = path.join(assetDir, ...asset.split(posix.sep));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    // Map TOC entries to spine indices; first TOC title per chapter becomes its title.
    const hrefToSpine = new Map(chapters.map((c) => [c.href, c.idx]));
    const toc: BookManifest['toc'] = [];
    for (const t of epub.toc) {
      const [file, frag] = t.href.split('#');
      const spineIdx = hrefToSpine.get(posix.normalize(file!));
      if (spineIdx === undefined) continue;
      toc.push({ title: t.title, spineIdx, fragment: frag ?? null, depth: t.depth });
      if (chapters[spineIdx] && chapters[spineIdx]!.title === null && (frag ?? null) === null) {
        chapters[spineIdx]!.title = t.title;
      }
    }

    const manifest: BookManifest = {
      bookId,
      title: epub.meta.title,
      author: epub.meta.author,
      language: epub.meta.language,
      direction: epub.meta.direction,
      directionDeclared: epub.meta.directionDeclared,
      totalChars: cum,
      chapters,
      toc,
    };
    assertOwnership();
    fs.writeFileSync(path.join(outDir, 'book.json'), JSON.stringify(manifest, null, 1));
    fs.writeFileSync(
      path.join(outDir, 'sentences.json'),
      JSON.stringify(
        sentencesByChapter.map((list) =>
          list.map((s) => ({ id: s.id, ord: s.ord, start: s.start, end: s.end })),
        ),
      ),
    );
    // Full sentence text (normalized) is kept separately for pairing/alignment.
    fs.writeFileSync(
      path.join(outDir, 'sentences_text.json'),
      JSON.stringify(sentencesByChapter.map((list) => list.map((s) => s.normalized))),
    );

    let coverFile: string | null = null;
    let coverExt: string | null = null;
    if (epub.coverHref) {
      const coverPath = opfRelative(epub.opfDir, epub.coverHref);
      const src = store.filePath(coverPath);
      const size = store.size(coverPath);
      if (src && size !== null && size <= MAX_COVER_BYTES) {
        coverExt = posix.extname(coverPath).slice(1).toLowerCase() || 'jpg';
        coverFile = path.join(outDir, `cover.${coverExt}`);
        assertOwnership();
        fs.copyFileSync(src, coverFile);
      }
    }

    return { manifest, meta: epub.meta, coverFile, coverExt, sentencesByChapter };
  } finally {
    fs.rmSync(unzipDir, { recursive: true, force: true });
  }
}

export function loadManifest(outDir: string): BookManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'book.json'), 'utf8')) as BookManifest;
  } catch {
    return null;
  }
}

export function loadSentences(
  outDir: string,
): { id: string; ord: number; start: number; end: number }[][] | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'sentences.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function loadChapterText(outDir: string, spineIdx: number): string | null {
  try {
    return fs.readFileSync(path.join(outDir, `text_${spineIdx}.txt`), 'utf8');
  } catch {
    return null;
  }
}

export function loadSentencesText(outDir: string): string[][] | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'sentences_text.json'), 'utf8'));
  } catch {
    return null;
  }
}
