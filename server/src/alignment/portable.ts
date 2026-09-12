import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { alignmentGapSchema, alignmentSourceSchema, type AlignmentSegment } from '@versovox/shared';
import { z } from 'zod';

/**
 * Portable alignment files: the on-disk, install-independent form of an
 * alignment.
 *
 * Alignments live in SQLite inside the container, which means a from-scratch
 * redeploy throws away hours of CPU the user already paid for. This module is
 * the answer: one self-contained file per aligned pair, written into a folder
 * mounted from the user's own library, next to the books it describes. A fresh
 * install reads the folder back and is immediately as capable as the install
 * that was wiped.
 *
 * Two decisions shape everything below.
 *
 * The file is a gzip-compressed JSON document with COLUMNAR segments — eight
 * parallel arrays rather than an array of objects. On a real 16,000-segment
 * book that is 950 KiB raw / 309 KiB gzipped, against 2450 KiB / 433 KiB for
 * objects: the repeated key names dominate both the raw size and, because gzip
 * is matching them over a 32 KiB window, a good part of the compressed size
 * too. It is deliberately NOT delta-encoded. Delta-encoding the timestamps
 * saves a further 82 KiB, and costs the one property that makes a portable
 * format worth having: a self-hoster can gunzip the file and read it.
 *
 * Matching a file back to a library is by FINGERPRINT, never by path, id or
 * filename — none of those survive a reinstall. The two fingerprints and the
 * pair key derived from them are the whole identity story, and each one carries
 * its algorithm as a prefix so the algorithm can be replaced later without a
 * format bump: an old reader meeting `t2:` knows only that it cannot compare
 * it, which is what stops it from confidently mis-matching a book.
 */

export const ALIGNMENT_FILE_EXT = '.vxalign';

/** The `format` tag every file carries, so a stray .vxalign is caught early. */
export const ALIGNMENT_FORMAT = 'versovox-alignment';

/**
 * Bumped only for a change a reader of the previous version cannot cope with.
 * Adding an optional field is not such a change: unknown keys are dropped on
 * read, so a 1.x writer may keep adding to the document.
 */
export const ALIGNMENT_FORMAT_VERSION = 1;

/** Algorithm tags. A file whose fingerprints use others is unmatchable here. */
export const TEXT_FINGERPRINT_PREFIX = 't1:';
export const TIMELINE_FINGERPRINT_PREFIX = 'a1:';

/** How much of the pair key goes in the filename: enough to be unique in a library. */
const KEY_IN_FILENAME = 12;

/** Per-slug cap. Two of these plus the key stay well inside a 255-byte name. */
const SLUG_MAX = 60;

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Identity of the ebook's text, from its sentence ids in reading order.
 *
 * Sentence ids are content-derived (see util/text.ts `segmentSentences`), so
 * the same EPUB segmented on another machine, by another install, yields the
 * same ids and the same fingerprint. That is the only reason imported segment
 * rows are meaningful at all: a segment says "sentence s3f9a starts at
 * 1:02:11", and it is worth nothing unless the importing install agrees about
 * which sentence s3f9a is. The count is folded in so that a truncated id list
 * cannot collide with the full one.
 */
export function textFingerprint(sentenceIdsInReadingOrder: string[]): string {
  const ids = sentenceIdsInReadingOrder;
  return TEXT_FINGERPRINT_PREFIX + sha256(`${ids.length}\n${ids.join('\n')}`).slice(0, 32);
}

/**
 * Identity of the audiobook's timeline, from its per-track durations.
 *
 * Duration-based and not byte-based on purpose. Retagging an audiobook —
 * fixing the narrator, embedding cover art, renaming chapters — rewrites every
 * file and must not cost the user their alignment, because none of it moves a
 * single word of narration. Durations do not change under retagging. Rounding
 * to 100 ms absorbs the last-frame disagreements between ffprobe versions and
 * container remuxes, which are a few milliseconds at most and would otherwise
 * invalidate an alignment on a server upgrade.
 */
export function timelineFingerprint(trackDurationsMs: number[]): string {
  const deciseconds = trackDurationsMs.map((ms) => Math.round(ms / 100));
  return (
    TIMELINE_FINGERPRINT_PREFIX +
    sha256(`${trackDurationsMs.length}|${deciseconds.join(',')}`).slice(0, 32)
  );
}

