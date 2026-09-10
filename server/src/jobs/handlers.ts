import fs from 'node:fs';
import path from 'node:path';
import {
  type AppContext,
  activeDerivedDir,
  coversDir,
  derivedRoot,
  derivedVersionDir,
  transcriptsDir,
} from '../context.js';
import { nowIso } from '../db/index.js';
import { newId, sha256hex, stableId } from '../util/ids.js';
import { realResolveWithin } from '../util/paths.js';
import { applyScan, scanRoots } from '../scanner/scan.js';
import { extractEpub, loadManifest, loadSentences, loadSentencesText } from '../epub/extract.js';
import { extractCover, probeAudio } from '../audio/probe.js';
import { CANDIDATE_THRESHOLD, scorePair } from '../pairing/score.js';
import { alignBook, type EbookSentenceInput, type TranscriptWord } from '../alignment/align.js';
import { storeAlignment } from '../alignment/service.js';
import { detectLanguage, getProvider, transcribeClip } from '../transcription/providers.js';
import {
  anyMultilingualModel,
  DEFAULT_MODEL_ID,
  isInstalled,
  languageByCode,
  modelById,
  modelPath,
  ModelMissingError,
  MODELS,
  resolveModelForLanguage,
} from '../transcription/models.js';
import { languageCode } from '../pairing/score.js';
import { libraryRoots, resolveSettings } from '../domain/settings.js';
import {
  enqueueJob,
  jobCheckpoint,
  jobProgress,
  LeaseLostError,
  retryJob,
  type JobRow,
  type LeaseGuard,
} from './queue.js';

/**
 * Job handler registry. Each handler receives the attempt's LeaseGuard and
 * calls `guard.assertHeld()` immediately before every filesystem/database
 * side effect — so an attempt whose lease expired (blocked heartbeat, long
 * synchronous work, reclaim by another worker) aborts with LeaseLostError
 * instead of clobbering the new owner's run.
 */

export type JobHandler = (ctx: AppContext, job: JobRow, guard: LeaseGuard) => Promise<void>;

export const JOB_HANDLERS: Record<string, JobHandler> = {
  scan: runScan,
  'index-ebook': runIndexEbook,
  'index-audio': runIndexAudio,
  'pair-scan': runPairScan,
  align: runAlign,
  'model-download': runModelDownload,
};

/**
 * Stream a catalog speech model into VX_MODELS_DIR. Writes to `<file>.part`
 * with progress updates and renames only once the whole file arrived and
 * matches the published size, so a half-download is never mistaken for a
 * model. Resumable across attempts via HTTP Range.
 */
