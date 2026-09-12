import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../db/index.js';
import { bookIdsWithFacet, facetGroups, facetsForBook, foldFacet, writeFacets } from './facets.js';

/**
 * Facets are read out of libraries other software wrote, so the interesting
 * cases are all about disagreement: two files spelling one genre differently,
 * a book tagged forty times, a drive that is unplugged, and a grouping the
 * library cannot actually support.
 */

let dir: string;
let db: DB;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-facets-'));
  db = openDatabase(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function addBook(fields: Partial<Record<string, unknown>> = {}): string {
  const id = `book${++seq}`;
  db.prepare(
    `INSERT INTO books (id, kind, root_dir, rel_path, format, title, author, series, language,
       scan_state, added_at)
     VALUES (?, 'ebook', '/lib', ?, 'epub', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  ).run(
    id,
    `${id}.epub`,
    (fields.title as string) ?? `Title ${id}`,
    (fields.author as string) ?? null,
    (fields.series as string) ?? null,
    (fields.language as string) ?? null,
    (fields.scan_state as string) ?? 'ready',
  );
  return id;
}

describe('foldFacet', () => {
  it('makes one shelf out of two spellings of one genre', () => {
    expect(foldFacet('Science Fiction')).toBe(foldFacet('  science   fiction '));
  });

  it('changes nothing inside the value', () => {
    expect(foldFacet("Le Guin's SF")).toBe("le guin's sf");
  });
});

describe('facetsForBook', () => {
  it('reads the tags a library already wrote', () => {
    const got = facetsForBook({
      genres: ['Fantasy', 'Adventure'],
      narrator: 'Rivka Sharon',
      publisher: 'Tide Line Press',
      year: 2019,
      rating: 4.5,
    });
    expect(got).toEqual([
      { kind: 'genre', value: 'Fantasy' },
      { kind: 'genre', value: 'Adventure' },
      { kind: 'narrator', value: 'Rivka Sharon' },
      { kind: 'publisher', value: 'Tide Line Press' },
      { kind: 'year', value: '2019' },
      { kind: 'rating', value: '4.5' },
    ]);
  });

  it('keeps one of two spellings of the same tag on one book', () => {
    const got = facetsForBook({ genres: ['Sci-Fi', 'sci-fi', 'SCI-FI '] });
    expect(got).toHaveLength(1);
    expect(got[0]!.value).toBe('Sci-Fi');
  });

  it('drops empty and absurdly long values rather than storing them', () => {
    const got = facetsForBook({ genres: ['', '   ', 'x'.repeat(200)], publisher: null });
    expect(got).toEqual([]);
  });

  it('caps one pathological file so it cannot flood the table', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Tag ${i}`);
    expect(facetsForBook({ genres: many })).toHaveLength(24);
  });

  it('ignores a rating of zero, which means unrated rather than terrible', () => {
    expect(facetsForBook({ rating: 0 }).some((f) => f.kind === 'rating')).toBe(false);
  });

  it('normalises runs of whitespace so one tag is one value', () => {
    expect(facetsForBook({ genres: ['Historical   Fiction'] })[0]!.value).toBe(
      'Historical Fiction',
    );
  });
});

describe('facetGroups', () => {
  it('offers nothing for a library that cannot support a grouping', () => {
    // One author and one genre is not a way to browse anything.
    const a = addBook({ author: 'Solo' });
    writeFacets(db, a, facetsForBook({ genres: ['Fantasy'] }));
    expect(facetGroups(db)).toEqual([]);
  });

  it('groups and counts what the library does support', () => {
    const a = addBook({ author: 'Rivka Sharon' });
    const b = addBook({ author: 'Noa Adler' });
    writeFacets(db, a, facetsForBook({ genres: ['Fantasy', 'Adventure'] }));
    writeFacets(db, b, facetsForBook({ genres: ['fantasy'] }));

    const groups = facetGroups(db);
    const genres = groups.find((g) => g.kind === 'genre')!;
    expect(genres.values.map((v) => [v.label, v.count])).toEqual([
      ['Adventure', 1],
      ['Fantasy', 2],
    ]);
    expect(groups.find((g) => g.kind === 'author')!.values).toHaveLength(2);
  });

  it('leaves out a book whose drive is unplugged', () => {
    // A genre that leads to an empty list is worse than no genre.
    const a = addBook({ author: 'A' });
    const b = addBook({ author: 'B' });
    const gone = addBook({ author: 'C', scan_state: 'missing' });
    writeFacets(db, a, facetsForBook({ genres: ['Fantasy'] }));
    writeFacets(db, b, facetsForBook({ genres: ['History'] }));
    writeFacets(db, gone, facetsForBook({ genres: ['Fantasy', 'Poetry'] }));

    const genres = facetGroups(db).find((g) => g.kind === 'genre')!;
    expect(genres.values.map((v) => [v.value, v.count])).toEqual([
      ['Fantasy', 1],
      ['History', 1],
    ]);
    expect(genres.values.some((v) => v.value === 'Poetry')).toBe(false);
  });

  it('reads years and ratings backwards — newest and best first', () => {
    const a = addBook();
    const b = addBook();
    writeFacets(db, a, facetsForBook({ year: 1998, rating: 3 }));
    writeFacets(db, b, facetsForBook({ year: 2021, rating: 5 }));
    expect(
      facetGroups(db)
        .find((g) => g.kind === 'year')!
        .values.map((v) => v.value),
    ).toEqual(['2021', '1998']);
    expect(
      facetGroups(db)
        .find((g) => g.kind === 'rating')!
        .values.map((v) => v.label),
    ).toEqual(['★★★★★', '★★★']);
  });

  it('names a language rather than showing its code', () => {
    addBook({ language: 'en' });
    addBook({ language: 'he' });
    const langs = facetGroups(db).find((g) => g.kind === 'language')!;
    expect(langs.values.map((v) => v.label).sort()).toEqual(['English', 'Hebrew']);
  });

  it('shows a half star as a half star', () => {
    const a = addBook();
    const b = addBook();
    writeFacets(db, a, facetsForBook({ rating: 4.5 }));
    writeFacets(db, b, facetsForBook({ rating: 2 }));
    expect(facetGroups(db).find((g) => g.kind === 'rating')!.values[0]!.label).toBe('★★★★½');
  });
});

describe('writeFacets', () => {
  it('replaces rather than accumulates, so a retagged book loses the old tag', () => {
    const a = addBook();
    writeFacets(db, a, facetsForBook({ genres: ['Fantasy'] }));
    writeFacets(db, a, facetsForBook({ genres: ['History'] }));
    const rows = db.prepare('SELECT value FROM book_facets WHERE book_id = ?').all(a);
    expect(rows).toEqual([{ value: 'History' }]);
  });
});

describe('bookIdsWithFacet', () => {
  it('matches regardless of how a value was capitalised', () => {
    const a = addBook();
    const b = addBook();
    writeFacets(db, a, facetsForBook({ genres: ['Science Fiction'] }));
    writeFacets(db, b, facetsForBook({ genres: ['science fiction'] }));
    expect(bookIdsWithFacet(db, 'genre', 'SCIENCE FICTION')).toEqual(new Set([a, b]));
  });

  it('says nothing for a kind the caller must answer from the book row', () => {
    // Author, series and language live on `books`; returning an empty set
    // here would silently filter the library down to nothing.
    expect(bookIdsWithFacet(db, 'author', 'Anyone')).toBeNull();
  });

  it('returns an empty set for a value nothing carries', () => {
    expect(bookIdsWithFacet(db, 'genre', 'Nothing')).toEqual(new Set());
  });
});