/** The identity of the pair itself: this text read as this timeline. */
export function pairKey(textFp: string, timelineFp: string): string {
  return sha256(`${textFp}|${timelineFp}`).slice(0, 24);
}

export const alignmentColumnsSchema = z.object({
  sentenceIds: z.array(z.string()),
  spineIdx: z.array(z.number().int().min(0)),
  sentenceOrd: z.array(z.number().int().min(0)),
  startMs: z.array(z.number().int().min(0)),
  endMs: z.array(z.number().int().min(0)),
  confidence: z.array(z.number().min(0).max(1)),
  source: z.array(alignmentSourceSchema),
  uncertaintyMs: z.array(z.number().int().min(0)),
});
export type AlignmentColumns = z.infer<typeof alignmentColumnsSchema>;

const COLUMN_NAMES = [
  'sentenceIds',
  'spineIdx',
  'sentenceOrd',
  'startMs',
  'endMs',
  'confidence',
  'source',
  'uncertaintyMs',
] as const satisfies readonly (keyof AlignmentColumns)[];

/**
 * Enough of the ebook to recognise it, describe it in an import list, and say
 * out loud why it did not match. The counts and size are not part of identity —
 * only `textFingerprint` is — but they are what lets the import UI tell a user
 * "this file is for a 412-sentence book and yours has 1,208" instead of a bare
 * "no match".
 */
export const portableEbookSchema = z.object({
  title: z.string(),
  author: z.string(),
  language: z.string(),
  sentenceCount: z.number().int().min(0),
  spineCount: z.number().int().min(0),
  sizeBytes: z.number().int().min(0),
  textFingerprint: z.string(),
});

export const portableAudioSchema = z.object({
  title: z.string(),
  narrator: z.string(),
  trackCount: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  /** Kept in full, not just their hash, so a near-miss can be diagnosed. */
  trackDurationsMs: z.array(z.number().int().min(0)),
  timelineFingerprint: z.string(),
});

export const portableAlignmentMetaSchema = z.object({
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  language: z.string(),
  model: z.string(),
  coverage: z.number().min(0).max(1),
  meanConfidence: z.number().min(0).max(1),
  /**
   * Whatever the engine recorded about the run. Deliberately unconstrained:
   * provenance is for a human reading the file to understand where these
   * numbers came from, and pinning a shape here would mean older readers
   * rejecting files a newer engine annotated more richly.
   */
  provenance: z.record(z.string(), z.unknown()),
  gaps: z.array(alignmentGapSchema),
});

/**
 * The document as written. Column lengths are NOT checked here on purpose:
 * `readAlignmentFile` checks them itself so it can name the offending column
 * in a sentence the user can act on, rather than surfacing a schema path.
 */
export const portableAlignmentSchema = z.object({
  format: z.literal(ALIGNMENT_FORMAT),
  formatVersion: z.number().int().min(1),
  writtenAt: z.iso.datetime(),
  /** Which build produced this, e.g. "versovox 0.8.1". For support, not logic. */
  writtenBy: z.string(),
  ebook: portableEbookSchema,
  audio: portableAudioSchema,
  alignment: portableAlignmentMetaSchema,
  pairKey: z.string(),
  segmentCount: z.number().int().min(0),
  segments: alignmentColumnsSchema,
});
export type PortableAlignment = z.infer<typeof portableAlignmentSchema>;

export function segmentsToColumns(segments: AlignmentSegment[]): AlignmentColumns {
  const columns: AlignmentColumns = {
    sentenceIds: [],
    spineIdx: [],
    sentenceOrd: [],
    startMs: [],
    endMs: [],
    confidence: [],
    source: [],
    uncertaintyMs: [],
  };
  for (const s of segments) {
    columns.sentenceIds.push(s.sentenceId);
    columns.spineIdx.push(s.spineIdx);
    columns.sentenceOrd.push(s.sentenceOrd);
    columns.startMs.push(s.startMs);
    columns.endMs.push(s.endMs);
    columns.confidence.push(s.confidence);
    columns.source.push(s.source);
    columns.uncertaintyMs.push(s.uncertaintyMs ?? 0);
  }
  return columns;
}

/**
 * The inverse. The fallbacks are unreachable for any file that came through
 * `readAlignmentFile`, which refuses ragged columns before anything is
 * converted; they exist so a hand-built column set degrades to the most modest
 * claim available (`interpolated` is the source the reader never presents as
 * exact) instead of throwing deep inside an import.
 */
