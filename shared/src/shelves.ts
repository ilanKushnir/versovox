import { z } from 'zod';
import { bookSummarySchema } from './api.js';

/**
 * Shelves and the reading list. Everything here belongs to one person: two
 * people on the same server share every book and no shelf at all.
 *
 * Three kinds of collection, deliberately distinct:
 *  - AUTOMATIC shelves are computed from what the server already knows
 *    (progress, pairing, when a book arrived). Nobody curates them and
 *    nobody can rename them.
 *  - USER shelves are a name and a pile of books.
 *  - The READING LIST is a queue. Order is its whole point, which is why it
 *    is not simply a shelf that happens to be sorted.
 */

/**
 * The computed shelves the server can count. `on-this-device` is deliberately
 * absent: downloads live in one browser on one machine, so only the client
 * knows what is there, and a server-side zero would be a lie.
 */
export const autoShelfIdSchema = z.enum([
  'reading-now',
  'finished',
  'both-formats',
  'recently-added',
]);
export type AutoShelfId = z.infer<typeof autoShelfIdSchema>;

export const AUTO_SHELVES: { id: AutoShelfId; label: string; blurb: string }[] = [
  {
    id: 'reading-now',
    label: 'Reading now',
    blurb: 'Started and not yet finished, most recent first.',
  },
  { id: 'finished', label: 'Finished', blurb: 'Everything you have marked as finished.' },
  {
    id: 'both-formats',
    label: 'Both formats',
    blurb: 'Titles you own as an ebook and as an audiobook.',
  },
  { id: 'recently-added', label: 'Recently added', blurb: 'What the last scans turned up.' },
];

/** How long a book counts as a new arrival, and how many are worth showing. */
export const RECENTLY_ADDED_DAYS = 30;
export const RECENTLY_ADDED_LIMIT = 60;

/** A shelf cannot be named nothing, and a name past this stops being a name. */
export const SHELF_NAME_MAX = 60;
/** Past this a sidebar is a directory, not navigation. */
export const SHELVES_PER_USER_MAX = 100;
/** One multi-select in the library grid, capped so one request stays one request. */
export const BULK_ADD_MAX = 200;
export const READING_LIST_NOTE_MAX = 2000;

export const shelfSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int(),
  sortKey: z.string(),
  updatedAt: z.string(),
});
export type ShelfSummary = z.infer<typeof shelfSummarySchema>;

export const shelvesOverviewSchema = z.object({
  auto: z.array(z.object({ id: autoShelfIdSchema, count: z.number().int() })),
  shelves: z.array(shelfSummarySchema),
  readingList: z.object({
    count: z.number().int(),
    nextBookId: z.string().nullable(),
    nextTitle: z.string().nullable(),
  }),
});
export type ShelvesOverview = z.infer<typeof shelvesOverviewSchema>;

export const readingListItemSchema = z.object({
  book: bookSummarySchema,
  note: z.string().nullable(),
  addedAt: z.string(),
  sortKey: z.string(),
});
export type ReadingListItem = z.infer<typeof readingListItemSchema>;

/** Collapse inner runs of whitespace so "Summer  reads" cannot shadow "Summer reads". */
const shelfNameSchema = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'A shelf needs a name').max(SHELF_NAME_MAX));

export const createShelfSchema = z.object({ name: shelfNameSchema });

/**
 * Rename and/or move, per field. NOT `.partial()`: partial injects defaults,
 * so a plain rename would silently carry `afterShelfId` and jump the shelf to
 * the top of the sidebar. The handler branches on `!== undefined`.
 */
export const updateShelfSchema = z.object({
  name: shelfNameSchema.optional(),
  /** The shelf this one now follows; null puts it first. Absent = do not move. */
  afterShelfId: z.string().max(64).nullable().optional(),
});

/** Where an item lands. null = first in the list. */
export const movePositionSchema = z.object({ afterBookId: z.string().max(64).nullable() });

export const bulkAddSchema = z.object({
  bookIds: z.array(z.string().min(1).max(64)).min(1).max(BULK_ADD_MAX),
});

export const addToShelfSchema = z.object({
  afterBookId: z.string().max(64).nullable().optional(),
});

export const addToReadingListSchema = z.object({
  /** 'top' is Read next; 'end' (the default) is Add to reading list. */
  position: z.enum(['top', 'end']).optional(),
  afterBookId: z.string().max(64).nullable().optional(),
  note: z.string().max(READING_LIST_NOTE_MAX).nullable().optional(),
});

export const readingListNoteSchema = z.object({
  note: z.string().max(READING_LIST_NOTE_MAX).nullable(),
});
