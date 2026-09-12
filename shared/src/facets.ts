/**
 * Facets: the library's own metadata, as ways to browse it.
 *
 * A self-hosted library is not a blank slate. Calibre owners have spent years
 * tagging their books; Audiobookshelf writes a genre and a narrator into every
 * file. ReadPort reads all of that and offers it as browsing, without changing
 * a byte of it and without inventing categories nobody asked for.
 *
 * Two rules keep the sidebar honest, and both are enforced server-side rather
 * than left to the client:
 *
 *  - a facet with fewer than two distinct values is not offered. "Publisher:
 *    one publisher" is not a way to browse anything.
 *  - nothing is hidden that the library actually contains. If a facet has
 *    values, the reader can turn it on, whether or not this build thinks it
 *    is interesting.
 */

/** A way of grouping the library. The wire value; do not renumber or rename. */
export const FACET_KINDS = [
  'genre',
  'author',
  'series',
  'narrator',
  'publisher',
  'language',
  'year',
  'rating',
] as const;

export type FacetKind = (typeof FACET_KINDS)[number];

export function isFacetKind(value: string): value is FacetKind {
  return (FACET_KINDS as readonly string[]).includes(value);
}

export interface FacetKindSpec {
  kind: FacetKind;
  /** Plural, for the sidebar group's own row. */
  label: string;
  /** Where the values come from, shown in the customise sheet. */
  source: string;
  /** Whether values sort by name (false) or by their own order (true). */
  ordered: boolean;
}

export const FACET_SPECS: FacetKindSpec[] = [
  {
    kind: 'genre',
    label: 'Genres',
    source: 'Calibre tags (dc:subject) and audiobook genre tags',
    ordered: false,
  },
  { kind: 'author', label: 'Authors', source: "The book's own author metadata", ordered: false },
  { kind: 'series', label: 'Series', source: 'Calibre series, or a series tag', ordered: false },
  {
    kind: 'narrator',
    label: 'Narrators',
    source: 'The narrator or composer tag on the audio files',
    ordered: false,
  },
  { kind: 'publisher', label: 'Publishers', source: 'dc:publisher', ordered: false },
  { kind: 'language', label: 'Languages', source: "The book's declared language", ordered: false },
  { kind: 'year', label: 'Published', source: 'dc:date, or the audio date tag', ordered: true },
  { kind: 'rating', label: 'Ratings', source: 'calibre:rating', ordered: true },
];

export function facetSpec(kind: FacetKind): FacetKindSpec {
  return FACET_SPECS.find((s) => s.kind === kind)!;
}

/** One value within a facet, with how many books carry it. */
export interface FacetValue {
  /** The stored value, and what a filter names. */
  value: string;
  /** What to show. Differs from `value` for languages and ratings. */
  label: string;
  count: number;
}

export interface FacetGroup {
  kind: FacetKind;
  label: string;
  values: FacetValue[];
}

/**
 * The wire form of a filter: `kind:value`.
 *
 * The value may itself contain a colon — "Publisher: A: An Imprint" is a real
 * thing — so only the first one separates, and parsing splits once from the
 * left rather than joining a split array back together.
 */
export function formatFacet(kind: FacetKind, value: string): string {
  return `${kind}:${value}`;
}

export function parseFacet(raw: string): { kind: FacetKind; value: string } | null {
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at);
  const value = raw.slice(at + 1);
  if (!isFacetKind(kind) || value.length === 0) return null;
  return { kind, value };
}

/** A facet with fewer than this many distinct values is not worth a group. */
export const MIN_FACET_VALUES = 2;

/**
 * Which facet groups the sidebar shows, and in what order.
 *
 * Stored per person, because two people sharing a server browse differently:
 * one wants genres, the other only ever looks for a narrator. An empty list
 * means "not chosen yet" and the defaults below apply — distinct from a list
 * the reader has deliberately emptied, which is `[]` with `chosen: true`.
 */
export interface SidebarPrefs {
  /** Facet kinds to show, in sidebar order. */
  facets: FacetKind[];
  /** False until the reader has opened the customise sheet and saved. */
  chosen: boolean;
}

/**
 * What a library gets before anyone customises anything.
 *
 * Genres and series, and nothing else. Authors is deliberately not a default:
 * a sidebar that enumerates three hundred authors is a directory, not
 * navigation, and the search box already matches on author. It is one tick
 * away for anyone who wants it.
 */
export const DEFAULT_SIDEBAR_FACETS: FacetKind[] = ['genre', 'series'];

/**
 * What to show, given what this reader chose and what this library has.
 *
 * A choice is honoured exactly, including the choice to show nothing: a
 * reader who unticked everything meant it. Only the *defaults* adapt — a
 * library with no genres and no series would otherwise get an empty Browse
 * section explaining that nothing was chosen, when in fact nothing was ever
 * asked. There, the first two groupings the library does support stand in.
 */
export function sidebarFacetsOf(
  prefs: SidebarPrefs | null | undefined,
  available: readonly FacetKind[] = FACET_KINDS,
): FacetKind[] {
  if (prefs?.chosen) return prefs.facets.filter((k) => available.includes(k));
  const defaults = DEFAULT_SIDEBAR_FACETS.filter((k) => available.includes(k));
  if (defaults.length > 0) return defaults;
  return FACET_SPECS.map((s) => s.kind)
    .filter((k) => available.includes(k))
    .slice(0, 2);
}
