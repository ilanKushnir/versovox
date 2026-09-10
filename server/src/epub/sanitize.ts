import { parse, serialize } from 'parse5';
import path from 'node:path/posix';

/**
 * Strict allowlist sanitizer for EPUB chapter documents, built on parse5's
 * spec-compliant HTML parser. Output is inert HTML: no scripts, no event
 * handlers, no forms/iframes/objects, no external network references, no
 * inline styles. Internal links become data attributes the reader resolves;
 * internal images are rewritten to authenticated asset routes.
 *
 * Publisher CSS is intentionally not loaded in V1 — the reader applies its
 * own typography while semantic elements (em/strong/blockquote/headings…)
 * survive. This is documented as a limitation in docs/reader.md.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'em',
  'i',
  'strong',
  'b',
  'u',
  's',
  'small',
  'sup',
  'sub',
  'blockquote',
  'q',
  'cite',
  'abbr',
  'dfn',
  'mark',
  'time',
  'wbr',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'caption',
  'colgroup',
  'col',
  'figure',
  'figcaption',
  'img',
  'br',
  'hr',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'a',
  'ruby',
  'rt',
  'rp',
  'bdi',
  'bdo',
  'ins',
  'del',
]);

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'li',
  'dt',
  'dd',
  'tr',
  'caption',
  'figure',
  'figcaption',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'nav',
  'pre',
  'table',
  'ul',
  'ol',
  'dl',
  'hr',
  'br',
]);

const GLOBAL_ATTRS = new Set(['id', 'class', 'dir', 'lang', 'title']);
const TAG_ATTRS: Record<string, Set<string>> = {
  img: new Set(['alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  time: new Set(['datetime']),
  bdo: new Set(['dir']),
  ol: new Set(['start', 'reversed', 'type']),
};

interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: P5Node[];
  parentNode?: P5Node | null;
}

export interface SanitizeResult {
  /** Inert HTML for the reader (children of <body>, wrapped in the reader). */
  html: string;
  /** Plain text with block boundaries as \n — offsets match the DOM walk. */
  text: string;
  /** Internal image asset paths referenced (zip paths, normalized). */
  assets: string[];
  /** ids retained (for TOC fragment navigation). */
  anchorIds: string[];
}

export function sanitizeChapter(
  rawHtml: string,
  chapterZipPath: string,
  knownFiles: Set<string>,
): SanitizeResult {
  const doc = parse(rawHtml) as unknown as P5Node;
  const chapterDir = path.dirname(chapterZipPath);
  const assets: string[] = [];
  const anchorIds: string[] = [];

  const body = findBody(doc);
  if (!body) return { html: '', text: '', assets, anchorIds };

  cleanNode(body, chapterDir, knownFiles, assets, anchorIds);

  const html = serialize(body as never);
  const text = extractText(body);
  return { html, text, assets, anchorIds };
}

function findBody(node: P5Node): P5Node | null {
  if (node.nodeName === 'body') return node;
  for (const c of node.childNodes ?? []) {
    const found = findBody(c);
    if (found) return found;
  }
  return null;
}

function cleanNode(
  node: P5Node,
  chapterDir: string,
  knownFiles: Set<string>,
  assets: string[],
  anchorIds: string[],
): void {
  const children = node.childNodes ?? [];
  const kept: P5Node[] = [];
  for (const child of children) {
    if (child.nodeName === '#text') {
      kept.push(child);
      continue;
    }
    if (child.nodeName === '#comment') continue;
    const tag = child.tagName?.toLowerCase() ?? '';
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown element: unwrap (keep safe children) for containers, drop
      // entirely for known-dangerous content-bearing elements.
      const DROP_CONTENT = new Set([
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'svg',
        'video',
        'audio',
        'form',
        'input',
        'button',
        'select',
        'textarea',
        'template',
        'link',
        'meta',
        'base',
        'noscript',
        'math',
        'canvas',
        'dialog',
        'slot',
        'portal',
      ]);
      if (DROP_CONTENT.has(tag)) continue;
      cleanNode(child, chapterDir, knownFiles, assets, anchorIds);
      kept.push(...(child.childNodes ?? []));
      continue;
    }
    sanitizeAttrs(child, tag, chapterDir, knownFiles, assets, anchorIds);
    if (tag === 'img') {
      // Drop images whose src did not resolve to a bundled asset.
      const hasSrc = (child.attrs ?? []).some((a) => a.name === 'src');
      if (!hasSrc) continue;
    }
    cleanNode(child, chapterDir, knownFiles, assets, anchorIds);
    kept.push(child);
  }
  node.childNodes = kept;
  for (const k of kept) k.parentNode = node;
}

