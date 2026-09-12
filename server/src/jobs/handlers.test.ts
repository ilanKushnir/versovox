import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openMemoryDatabase, nowIso } from '../db/index.js';
import { type AppContext, activeDerivedDir, derivedRoot, derivedVersionDir } from '../context.js';
import { extractEpub, loadManifest } from '../epub/extract.js';
import { ModelMissingError } from '../alignment/model.js';
import { claimNextJob, enqueueJob, LeaseLostError, makeLeaseGuard, type JobRow } from './queue.js';
import {
  copyFallbackCover,
  derivedRevForAttempt,
  extractCoverAtomic,
  runAlign,
  runIndexEbook,
  sweepDerivedVersions,
} from './handlers.js';

let tmp: string;
let ctx: AppContext;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-handlers-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    // Pinned inside the sandbox: otherwise a developer who has the real
    // aligner in ./models would run these tests against a 317 MB model.
    modelsDir: path.join(tmp, 'models'),
    sessionSecret: 'handlers-test-secret-0123456789',
    logLevel: 'error',
  });
  ctx = {
    db: openMemoryDatabase(),
    config,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Simulate another worker reclaiming the job (fresh token, fresh lease). */
function stealLease(jobId: string): void {
  ctx.db
    .prepare(
      `UPDATE jobs SET lease_token = 'stolen-by-other-worker', lease_expires_at = ? WHERE id = ?`,
    )
    .run(new Date(Date.now() + 10 * 60_000).toISOString(), jobId);
}

/** Simulate the stale-job sweeper requeueing an expired running job. */
function requeueJobRow(jobId: string): void {
  ctx.db
    .prepare(
      `UPDATE jobs SET state = 'queued', started_at = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ?`,
    )
    .run(jobId);
}

function claimWithGuard(): { job: JobRow; guard: ReturnType<typeof makeLeaseGuard> } {
  const job = claimNextJob(ctx.db)!;
  return { job, guard: makeLeaseGuard(ctx.db, job) };
}

/* ------------------------------------------------- fallback cover safety */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

describe('copyFallbackCover', () => {
  it('SYMLINK ESCAPE: a cover.jpg symlink pointing outside the library is never read', () => {
    const outside = path.join(tmp, 'session-secret');
    fs.writeFileSync(outside, 'top-secret-value');
    const root = path.join(tmp, 'lib-escape');
    const bookDir = path.join(root, 'book');
    fs.mkdirSync(bookDir, { recursive: true });
    fs.symlinkSync(outside, path.join(bookDir, 'cover.jpg'));
    const result = copyFallbackCover(ctx, root, 'book', 'bk_escape');
    expect(result).toBeNull();
    // Nothing containing the secret ended up in the cache.
    const covers = path.join(ctx.config.cacheDir, 'covers');
    if (fs.existsSync(covers)) {
      for (const f of fs.readdirSync(covers)) {
        expect(fs.readFileSync(path.join(covers, f), 'utf8')).not.toContain('top-secret-value');
      }
    }
  });

  it('rejects files without a real image signature', () => {
    const root = path.join(tmp, 'lib-sig');
    const bookDir = path.join(root, 'book');
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, 'cover.jpg'), '<html>not an image</html>');
    expect(copyFallbackCover(ctx, root, 'book', 'bk_sig')).toBeNull();
  });

  it('copies a genuine JPEG cover', () => {
    const root = path.join(tmp, 'lib-ok');
    const bookDir = path.join(root, 'book');
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, 'cover.jpg'), JPEG);
    const result = copyFallbackCover(ctx, root, 'book', 'bk_ok');
    expect(result).toBeTruthy();
    expect(fs.readFileSync(result!)).toEqual(JPEG);
  });
});

/* ------------------------------------------- crash-safe versioned re-index */

