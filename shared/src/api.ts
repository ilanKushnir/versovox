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
  /** What the job is about (pair/book/model), for queue displays. */
  subject: z
    .object({
      title: z.string(),
      sub: z.string().nullable(),
      pairId: z.string().nullable(),
      bookId: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type Job = z.infer<typeof jobSchema>;

/**
 * Roles. `admin` runs the server and its people; `curator` shepherds pairs
 * (confirm / dismiss / re-align, watch the queue); `reader` reads and listens.
 * Every role keeps its own progress, bookmarks and offline copies.
 */
export const roleSchema = z.enum(['admin', 'curator', 'reader']);
export type Role = z.infer<typeof roleSchema>;
export const ROLE_LABELS: Record<Role, { label: string; blurb: string }> = {
  admin: { label: 'Admin', blurb: 'Everything: users, libraries, models, server settings.' },
  curator: {
    label: 'Curator',
    blurb: 'Confirms and dismisses pairs, starts alignments, watches the queue.',
  },
  reader: { label: 'Reader', blurb: 'Reads and listens; own progress, bookmarks and downloads.' },
};

const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, digits, dots, dashes and underscores only');
const passwordSchema = z.string().min(10, 'At least 10 characters').max(1024);
const displayNameSchema = z.string().trim().min(1).max(80);

export const userDtoSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: roleSchema,
  status: z.enum(['active', 'disabled']),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  /** Signs in through the reverse proxy (no local password). */
  proxyManaged: z.boolean(),
  sessions: z.number().int(),
  booksInProgress: z.number().int(),
});
export type UserDto = z.infer<typeof userDtoSchema>;

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: roleSchema.default('reader'),
  displayName: displayNameSchema.optional(),
});
export const updateUserSchema = z.object({
  role: roleSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  displayName: displayNameSchema.nullable().optional(),
  /** Admin-set new password; signs the user out everywhere. */
  password: passwordSchema.optional(),
});
export const createInviteSchema = z.object({
  role: roleSchema.default('reader'),
  displayName: displayNameSchema.optional(),
  /** Suggested username, editable by the invitee. */
  username: usernameSchema.optional(),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});
export const inviteDtoSchema = z.object({
  id: z.string(),
  role: roleSchema,
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  usedAt: z.string().nullable(),
});
export type InviteDto = z.infer<typeof inviteDtoSchema>;
export const acceptInviteSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: passwordSchema,
});

export const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

const dirListSchema = z.array(z.string().trim().min(1).max(1024)).max(16);

export const setupSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: displayNameSchema.optional(),
  /** One-time bootstrap token proving control of the server (env/secret file/log). */
  setupToken: z.string().min(8).max(512),
  /** Library roots chosen in the wizard (ignored when pinned by env). */
  ebookDirs: dirListSchema.optional(),
  audiobookDirs: dirListSchema.optional(),
  defaultLanguage: z.string().min(2).max(16).optional(),
  /** Folder where alignments are saved as files, chosen in the wizard. */
  alignmentDirs: dirListSchema.optional(),
  /** Align new matches without being asked; see settingsSchema. */
  autoAlign: z.boolean().optional(),
});
export const alignManySchema = z.object({
  pairIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

/**
 * What a folder is for. Not `bookKindSchema`: that one also types `books.kind`,
 * and an alignment folder holds no books.
 */
export const folderKindSchema = z.enum(['ebook', 'audio', 'alignment']);
export type FolderKind = z.infer<typeof folderKindSchema>;

export const testPathsSchema = z.object({
  paths: dirListSchema,
  /** What the folder is expected to hold; drives the file-count hint. */
  kind: folderKindSchema.optional(),
});
export const pathCheckSchema = z.object({
  path: z.string(),
  ok: z.boolean(),
  exists: z.boolean(),
  isDirectory: z.boolean(),
  readable: z.boolean(),
  /**
   * Whether the server can create a file here. Only asked of an alignment
   * folder, and asked by writing rather than by permission bits — a bind mount
   * can report the bits and still refuse.
   */
  writable: z.boolean().nullable().default(null),
  /** Matching files found in a shallow, capped walk (null when unreadable). */
  matches: z.number().int().nullable(),
  sampled: z.boolean(),
  problem: z.string().nullable(),
});
export type PathCheck = z.infer<typeof pathCheckSchema>;

export const settingsSchema = z.object({
  /** Used when a book's own metadata does not say what language it is in. */
  defaultLanguage: z.string().min(2).max(16),
  /** How many books may be aligned at the same time. */
  jobConcurrency: z.number().int().min(1).max(8),
  /** Folders scanned for books. Read-only; pinned by VX_EBOOK_DIRS / VX_AUDIOBOOK_DIRS. */
  ebookDirs: dirListSchema.default([]),
  audiobookDirs: dirListSchema.default([]),
  /**
   * Where finished alignments are saved as files, so they outlive the
   * container. The only folders this app writes to. Empty means the app's own
   * data directory, which a rebuild can take with it.
   */
  alignmentDirs: dirListSchema.default([]),
  /**
   * How much of the narration is listened to.
   *  - `standard` samples it and interpolates between the matches: minutes per
   *    book, and switching lands on the right paragraph.
   *  - `exact` listens to every second for sentence-perfect timings, at
   *    roughly fifteen times the cost.
   */
  alignPrecision: z.enum(['standard', 'exact']).default('standard'),
  /** Align a book as soon as its two halves are matched, without being asked. */
  autoAlign: z.boolean().default(true),
  /**
   * Measured throughput: seconds of audio aligned per second of wall clock.
   * Written by the worker from real runs, never guessed; 0 = not yet known.
   */
  alignSpeedRatio: z.number().min(0).max(500).default(0),
});
export type Settings = z.infer<typeof settingsSchema>;
