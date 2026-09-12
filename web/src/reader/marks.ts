import { type Annotation } from '@versovox/shared';
import { domToOffset, rangeForSpan, type TextMap } from './textmap';

/**
 * Painting highlights and notes onto the page, and finding the one under a
 * finger.
 *
 * Marks are drawn with the CSS Custom Highlight API rather than by wrapping
 * text in elements: the chapter's DOM comes from the book and must not be
 * rewritten, and a wrapper would break the character offsets everything else
 * in the reader is addressed by. The cost of that choice is that a highlight
 * is paint, not an element — nothing to click. So hit testing is done the
 * other way round: turn the point into a character offset and ask which mark
 * covers it.
 */

/** A highlight colour. Values are stored on the annotation, so they are API. */
export const HIGHLIGHT_COLORS = ['amber', 'rose', 'plum', 'sky', 'sand'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const DEFAULT_HIGHLIGHT: HighlightColor = 'amber';

/** What each colour is called when a screen reader says it aloud. */
export const COLOR_LABELS: Record<HighlightColor, string> = {
  amber: 'Amber',
  rose: 'Rose',
  plum: 'Plum',
  sky: 'Sky',
  sand: 'Sand',
};

export function isHighlightColor(value: string | null | undefined): value is HighlightColor {
  return HIGHLIGHT_COLORS.includes(value as HighlightColor);
}

/** The colour to paint an annotation in, tolerating anything unexpected. */
export function colorOf(a: Annotation): HighlightColor {
  return isHighlightColor(a.color) ? a.color : DEFAULT_HIGHLIGHT;
}

/** Registry names, one per colour plus one for notes. Must match the CSS. */
const registryFor = (a: Annotation): string =>
  a.kind === 'note' ? 'vx-note' : `vx-hl-${colorOf(a)}`;

const ALL_REGISTRIES = ['vx-note', ...HIGHLIGHT_COLORS.map((c) => `vx-hl-${c}`)];

type HighlightApi = {
  highlights?: Map<string, unknown> & {
    set(k: string, v: unknown): void;
    delete(k: string): void;
  };
};

/** The span an annotation covers, in chapter character offsets. */
export function spanOf(a: Annotation): { start: number; end: number } | null {
  if (a.locator.medium !== 'ebook') return null;
  const start = a.locator.charOffset ?? 0;
  const end = a.endLocator?.medium === 'ebook' ? (a.endLocator.charOffset ?? start + 1) : start + 1;
  return { start, end: Math.max(end, start + 1) };
}

/** Marks belonging to this chapter, in the order they appear in it. */
export function marksInChapter(annotations: Annotation[], spineIdx: number): Annotation[] {
  const here = annotations.filter(
    (a) =>
      (a.kind === 'highlight' || a.kind === 'note') &&
      a.locator.medium === 'ebook' &&
      a.locator.spineIdx === spineIdx,
  );
  return here.sort((x, y) => (spanOf(x)?.start ?? 0) - (spanOf(y)?.start ?? 0));
}

/**
 * Paint every mark in this chapter, one registry per colour so the CSS can
 * give each its own tint, and notes their own dashed underline.
 *
 * Registries are cleared rather than left behind when a colour goes unused:
 * a stale registry keeps painting a range that no longer belongs to anything.
 */
export function paintMarks(map: TextMap | null, annotations: Annotation[], spineIdx: number): void {
  const css = CSS as unknown as HighlightApi;
  if (!css.highlights || typeof Highlight === 'undefined') return;
  if (!map) {
    for (const name of ALL_REGISTRIES) css.highlights.delete(name);
    return;
  }

  const byRegistry = new Map<string, Range[]>();
  for (const a of marksInChapter(annotations, spineIdx)) {
    const span = spanOf(a);
    if (!span) continue;
    const range = rangeForSpan(map, span.start, span.end);
    if (!range) continue;
    const name = registryFor(a);
    const list = byRegistry.get(name);
    if (list) list.push(range);
    else byRegistry.set(name, [range]);
  }

  for (const name of ALL_REGISTRIES) {
    const ranges = byRegistry.get(name);
    if (ranges && ranges.length > 0) css.highlights.set(name, new Highlight(...ranges));
    else css.highlights.delete(name);
  }
}

/**
 * The mark under a point, or null.
 *
 * When marks overlap, the shortest wins: a note added inside a long highlight
 * is the more specific thing the reader is pointing at, and it is the one they
 * cannot otherwise reach.
 */
export function markAtPoint(
  map: TextMap | null,
  annotations: Annotation[],
  spineIdx: number,
  x: number,
  y: number,
): Annotation | null {
  if (!map) return null;
  const hit = caretAt(x, y);
  if (!hit) return null;
  const offset = domToOffset(map, hit.node, hit.offset);
  if (offset === null) return null;

  let best: { a: Annotation; width: number } | null = null;
  for (const a of marksInChapter(annotations, spineIdx)) {
    const span = spanOf(a);
    if (!span || offset < span.start || offset >= span.end) continue;
    const width = span.end - span.start;
    if (!best || width < best.width) best = { a, width };
  }
  return best?.a ?? null;
}

/**
 * The text position under a point. Two APIs do this and neither is universal:
 * Firefox has caretPositionFromPoint, WebKit had caretRangeFromPoint first.
 */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}
