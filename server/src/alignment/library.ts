import fs from 'node:fs';
import path from 'node:path';
import { type AlignmentSegment } from '@versovox/shared';
import { activeDerivedDir, type AppContext } from '../context.js';
import { loadSentences } from '../epub/extract.js';
import { nowIso } from '../db/index.js';
import { alignmentRoots } from '../domain/settings.js';
import { latestAlignment, storeAlignment } from './service.js';
import {
  ALIGNMENT_FILE_EXT,
  buildAlignmentDocument,
  columnsToSegments,
  listAlignmentFiles,
  pairKey,
  readAlignmentFile,
  timelineFingerprint,
  writeAlignmentFile,
  type PortableAlignment,
} from './portable.js';

/**
 * The alignment folder as a library: saving into it, reading back out of it,
 * and deciding whether a file it holds really describes a book on this server.
 *
 * This is the layer between the file format (portable.ts, which knows nothing
 * about the database) and the jobs and routes that use it.
 */

/** Everything about a pair that a portable file needs, gathered in one query. */
interface PairFacts {
  pairId: string;
  ebookId: string;
  audioId: string;
  ebookTitle: string;
  ebookAuthor: string | null;
  ebookLanguage: string | null;
  ebookSizeBytes: number;
  sentenceIds: string[];
  audioTitle: string;
  audioAuthor: string | null;
  textFingerprint: string | null;
  trackDurationsMs: number[];
  audioDurationMs: number;
  spineCount: number;
}

function pairFacts(ctx: AppContext, pairId: string): PairFacts | null {
  const { db } = ctx;
  const row = db
    .prepare(
      `SELECT p.id AS pair_id, e.id AS ebook_id, a.id AS audio_id,
              e.title AS e_title, e.author AS e_author, e.language AS e_language,
              e.size_bytes AS e_size, e.text_fingerprint AS e_fp, e.meta_json AS e_meta,
              a.title AS a_title, a.author AS a_author, a.duration_ms AS a_duration
         FROM pairs p JOIN books e ON e.id = p.ebook_id JOIN books a ON a.id = p.audio_id
        WHERE p.id = ?`,
    )
    .get(pairId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const tracks = db
    .prepare('SELECT duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx')
    .all(String(row.audio_id)) as { duration_ms: number }[];
  const meta = JSON.parse(String(row.e_meta ?? '{}')) as { spineCount?: number };
  // Straight from the derived index, in reading order: it is the input the
  // text fingerprint is defined over, and reconstructing it from the alignment
  // rows would silently drop every sentence that has no timing.
  const dd = activeDerivedDir(ctx, String(row.ebook_id));
  const sentences = loadSentences(dd);
  if (!sentences) return null;
  return {
    pairId: String(row.pair_id),
    ebookId: String(row.ebook_id),
    audioId: String(row.audio_id),
    ebookTitle: String(row.e_title ?? 'Untitled'),
    ebookAuthor: (row.e_author as string) ?? null,
    ebookLanguage: (row.e_language as string) ?? null,
    ebookSizeBytes: Number(row.e_size ?? 0),
    sentenceIds: sentences.flatMap((chapter) => chapter.map((sent) => sent.id)),
    audioTitle: String(row.a_title ?? 'Untitled'),
    audioAuthor: (row.a_author as string) ?? null,
    textFingerprint: (row.e_fp as string) ?? null,
    trackDurationsMs: tracks.map((t) => Number(t.duration_ms ?? 0)),
    audioDurationMs: Number(row.a_duration ?? 0),
    spineCount: Number(meta.spineCount ?? sentences.length),
  };
}

/** The folder new files are written to: the first one that will take them. */
export function writeTargetDir(ctx: AppContext): { dir: string; problem: string | null } {
  const roots = alignmentRoots(ctx.db, ctx.config);
  for (const dir of roots) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.versovox-write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return { dir, problem: null };
    } catch {
      /* try the next one */
    }
  }
  // Never nowhere: alignments are not lost because a mount is read-only, they
  // are only not portable until the operator fixes it.
  const fallback = path.join(ctx.config.dataDir, 'alignments');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    /* reported below */
  }
  return {
    dir: fallback,
    problem:
      roots.length > 0
        ? `None of the alignment folders can be written to, so alignments are being kept in ${fallback} instead. Mount the folder read-write (no :ro) and make sure the container user owns it.`
        : null,
  };
}

/**
 * Save a finished alignment as a file.
 *
 * Never throws. A backup that could not be written is worth a line in the log
 * and nothing more: the alignment itself succeeded, it is in the database, and
 * failing the job over its copy would throw away the expensive half.
 */
