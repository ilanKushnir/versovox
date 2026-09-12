import {
  type FacetGroup,
  type FacetKind,
  MIN_FACET_VALUES,
  facetSpec,
  languageByCode,
} from '@readport/shared';
import { type DB } from '../db/index.js';

/**
 * Reading the library's own metadata back out as ways to browse it.
 *
 * Nothing here invents a category. Every value comes from a tag somebody
 * already wrote — in Calibre, in Audiobookshelf, or by hand in a tag editor —
 * and ReadPort's only contributions are folding case so one genre is one
 * shelf, and refusing to offer a grouping the library cannot actually support.
 */

/** A facet value as it comes off a book, before it is stored. */
export interface ExtractedFacet {
  kind: FacetKind;
  value: string;
}

/**
 * Fold a value for grouping. Case and surrounding punctuation are noise —
 * "Science Fiction", "science fiction" and "Science Fiction " are one genre —
 * but nothing inside the value is touched, so a value can always be shown
 * back in the spelling its owner chose.
 */
export function foldFacet(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Stored facets are capped so one pathological file cannot flood the table. */
const MAX_PER_KIND = 24;
const MAX_VALUE_LENGTH = 80;

/**
 * The facets a book carries, from what its own metadata says.
 *
 * Only the kinds that are not already columns on `books`: author, series and
 * language are read from those columns instead, so there is one place that
 * knows a book's author and the sidebar cannot disagree with the library list.
 */
export function facetsForBook(input: {
  genres?: string[] | null;
  narrator?: string | null;
  publisher?: string | null;
  year?: number | null;
  rating?: number | null;
}): ExtractedFacet[] {
  const out: ExtractedFacet[] = [];
  const push = (kind: FacetKind, raw: string | null | undefined) => {
    const value = (raw ?? '').trim().replace(/\s+/g, ' ');
    if (!value || value.length > MAX_VALUE_LENGTH) return;
    if (out.filter((f) => f.kind === kind).length >= MAX_PER_KIND) return;
    if (out.some((f) => f.kind === kind && foldFacet(f.value) === foldFacet(value))) return;
    out.push({ kind, value });
  };

  for (const g of input.genres ?? []) push('genre', g);
  push('narrator', input.narrator);
  push('publisher', input.publisher);
  if (input.year != null && Number.isInteger(input.year)) push('year', String(input.year));
  if (input.rating != null && input.rating > 0) {
    // Stored as the number of stars so it sorts, formatted for display later.
    push('rating', String(Math.round(input.rating * 2) / 2));
  }
  return out;
}

/** Replace everything stored for one book. Called at the end of indexing. */
export function writeFacets(db: DB, bookId: string, facets: ExtractedFacet[]): void {
  db.prepare('DELETE FROM book_facets WHERE book_id = ?').run(bookId);
  if (facets.length === 0) return;
  const ins = db.prepare(
    'INSERT OR IGNORE INTO book_facets (book_id, kind, value, fold) VALUES (?, ?, ?, ?)',
  );
  for (const f of facets) ins.run(bookId, f.kind, f.value, foldFacet(f.value));
}

/** How a value is shown, which is not always how it is stored. */
function labelFor(kind: FacetKind, value: string): string {
  if (kind === 'language') return languageByCode(value)?.label ?? value.toUpperCase();
  if (kind === 'rating') {
    const stars = Number(value);
    if (!Number.isFinite(stars)) return value;
    const whole = Math.floor(stars);
    return '★'.repeat(whole) + (stars % 1 ? '½' : '');
  }
  return value;
}

/**
 * Every grouping this library can actually support, with its values and
 * counts, in the order FACET_SPECS declares.
 *
 * Books the scanner has marked missing are left out throughout — a drive that
 * is unplugged should not put a genre in the sidebar that leads to an empty
 * list. A grouping with fewer than two distinct values is dropped for the same
 * reason it would not be worth a shelf.
 */
export function facetGroups(db: DB): FacetGroup[] {
  const groups: FacetGroup[] = [];

  // Author, series and language: straight off the books table, so the counts
  // agree with the library listing by construction.
  const column: [FacetKind, string][] = [
    ['author', 'author'],
    ['series', 'series'],
    ['language', 'language'],
  ];
  for (const [kind, col] of column) {
    const rows = db
      .prepare(
        `SELECT ${col} AS value, COUNT(*) AS n FROM books
          WHERE scan_state != 'missing' AND ${col} IS NOT NULL AND TRIM(${col}) != ''
          GROUP BY ${col} COLLATE NOCASE ORDER BY ${col} COLLATE NOCASE`,
      )
      .all() as { value: string; n: number }[];
    if (rows.length >= MIN_FACET_VALUES) {
      groups.push({
        kind,
        label: facetSpec(kind).label,
        values: rows.map((r) => ({
          value: r.value,
          label: labelFor(kind, r.value),
          count: Number(r.n),
        })),
      });
    }
  }

  // Everything else comes from the facet table. MIN(value) picks one spelling
  // to show when two files disagree about capitalisation; the fold is what
  // grouped them.
  const rows = db
    .prepare(
      `SELECT f.kind AS kind, f.fold AS fold, MIN(f.value) AS value, COUNT(DISTINCT f.book_id) AS n
         FROM book_facets f JOIN books b ON b.id = f.book_id
        WHERE b.scan_state != 'missing'
        GROUP BY f.kind, f.fold`,
    )
    .all() as { kind: string; fold: string; value: string; n: number }[];

  const byKind = new Map<string, { value: string; label: string; count: number }[]>();
  for (const r of rows) {
    const list = byKind.get(r.kind) ?? [];
    list.push({
      value: r.value,
      label: labelFor(r.kind as FacetKind, r.value),
      count: Number(r.n),
    });
    byKind.set(r.kind, list);
  }
  for (const [kind, values] of byKind) {
    if (values.length < MIN_FACET_VALUES) continue;
    const spec = facetSpec(kind as FacetKind);
    // Years and ratings read backwards — newest and best first — because that
    // is the end of those lists anyone actually opens.
    values.sort((a, b) =>
      spec.ordered
        ? Number(b.value) - Number(a.value)
        : a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
    );
    groups.push({ kind: kind as FacetKind, label: spec.label, values });
  }

  // FACET_SPECS order, so the sidebar and the customise sheet agree.
  const order = new Map(facetOrder().map((k, i) => [k, i]));
  groups.sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99));
  return groups;
}

function facetOrder(): FacetKind[] {
  return ['genre', 'author', 'series', 'narrator', 'publisher', 'language', 'year', 'rating'];
}

/**
 * The book ids carrying one facet value, or null when the kind is one the
 * caller should answer from the book row itself.
 *
 * Returning ids rather than a SQL fragment keeps the caller's filtering in
 * one place — the library route already loads and filters in memory — and
 * makes the one query here easy to read.
 */
export function bookIdsWithFacet(db: DB, kind: FacetKind, value: string): Set<string> | null {
  if (kind === 'author' || kind === 'series' || kind === 'language') return null;
  const rows = db
    .prepare('SELECT book_id FROM book_facets WHERE kind = ? AND fold = ?')
    .all(kind, foldFacet(value)) as { book_id: string }[];
  return new Set(rows.map((r) => String(r.book_id)));
}
