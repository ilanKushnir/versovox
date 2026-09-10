import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import path from 'node:path/posix';
import { EPUB_ZIP_LIMITS, type ZipDirIndex } from './zip.js';

/**
 * EPUB container parsing: OCF zip -> OPF package -> spine, manifest,
 * metadata, and TOC (EPUB3 nav or NCX fallback). Read-only; never mutates
 * the source file.
 *
 * Parsing operates over an EpubStore — a bounded view of entries that were
 * stream-extracted to disk — so only the small metadata documents
 * (container/OPF/nav/NCX) are ever read into memory here. Chapters and
 * assets are read/copied one at a time by the extract stage.
 */

export interface EpubMeta {
  title: string;
  author: string | null;
  language: string | null;
  identifiers: Record<string, string>;
  series: string | null;
  seriesIdx: number | null;
  direction: 'ltr' | 'rtl';
  publisher: string | null;
  description: string | null;
}

export interface SpineItem {
  idx: number;
  href: string; // zip path relative to OPF dir, normalized
  mediaType: string;
}

export interface TocEntry {
  title: string;
  href: string; // spine-relative href (may include #fragment)
  depth: number;
}

/**
 * Bounded access to extracted EPUB entries on disk. `read` loads one entry
 * into memory and refuses anything over `maxBytes`; `filePath` supports
 * file-to-file copies that never buffer the whole entry.
 */
export interface EpubStore {
  has(name: string): boolean;
  size(name: string): number | null;
  read(name: string, maxBytes: number): Buffer | null;
  filePath(name: string): string | null;
  names(): IterableIterator<string> | string[];
}

/** EpubStore over a stream-extracted zip directory index. */
export function makeZipDirStore(index: ZipDirIndex): EpubStore {
  return {
    has: (name) => index.has(name),
    size: (name) => index.get(name)?.size ?? null,
    read: (name, maxBytes) => {
      const entry = index.get(name);
      if (!entry) return null;
      if (entry.size > maxBytes) {
        throw new Error(`EPUB entry ${name} exceeds ${maxBytes} bytes`);
      }
      return fs.readFileSync(entry.filePath);
    },
    filePath: (name) => index.get(name)?.filePath ?? null,
    names: () => index.keys(),
  };
}

/** In-memory EpubStore (tests and small synthetic inputs). */
export function makeMemoryStore(files: Map<string, Uint8Array>): EpubStore {
  const norm = new Map<string, Uint8Array>();
  for (const [name, data] of files) {
    const n = path.normalize(name);
    if (n.startsWith('..') || path.isAbsolute(n)) continue;
    if (!norm.has(n)) norm.set(n, data);
  }
  return {
    has: (name) => norm.has(name),
    size: (name) => norm.get(name)?.byteLength ?? null,
    read: (name, maxBytes) => {
      const data = norm.get(name);
      if (!data) return null;
      if (data.byteLength > maxBytes) {
        throw new Error(`EPUB entry ${name} exceeds ${maxBytes} bytes`);
      }
      return Buffer.from(data);
    },
    filePath: () => null,
    names: () => norm.keys(),
  };
}

export interface ParsedEpub {
  meta: EpubMeta;
  spine: SpineItem[];
  toc: TocEntry[];
  /** Bounded, disk-backed view of the extracted entries. */
  files: EpubStore;
  opfDir: string;
  coverHref: string | null;
  manifest: Map<string, { href: string; mediaType: string; properties: string }>;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  isArray: (name) =>
    ['item', 'itemref', 'reference', 'navPoint', 'identifier', 'creator', 'meta', 'title'].includes(
      name,
    ),
});

function asText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return asText(node[0]);
  if (typeof node === 'object' && '#text' in (node as Record<string, unknown>)) {
    return String((node as Record<string, unknown>)['#text']);
  }
  return '';
}

/** Compressed archive size cap (streaming extraction enforces the rest). */
export const MAX_EPUB_BYTES = EPUB_ZIP_LIMITS.maxCompressedBytes;
/** Metadata documents (container/OPF/nav/NCX) may not exceed this. */
export const MAX_METADATA_BYTES = 10 * 1024 * 1024;
/** Spine length cap: more chapters than this is not a book we index. */
export const MAX_SPINE_ITEMS = 1500;