function sanitizeAttrs(
  node: P5Node,
  tag: string,
  chapterDir: string,
  knownFiles: Set<string>,
  assets: string[],
  anchorIds: string[],
): void {
  const out: { name: string; value: string }[] = [];
  for (const attr of node.attrs ?? []) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith('on')) continue;
    if (name === 'style') continue;
    if (GLOBAL_ATTRS.has(name)) {
      if (name === 'id') {
        if (/^[A-Za-z][\w:.-]{0,128}$/.test(value)) {
          out.push({ name: 'id', value });
          anchorIds.push(value);
        }
        continue;
      }
      if (name === 'class') {
        out.push({ name: 'class', value: value.slice(0, 256) });
        continue;
      }
      if (name === 'dir' && !['ltr', 'rtl', 'auto'].includes(value)) continue;
      out.push({ name, value: value.slice(0, 256) });
      continue;
    }
    if (tag === 'a' && name === 'href') {
      const target = resolveInternal(value, chapterDir, knownFiles);
      if (target) {
        // Internal link: the reader intercepts data-vx-href and navigates.
        out.push({ name: 'data-vx-href', value: target });
        out.push({ name: 'href', value: '#' });
      } else if (/^https?:\/\//i.test(value)) {
        out.push({ name: 'href', value });
        out.push({ name: 'rel', value: 'noopener noreferrer nofollow' });
        out.push({ name: 'target', value: '_blank' });
      }
      continue;
    }
    if (tag === 'img' && (name === 'src' || name === 'xlink:href')) {
      const target = resolveInternal(value, chapterDir, knownFiles);
      if (target) {
        assets.push(target);
        // Relative URL resolved by the reader against the book asset route.
        out.push({ name: 'src', value: `asset/${encodeURIComponent(target)}` });
        out.push({ name: 'loading', value: 'lazy' });
        out.push({ name: 'decoding', value: 'async' });
      }
      continue;
    }
    if (TAG_ATTRS[tag]?.has(name)) {
      out.push({ name, value: value.slice(0, 256) });
    }
  }
  node.attrs = out;
}

function resolveInternal(url: string, chapterDir: string, knownFiles: Set<string>): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // absolute scheme: external
  if (url.startsWith('//') || url.startsWith('/')) return null;
  const [file, frag] = url.split('#');
  if (!file) return frag ? `#${frag}` : null;
  try {
    const abs = path.normalize(path.join(chapterDir, decodeURIComponent(file)));
    if (abs.startsWith('..')) return null;
    if (!knownFiles.has(abs)) return null;
    return frag ? `${abs}#${frag}` : abs;
  } catch {
    return null;
  }
}

/** Plain text with '\n' at block boundaries; matches the client DOM walk. */
export function extractText(node: P5Node): string {
  let out = '';
  const visit = (n: P5Node): void => {
    if (n.nodeName === '#text') {
      out += n.value ?? '';
      return;
    }
    const tag = n.tagName?.toLowerCase() ?? '';
    for (const c of n.childNodes ?? []) visit(c);
    if (BLOCK_TAGS.has(tag) && !out.endsWith('\n')) out += '\n';
  };
  for (const c of node.childNodes ?? []) visit(c);
  return out;
}