export function columnsToSegments(columns: AlignmentColumns): AlignmentSegment[] {
  return columns.sentenceIds.map((sentenceId, i) => ({
    sentenceId,
    spineIdx: columns.spineIdx[i] ?? 0,
    sentenceOrd: columns.sentenceOrd[i] ?? i,
    startMs: columns.startMs[i] ?? 0,
    endMs: columns.endMs[i] ?? 0,
    confidence: columns.confidence[i] ?? 0,
    source: columns.source[i] ?? 'interpolated',
    uncertaintyMs: columns.uncertaintyMs[i] ?? 0,
  }));
}

/**
 * The ebook half of a document.
 *
 * Either hand over the sentence ids and let the fingerprint be taken here, or
 * hand over a fingerprint that was computed earlier. Both exist because both
 * callers are real: an export straight off an aligner run has the ids in
 * memory, while an export out of the database has only the fingerprint column,
 * which is stored precisely so the ids never have to be re-derived.
 */
export type PortableEbookInput = {
  title: string;
  author: string;
  language: string;
  spineCount: number;
  sizeBytes: number;
} & (
  | {
      /** Every sentence of the book, in reading order. */
      sentenceIdsInReadingOrder: string[];
      sentenceCount?: number;
      textFingerprint?: never;
    }
  | {
      textFingerprint: string;
      sentenceCount: number;
      sentenceIdsInReadingOrder?: never;
    }
);

export interface PortableAudioInput {
  title: string;
  narrator: string;
  /** In play order. Everything else about the timeline derives from it. */
  trackDurationsMs: number[];
  /** Overrides, for a caller whose database already holds the answer. */
  trackCount?: number;
  durationMs?: number;
  timelineFingerprint?: string;
}

export interface AlignmentDocumentInput {
  /** Build identifier for the file's own record, e.g. "versovox 0.8.1". */
  writtenBy: string;
  /** Defaults to now; injectable so a re-export can be byte-identical in tests. */
  writtenAt?: string;
  ebook: PortableEbookInput;
  audio: PortableAudioInput;
  alignment: Omit<z.infer<typeof portableAlignmentMetaSchema>, 'gaps'> & {
    gaps: z.infer<typeof alignmentGapSchema>[];
  };
  segments: AlignmentSegment[];
}

/**
 * Assemble a document, deriving whatever the caller did not supply.
 *
 * Counts, durations and the pair key are computed here rather than asked for,
 * because a file whose declared sentence count disagrees with the text its
 * fingerprint was taken over is a file that fails to match for reasons nobody
 * can debug. The fingerprints themselves may be handed in — the database keeps
 * them — but they are never invented by the caller.
 */
export function buildAlignmentDocument(input: AlignmentDocumentInput): PortableAlignment {
  const ids = input.ebook.sentenceIdsInReadingOrder;
  const textFp = ids ? textFingerprint(ids) : (input.ebook.textFingerprint ?? '');
  const timelineFp =
    input.audio.timelineFingerprint ?? timelineFingerprint(input.audio.trackDurationsMs);
  return {
    format: ALIGNMENT_FORMAT,
    formatVersion: ALIGNMENT_FORMAT_VERSION,
    writtenAt: input.writtenAt ?? new Date().toISOString(),
    writtenBy: input.writtenBy,
    ebook: {
      title: input.ebook.title,
      author: input.ebook.author,
      language: input.ebook.language,
      sentenceCount: ids?.length ?? input.ebook.sentenceCount ?? 0,
      spineCount: input.ebook.spineCount,
      sizeBytes: input.ebook.sizeBytes,
      textFingerprint: textFp,
    },
    audio: {
      title: input.audio.title,
      narrator: input.audio.narrator,
      trackCount: input.audio.trackCount ?? input.audio.trackDurationsMs.length,
      durationMs: input.audio.durationMs ?? input.audio.trackDurationsMs.reduce((a, b) => a + b, 0),
      trackDurationsMs: [...input.audio.trackDurationsMs],
      timelineFingerprint: timelineFp,
    },
    alignment: { ...input.alignment, gaps: [...input.alignment.gaps] },
    pairKey: pairKey(textFp, timelineFp),
    segmentCount: input.segments.length,
    segments: segmentsToColumns(input.segments),
  };
}