/** Bounded metadata-document read: null when absent, throws when oversize. */
function readMetadata(files: EpubStore, name: string): Buffer | null {
  const size = files.size(name);
  if (size !== null && size > MAX_METADATA_BYTES) {
    throw new Error(`EPUB metadata document ${name} exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return files.read(name, MAX_METADATA_BYTES);
}

export function parseEpub(files: EpubStore): ParsedEpub {
  const containerRaw = readMetadata(files, 'META-INF/container.xml');
  if (!containerRaw) throw new Error('Not an EPUB: missing META-INF/container.xml');
  const container = xml.parse(containerRaw.toString('utf8'));
  const rootfile = container?.container?.rootfiles?.rootfile;
  const opfPath: string | undefined = Array.isArray(rootfile)
    ? rootfile[0]?.['@_full-path']
    : rootfile?.['@_full-path'];
  if (!opfPath) throw new Error('EPUB container has no rootfile');
  const opfRaw = readMetadata(files, path.normalize(opfPath));
  if (!opfRaw) throw new Error(`EPUB missing OPF at ${opfPath}`);
  const opfDir = path.dirname(path.normalize(opfPath));
  const opf = xml.parse(opfRaw.toString('utf8'));
  const pkg = opf?.package;
  if (!pkg) throw new Error('Invalid OPF: no <package>');

  // --- metadata ---
  const md = pkg.metadata ?? {};
  const identifiers: Record<string, string> = {};
  for (const ident of md.identifier ?? []) {
    const value = asText(ident).trim();
    if (!value) continue;
    const scheme = (ident?.['@_scheme'] ?? '').toString().toLowerCase();
    if (scheme) identifiers[scheme] = value;
    else if (/^(97[89])?\d{9}[\dxX]$/.test(value.replace(/-/g, ''))) {
      identifiers['isbn'] = value.replace(/-/g, '');
    } else identifiers['id'] = value;
  }
  let series: string | null = null;
  let seriesIdx: number | null = null;
  for (const m of md.meta ?? []) {
    const name = m?.['@_name'] ?? '';
    const property = m?.['@_property'] ?? '';
    if (name === 'calibre:series') series = m?.['@_content'] ?? null;
    if (name === 'calibre:series_index') seriesIdx = Number(m?.['@_content']) || null;
    if (property === 'belongs-to-collection') series = asText(m) || series;
    if (property === 'group-position') seriesIdx = Number(asText(m)) || seriesIdx;
  }
  const meta: EpubMeta = {
    title: asText(md.title).trim() || 'Untitled',
    author: asText(md.creator).trim() || null,
    language: asText(md.language).trim().toLowerCase() || null,
    identifiers,
    series,
    seriesIdx,
    direction: pkg.spine?.['@_page-progression-direction'] === 'rtl' ? 'rtl' : 'ltr',
    publisher: asText(md.publisher).trim() || null,
    description: asText(md.description).trim() || null,
  };

  // --- manifest ---
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of pkg.manifest?.item ?? []) {
    const id = item?.['@_id'];
    const href = item?.['@_href'];
    if (!id || !href) continue;
    manifest.set(id, {
      href: path.normalize(decodeURIComponent(href)),
      mediaType: item?.['@_media-type'] ?? '',
      properties: item?.['@_properties'] ?? '',
    });
  }

  // --- spine ---
  const spine: SpineItem[] = [];
  for (const ref of pkg.spine?.itemref ?? []) {
    if (ref?.['@_linear'] === 'no') continue;
    const item = manifest.get(ref?.['@_idref']);
    if (!item) continue;
    if (!/xhtml|html/.test(item.mediaType)) continue;
    spine.push({ idx: spine.length, href: item.href, mediaType: item.mediaType });
  }
  if (spine.length === 0) throw new Error('EPUB has an empty spine');
  if (spine.length > MAX_SPINE_ITEMS) {
    throw new Error(`EPUB spine has ${spine.length} items; the limit is ${MAX_SPINE_ITEMS}`);
  }

  // --- cover ---
  let coverHref: string | null = null;
  for (const [, item] of manifest) {
    if (item.properties.includes('cover-image')) coverHref = item.href;
  }
  if (!coverHref) {
    const coverMeta = (md.meta ?? []).find(
      (m: Record<string, unknown>) => m?.['@_name'] === 'cover',
    );
    const coverId = coverMeta?.['@_content'];
    if (coverId && manifest.has(coverId)) {
      const item = manifest.get(coverId)!;
      if (item.mediaType.startsWith('image/')) coverHref = item.href;
    }
  }

  // --- TOC: EPUB3 nav first, NCX fallback ---
  const toc =
    parseNavToc(files, manifest, opfDir) ?? parseNcxToc(files, manifest, opfDir, pkg) ?? [];

  return { meta, spine, toc, files, opfDir, coverHref, manifest };
}

export function opfRelative(opfDir: string, href: string): string {
  const clean = href.split('#')[0]!;
  return opfDir === '.' ? path.normalize(clean) : path.normalize(path.join(opfDir, clean));
}

function parseNavToc(
  files: EpubStore,
  manifest: ParsedEpub['manifest'],
  opfDir: string,
): TocEntry[] | null {
  let navHref: string | null = null;
  for (const [, item] of manifest) {
    if (item.properties.includes('nav')) navHref = item.href;
  }
  if (!navHref) return null;
  const navPath = opfRelative(opfDir, navHref);
  const raw = readMetadata(files, navPath);
  if (!raw) return null;
  const html = raw.toString('utf8');
  // The nav doc is XHTML; extract the toc <nav> block and its anchors with
  // list depth. A tolerant regex pass is sufficient and avoids executing or
  // fully interpreting book HTML here (sanitization happens elsewhere).
  const navMatch = html.match(/<nav[^>]*epub:type="toc"[\s\S]*?<\/nav>/i) ?? [html];
  const block = navMatch[0]!;
  const entries: TocEntry[] = [];
  const re = /<(ol|\/ol|a\s[^>]*href="([^"]+)"[^>]*)>([\s\S]*?)(?=<)/gi;
  let depth = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    const tag = m[1]!.toLowerCase();
    if (tag === 'ol') depth += 1;
    else if (tag === '/ol') depth -= 1;
    else if (m[2]) {
      const title = decodeEntities(m[3]!.replace(/<[^>]+>/g, '').trim());
      if (title) {
        const navDir = path.dirname(navPath);
        const target = m[2]!;
        const [file, frag] = target.split('#');
        const abs = path.normalize(path.join(navDir, decodeURIComponent(file!)));
        entries.push({ title, href: frag ? `${abs}#${frag}` : abs, depth: Math.max(depth, 0) });
      }
    }
  }
  return entries.length ? entries : null;
}

