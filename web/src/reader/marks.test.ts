import { describe, expect, it } from 'vitest';
import { type Annotation } from '@readport/shared';
import { colorOf, isHighlightColor, marksInChapter, spanOf } from './marks';

/**
 * The parts of mark handling that are pure. Painting and hit testing need a
 * live document and the CSS Custom Highlight API, so they are exercised in the
 * browser rather than here; what is worth pinning down without one is the
 * arithmetic that decides which mark is where, and the tolerance for an
 * annotation whose colour came from an older version or another client.
 */

let seq = 0;
function mark(
  kind: 'highlight' | 'note' | 'bookmark',
  spineIdx: number,
  start: number,
  end?: number,
  color?: string | null,
): Annotation {
  return {
    id: `a${++seq}`,
    bookId: 'b1',
    kind,
    locator: { medium: 'ebook', spineIdx, charOffset: start, pct: 0 },
    endLocator: end === undefined ? null : { medium: 'ebook', spineIdx, charOffset: end, pct: 0 },
    color: color ?? null,
    selectedText: null,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('spanOf', () => {
  it('reads the span a highlight covers', () => {
    expect(spanOf(mark('highlight', 0, 100, 160))).toEqual({ start: 100, end: 160 });
  });

  it('gives a mark with no end a single character, so it can still be hit', () => {
    // A note attached to a point rather than a selection has no end locator.
    // Zero width would make it unclickable and invisible.
    expect(spanOf(mark('note', 0, 100))).toEqual({ start: 100, end: 101 });
  });

  it('refuses to guess a span for an audio locator', () => {
    const a = mark('note', 0, 10);
    a.locator = { medium: 'audio', trackIdx: 0, positionMs: 1000, pct: 0 };
    expect(spanOf(a)).toBeNull();
  });

  it('never returns an end before its start, however the row was written', () => {
    expect(spanOf(mark('highlight', 0, 200, 150))!.end).toBeGreaterThan(200);
  });
});

describe('marksInChapter', () => {
  const all = [
    mark('highlight', 1, 300, 340),
    mark('bookmark', 1, 10),
    mark('note', 1, 50, 60),
    mark('highlight', 2, 5, 20),
    mark('highlight', 1, 100, 120),
  ];

  it('keeps only the marks that paint, in this chapter, in reading order', () => {
    const got = marksInChapter(all, 1);
    expect(got.map((a) => spanOf(a)!.start)).toEqual([50, 100, 300]);
  });

  it('leaves bookmarks out — a bookmark marks a page, not a passage', () => {
    expect(marksInChapter(all, 1).some((a) => a.kind === 'bookmark')).toBe(false);
  });

  it('returns nothing for a chapter with no marks', () => {
    expect(marksInChapter(all, 7)).toEqual([]);
  });
});

describe('colorOf', () => {
  it('uses the stored colour when it is one this build can paint', () => {
    expect(colorOf(mark('highlight', 0, 0, 5, 'plum'))).toBe('plum');
  });

  it('falls back rather than losing a highlight to an unknown colour', () => {
    // Older versions wrote 'leaf'. A highlight whose colour we cannot paint
    // must still appear — an invisible highlight reads as lost data.
    expect(colorOf(mark('highlight', 0, 0, 5, 'leaf'))).toBe('amber');
    expect(colorOf(mark('highlight', 0, 0, 5, null))).toBe('amber');
  });

  it('recognises exactly the colours this build offers', () => {
    expect(isHighlightColor('sky')).toBe(true);
    expect(isHighlightColor('chartreuse')).toBe(false);
    expect(isHighlightColor(null)).toBe(false);
  });
});