export function saveAlignmentFile(ctx: AppContext, pairId: string): string | null {
  try {
    const facts = pairFacts(ctx, pairId);
    if (!facts || !facts.textFingerprint) return null;
    const handle = latestAlignment(ctx.db, pairId);
    if (!handle) return null;
    const segments = ctx.db
      .prepare('SELECT * FROM alignment_segments WHERE alignment_id = ? ORDER BY ord')
      .all(handle.alignmentId) as Record<string, unknown>[];
    const doc = buildAlignmentDocument({
      ebook: {
        title: facts.ebookTitle,
        author: facts.ebookAuthor ?? '',
        language: facts.ebookLanguage ?? handle.summary.language,
        spineCount: facts.spineCount,
        sizeBytes: facts.ebookSizeBytes,
        sentenceIdsInReadingOrder: facts.sentenceIds,
      },
      audio: {
        title: facts.audioTitle,
        narrator: facts.audioAuthor ?? '',
        trackDurationsMs: facts.trackDurationsMs,
      },
      alignment: {
        version: handle.summary.version,
        createdAt: handle.summary.createdAt,
        language: handle.summary.language,
        model: handle.summary.model,
        coverage: handle.summary.coverage,
        meanConfidence: handle.summary.meanConfidence,
        provenance: {},
        gaps: handle.summary.gaps,
      },
      segments: segments.map(rowToSegment),
      writtenBy: 'versovox',
      writtenAt: nowIso(),
    });
    const { dir, problem } = writeTargetDir(ctx);
    if (problem) ctx.log.warn(problem);
    return writeAlignmentFile(dir, doc);
  } catch (err) {
    ctx.log.warn(`Could not save the alignment file for ${pairId}: ${(err as Error).message}`);
    return null;
  }
}

function rowToSegment(r: Record<string, unknown>): AlignmentSegment {
  return {
    sentenceId: String(r.sentence_id),
    spineIdx: Number(r.spine_idx),
    sentenceOrd: Number(r.sentence_ord),
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    confidence: Number(r.confidence),
    source: String(r.source) as AlignmentSegment['source'],
    uncertaintyMs: Number(r.uncertainty_ms ?? 0),
  };
}

export interface ImportOutcome {
  /** Pairs that gained an alignment they did not have. */
  imported: number;
  /** Files that could not be used, with a sentence saying why. */
  rejected: { file: string; title: string; reason: string }[];
  /** Files whose book is simply not in this library. Normal, not a problem. */
  unmatched: number;
  scanned: number;
}

/**
 * Take every saved alignment that belongs to a pair on this server and has not
 * already been computed here.
 *
 * A row in the database always wins over a file: a redeploy that kept its data
 * imports nothing, which is what makes running this after every scan safe. And
 * a file is either applied whole or not at all — importing the sentences that
 * happen to still exist would leave the reader with a timeline full of silent
 * holes and a coverage figure that lies about them.
 */
export function importAlignments(
  ctx: AppContext,
  onProgress?: (done: number, total: number) => void,
): ImportOutcome {
  const { db } = ctx;
  const out: ImportOutcome = { imported: 0, rejected: [], unmatched: 0, scanned: 0 };
  const files = alignmentRoots(db, ctx.config).flatMap(listAlignmentFiles);
  if (files.length === 0) return out;

  // Index the pairs this server could possibly be offered a file for.
  const pairs = db
    .prepare(
      `SELECT p.id AS pair_id, e.text_fingerprint AS e_fp, p.audio_id AS audio_id
         FROM pairs p JOIN books e ON e.id = p.ebook_id
        WHERE p.status IN ('auto', 'confirmed', 'candidate') AND e.text_fingerprint IS NOT NULL`,
    )
    .all() as { pair_id: string; e_fp: string; audio_id: string }[];
  const byKey = new Map<string, { pairId: string; textFp: string; durations: number[] }>();
  for (const p of pairs) {
    const durations = (
      db
        .prepare('SELECT duration_ms FROM audio_tracks WHERE book_id = ? ORDER BY idx')
        .all(p.audio_id) as { duration_ms: number }[]
    ).map((t) => Number(t.duration_ms ?? 0));
    byKey.set(pairKey(p.e_fp, timelineFingerprint(durations)), {
      pairId: p.pair_id,
      textFp: p.e_fp,
      durations,
    });
  }

  files.forEach((file, i) => {
    out.scanned += 1;
    onProgress?.(i + 1, files.length);
    const read = readAlignmentFile(file);
    if (!read.ok) {
      out.rejected.push({ file, title: path.basename(file), reason: read.reason });
      return;
    }
    const doc = read.doc;
    const local = byKey.get(doc.pairKey);
    if (!local) {
      out.unmatched += 1;
      return;
    }
    if (latestAlignment(db, local.pairId)) return;
    const applied = applyDocument(ctx, local.pairId, doc, file);
    if (applied) out.imported += 1;
    else {
      out.rejected.push({
        file,
        title: doc.ebook.title,
        reason: 'Its timings do not line up with this copy of the ebook — align this pair again.',
      });
    }
  });
  return out;
}