function parseNcxToc(
  files: EpubStore,
  manifest: ParsedEpub['manifest'],
  opfDir: string,
  pkg: Record<string, { [k: string]: unknown } | string | undefined> & {
    spine?: { [k: string]: unknown };
  },
): TocEntry[] | null {
  const ncxId = typeof pkg.spine?.['@_toc'] === 'string' ? pkg.spine['@_toc'] : undefined;
  let ncxHref: string | null =
    ncxId && manifest.get(ncxId)?.href ? manifest.get(ncxId)!.href : null;
  if (!ncxHref) {
    for (const [, item] of manifest) {
      if (item.mediaType === 'application/x-dtbncx+xml') ncxHref = item.href;
    }
  }
  if (!ncxHref) return null;
  const ncxPath = opfRelative(opfDir, ncxHref);
  const raw = readMetadata(files, ncxPath);
  if (!raw) return null;
  const ncx = xml.parse(raw.toString('utf8'));
  const entries: TocEntry[] = [];
  const ncxDir = path.dirname(ncxPath);
  type NavPoint = {
    navLabel?: { text?: unknown };
    content?: { '@_src'?: unknown };
    navPoint?: NavPoint[];
  };
  const walk = (points: NavPoint[], depth: number) => {
    for (const p of points ?? []) {
      const title = asText(p?.navLabel?.text).trim();
      const src = p?.content?.['@_src'];
      if (title && src) {
        const [file, frag] = String(src).split('#');
        const abs = path.normalize(path.join(ncxDir, decodeURIComponent(file!)));
        entries.push({ title, href: frag ? `${abs}#${frag}` : abs, depth });
      }
      if (p?.navPoint) walk(p.navPoint, depth + 1);
    }
  };
  walk(ncx?.ncx?.navMap?.navPoint ?? [], 0);
  return entries.length ? entries : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ');
}
