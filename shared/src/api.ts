import { z } from 'zod';
import { handoffStatusSchema } from './alignment.js';
import { locatorSchema } from './locator.js';

/** DTOs shared between the API and the web client. */

export const bookKindSchema = z.enum(['ebook', 'audio']);
export type BookKind = z.infer<typeof bookKindSchema>;

export const scanStateSchema = z.enum(['discovered', 'indexing', 'ready', 'error', 'missing']);
export type ScanState = z.infer<typeof scanStateSchema>;

export const pairStatusSchema = z.enum(['candidate', 'auto', 'confirmed', 'rejected']);
export type PairStatus = z.infer<typeof pairStatusSchema>;

export const bookSummarySchema = z.object({
  id: z.string(),
  kind: bookKindSchema,
  title: z.string(),
  author: z.string().nullable(),
  series: z.string().nullable(),
  seriesIdx: z.number().nullable(),
  language: z.string().nullable(),
  format: z.string(),
  scanState: scanStateSchema,
  scanError: z.string().nullable(),
  durationMs: z.number().nullable(),
  sizeBytes: z.number(),
  hasCover: z.boolean(),
  addedAt: z.string(),
  pair: z
    .object({
      pairId: z.string(),
      otherBookId: z.string(),
      status: pairStatusSchema,
      /** Handoff is available (does NOT claim sentence exactness — see handoff). */
      switchable: z.boolean(),
      handoff: handoffStatusSchema.nullable(),
    })
    .nullable(),
  progress: z
    .object({
      pct: z.number(),
      locator: locatorSchema,
      updatedAt: z.string(),
      finished: z.boolean(),
    })
    .nullable(),
});
export type BookSummary = z.infer<typeof bookSummarySchema>;

export const chapterInfoSchema = z.object({
  idx: z.number().int(),
  title: z.string(),
  spineIdx: z.number().int().nullable(),
  href: z.string().nullable(),
  startMs: z.number().int().nullable(),
  endMs: z.number().int().nullable(),
});
export type ChapterInfo = z.infer<typeof chapterInfoSchema>;

export const trackInfoSchema = z.object({
  idx: z.number().int(),
  durationMs: z.number().int(),
  startMsAbsolute: z.number().int(),
  sizeBytes: z.number().int(),
  format: z.string(),
  title: z.string().nullable(),
});
export type TrackInfo = z.infer<typeof trackInfoSchema>;

export const annotationKindSchema = z.enum(['bookmark', 'highlight', 'note']);
export type AnnotationKind = z.infer<typeof annotationKindSchema>;

export const annotationSchema = z.object({
  id: z.string(),
  bookId: z.string(),
  kind: annotationKindSchema,
  locator: locatorSchema,
  endLocator: locatorSchema.nullable(),
  color: z.string().nullable(),
  selectedText: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const createAnnotationSchema = z.object({
  kind: annotationKindSchema,
  locator: locatorSchema,
  endLocator: locatorSchema.nullable().optional(),
  color: z
    .string()
    .regex(/^[a-z]{1,20}$/)
    .nullable()
    .optional(),
  selectedText: z.string().max(2000).nullable().optional(),
  note: z.string().max(10000).nullable().optional(),
});

export const pairEvidenceSchema = z.object({
  titleScore: z.number(),
  authorScore: z.number(),
  identifierMatch: z.boolean(),
  languageMatch: z.boolean().nullable(),
  seriesMatch: z.boolean().nullable(),
  durationPagesRatio: z.number().nullable(),
  contentScore: z.number().nullable(),
  notes: z.array(z.string()),
});
export type PairEvidence = z.infer<typeof pairEvidenceSchema>;

export const jobStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type JobState = z.infer<typeof jobStateSchema>;

export const jobSchema = z.object({
  id: z.string(),
  type: z.string(),
  state: jobStateSchema,
  progress: z.number().min(0).max(1),
  detail: z.string().nullable(),
  error: z.string().nullable(),
  attempts: z.number().int(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const setupSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/),
  password: z.string().min(10).max(1024),
  /** One-time bootstrap token proving control of the server (env/secret file/log). */
  setupToken: z.string().min(8).max(512),
});

export const settingsSchema = z.object({
  defaultLanguage: z.string().min(2).max(16),
  transcribeProvider: z.enum(['none', 'fixture', 'whisper-cli']),
  whisperBin: z.string().max(512),
  whisperModel: z.string().max(128),
  jobConcurrency: z.number().int().min(1).max(8),
  autoPairThreshold: z.number().min(0.5).max(1),
  storageBudgetMb: z.number().int().min(0),
  /** Per-language speech model preference (language code → catalog model id). */
  languageModels: z.record(z.string().max(8), z.string().max(64)).default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