/**
 * Insert a document's timings for a pair, after checking that every one of
 * them names a sentence this install actually has.
 *
 * The pair key already says the text is the same, so this is belt and braces —
 * but it is cheap, and it is the difference between an import that is provably
 * safe and one that is merely plausible.
 */
function applyDocument(
  ctx: AppContext,
  pairId: string,
  doc: PortableAlignment,
  file: string,
): boolean {
  const segments = columnsToSegments(doc.segments);
  // Checked against the ebook's own sentence index, not against a previous
  // alignment: on the fresh install this feature exists for there is no
  // previous alignment to compare with, and the point of the check is to prove
  // that every imported row names a sentence that is really there. The
  // fingerprint already says so; this is what makes it demonstrable rather
  // than merely likely, and it costs one pass over the columns.
  const facts = pairFacts(ctx, pairId);
  if (!facts) return false;
  const known = new Set(facts.sentenceIds);
  if (segments.some((s) => !known.has(s.sentenceId))) return false;

  storeAlignment(
    ctx.db,
    pairId,
    doc.alignment.language,
    doc.alignment.model,
    {
      segments,
      gaps: doc.alignment.gaps,
      coverage: doc.alignment.coverage,
      meanConfidence: doc.alignment.meanConfidence,
    },
    {
      ...doc.alignment.provenance,
      importedFrom: file,
      importedAt: nowIso(),
      importedFormatVersion: doc.formatVersion,
      sentenceCount: doc.ebook.sentenceCount,
    },
  );
  // A pair whose alignment was computed elsewhere is as linked as one computed
  // here; leaving it a suggestion would ask the user to re-decide something
  // they already decided on the machine this file came from.
  ctx.db
    .prepare(
      `UPDATE pairs SET status = 'auto', decided_at = ? WHERE id = ? AND status = 'candidate'`,
    )
    .run(nowIso(), pairId);
  return true;
}

export interface ExportOutcome {
  written: number;
  skipped: number;
  problem: string | null;
}

/**
 * Write out every alignment this server holds that is not already on disk.
 *
 * The one-click answer for an install that has been aligning books since
 * before there was anywhere to put them.
 */
export function exportAlignments(
  ctx: AppContext,
  onProgress?: (done: number, total: number) => void,
): ExportOutcome {
  const { dir, problem } = writeTargetDir(ctx);
  const pairs = ctx.db
    .prepare(`SELECT DISTINCT pair_id FROM alignments WHERE status = 'ready' ORDER BY pair_id`)
    .all() as { pair_id: string }[];
  let written = 0;
  let skipped = 0;
  pairs.forEach((p, i) => {
    onProgress?.(i + 1, pairs.length);
    const facts = pairFacts(ctx, p.pair_id);
    if (!facts?.textFingerprint) {
      skipped += 1;
      return;
    }
    const key = pairKey(facts.textFingerprint, timelineFingerprint(facts.trackDurationsMs));
    if (fileForKey(dir, key)) {
      skipped += 1;
      return;
    }
    if (saveAlignmentFile(ctx, p.pair_id)) written += 1;
    else skipped += 1;
  });
  return { written, skipped, problem };
}

/** The file already saved for a pair key in `dir`, if there is one. */
function fileForKey(dir: string, key: string): string | null {
  const marker = `[${key.slice(0, 12)}]${ALIGNMENT_FILE_EXT}`;
  return listAlignmentFiles(dir).find((f) => f.endsWith(marker)) ?? null;
}

/** What Settings shows about the alignment folder. */
export function alignmentFolderSummary(ctx: AppContext): {
  dirs: string[];
  writeDir: string;
  files: number;
  bytes: number;
  problem: string | null;
} {
  const dirs = alignmentRoots(ctx.db, ctx.config);
  const { dir: writeDir, problem } = writeTargetDir(ctx);
  let files = 0;
  let bytes = 0;
  for (const d of dirs) {
    for (const f of listAlignmentFiles(d)) {
      files += 1;
      try {
        bytes += fs.statSync(f).size;
      } catch {
        /* counted, size unknown */
      }
    }
  }
  return { dirs, writeDir, files, bytes, problem };
}

export { ALIGNMENT_FILE_EXT };