/**
 * Fold a title or author down to something every filesystem accepts.
 *
 * ASCII-only, because these files are meant to be copied between a NAS, a
 * Windows box and a phone's SMB mount, and non-ASCII names survive that trip
 * unreliably (NFC/NFD disagreements alone will hand you two files that look
 * identical). The cost is that a book with no Latin characters at all slugs to
 * nothing, which is why the fallback exists — the pair key in the filename is
 * the real identifier, and the slug is a courtesy to whoever is looking at the
 * folder.
 */
function slug(raw: string, fallback: string): string {
  const ascii = raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const capped = ascii.slice(0, SLUG_MAX).trim();
  return capped || fallback;
}

/**
 * `<author> - <title> [<key>].vxalign`.
 *
 * The bracketed key is what `writeAlignmentFile` matches on when it cleans up
 * after a retitled book, so its shape is load-bearing, not decorative. The
 * name always ends in the key and the extension, which also means it can never
 * come out as a Windows reserved device name.
 */
export function alignmentFileName(meta: {
  author: string;
  title: string;
  pairKey: string;
}): string {
  const author = slug(meta.author, 'Unknown Author');
  const title = slug(meta.title, 'Untitled');
  return `${author} - ${title} [${meta.pairKey.slice(0, KEY_IN_FILENAME)}]${ALIGNMENT_FILE_EXT}`;
}

/** The tail every file for one pair ends with, whatever the book is called. */
function keySuffix(key: string): string {
  return `[${key.slice(0, KEY_IN_FILENAME)}]${ALIGNMENT_FILE_EXT}`;
}

/**
 * The alignment files in `dir`, sorted, never throwing.
 *
 * A missing or unreadable directory is not an error worth propagating: this is
 * called on a user-configured mount point that may be unmounted, empty or
 * simply not created yet, and every one of those cases means the same thing to
 * the caller — no alignments to import. Dotfiles are skipped so a half-written
 * temporary file, or a Synology/macOS sidecar, is never offered as an import.
 */
export function listAlignmentFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (e) =>
        !e.name.startsWith('.') &&
        e.name.toLowerCase().endsWith(ALIGNMENT_FILE_EXT) &&
        (e.isFile() || e.isSymbolicLink()),
    )
    .map((e) => path.join(dir, e.name))
    .sort();
}

/**
 * The file in `dir` holding this pair's alignment, if there is one.
 *
 * By pair key, not by name: the point of putting the key in the filename is
 * that a book renamed in the library is still findable. This is what lets a
 * bulk export skip the pairs it has already written, so running it twice is
 * cheap instead of rewriting a folder full of files.
 */
export function findAlignmentFile(dir: string, key: string): string | null {
  const suffix = keySuffix(key);
  for (const file of listAlignmentFiles(dir)) {
    if (path.basename(file).endsWith(suffix)) return file;
  }
  return null;
}

/**
 * Write `doc` into `dir`, returning the path written.
 *
 * The mount this lands on is the user's library, watched by their sync client
 * and their backup job, so a partially written file is not a private problem —
 * it gets replicated. Hence the temporary-then-rename dance, with the
 * temporary in the SAME directory so the rename is a same-filesystem atomic
 * one, and an fsync before it so a container killed mid-write cannot leave a
 * renamed-but-empty file behind.
 *
 * The duplicate sweep runs after the temporary is safely on disk and before
 * the rename: a book retitled in the library gets a new filename for the same
 * pair key, and without the sweep the folder would accumulate one file per
 * title the book ever had, all of them importable and all but one stale.
 * Doing it in that order means there is never an instant when the pair has no
 * file at all.
 */
export function writeAlignmentFile(dir: string, doc: PortableAlignment): string {
  fs.mkdirSync(dir, { recursive: true });
  const key12 = doc.pairKey.slice(0, KEY_IN_FILENAME);
  const target = path.join(
    dir,
    alignmentFileName({ author: doc.ebook.author, title: doc.ebook.title, pairKey: doc.pairKey }),
  );
  // The pid keeps two workers exporting the same pair from clobbering each
  // other's temporary; the leading dot keeps it out of listAlignmentFiles.
  const tmp = path.join(dir, `.${key12}.${process.pid}.tmp`);
  const bytes = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 });
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const stale = keySuffix(doc.pairKey);
    for (const file of listAlignmentFiles(dir)) {
      if (file !== target && path.basename(file).endsWith(stale)) fs.rmSync(file, { force: true });
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return target;
}