export async function runModelDownload(
  ctx: AppContext,
  job: JobRow,
  guard: LeaseGuard,
): Promise<void> {
  const { db, config } = ctx;
  const { modelId } = JSON.parse(job.payload_json) as { modelId: string };
  const spec = modelById(modelId);
  if (!spec) throw new Error(`Unknown model: ${modelId}`);
  fs.mkdirSync(config.modelsDir, { recursive: true });
  const dest = modelPath(config.modelsDir, spec);
  const part = `${dest}.part`;
  let have = 0;
  try {
    have = fs.statSync(part).size;
  } catch {
    have = 0;
  }
  const controller = new AbortController();
  const res = await fetch(spec.url, {
    headers: have > 0 ? { range: `bytes=${have}-` } : {},
    redirect: 'follow',
    signal: controller.signal,
  });
  if (res.status === 416) {
    have = 0; // server refused the range: start over
    fs.rmSync(part, { force: true });
    return runModelDownload(ctx, job, guard);
  }
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} from ${spec.url}`);
  const resumed = res.status === 206;
  if (!resumed) have = 0;
  const total = (resumed ? have : 0) + Number(res.headers.get('content-length') ?? spec.sizeBytes);
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  let received = have;
  let lastReport = 0;
  const fmt = (n: number) => `${(n / 1_073_741_824).toFixed(2)} GB`;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (guard.isLost()) {
        controller.abort();
        throw new LeaseLostError(job.id);
      }
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      received += chunk.byteLength;
      const now = Date.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        // Removing the model from the UI deletes the .part file: stop streaming.
        if (!fs.existsSync(part)) {
          controller.abort();
          throw new Error('Download cancelled (model removed)');
        }
        jobProgress(
          db,
          job.id,
          job.lease_token,
          Math.min(0.99, received / total),
          `${spec.label}: ${fmt(received)} of ${fmt(total)}`,
        );
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  const size = fs.statSync(part).size;
  if (size < spec.sizeBytes * 0.9) {
    throw new Error(
      `Download incomplete (${fmt(size)} of ${fmt(spec.sizeBytes)}); retry to resume`,
    );
  }
  guard.assertHeld();
  fs.renameSync(part, dest);
  jobProgress(db, job.id, job.lease_token, 1, `${spec.label}: installed (${fmt(size)})`);
  requeueAlignmentsWaitingFor(ctx, [spec.id]);
}

/**
 * Alignments that failed only because a speech model was missing go again
 * once that model is installed — whether it arrived through the in-app
 * download, the CLI, or a file dropped into the models volume.
 */
export function requeueAlignmentsWaitingFor(ctx: AppContext, modelIds?: string[]): number {
  const { db, config } = ctx;
  const ids = modelIds ?? MODELS.filter((m) => isInstalled(config.modelsDir, m)).map((m) => m.id);
  let n = 0;
  for (const id of ids) {
    const waiting = db
      .prepare(`SELECT id FROM jobs WHERE type = 'align' AND state = 'failed' AND error LIKE ?`)
      .all(`model-missing:%:${id}|%`) as { id: string }[];
    for (const w of waiting) if (retryJob(db, w.id)) n += 1;
  }
  if (n) ctx.log.info(`Re-queued ${n} alignment(s) whose speech model is now installed`);
  return n;
}

/**
 * First-start convenience: fetch ONLY the multilingual default model when
 * transcription is on and nothing is installed yet. Every other language is
 * a deliberate click in Settings → Speech models.
 */
export function ensureDefaultModel(ctx: AppContext): void {
  const { db, config } = ctx;
  const { values } = resolveSettings(db, config);
  if (values.transcribeProvider !== 'whisper-cli' || !values.autoDownloadDefaultModel) return;
  if (MODELS.some((m) => m.languages === '*' && isInstalled(config.modelsDir, m))) return;
  const id = enqueueJob(
    db,
    'model-download',
    { modelId: DEFAULT_MODEL_ID },
    { dedupeKey: `model:${DEFAULT_MODEL_ID}` },
  );
  if (id) ctx.log.info(`No speech model installed — fetching the default (${DEFAULT_MODEL_ID})`);
}

export async function runScan(ctx: AppContext, job: JobRow, guard: LeaseGuard): Promise<void> {
  const { db, config } = ctx;
  jobProgress(db, job.id, job.lease_token, 0.05, 'Scanning library roots');
  const roots = libraryRoots(db, config);
  const report = scanRoots(roots.ebookDirs, roots.audiobookDirs);
  guard.assertHeld();
  const result = applyScan(db, report);
  jobProgress(
    db,
    job.id,
    job.lease_token,
    0.7,
    `Found ${result.discovered} items (${report.unsupported.length} unsupported formats)`,
  );
  for (const item of result.needsIndex) {
    enqueueJob(
      db,
      item.kind === 'ebook' ? 'index-ebook' : 'index-audio',
      { bookId: item.bookId },
      {
        dedupeKey: `index:${item.bookId}`,
      },
    );
  }
  // Pair scan runs after indexing; it is cheap and idempotent, so enqueue at
  // lower priority — it will see whatever is ready by the time it runs.
  enqueueJob(db, 'pair-scan', {}, { dedupeKey: 'pair-scan', priority: -1 });
  if (report.errors.length) {
    jobProgress(
      db,
      job.id,
      job.lease_token,
      1,
      `Completed with warnings: ${report.errors.join('; ')}`.slice(0, 500),
    );
  }
}

const MAX_FALLBACK_COVER_BYTES = 20 * 1024 * 1024;

function looksLikeJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function looksLikePng(buf: Buffer): boolean {
  return (
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a
  );
}

/**
 * Fallback folder-cover discovery, hardened: every candidate resolves through
 * realResolveWithin (so a symlink cannot point outside the library root), is
 * opened with O_NOFOLLOW, must be a regular file of sane size, and must carry
 * a real JPEG/PNG signature before its bytes are copied into the cache.
 */
export function copyFallbackCover(
  ctx: AppContext,
  rootDir: string,
  relDir: string,
  bookId: string,
): string | null {
  for (const name of ['cover.jpg', 'cover.png', 'folder.jpg', 'folder.png']) {
    const relCandidate = relDir === '.' ? name : path.join(relDir, name);
    let real: string;
    try {
      real = realResolveWithin(rootDir, relCandidate);
    } catch {
      continue; // missing, or a symlink escaping the library root
    }
    let fd: number;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size === 0 || st.size > MAX_FALLBACK_COVER_BYTES) continue;
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      if (off !== st.size) continue;
      const ext = name.endsWith('.png') ? '.png' : '.jpg';
      if (ext === '.jpg' && !looksLikeJpeg(buf)) continue;
      if (ext === '.png' && !looksLikePng(buf)) continue;
      fs.mkdirSync(coversDir(ctx), { recursive: true });
      const out = path.join(coversDir(ctx), `${bookId}${ext}`);
      fs.writeFileSync(out, buf);
      return out;
    } catch {
      continue;
    } finally {
      fs.closeSync(fd);
    }
  }
  return null;
}

function getBook(ctx: AppContext, bookId: string): Record<string, unknown> {
  const row = ctx.db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error(`Book not found: ${bookId}`);
  return row;
}

/**
 * Guarded failure-state write: an attempt that lost its lease must not even
 * write the error state — the job's new owner manages the book row now.
 */
function markBookError(ctx: AppContext, guard: LeaseGuard, bookId: string, err: unknown): void {
  if (err instanceof LeaseLostError || guard.isLost()) return;
  try {
    guard.assertHeld();
    ctx.db
      .prepare("UPDATE books SET scan_state = 'error', scan_error = ? WHERE id = ?")
      .run(String((err as Error).message).slice(0, 500), bookId);
  } catch {
    /* lease lost while reporting: stay silent, the owner will overwrite */
  }
}

/**
 * Derived revision for ONE lease attempt. The job id alone is not unique
 * enough: a reclaimed job keeps its id while receiving a fresh lease token,
 * and two overlapping attempts (one stale, one owning) must never share —
 * let alone delete — each other's extraction directory. The token slice
 * makes every attempt's directory its own; only the attempt that still
 * holds the lease at commit time gets to point `books.derived_rev` at its
 * directory, so losers merely leave an orphan for the deferred sweep.
 */
export function derivedRevForAttempt(job: Pick<JobRow, 'id' | 'lease_token'>): string {
  return `v-${job.id}-${job.lease_token.slice(0, 8)}`;
}

/**
 * Grace period before a RETIRED derived version is deleted. The pointer
 * switch is atomic in the database, but route handlers resolve
 * `books.derived_rev` to a path first and open files second — a request
 * that resolved the old revision just before the switch may open its files
 * shortly after. Retired versions therefore stay on disk for a conservative
 * grace period (far longer than any request lifetime) before deletion.
 */
export const DERIVED_GC_GRACE_MS = 5 * 60_000;

/** Sidecar recording when each non-active entry was first seen retired. */
const GC_REGISTRY_FILE = '.vx-gc.json';

/**
 * Deferred, reference-safe garbage collection of derived versions. Runs
 * only AFTER a pointer switch committed. Entries other than the active
 * revision (old versions, legacy unversioned files, leftover unzip scratch
 * from interrupted attempts) are first MARKED retired; only entries whose
 * retirement is older than the grace period are actually deleted, so an
 * in-flight reader that resolved the previous revision before the switch
 * can still open its files. Best-effort throughout: a failed sweep is
 * retried by the next successful re-index (and by the scheduled sweep).
 */
export function sweepDerivedVersions(
  root: string,
  activeRev: string,
  opts: { graceMs?: number; now?: number } = {},
): void {
  const graceMs = opts.graceMs ?? DERIVED_GC_GRACE_MS;
  const now = opts.now ?? Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  const registryPath = path.join(root, GC_REGISTRY_FILE);
  let registry: Record<string, number> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v)) registry[k] = v;
    }
  } catch {
    registry = {};
  }
  const present = new Set<string>();
  for (const e of entries) {
    if (e.name === activeRev || e.name === GC_REGISTRY_FILE) continue;
    present.add(e.name);
    const retiredAt = registry[e.name];
    if (retiredAt === undefined) {
      registry[e.name] = now; // newly retired: start its grace clock
      continue;
    }
    if (now - retiredAt < graceMs) continue; // an old reader may still hold it
    try {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
      delete registry[e.name];
      present.delete(e.name);
    } catch {
      /* best effort; the next sweep retries */
    }
  }
  // Drop stale bookkeeping (deleted entries, or a revision that became
  // active again before its grace expired).
  for (const name of Object.keys(registry)) {
    if (!present.has(name)) delete registry[name];
  }
  try {
    if (Object.keys(registry).length === 0) {
      fs.rmSync(registryPath, { force: true });
    } else {
      fs.writeFileSync(registryPath, JSON.stringify(registry));
    }
  } catch {
    /* best effort */
  }
}

/**
 * Best-effort in-process follow-up sweep: marks retire immediately (via the
 * post-commit sweep) and actually deletes shortly after the grace period.
 * Re-resolves the ACTIVE revision from the database at fire time — never
 * the captured one — so a version that became active in the meantime is
 * untouched. If the process dies first, the next successful re-index's
 * sweep finishes the job.
 */
export function scheduleDerivedSweep(
  ctx: AppContext,
  bookId: string,
  graceMs = DERIVED_GC_GRACE_MS,
): void {
  const t = setTimeout(() => {
    try {
      const row = ctx.db.prepare('SELECT derived_rev FROM books WHERE id = ?').get(bookId) as
        { derived_rev: string | null } | undefined;
      // NULL means the legacy layout is active: the whole root is live content.
      if (!row?.derived_rev) return;
      sweepDerivedVersions(derivedRoot(ctx, bookId), row.derived_rev, { graceMs });
    } catch {
      /* best effort */
    }
  }, graceMs + 1000);
  t.unref?.();
}

export async function runIndexEbook(
  ctx: AppContext,
  job: JobRow,
  guard: LeaseGuard,
): Promise<void> {
  const { bookId } = JSON.parse(job.payload_json) as { bookId: string };
  const { db } = ctx;
  const book = getBook(ctx, bookId);
  guard.assertHeld();
  db.prepare("UPDATE books SET scan_state = 'indexing', scan_error = NULL WHERE id = ?").run(
    bookId,
  );
  try {
    const abs = realResolveWithin(String(book.root_dir), String(book.rel_path));
    jobProgress(db, job.id, job.lease_token, 0.2, `Extracting ${path.basename(abs)}`);
    // Crash-safe re-index: extract into a fresh IMMUTABLE versioned
    // directory UNIQUE TO THIS LEASE ATTEMPT, then switch the database
    // pointer (books.derived_rev) in a single transaction. Readers resolve
    // the active version, so there is never a moment without a complete
    // derived directory; a reclaimed job's overlapping attempts each write
    // their own directory (never each other's), old versions are retired
    // only after the switch committed and deleted only after a grace
    // period, and a crash at any point leaves either the old version
    // active or the new one — never neither.
    const rev = derivedRevForAttempt(job);
    const root = derivedRoot(ctx, bookId);
    const newDir = derivedVersionDir(ctx, bookId, rev);
    fs.rmSync(newDir, { recursive: true, force: true }); // only ever this attempt's own dir
    let result;
    try {
      // Lease ownership is threaded into extraction: a reclaimed attempt
      // aborts mid-extraction instead of writing to completion.
      result = await extractEpub(abs, bookId, newDir, {
        assertOwnership: () => guard.assertHeld(),
      });
    } catch (err) {
      // Failure cleanup touches ONLY this attempt's directory; a stale
      // attempt never deletes the directory of the attempt that owns the
      // job now.
      fs.rmSync(newDir, { recursive: true, force: true });
      throw err;
    }

    guard.assertHeld();
    let coverPath: string | null = null;
    if (result.coverFile) {
      fs.mkdirSync(coversDir(ctx), { recursive: true });
      coverPath = path.join(coversDir(ctx), `${bookId}.${result.coverExt ?? 'jpg'}`);
      // Attempt-private temp + atomic rename: the shared active cover path
      // is never mid-write, and ownership is validated immediately before
      // publication.
      const tmpCover = `${coverPath}.${job.lease_token.slice(0, 8)}.tmp`;
      try {
        fs.copyFileSync(result.coverFile, tmpCover);
        guard.assertHeld();
        fs.renameSync(tmpCover, coverPath);
      } finally {
        fs.rmSync(tmpCover, { force: true });
      }
    }

    // Atomic pointer switch: chapters and book metadata (including
    // derived_rev) commit together, revalidated against the lease
    // immediately beforehand.
    guard.assertHeld();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId);
      const insCh = db.prepare(
        'INSERT INTO chapters (book_id, idx, title, spine_idx, href) VALUES (?, ?, ?, ?, ?)',
      );
      let chIdx = 0;
      for (const t of result.manifest.toc) {
        if (t.depth > 1) continue; // keep chapters shallow; full toc lives in the manifest
        insCh.run(bookId, chIdx++, t.title, t.spineIdx, t.fragment);
      }

      const prevMeta = JSON.parse(String(book.meta_json ?? '{}'));
      db.prepare(
        `UPDATE books SET title = ?, author = ?, language = ?, series = ?, series_idx = ?,
           identifiers_json = ?, cover_path = ?, scan_state = 'ready', scanned_at = ?,
           meta_json = ?, derived_rev = ?
         WHERE id = ?`,
      ).run(
        result.meta.title,
        result.meta.author,
        result.meta.language,
        result.meta.series,
        result.meta.seriesIdx,
        JSON.stringify(result.meta.identifiers),
        coverPath,
        nowIso(),
        JSON.stringify({
          ...prevMeta,
          totalChars: result.manifest.totalChars,
          direction: result.manifest.direction,
          spineCount: result.manifest.chapters.length,
          publisher: result.meta.publisher,
          description: result.meta.description,
        }),
        rev,
        bookId,
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    // Only after the switch committed: retire old versions and orphans.
    // Deletion is DEFERRED past a grace period so a request that resolved
    // the previous revision just before the switch can still open its
    // files (reference-safe GC; see sweepDerivedVersions).
    sweepDerivedVersions(root, rev);
    scheduleDerivedSweep(ctx, bookId);
  } catch (err) {
    markBookError(ctx, guard, bookId, err);
    throw err;
  }
}

/** Upper bound on one embedded-cover ffmpeg run; a hung ffmpeg is killed. */
export const COVER_FFMPEG_TIMEOUT_MS = 60_000;

/**
 * Lease-guarded, attempt-isolated embedded-cover extraction. ffmpeg never
 * writes the shared active cover path directly: output goes to an
 * attempt-unique temp file, the run is bounded by a timeout and aborted if
 * the lease is lost mid-flight, ownership is revalidated immediately
 * before publication, and publication is an atomic rename. A stale attempt
 * cleans up only its OWN temp output — never another attempt's file and
 * never the published cover.
 */
export async function extractCoverAtomic(
  ctx: AppContext,
  guard: LeaseGuard,
  src: string,
  bookId: string,
  attemptTag: string,
  opts: {
    extract?: typeof extractCover;
    timeoutMs?: number;
    watchIntervalMs?: number;
  } = {},
): Promise<string | null> {
  const extract = opts.extract ?? extractCover;
  fs.mkdirSync(coversDir(ctx), { recursive: true });
  const finalOut = path.join(coversDir(ctx), `${bookId}.jpg`);
  // The temp name must still end in .jpg so ffmpeg picks the same muxer it
  // would for the final path.
  const tmpOut = path.join(coversDir(ctx), `.cover-${bookId}-${attemptTag}.tmp.jpg`);
  const abort = new AbortController();
  const watch = setInterval(() => {
    guard.heartbeat();
    if (guard.isLost()) abort.abort();
  }, opts.watchIntervalMs ?? 1000);
  watch.unref?.();
  try {
    const ok = await extract(src, tmpOut, {
      timeoutMs: opts.timeoutMs ?? COVER_FFMPEG_TIMEOUT_MS,
      signal: abort.signal,
    });
    // Ownership is validated BEFORE the output can become visible — a
    // reclaimed attempt (including one whose ffmpeg was just aborted)
    // throws here and publishes nothing.
    guard.assertHeld();
    if (!ok || !fs.existsSync(tmpOut)) return null;
    fs.renameSync(tmpOut, finalOut); // atomic publication
    return finalOut;
  } finally {
    clearInterval(watch);
    fs.rmSync(tmpOut, { force: true }); // this attempt's own leftover only
  }
}

export async function runIndexAudio(
  ctx: AppContext,
  job: JobRow,
  guard: LeaseGuard,
): Promise<void> {
  const { bookId } = JSON.parse(job.payload_json) as { bookId: string };
  const { db } = ctx;
  const book = getBook(ctx, bookId);
  guard.assertHeld();
  db.prepare("UPDATE books SET scan_state = 'indexing', scan_error = NULL WHERE id = ?").run(
    bookId,
  );
  try {
    const trackRows = db
      .prepare('SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY idx')
      .all(bookId) as Record<string, unknown>[];
    let absoluteMs = 0;
    let title: string | null = null;
    let author: string | null = null;
    let language: string | null = null;
    const chapters: { title: string; startMs: number; endMs: number }[] = [];
    let hasEmbeddedCover = false;
    let firstTrackAbs: string | null = null;

    for (const [i, t] of trackRows.entries()) {
      const abs = realResolveWithin(String(book.root_dir), String(t.rel_path));
      if (i === 0) firstTrackAbs = abs;
      jobProgress(
        db,
        job.id,
        job.lease_token,
        0.1 + (0.7 * i) / trackRows.length,
        `Probing ${path.basename(abs)}`,
      );
      const probe = await probeAudio(abs);
      guard.assertHeld();
      db.prepare(
        'UPDATE audio_tracks SET duration_ms = ?, start_ms_absolute = ?, title = ? WHERE book_id = ? AND idx = ?',
      ).run(probe.durationMs, absoluteMs, probe.title, bookId, Number(t.idx));
      if (probe.chapters.length > 0) {
        for (const c of probe.chapters) {
          chapters.push({
            title: c.title ?? `Chapter ${chapters.length + 1}`,
            startMs: absoluteMs + c.startMs,
            endMs: absoluteMs + c.endMs,
          });
        }
      } else if (trackRows.length > 1) {
        chapters.push({
          title: probe.title ?? path.basename(String(t.rel_path)).replace(/\.[^.]+$/, ''),
          startMs: absoluteMs,
          endMs: absoluteMs + probe.durationMs,
        });
      }
      absoluteMs += probe.durationMs;
      title = title ?? probe.album ?? probe.title;
      author = author ?? probe.artist;
      language = language ?? probe.language;
      hasEmbeddedCover = hasEmbeddedCover || probe.hasCover;
    }

    // Cover: embedded art, else cover.jpg/png in the book folder.
    guard.assertHeld();
    let coverPath: string | null = null;
    fs.mkdirSync(coversDir(ctx), { recursive: true });
    if (hasEmbeddedCover && firstTrackAbs) {
      coverPath = await extractCoverAtomic(
        ctx,
        guard,
        firstTrackAbs,
        bookId,
        job.lease_token.slice(0, 8),
      );
    }
    if (!coverPath && trackRows.length > 0) {
      const firstRel = String(trackRows[0]!.rel_path);
      coverPath = copyFallbackCover(ctx, String(book.root_dir), path.dirname(firstRel), bookId);
    }

    guard.assertHeld();
    db.prepare('DELETE FROM chapters WHERE book_id = ?').run(bookId);
    const insCh = db.prepare(
      'INSERT INTO chapters (book_id, idx, title, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)',
    );
    chapters.forEach((c, idx) => insCh.run(bookId, idx, c.title, c.startMs, c.endMs));

    db.prepare(
      `UPDATE books SET title = COALESCE(?, title), author = COALESCE(?, author),
         language = COALESCE(?, language), duration_ms = ?, cover_path = ?,
         scan_state = 'ready', scanned_at = ? WHERE id = ?`,
    ).run(
      title,
      author,
      language ? language.toLowerCase().slice(0, 5) : null,
      absoluteMs,
      coverPath,
      nowIso(),
      bookId,
    );
  } catch (err) {
    markBookError(ctx, guard, bookId, err);
    throw err;
  }
}

export async function runPairScan(ctx: AppContext, job: JobRow, guard: LeaseGuard): Promise<void> {
  const { db } = ctx;
  const { values: settings } = resolveSettings(db, ctx.config);
  // Index jobs from the same scan may still be running (they share the
  // worker pool). Pairing only considers 'ready' books, so instead of
  // silently missing late-indexed titles, come back once indexing is done.
  const pendingIndex = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs WHERE id != ? AND state IN ('queued','running')
         AND type IN ('index-ebook','index-audio')`,
      )
      .get(job.id) as { c: number }
  ).c;
  if (pendingIndex > 0) {
    jobProgress(db, job.id, job.lease_token, 0.1, `Waiting for ${pendingIndex} index job(s)`);
    await new Promise((r) => setTimeout(r, 5000));
    guard.assertHeld();
    enqueueJob(db, 'pair-scan', {}, { dedupeKey: 'pair-scan-retry', priority: -1 });
    return;
  }
  const ebooks = db
    .prepare("SELECT * FROM books WHERE kind = 'ebook' AND scan_state = 'ready'")
    .all() as Record<string, unknown>[];
  const audios = db
    .prepare("SELECT * FROM books WHERE kind = 'audio' AND scan_state = 'ready'")
    .all() as Record<string, unknown>[];
  jobProgress(
    db,
    job.id,
    job.lease_token,
    0.2,
    `Comparing ${ebooks.length} ebooks x ${audios.length} audiobooks`,
  );

  for (const e of ebooks) {
    const meta = JSON.parse(String(e.meta_json ?? '{}'));
    for (const a of audios) {
      const existing = db
        .prepare('SELECT id, status FROM pairs WHERE ebook_id = ? AND audio_id = ?')
        .get(String(e.id), String(a.id)) as { id: string; status: string } | undefined;
      if (existing) continue; // decisions (incl. rejections) are durable
      const { score, evidence } = scorePair({
        ebook: {
          title: String(e.title),
          author: (e.author as string) ?? null,
          language: (e.language as string) ?? null,
          series: (e.series as string) ?? null,
          identifiers: JSON.parse(String(e.identifiers_json ?? '{}')),
          totalChars: meta.totalChars ?? null,
        },
        audio: {
          title: String(a.title),
          author: (a.author as string) ?? null,
          language: (a.language as string) ?? null,
          series: (a.series as string) ?? null,
          identifiers: JSON.parse(String(a.identifiers_json ?? '{}')),
          durationMs: (a.duration_ms as number) ?? null,
        },
      });
      if (score < CANDIDATE_THRESHOLD) continue;
      // Metadata alone NEVER links editions automatically. A high-scoring
      // metadata match stays a candidate; if transcription is available, an
      // alignment probe runs and only passing multi-region content
      // compatibility promotes it to 'auto' (see runAlign). With
      // transcription disabled, linking always waits for the user.
      const autoEligible = score >= settings.autoPairThreshold;
      const pairId = stableId('pair', String(e.id), String(a.id));
      guard.assertHeld();
      if (autoEligible) {
        evidence.notes.push(
          settings.transcribeProvider !== 'none'
            ? 'Strong metadata match — automatic linking awaits content verification.'
            : 'Strong metadata match — enable transcription or confirm manually to link.',
        );
      }
      db.prepare(
        `INSERT INTO pairs (id, ebook_id, audio_id, status, score, evidence_json, created_at)
         VALUES (?, ?, ?, 'candidate', ?, ?, ?)`,
      ).run(pairId, String(e.id), String(a.id), score, JSON.stringify(evidence), nowIso());
      if (autoEligible && settings.transcribeProvider !== 'none') {
        enqueueJob(db, 'align', { pairId }, { dedupeKey: `align:${pairId}`, priority: -2 });
      }
    }
  }
}

