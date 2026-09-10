import { z } from 'zod';

/**
 * Canonical locators. One contract, reused by the reader, the player, the
 * progress pipeline, annotations, alignment, and the switch endpoint.
 *
 * Ebook positions are anchored to the derived text index that TandemLeaf
 * extracts from the EPUB (never to the mutable rendered DOM):
 *  - `spineIdx`: index into the spine reading order.
 *  - `sentenceId`: stable content-derived sentence id ("s" + hash), survives
 *    re-extraction of an unchanged publication.
 *  - `charOffset`: character offset into the chapter's extracted plain text,
 *    used as a fallback when a sentence id is unknown or no longer resolves.
 *  - `sentenceRatio`: 0..1 position within the sentence (word-level hint).
 *
 * Audio positions are absolute within a track plus a derived whole-book
 * millisecond offset (`bookMs`) so multi-file books reconcile cleanly.
 */

export const ebookLocatorSchema = z.object({
  medium: z.literal('ebook'),
  spineIdx: z.number().int().min(0),
  sentenceId: z.string().min(1).max(64).optional(),
  charOffset: z.number().int().min(0).optional(),
  sentenceRatio: z.number().min(0).max(1).optional(),
  pct: z.number().min(0).max(1),
});

export const audioLocatorSchema = z.object({
  medium: z.literal('audio'),
  trackIdx: z.number().int().min(0),
  positionMs: z.number().int().min(0),
  bookMs: z.number().int().min(0).optional(),
  pct: z.number().min(0).max(1),
});

export const locatorSchema = z.discriminatedUnion('medium', [
  ebookLocatorSchema,
  audioLocatorSchema,
]);

export type EbookLocator = z.infer<typeof ebookLocatorSchema>;
export type AudioLocator = z.infer<typeof audioLocatorSchema>;
export type Locator = z.infer<typeof locatorSchema>;
