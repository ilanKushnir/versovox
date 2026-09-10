/**
 * Maps between the server's extracted-text character offsets and live DOM
 * positions. The walk mirrors server/src/epub/sanitize.ts extractText():
 * text node data verbatim, with a synthetic '\n' after each block element
 * (only when the accumulated text does not already end with one).
 */

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'LI',
  'DT',
  'DD',
  'TR',
  'CAPTION',
  'FIGURE',
  'FIGCAPTION',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'NAV',
  'PRE',
  'TABLE',
  'UL',
  'OL',
  'DL',
  'HR',
  'BR',
]);

export interface TextMap {
  /** Text nodes in document order with their global start offsets. */
  nodes: { node: Text; start: number }[];
  totalChars: number;
}

export function buildTextMap(root: HTMLElement): TextMap {
  const nodes: { node: Text; start: number }[] = [];
  let count = 0;
  let lastChar = '';
  const visit = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) {
      const data = (n as Text).data;
      nodes.push({ node: n as Text, start: count });
      count += data.length;
      if (data.length > 0) lastChar = data[data.length - 1]!;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    for (const c of Array.from(n.childNodes)) visit(c);
    if (BLOCK_TAGS.has((n as Element).tagName) && lastChar !== '\n') {
      count += 1; // synthetic newline
      lastChar = '\n';
    }
  };
  for (const c of Array.from(root.childNodes)) visit(c);
  return { nodes, totalChars: count };
}

/** Locate the DOM position for a global char offset. */
export function offsetToDom(map: TextMap, offset: number): { node: Text; offset: number } | null {
  if (map.nodes.length === 0) return null;
  let lo = 0;
  let hi = map.nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (map.nodes[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const entry = map.nodes[lo]!;
  const within = Math.max(0, Math.min(offset - entry.start, entry.node.data.length));
  return { node: entry.node, offset: within };
}

/** Global char offset for a DOM position inside the mapped root. */
export function domToOffset(map: TextMap, node: Node, nodeOffset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const entry = map.nodes.find((e) => e.node === node);
    if (entry) return entry.start + nodeOffset;
    return null;
  }
  // Element position: use the first text node at/after the child index.
  const el = node as Element;
  const child = el.childNodes[nodeOffset] ?? el;
  const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  const first = (walker.nextNode() ?? null) as Text | null;
  if (first) {
    const entry = map.nodes.find((e) => e.node === first);
    if (entry) return entry.start;
  }
  return null;
}

export function rangeForSpan(map: TextMap, start: number, end: number): Range | null {
  const a = offsetToDom(map, start);
  const b = offsetToDom(map, Math.max(start, end));
  if (!a || !b) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  } catch {
    return null;
  }
}

/**
 * First visible text offset inside a viewport box (paginated page or scroll
 * viewport). Walks text nodes and returns the first whose rect intersects.
 */
export function firstVisibleOffset(
  map: TextMap,
  box: { left: number; right: number; top: number; bottom: number },
): number | null {
  const probe = document.createRange();
  for (const entry of map.nodes) {
    if (!entry.node.data.trim()) continue;
    probe.selectNodeContents(entry.node);
    const rects = probe.getClientRects();
    for (const r of rects) {
      if (r.width === 0 && r.height === 0) continue;
      const cx = Math.max(box.left, Math.min(r.left + 1, box.right));
      if (
        r.right > box.left + 1 &&
        r.left < box.right - 1 &&
        r.bottom > box.top &&
        r.top < box.bottom
      ) {
        // Refine to the first character within the box on this rect's line.
        const len = entry.node.data.length;
        for (let i = 0; i < len; i += 8) {
          probe.setStart(entry.node, i);
          probe.setEnd(entry.node, Math.min(len, i + 1));
          const cr = probe.getBoundingClientRect();
          if (
            cr.right > box.left + 1 &&
            cr.left < box.right - 1 &&
            cr.bottom > box.top &&
            cr.top < box.bottom
          ) {
            return entry.start + i;
          }
        }
        void cx;
        return entry.start;
      }
    }
  }
  return null;
}