export async function runAlign(ctx: AppContext, job: JobRow, guard: LeaseGuard): Promise<void> {
  const { db, config } = ctx;
  const { pairId } = JSON.parse(job.payload_json) as { pairId: string };
  const { values: settings } = resolveSettings(db, config);
  const pair = db.prepare('SELECT * FROM pairs WHERE id = ?').get(pairId) as
    Record<string, unknown> | undefined;
  if (!pair) throw new Error(`Pair not found: ${pairId}`);
  if (!['auto', 'confirmed', 'candidate'].includes(String(pair.status))) {
    throw new Error(`Pair ${pairId} is ${pair.status}; not aligning`);
  }

  const ebook = getBook(ctx, String(pair.ebook_id));
  const audio = getBook(ctx, String(pair.audio_id));
  const dd = activeDerivedDir(ctx, String(ebook.id));
  const manifest = loadManifest(dd);
  const sentences = loadSentences(dd);
  const sentencesText = loadSentencesText(dd);
  if (!manifest || !sentences || !sentencesText) {
    throw new Error('Ebook derived index missing; re-run the library scan first.');
  }

  const provider = getProvider(settings.transcribeProvider);
  if (!provider) {
    throw new Error(
      'Transcription is disabled (VX_TRANSCRIBE_PROVIDER=none). Configure "fixture" or the experimental "whisper-cli" provider to align this pair.',
    );
  }

  const trackRows = db
    .prepare('SELECT * FROM audio_tracks WHERE book_id = ? ORDER BY idx')
    .all(String(audio.id)) as Record<string, unknown>[];
  const trackPaths = trackRows.map((t) =>
    realResolveWithin(String(audio.root_dir), String(t.rel_path)),
  );
  const trackStartMs = trackRows.map((t) => Number(t.start_ms_absolute));

  // Narration language: user override on the pair → ebook metadata → audio
  // tags → whisper's own detector on a short clip (needs any multilingual
  // model installed) → the instance default. The chosen language selects
  // the speech model (Hebrew → ivrit.ai fine-tune, etc.).
  let language = languageCode(pair.language as string | null);
  let languageSource = 'override';
  if (!language) {
    language = languageCode(ebook.language as string | null);
    languageSource = 'ebook-metadata';
  }
  if (!language) {
    language = languageCode(audio.language as string | null);
    languageSource = 'audio-tags';
  }
  if (!language && settings.transcribeProvider === 'whisper-cli' && trackPaths[0]) {
    const bin = settings.whisperBin || config.whisperBin;
    const detector = anyMultilingualModel(config.modelsDir);
    if (bin && detector) {
      jobProgress(db, job.id, job.lease_token, 0.12, 'Detecting narration language');
      const det = await detectLanguage(
        bin,
        detector.path,
        trackPaths[0],
        path.join(config.cacheDir, 'whisper-work'),
      );
      guard.assertHeld();
      if (det && det.probability >= 0.5) {
        language = languageCode(det.language);
        languageSource = `detected (${Math.round(det.probability * 100)}%)`;
      }
    }
  }
  if (!language) {
    language = languageCode(settings.defaultLanguage) ?? 'en';
    languageSource = 'default';
  }
  guard.assertHeld();
  db.prepare('UPDATE pairs SET detected_language = ? WHERE id = ?').run(language, pairId);
  jobProgress(
    db,
    job.id,
    job.lease_token,
    0.15,
    `Language: ${languageByCode(language)?.label ?? language} (${languageSource})`,
  );

  // Speech model for that language — a missing one fails the job with a
  // structured error the pairing page turns into a "download it" prompt.
  let whisperModel = settings.whisperModel || config.whisperModel;
  if (settings.transcribeProvider === 'whisper-cli') {
    try {
      const chosen = resolveModelForLanguage(config.modelsDir, language, settings.languageModels);
      whisperModel = chosen.path;
    } catch (err) {
      if (err instanceof ModelMissingError && !(whisperModel && fs.existsSync(whisperModel))) {
        throw err;
      }
      // A custom VX_WHISPER_MODEL path outside the catalog still works.
    }
  }

  // ── Fast content probe for CANDIDATES ─────────────────────────────────
  // A full transcription takes hours per book. Before spending them on a
  // metadata match that might be a different edition, transcribe two short
  // clips (90 s at ~25 % and ~60 % of the book) and check that their words
  // actually occur in the ebook. Pass → the pair is linked ('auto') and the
  // full alignment continues below; fail → stays a candidate with a note and
  // the operator decides. Sidecar-transcript setups skip the probe.
  if (
    String(pair.status) === 'candidate' &&
    settings.transcribeProvider === 'whisper-cli' &&
    trackPaths.length > 0
  ) {
    const bin = settings.whisperBin || config.whisperBin;
    const ebookTokens = new Set<string>();
    for (const chapter of sentencesText)
      for (const s of chapter) for (const w of s.split(' ')) if (w.length > 3) ebookTokens.add(w);
    const totalMs = trackRows.reduce((a, t) => a + Number(t.duration_ms ?? 0), 0);
    const clipAt = (frac: number) => {
      const abs = Math.max(0, Math.floor(totalMs * frac));
      let idx = 0;
      for (let i = 0; i < trackRows.length; i++)
        if (abs >= Number(trackRows[i]!.start_ms_absolute)) idx = i;
      return { path: trackPaths[idx]!, startMs: abs - Number(trackRows[idx]!.start_ms_absolute) };
    };
    const scores: number[] = [];
    for (const [i, frac] of [0.25, 0.6].entries()) {
      jobProgress(
        db,
        job.id,
        job.lease_token,
        0.16 + i * 0.02,
        `Checking the narration matches the text (sample ${i + 1} of 2)`,
      );
      const clip = clipAt(frac);
      const words = await transcribeClip(
        bin,
        whisperModel,
        language,
        clip.path,
        clip.startMs,
        90,
        path.join(config.cacheDir, 'whisper-work'),
      );
      guard.assertHeld();
      const candidates = words.map((w) => w.w).filter((w) => w.length > 3);
      const hits = candidates.filter((w) => ebookTokens.has(w)).length;
      scores.push(candidates.length >= 20 ? hits / candidates.length : 0);
    }
    const probeScore = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const evidence = JSON.parse(String(pair.evidence_json ?? '{}'));
    evidence.contentScore = Math.round(probeScore * 1000) / 1000;
    evidence.notes = (evidence.notes ?? []).filter(
      (n: string) => !n.startsWith('Narration sample'),
    );
    const pass = probeScore >= PROBE_COMPAT_MIN && Number(pair.score) >= settings.autoPairThreshold;
    evidence.notes.push(
      pass
        ? `Narration sample matched the text (${Math.round(probeScore * 100)}% of sampled words found) — linked automatically; full alignment follows.`
        : `Narration sample matched only ${Math.round(probeScore * 100)}% of sampled words — not linked automatically. Confirm manually if this really is the same edition.`,
    );
    guard.assertHeld();
    db.prepare('UPDATE pairs SET evidence_json = ? WHERE id = ?').run(
      JSON.stringify(evidence),
      pairId,
    );
    if (pass) {
      db.prepare(
        `UPDATE pairs SET status = 'auto', decided_at = ? WHERE id = ? AND status = 'candidate'`,
      ).run(nowIso(), pairId);
      pair.status = 'auto';
    } else {
      jobProgress(db, job.id, job.lease_token, 1, 'Probe did not pass — waiting for your decision');
      return;
    }
  }

  // Transcript cache: keyed by source content hash + provider + language.
  const sourceHash = String(audio.content_hash ?? sha256hex(trackPaths.join('|')));
  const cached = db
    .prepare('SELECT * FROM transcripts WHERE book_id = ? AND source_hash = ? AND language = ?')
    .get(String(audio.id), sourceHash, language) as Record<string, unknown> | undefined;

  let words: TranscriptWord[];
  let model: string;
  if (cached && fs.existsSync(String(cached.file_path))) {
    jobProgress(db, job.id, job.lease_token, 0.3, 'Using cached transcript');
    const data = JSON.parse(fs.readFileSync(String(cached.file_path), 'utf8'));
    words = data.words;
    model = String(cached.model);
  } else {
    jobProgress(db, job.id, job.lease_token, 0.2, `Transcribing via ${provider.name}`);
    const checkpoint = job.checkpoint_json ? JSON.parse(job.checkpoint_json) : undefined;
    const result = await provider.transcribe({
      trackPaths,
      trackStartMs,
      language,
      workDir: path.join(config.cacheDir, 'whisper-work'),
      whisperBin: settings.whisperBin || config.whisperBin,
      whisperModel,
      checkpoint,
      onProgress: (info) => {
        const done = (info.track + info.trackPct / 100) / Math.max(1, info.trackCount);
        jobProgress(
          db,
          job.id,
          job.lease_token,
          0.2 + 0.4 * done,
          `Transcribing ${info.trackCount > 1 ? `part ${info.track + 1} of ${info.trackCount} · ` : ''}${info.trackPct}%${
            whisperModel ? ` · ${path.basename(whisperModel).replace(/^ggml-|\.bin$/g, '')}` : ''
          }`,
        );
      },
      onCheckpoint: (cp) => jobCheckpoint(db, job.id, job.lease_token, cp),
    });
    words = result.words;
    model = result.model;
    guard.assertHeld();
    fs.mkdirSync(transcriptsDir(ctx), { recursive: true });
    const filePath = path.join(transcriptsDir(ctx), `${newId('tr')}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ words }));
    db.prepare(
      `INSERT OR REPLACE INTO transcripts (id, book_id, source_hash, model, language, provider, file_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('tr'),
      String(audio.id),
      sourceHash,
      model,
      language,
      provider.name,
      filePath,
      nowIso(),
    );
  }

  jobProgress(
    db,
    job.id,
    job.lease_token,
    0.6,
    `Aligning ${words.length.toLocaleString()} words to ${sentences.reduce((a, c) => a + c.length, 0).toLocaleString()} sentences`,
  );
  const input: EbookSentenceInput[] = [];
  sentences.forEach((chapter, spineIdx) => {
    chapter.forEach((s, i) => {
      input.push({
        sentenceId: s.id,
        spineIdx,
        sentenceOrd: s.ord,
        tokens: (sentencesText[spineIdx]?.[i] ?? '').split(' ').filter(Boolean),
      });
    });
  });
  const result = alignBook(input, words);

  // Edition-compatibility content check: token overlap sampled from three
  // regions of the book vs transcript windows (docs: pairing gate 2).
  const contentScore = sampleContentScore(input, words);
  const evidence = JSON.parse(String(pair.evidence_json ?? '{}'));
  evidence.contentScore = contentScore;
  const compat = {
    contentScore,
    coverage: result.coverage,
    meanConfidence: result.meanConfidence,
    warning:
      contentScore < 0.5
        ? 'Content overlap is low — this audio may be a different edition (abridged, translated, or dramatized).'
        : null,
  };
  // alignBook + sampleContentScore are synchronous CPU stages that can
  // outlive a blocked heartbeat: revalidate the lease before every write.
  guard.assertHeld();
  db.prepare('UPDATE pairs SET evidence_json = ?, compat_json = ? WHERE id = ?').run(
    JSON.stringify(evidence),
    JSON.stringify(compat),
    pairId,
  );

  guard.assertHeld();
  storeAlignment(db, pairId, language, model, result, {
    provider: provider.name,
    sourceHash,
    sentenceCount: input.length,
    wordCount: words.length,
  });

  // Content-verified promotion: a candidate that scored above the metadata
  // auto threshold becomes 'auto' only now, after multi-region content
  // compatibility passed. Metadata alone never links editions.
  if (
    String(pair.status) === 'candidate' &&
    Number(pair.score) >= settings.autoPairThreshold &&
    contentScore >= CONTENT_COMPAT_MIN &&
    result.coverage >= 0.5
  ) {
    guard.assertHeld();
    db.prepare(
      `UPDATE pairs SET status = 'auto', decided_at = ? WHERE id = ? AND status = 'candidate'`,
    ).run(nowIso(), pairId);
  }
  jobProgress(db, job.id, job.lease_token, 0.95, `Aligned ${result.segments.length} sentences`);
}

/** Minimum sampled content overlap before auto-linking is allowed. */
export const CONTENT_COMPAT_MIN = 0.5;
/** Minimum share of sampled narration words that must occur in the ebook (probe). */
export const PROBE_COMPAT_MIN = 0.55;

function sampleContentScore(sentences: EbookSentenceInput[], words: TranscriptWord[]): number {
  if (sentences.length === 0 || words.length === 0) return 0;
  const wordTokens = words.map((w) => w.w);
  const positions = [0.15, 0.5, 0.85];
  let total = 0;
  for (const p of positions) {
    const sIdx = Math.min(sentences.length - 1, Math.floor(p * sentences.length));
    const sample: string[] = [];
    for (let i = sIdx; i < Math.min(sentences.length, sIdx + 5); i++) {
      sample.push(...sentences[i]!.tokens);
    }
    const wIdx = Math.floor(p * wordTokens.length);
    const windowRadius = Math.max(400, sample.length * 4);
    const window = new Set(wordTokens.slice(Math.max(0, wIdx - windowRadius), wIdx + windowRadius));
    // Containment: what fraction of the sampled ebook text the narration
    // window contains. (Symmetric similarity would be diluted by the
    // deliberately larger transcript window.)
    const uniq = new Set(sample);
    let hit = 0;
    for (const t of uniq) if (window.has(t)) hit++;
    total += uniq.size > 0 ? hit / uniq.size : 0;
  }
  const raw = total / positions.length;
  return Math.round(raw * 1000) / 1000;
}
