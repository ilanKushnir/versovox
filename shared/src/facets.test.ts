import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_FACETS,
  type FacetKind,
  type SidebarPrefs,
  formatFacet,
  isFacetKind,
  parseFacet,
  sidebarFacetsOf,
} from './facets.js';
import { normaliseLanguage } from './languages.js';

/**
 * The two rules that decide what a reader sees in Browse — what their choice
 * means, and what "no choice yet" means in a library that cannot support the
 * defaults — and the wire format that carries a filter through a URL.
 */

describe('formatFacet / parseFacet', () => {
  it('round-trips', () => {
    expect(parseFacet(formatFacet('genre', 'Fantasy'))).toEqual({
      kind: 'genre',
      value: 'Fantasy',
    });
  });

  it('keeps a colon that belongs to the value', () => {
    // "Dune: Part Two" and imprint names like "A: An Imprint" are real.
    expect(parseFacet('series:Dune: Part Two')).toEqual({
      kind: 'series',
      value: 'Dune: Part Two',
    });
  });

  it('refuses anything that is not a facet this build knows', () => {
    expect(parseFacet('colour:blue')).toBeNull();
    expect(parseFacet('genre:')).toBeNull();
    expect(parseFacet(':Fantasy')).toBeNull();
    expect(parseFacet('nonsense')).toBeNull();
  });

  it('recognises exactly the kinds this build offers', () => {
    expect(isFacetKind('narrator')).toBe(true);
    expect(isFacetKind('mood')).toBe(false);
  });
});

describe('sidebarFacetsOf', () => {
  const all: FacetKind[] = ['genre', 'author', 'series', 'narrator'];
  const chose = (facets: FacetKind[]): SidebarPrefs => ({ facets, chosen: true });

  it('uses the defaults for someone who has never chosen', () => {
    expect(sidebarFacetsOf(null, all)).toEqual(DEFAULT_SIDEBAR_FACETS);
  });

  it('honours a choice exactly, including its order', () => {
    expect(sidebarFacetsOf(chose(['narrator', 'genre']), all)).toEqual(['narrator', 'genre']);
  });

  it('honours the choice to show nothing', () => {
    // Distinct from never having chosen. Someone who unticked everything
    // meant it, and must not be handed the defaults back.
    expect(sidebarFacetsOf(chose([]), all)).toEqual([]);
  });

  it('hides a chosen group this library cannot support, without forgetting it', () => {
    // The stored preference still says narrator; it simply has nothing to
    // show until an audiobook with a narrator tag turns up.
    const prefs = chose(['genre', 'narrator']);
    expect(sidebarFacetsOf(prefs, ['genre'])).toEqual(['genre']);
    expect(prefs.facets).toContain('narrator');
  });

  it('stands in for defaults the library cannot support', () => {
    // A library with no genres and no series would otherwise get an empty
    // Browse section saying nothing was chosen, when nothing was ever asked.
    expect(sidebarFacetsOf(null, ['author', 'narrator', 'year'])).toEqual(['author', 'narrator']);
  });

  it('offers nothing when the library supports nothing', () => {
    expect(sidebarFacetsOf(null, [])).toEqual([]);
  });
});

describe('normaliseLanguage', () => {
  it('makes one language out of the two codes a paired book carries', () => {
    // ffmpeg writes ISO 639-2, an EPUB declares ISO 639-1. Left alone, one
    // book shows up twice in the Languages group.
    expect(normaliseLanguage('eng')).toBe(normaliseLanguage('en'));
    expect(normaliseLanguage('eng')).toBe('en');
  });

  it('handles the bibliographic codes that differ from the terminological', () => {
    expect(normaliseLanguage('ger')).toBe('de');
    expect(normaliseLanguage('fre')).toBe('fr');
    expect(normaliseLanguage('dut')).toBe('nl');
  });

  it('drops the region', () => {
    expect(normaliseLanguage('en-GB')).toBe('en');
    expect(normaliseLanguage('pt_BR')).toBe('pt');
  });

  it('keeps a code it does not know rather than dropping the language', () => {
    expect(normaliseLanguage('cy')).toBe('cy');
    expect(normaliseLanguage('yor')).toBe('yor');
  });

  it('refuses junk, so a stray tag does not become a sidebar row', () => {
    expect(normaliseLanguage('')).toBeNull();
    expect(normaliseLanguage(null)).toBeNull();
    expect(normaliseLanguage('Unknown Language')).toBeNull();
    expect(normaliseLanguage('12')).toBeNull();
  });
});
