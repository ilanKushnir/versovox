import { z } from 'zod';

/**
 * Alignment contract: a monotonic mapping between ebook sentences and
 * absolute audiobook milliseconds, with per-segment confidence and explicit
 * gaps. Low-confidence regions are never presented as exact.
 */

export const alignmentSourceSchema = z.enum(['exact', 'fuzzy', 'interpolated', 'anchor']);
export type AlignmentSource = z.infer<typeof alignmentSourceSchema>;

export const alignmentSegmentSchema = z.object({
  sentenceId: z.string(),
  spineIdx: z.number().int().min(0),
  sentenceOrd: z.number().int().min(0),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
  source: alignmentSourceSchema,
});
export type AlignmentSegment = z.infer<typeof alignmentSegmentSchema>;

export const alignmentGapSchema = z.object({
  fromMs: z.number().int().min(0),
  toMs: z.number().int().min(0),
  reason: z.enum(['narration-only', 'text-only', 'low-confidence']),
});
export type AlignmentGap = z.infer<typeof alignmentGapSchema>;

export const alignmentSummarySchema = z.object({
  pairId: z.string(),
  version: z.number().int(),
  language: z.string(),
  model: z.string(),
  coverage: z.number().min(0).max(1),
  /**
   * Fraction of ebook sentences with a sentence-exact, high-confidence
   * mapping. This — not overall coverage — is what "exact" claims in the UI
   * must be based on.
   */
  exactSentenceCoverage: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
  segmentCount: z.number().int().min(0),
  gaps: z.array(alignmentGapSchema),
  createdAt: z.iso.datetime(),
});
export type AlignmentSummary = z.infer<typeof alignmentSummarySchema>;

/**
 * Per-pair switching status, exposed instead of a single boolean overclaim:
 * handoff availability, how much of the book is sentence-exact, and the rest
 * of the summary so clients can present honest expectations.
 */
export const handoffStatusSchema = z.object({
  available: z.boolean(),
  exactSentenceCoverage: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
});
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

/** Minimum confidence for a sentence-exact switch; below it we degrade. */
export const SWITCH_SENTENCE_CONFIDENCE = 0.6;
/** Below this, refuse the switch rather than guess. */
export const SWITCH_MIN_CONFIDENCE = 0.25;
/**
 * Fallback bound: how many sentences away a nearby aligned sentence may be
 * before a switch is refused (anchors returned instead of a silent jump).
 */
export const SWITCH_MAX_SENTENCE_DISTANCE = 8;
/** Audio-side bound: max ms past a segment's end before it is a gap, not a match. */
export const SWITCH_MAX_AUDIO_DRIFT_MS = 30_000;

export const switchResolutionSchema = z.object({
  granularity: z.enum(['sentence', 'paragraph', 'chapter', 'none']),
  confidence: z.number().min(0).max(1),
  /** Provenance of the segment the resolution is based on. */
  source: alignmentSourceSchema.optional(),
  /** True when the resolution is a nearby-but-not-exact mapping. */
  approximate: z.boolean().optional(),
  reason: z.string().optional(),
});
export type SwitchResolution = z.infer<typeof switchResolutionSchema>;