function makeEpub(title: string, chapters: string[]): Uint8Array {
  const items = chapters
    .map((_, i) => `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const refs = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('');
  const opf =
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title>` +
    `<dc:language>en</dc:language></metadata>` +
    `<manifest>${items}</manifest><spine>${refs}</spine></package>`;
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
        `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    ),
    'OEBPS/content.opf': strToU8(opf),
  };
  chapters.forEach((text, i) => {
    files[`OEBPS/ch${i}.xhtml`] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${text}</p></body></html>`,
    );
  });
  return zipSync(files);
}

function insertEbook(bookId: string, root: string, relPath: string): void {
  ctx.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
       VALUES (?, 'ebook', ?, ?, 'epub', 'Novel', 1, 'discovered', ?)`,
    )
    .run(bookId, root, relPath, nowIso());
}

const versionDirsOf = (bookId: string): string[] =>
  fs.existsSync(derivedRoot(ctx, bookId))
    ? fs.readdirSync(derivedRoot(ctx, bookId)).filter((d) => d.startsWith('v-'))
    : [];

/** Run the deferred GC as if the grace period had fully elapsed. */
const sweepPastGrace = (bookId: string): void =>
  sweepDerivedVersions(derivedRoot(ctx, bookId), path.basename(activeDerivedDir(ctx, bookId)), {
    graceMs: 0,
  });

describe('runIndexEbook crash-safe versioned replacement', () => {
  it('re-indexing a shorter edition switches atomically and leaves no stale content', async () => {
    const root = path.join(tmp, 'lib-books');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'novel.epub');
    fs.writeFileSync(
      epubPath,
      makeEpub('Long Edition', [
        'Chapter one text.',
        'Chapter two text.',
        'Chapter three text.',
        'Chapter four secret ending.',
      ]),
    );
    const bookId = 'bk_atomic';
    insertEbook(bookId, root, 'novel.epub');

    enqueueJob(ctx.db, 'index-ebook', { bookId });
    let { job, guard } = claimWithGuard();
    await runIndexEbook(ctx, job, guard);
    const firstDir = activeDerivedDir(ctx, bookId);
    expect(fs.existsSync(path.join(firstDir, 'ch_3.html'))).toBe(true);
    // The active dir IS a versioned dir named by the pointer, unique to
    // the lease attempt that produced it.
    expect(path.basename(firstDir)).toBe(derivedRevForAttempt(job));

    // The library file is replaced with a shorter edition.
    fs.writeFileSync(epubPath, makeEpub('Short Edition', ['Only chapter now.']));
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    ({ job, guard } = claimWithGuard());
    await runIndexEbook(ctx, job, guard);

    const dd = activeDerivedDir(ctx, bookId);
    expect(dd).not.toBe(firstDir);
    expect(fs.existsSync(path.join(dd, 'ch_0.html'))).toBe(true);
    expect(fs.existsSync(path.join(dd, 'ch_1.html'))).toBe(false);
    expect(fs.existsSync(path.join(dd, 'ch_3.html'))).toBe(false);
    const manifest = loadManifest(dd)!;
    expect(manifest.chapters.length).toBe(1);
    expect(manifest.title).toBe('Short Edition');
    // The old version is RETIRED after the switch, not deleted: an
    // in-flight reader that resolved it just before the switch can still
    // open its files during the grace period.
    expect(fs.existsSync(path.join(firstDir, 'ch_0.html'))).toBe(true);
    // Once the grace period elapses, deferred GC removes it.
    sweepPastGrace(bookId);
    expect(fs.existsSync(firstDir)).toBe(false);
    expect(versionDirsOf(bookId)).toEqual([path.basename(dd)]);
    expect(fs.readdirSync(derivedRoot(ctx, bookId)).filter((d) => d.includes('unzip'))).toEqual([]);
  });

  it('a failed re-index keeps the previous version active and readable', async () => {
    const root = path.join(tmp, 'lib-fail');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'keeper.epub');
    fs.writeFileSync(epubPath, makeEpub('Keeper', ['Good chapter.']));
    const bookId = 'bk_keep';
    insertEbook(bookId, root, 'keeper.epub');
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    let { job, guard } = claimWithGuard();
    await runIndexEbook(ctx, job, guard);
    const dd = activeDerivedDir(ctx, bookId);
    const goodManifest = fs.readFileSync(path.join(dd, 'book.json'), 'utf8');

    // Corrupt the source; the next index attempt must fail...
    fs.writeFileSync(epubPath, 'this is not a zip file');
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    ({ job, guard } = claimWithGuard());
    await expect(runIndexEbook(ctx, job, guard)).rejects.toThrow();

    // ...while the pointer still names the previous version, intact.
    expect(activeDerivedDir(ctx, bookId)).toBe(dd);
    expect(fs.readFileSync(path.join(dd, 'book.json'), 'utf8')).toBe(goodManifest);
    expect(versionDirsOf(bookId)).toEqual([path.basename(dd)]);
  });

  it('INTERRUPTION around the pointer switch: a crash before the switch is invisible and recoverable', async () => {
    const root = path.join(tmp, 'lib-crash');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'crashy.epub');
    fs.writeFileSync(epubPath, makeEpub('Edition One', ['First edition text.']));
    const bookId = 'bk_crash';
    insertEbook(bookId, root, 'crashy.epub');
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const first = claimWithGuard();
    await runIndexEbook(ctx, first.job, first.guard);
    const oldDir = activeDerivedDir(ctx, bookId);
    const oldManifest = fs.readFileSync(path.join(oldDir, 'book.json'), 'utf8');

    // Simulate a process dying AFTER extracting the replacement but BEFORE
    // the pointer switch: the new version dir exists, the pointer does not
    // move, and no further statements run.
    fs.writeFileSync(epubPath, makeEpub('Edition Two', ['Second edition text.']));
    const orphan = derivedVersionDir(ctx, bookId, 'v-crashed_attempt');
    await extractEpub(epubPath, bookId, orphan);
    // No missing-path window: the active dir is still the old version and
    // still fully readable.
    expect(activeDerivedDir(ctx, bookId)).toBe(oldDir);
    expect(fs.readFileSync(path.join(oldDir, 'book.json'), 'utf8')).toBe(oldManifest);
    expect(loadManifest(activeDerivedDir(ctx, bookId))!.title).toBe('Edition One');

    // Recovery: the retried job completes, switches, and retires the
    // orphan and the old version; deferred GC removes them after grace.
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const retry = claimWithGuard();
    await runIndexEbook(ctx, retry.job, retry.guard);
    const dd = activeDerivedDir(ctx, bookId);
    expect(loadManifest(dd)!.title).toBe('Edition Two');
    sweepPastGrace(bookId);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(versionDirsOf(bookId)).toEqual([path.basename(dd)]);
  });

  it('legacy unversioned derived content stays readable and upgrades on re-index', async () => {
    const root = path.join(tmp, 'lib-legacy');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'legacy.epub');
    fs.writeFileSync(epubPath, makeEpub('Legacy Book', ['Legacy chapter.']));
    const bookId = 'bk_legacy';
    insertEbook(bookId, root, 'legacy.epub');
    // Pre-versioning layout: derived content directly under the book root,
    // derived_rev NULL.
    const legacyDir = derivedRoot(ctx, bookId);
    await extractEpub(epubPath, bookId, legacyDir);
    expect(activeDerivedDir(ctx, bookId)).toBe(legacyDir);
    expect(loadManifest(activeDerivedDir(ctx, bookId))!.title).toBe('Legacy Book');

    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const { job, guard } = claimWithGuard();
    await runIndexEbook(ctx, job, guard);
    const dd = activeDerivedDir(ctx, bookId);
    expect(path.basename(dd)).toBe(derivedRevForAttempt(job));
    expect(loadManifest(dd)!.title).toBe('Legacy Book');
    // Legacy loose files are retired after the switch (still openable by an
    // in-flight legacy reader), then removed by deferred GC after grace.
    expect(fs.existsSync(path.join(legacyDir, 'book.json'))).toBe(true);
    sweepPastGrace(bookId);
    expect(fs.existsSync(path.join(legacyDir, 'book.json'))).toBe(false);
    expect(versionDirsOf(bookId)).toEqual([path.basename(dd)]);
  });
});

/* ------------------------------------ attempt-isolated overlapping re-index */

describe('overlapping lease attempts are fully isolated', () => {
  it('TWO-ATTEMPT OVERLAP: a reclaimed job re-runs in its own directory; output is never shared or mixed and only the owner publishes', async () => {
    const root = path.join(tmp, 'lib-overlap');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'novel.epub');
    // Many chapters: attempt 1 yields once per chapter, so it is guaranteed
    // to still be mid-extraction when the reclaim below lands.
    const staleChapters = Array.from({ length: 30 }, (_, i) => `Stale edition chapter ${i}.`);
    fs.writeFileSync(epubPath, makeEpub('Stale Edition', staleChapters));
    const bookId = 'bk_overlap';
    insertEbook(bookId, root, 'novel.epub');

    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const attempt1 = claimWithGuard();
    const rev1 = derivedRevForAttempt(attempt1.job);
    const dir1 = derivedVersionDir(ctx, bookId, rev1);
    // The rejection lands while attempt 2 is still running; capture it via
    // an immediately-attached handler (no unhandled-rejection window).
    let p1Error: unknown = null;
    const p1 = runIndexEbook(ctx, attempt1.job, attempt1.guard).catch((err: unknown) => {
      p1Error = err;
    });
    // Let attempt 1 unzip and write its first chapter, then reclaim while
    // it is still extracting (the real stale-sweeper + second-worker path).
    while (!fs.existsSync(path.join(dir1, 'ch_0.html'))) {
      await new Promise((r) => setImmediate(r));
    }
    requeueJobRow(attempt1.job.id);
    // The unzip already finished (ch_0 exists), so the source file is free
    // to change: the reclaimed attempt indexes the replacement edition.
    fs.writeFileSync(epubPath, makeEpub('Owner Edition', ['Owner chapter text.']));

    const attempt2 = claimWithGuard();
    expect(attempt2.job.id).toBe(attempt1.job.id); // same job...
    const rev2 = derivedRevForAttempt(attempt2.job);
    expect(rev2).not.toBe(rev1); // ...but an attempt-unique directory
    await runIndexEbook(ctx, attempt2.job, attempt2.guard);
    // The stale attempt aborts mid-extraction instead of running to
    // completion, and never publishes.
    await p1;
    expect(p1Error).toBeInstanceOf(LeaseLostError);

    // Only the owner published: the pointer names attempt 2's directory.
    const active = activeDerivedDir(ctx, bookId);
    expect(path.basename(active)).toBe(rev2);
    // The active directory holds ONLY the owner's output — no chapter of
    // the stale 30-chapter edition leaked in (no shared/mixed output).
    expect(loadManifest(active)!.title).toBe('Owner Edition');
    expect(loadManifest(active)!.chapters.length).toBe(1);
    expect(fs.readFileSync(path.join(active, 'ch_0.html'), 'utf8')).toContain(
      'Owner chapter text.',
    );
    expect(fs.existsSync(path.join(active, 'ch_1.html'))).toBe(false);
    // The stale attempt cleaned up only its OWN directory; the owner's
    // published directory was never deleted or written by it.
    expect(fs.existsSync(dir1)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
    const book = ctx.db
      .prepare('SELECT title, derived_rev, scan_state FROM books WHERE id = ?')
      .get(bookId) as { title: string; derived_rev: string; scan_state: string };
    expect(book.derived_rev).toBe(rev2);
    expect(book.title).toBe('Owner Edition');
    expect(book.scan_state).toBe('ready');
  });
});

/* --------------------------------------------- deferred reference-safe GC */

describe('deferred derived-version garbage collection', () => {
  it('READER RACE: a request that resolved the old revision before the switch can still open its files after it', async () => {
    const root = path.join(tmp, 'lib-gc');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'novel.epub');
    fs.writeFileSync(epubPath, makeEpub('Before Switch', ['The original text.']));
    const bookId = 'bk_gc';
    insertEbook(bookId, root, 'novel.epub');
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const first = claimWithGuard();
    await runIndexEbook(ctx, first.job, first.guard);

    // A route handler resolves the pointer to a path FIRST (this is the
    // old reader's resolve step)...
    const resolvedDir = activeDerivedDir(ctx, bookId);

    // ...then a re-index switches the pointer...
    fs.writeFileSync(epubPath, makeEpub('After Switch', ['The replacement text.']));
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const second = claimWithGuard();
    await runIndexEbook(ctx, second.job, second.guard);
    expect(activeDerivedDir(ctx, bookId)).not.toBe(resolvedDir);

    // ...and only NOW does the old reader open its files. Every open the
    // reader routes perform against the resolved path must still succeed.
    expect(loadManifest(resolvedDir)!.title).toBe('Before Switch');
    expect(fs.readFileSync(path.join(resolvedDir, 'ch_0.html'), 'utf8')).toContain(
      'The original text.',
    );
    expect(fs.readFileSync(path.join(resolvedDir, 'sentences.json'), 'utf8')).toBeTruthy();

    // After the grace period the deferred sweep removes the retired
    // version — and leaves the active one untouched.
    sweepPastGrace(bookId);
    expect(fs.existsSync(resolvedDir)).toBe(false);
    const active = activeDerivedDir(ctx, bookId);
    expect(loadManifest(active)!.title).toBe('After Switch');
    expect(versionDirsOf(bookId)).toEqual([path.basename(active)]);
  });
});

/* ------------------------------------- lease-guarded audio cover extraction */

describe('audio cover extraction (attempt-isolated, lease-guarded)', () => {
  const coverFile = (name: string) => path.join(ctx.config.cacheDir, 'covers', name);

  it('OVERLAP: a stale attempt cannot overwrite the cover the owner published', async () => {
    enqueueJob(ctx.db, 'index-audio', { bookId: 'bk_cover_ovl' });
    const stale = claimWithGuard();
    requeueJobRow(stale.job.id); // lease expired; sweeper requeued the job
    const owner = claimWithGuard();
    expect(owner.job.id).toBe(stale.job.id);
    expect(owner.job.lease_token).not.toBe(stale.job.lease_token);

    const OWNER = Buffer.from('owner-cover-bytes');
    const STALE = Buffer.from('stale-cover-bytes');

    // The owner extracts and publishes.
    const published = await extractCoverAtomic(
      ctx,
      owner.guard,
      'unused-src',
      'bk_cover_ovl',
      owner.job.lease_token.slice(0, 8),
      {
        extract: async (_src, out) => {
          fs.writeFileSync(out, OWNER);
          return true;
        },
      },
    );
    expect(published).toBe(coverFile('bk_cover_ovl.jpg'));
    expect(fs.readFileSync(published!)).toEqual(OWNER);

    // The stale attempt's ffmpeg finishes afterwards — into its OWN
    // attempt-unique temp file — and ownership validation refuses the
    // publication.
    await expect(
      extractCoverAtomic(
        ctx,
        stale.guard,
        'unused-src',
        'bk_cover_ovl',
        stale.job.lease_token.slice(0, 8),
        {
          extract: async (_src, out) => {
            expect(out).not.toBe(published); // never the shared active path
            fs.writeFileSync(out, STALE);
            return true;
          },
        },
      ),
    ).rejects.toThrow(LeaseLostError);

    // The published cover is untouched and the stale attempt cleaned up
    // only its own temp output.
    expect(fs.readFileSync(published!)).toEqual(OWNER);
    const leftovers = fs
      .readdirSync(path.join(ctx.config.cacheDir, 'covers'))
      .filter((f) => f.includes('bk_cover_ovl') && f !== 'bk_cover_ovl.jpg');
    expect(leftovers).toEqual([]);
  });

  it('LEASE LOSS mid-ffmpeg: the run is aborted (bounded cancellation) and nothing is published', async () => {
    enqueueJob(ctx.db, 'index-audio', { bookId: 'bk_cover_loss' });
    const { job, guard } = claimWithGuard();
    let sawAbort = false;
    const p = extractCoverAtomic(ctx, guard, 'unused-src', 'bk_cover_loss', 'attempt1', {
      watchIntervalMs: 5,
      extract: (_src, _out, o) =>
        new Promise<boolean>((resolve) => {
          // Mirrors the real wrapper: an aborted ffmpeg reports failure.
          o?.signal?.addEventListener('abort', () => {
            sawAbort = true;
            resolve(false);
          });
        }),
    });
    stealLease(job.id); // reclaimed while ffmpeg runs
    await expect(p).rejects.toThrow(LeaseLostError);
    expect(sawAbort).toBe(true); // the in-flight ffmpeg was actually cancelled
    expect(fs.existsSync(coverFile('bk_cover_loss.jpg'))).toBe(false);
    expect(fs.existsSync(coverFile('.cover-bk_cover_loss-attempt1.tmp.jpg'))).toBe(false);
  });
});

/* --------------------------------------- lease ownership over side effects */

describe('lease ownership gates handler side effects', () => {
  it('an attempt whose lease was already reclaimed cannot write anything', async () => {
    const root = path.join(tmp, 'lib-lease0');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'novel.epub'), makeEpub('Lease Zero', ['Text.']));
    const bookId = 'bk_lease0';
    insertEbook(bookId, root, 'novel.epub');
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const { job, guard } = claimWithGuard();
    stealLease(job.id); // reclaimed before the handler ran at all
    await expect(runIndexEbook(ctx, job, guard)).rejects.toThrow(LeaseLostError);
    const book = ctx.db
      .prepare('SELECT scan_state, scan_error, derived_rev FROM books WHERE id = ?')
      .get(bookId) as {
      scan_state: string;
      scan_error: string | null;
      derived_rev: string | null;
    };
    // Not even the 'indexing' or 'error' state writes happened.
    expect(book.scan_state).toBe('discovered');
    expect(book.scan_error).toBeNull();
    expect(book.derived_rev).toBeNull();
    const chapters = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM chapters WHERE book_id = ?')
      .get(bookId) as { c: number };
    expect(chapters.c).toBe(0);
  });

  it('RECLAIM DURING LONG WORK: extraction finishes but the old attempt cannot publish', async () => {
    const root = path.join(tmp, 'lib-lease1');
    fs.mkdirSync(root, { recursive: true });
    const epubPath = path.join(root, 'novel.epub');
    fs.writeFileSync(epubPath, makeEpub('Original', ['Original chapter text that must survive.']));
    const bookId = 'bk_lease1';
    insertEbook(bookId, root, 'novel.epub');
    // Establish a good first index.
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const first = claimWithGuard();
    await runIndexEbook(ctx, first.job, first.guard);
    const oldDir = activeDerivedDir(ctx, bookId);
    const oldManifest = fs.readFileSync(path.join(oldDir, 'book.json'), 'utf8');
    const oldChapters = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM chapters WHERE book_id = ?')
      .get(bookId) as { c: number };

    // Second attempt starts (synchronous prelude runs: state -> indexing),
    // then — while the async extraction is in flight — the lease expires and
    // another worker reclaims the job.
    fs.writeFileSync(epubPath, makeEpub('Hijacked Edition', ['Replacement text.']));
    enqueueJob(ctx.db, 'index-ebook', { bookId });
    const { job, guard } = claimWithGuard();
    const p = runIndexEbook(ctx, job, guard);
    stealLease(job.id); // reclaim lands while extractEpub awaits
    await expect(p).rejects.toThrow(LeaseLostError);

    // The old attempt altered NOTHING that readers see: pointer, derived
    // content, chapters and metadata are all the previous run's.
    expect(activeDerivedDir(ctx, bookId)).toBe(oldDir);
    expect(fs.readFileSync(path.join(oldDir, 'book.json'), 'utf8')).toBe(oldManifest);
    const book = ctx.db
      .prepare('SELECT title, scan_state, scan_error FROM books WHERE id = ?')
      .get(bookId) as {
      title: string;
      scan_state: string;
      scan_error: string | null;
    };
    expect(book.title).toBe('Original');
    expect(book.scan_state).toBe('indexing'); // stuck state belongs to the new owner to resolve
    expect(book.scan_error).toBeNull(); // the loser did not even write an error
    const chapters = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM chapters WHERE book_id = ?')
      .get(bookId) as { c: number };
    expect(chapters.c).toBe(oldChapters.c);
  });

  it('a reclaimed align attempt leaves the pair exactly as it found it', async () => {
    const root = path.join(tmp, 'lib-align');
    fs.mkdirSync(path.join(root, 'audio'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'novel.epub'),
      makeEpub('Alignable', ['Hello world sentence.']),
    );
    insertEbook('bk_al_e', root, 'novel.epub');
    enqueueJob(ctx.db, 'index-ebook', { bookId: 'bk_al_e' });
    const idx = claimWithGuard();
    await runIndexEbook(ctx, idx.job, idx.guard);
    fs.writeFileSync(path.join(root, 'audio', 'a.mp3'), Buffer.alloc(64, 7));
    ctx.db
      .prepare(
        `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
         VALUES ('bk_al_a', 'audio', ?, 'audio', 'mp3', 'Alignable Audio', 1, 'ready', ?)`,
      )
      .run(root, nowIso());
    ctx.db
      .prepare(
        `INSERT INTO audio_tracks (book_id, idx, rel_path, duration_ms, size_bytes, format, start_ms_absolute)
         VALUES ('bk_al_a', 0, 'audio/a.mp3', 800, 64, 'mp3', 0)`,
      )
      .run();
    ctx.db
      .prepare(
        `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at)
         VALUES ('pair_al', 'bk_al_e', 'bk_al_a', 'confirmed', 0.9, ?)`,
      )
      .run(nowIso());

    enqueueJob(ctx.db, 'align', { pairId: 'pair_al' });
    const { job, guard } = claimWithGuard();
    stealLease(job.id); // another worker owns this pair now
    await expect(runAlign(ctx, job, guard)).rejects.toThrow(LeaseLostError);

    const pair = ctx.db
      .prepare(
        'SELECT detected_language, evidence_json, compat_json, status FROM pairs WHERE id = ?',
      )
      .get('pair_al') as {
      detected_language: string | null;
      evidence_json: string;
      compat_json: string | null;
      status: string;
    };
    expect(pair.detected_language).toBeNull();
    expect(pair.evidence_json).toBe('{}');
    expect(pair.compat_json).toBeNull();
    expect(pair.status).toBe('confirmed');
    const a = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM alignments WHERE pair_id = ?')
      .get('pair_al') as { c: number };
    expect(a.c).toBe(0);

    // Retried by the worker that does hold the lease, the same job writes the
    // detected language before the missing model stops it — so the emptiness
    // above is the ownership check, not runAlign giving up first.
    enqueueJob(ctx.db, 'align', { pairId: 'pair_al' });
    const held = claimWithGuard();
    await expect(runAlign(ctx, held.job, held.guard)).rejects.toThrow(ModelMissingError);
    const written = ctx.db
      .prepare('SELECT detected_language FROM pairs WHERE id = ?')
      .get('pair_al') as { detected_language: string | null };
    expect(written.detected_language).toBe('en');
  });
});