/**
 * Either the document, or a sentence explaining why not.
 *
 * A rejection is data, not an exception. These files come off a folder the
 * user controls: truncated by a sync client, edited in a text editor, written
 * by a Versovox two releases newer than this one. Importing a folder must
 * report each bad file and carry on with the rest, and the person reading that
 * report is a self-hoster looking at a log line, not a developer with a stack
 * trace.
 */
export type ReadAlignmentResult =
  { ok: true; doc: PortableAlignment } | { ok: false; reason: string };

function reject(reason: string): ReadAlignmentResult {
  return { ok: false, reason };
}

/** Decode an already-loaded file. Split out so an upload can reuse the checks. */
export function decodeAlignmentFile(bytes: Buffer | Uint8Array): ReadAlignmentResult {
  let json: string;
  try {
    json = gunzipSync(bytes).toString('utf8');
  } catch {
    return reject(
      'This file is not readable as gzip, so it is either truncated or not an alignment file at all. Export the alignment again to replace it.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return reject(
      'This file unpacked but does not contain valid JSON, so it was damaged after it was written. Export the alignment again to replace it.',
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject('This file does not contain a Versovox alignment document.');
  }
  const envelope = raw as Record<string, unknown>;

  // The format tag and version are read before the schema so that a file from
  // the future is told apart from a file that is merely broken. They are the
  // two questions whose answers change what the user should do about it.
  if (typeof envelope.format !== 'string') {
    return reject('This file has no Versovox format tag, so it is not an alignment file.');
  }
  if (envelope.format !== ALIGNMENT_FORMAT) {
    return reject(
      `This file says it is "${envelope.format}", which is not a Versovox alignment file.`,
    );
  }
  const version = envelope.formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return reject(
      'This alignment file does not say which format version it uses, so it cannot be read safely.',
    );
  }
  if (version > ALIGNMENT_FORMAT_VERSION) {
    return reject(
      `This alignment file was written by a newer version of Versovox (alignment format ${version}, this server understands ${ALIGNMENT_FORMAT_VERSION}) — upgrade this server to read it.`,
    );
  }

  const parsed = portableAlignmentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'the document itself';
    // Zod says "received undefined" for an absent field, which reads to a
    // self-hoster like a bug in Versovox rather than a hole in their file.
    const detail = (issue?.message ?? 'the value is not what this format allows').replace(
      /received undefined/i,
      'found nothing',
    );
    return reject(
      `This alignment file is not shaped the way Versovox expects: at "${where}", ${detail}. Export the alignment again to replace it.`,
    );
  }
  const doc = parsed.data;

  // A fingerprint from a scheme this build does not implement cannot be
  // compared, and comparing it as an opaque string would silently mis-match a
  // book. Refusing the file is the honest answer.
  if (!doc.ebook.textFingerprint.startsWith(TEXT_FINGERPRINT_PREFIX)) {
    return reject(
      `This alignment file identifies its ebook with a fingerprint scheme this server does not know ("${doc.ebook.textFingerprint.split(':')[0]}"), so it cannot be matched to a book — upgrade this server to use it.`,
    );
  }
  if (!doc.audio.timelineFingerprint.startsWith(TIMELINE_FINGERPRINT_PREFIX)) {
    return reject(
      `This alignment file identifies its audiobook with a fingerprint scheme this server does not know ("${doc.audio.timelineFingerprint.split(':')[0]}"), so it cannot be matched to an audiobook — upgrade this server to use it.`,
    );
  }

  // Columnar segments are only coherent if every column agrees on its length.
  // One short column would otherwise import as a whole book of segments quietly
  // shifted by one sentence, which is far worse than importing nothing.
  for (const name of COLUMN_NAMES) {
    const length = doc.segments[name].length;
    if (length !== doc.segmentCount) {
      return reject(
        `This alignment file is damaged: it says it holds ${doc.segmentCount} segments but its "${name}" column holds ${length}. Export the alignment again to replace it.`,
      );
    }
  }

  return { ok: true, doc };
}

/** Read one alignment file. Never throws, whatever is at `file`. */
export function readAlignmentFile(file: string): ReadAlignmentResult {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return reject(
      `This alignment file could not be read from disk (${code ?? 'unknown error'}). Check that it still exists and that Versovox has permission to read the folder it is in.`,
    );
  }
  return decodeAlignmentFile(bytes);
}
