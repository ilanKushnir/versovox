import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { type AppContext } from '../context.js';
import { nowIso, openMemoryDatabase } from '../db/index.js';
import { ALIGNER_MODEL_ID, ModelMissingError, parseModelMissing } from '../alignment/model.js';
import { claimNextJob, enqueueJob, makeLeaseGuard, type JobRow } from './queue.js';
import { runAlign, runIndexEbook } from './handlers.js';

/**
 * Wiring test for `runAlign`.
 *
 * It deliberately does NOT install the 317 MB model or run it. What has to
 * hold here is the failure shape: with no model on disk the job fails with the
 * structured `model-missing:` error that the Pairing page turns into a
 * "download it" prompt, and writes nothing. Get that wrong and the only
 * symptom is a prompt that never appears and a job that just looks broken.
 *
 * The engine's own behaviour is covered in alignment/ctc/engine.test.ts.
 */

let tmp: string;
let ctx: AppContext;
let pairSeq = 0;

const EBOOK_ID = 'bk_fa_ebook';

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

function claimWithGuard(): { job: JobRow; guard: ReturnType<typeof makeLeaseGuard> } {
  const job = claimNextJob(ctx.db)!;
  return { job, guard: makeLeaseGuard(ctx.db, job) };
}

/**
 * A fresh audiobook + pair for the shared ebook. One per test: `pairs` is
 * unique on (ebook_id, audio_id), and a test that aligned must not colour the
 * next one's starting state.
 */
function makePair(): string {
  const n = ++pairSeq;
  const audioId = `bk_fa_audio_${n}`;
  const pairId = `pair_fa_${n}`;
  const dir = path.join(tmp, 'lib', `audio-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.alloc(64, 7));
  ctx.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
       VALUES (?, 'audio', ?, '.', 'mp3', 'Alignable Audio', 1, 'ready', ?)`,
    )
    .run(audioId, dir, nowIso());
  ctx.db
    .prepare(
      `INSERT INTO audio_tracks (book_id, idx, rel_path, duration_ms, size_bytes, format, start_ms_absolute)
       VALUES (?, 0, 'a.mp3', 900, 64, 'mp3', 0)`,
    )
    .run(audioId);
  ctx.db
    .prepare(
      `INSERT INTO pairs (id, ebook_id, audio_id, status, score, created_at)
       VALUES (?, ?, ?, 'confirmed', 0.95, ?)`,
    )
    .run(pairId, EBOOK_ID, audioId, nowIso());
  return pairId;
}

async function align(pairId: string): Promise<unknown> {
  enqueueJob(ctx.db, 'align', { pairId });
  const { job, guard } = claimWithGuard();
  return runAlign(ctx, job, guard).then(
    () => null,
    (err: unknown) => err,
  );
}

const alignmentCount = (pairId: string): number =>
  (
    ctx.db.prepare('SELECT COUNT(*) AS c FROM alignments WHERE pair_id = ?').get(pairId) as {
      c: number;
    }
  ).c;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-forcedalign-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    // Empty: nothing is installed, which is the state the "download it" prompt
    // exists for.
    modelsDir: path.join(tmp, 'models'),
    sessionSecret: 'forcedalign-test-secret-0123456789',
    logLevel: 'error',
  });
  ctx = {
    db: openMemoryDatabase(),
    config,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };

  const root = path.join(tmp, 'lib');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'novel.epub'), makeEpub('Alignable', ['Hello world sentence.']));
  ctx.db
    .prepare(
      `INSERT INTO books (id, kind, root_dir, rel_path, format, title, size_bytes, scan_state, added_at)
       VALUES (?, 'ebook', ?, 'novel.epub', 'epub', 'Alignable', 1, 'discovered', ?)`,
    )
    .run(EBOOK_ID, root, nowIso());
  enqueueJob(ctx.db, 'index-ebook', { bookId: EBOOK_ID });
  const idx = claimWithGuard();
  await runIndexEbook(ctx, idx.job, idx.guard);
  // Pin the narration language so no test can reach the whisper language
  // detector; this file is about engine selection, not language resolution.
  ctx.db.prepare('UPDATE books SET language = ? WHERE id = ?').run('en', EBOOK_ID);

  // A whisper model path that exists. The legacy engine's model check runs
  // before the forced-align branch and accepts any out-of-catalog file, so
  // this is what keeps the assertions below about the ALIGNER rather than
  // about a whisper model that the forced-align path never opens.
  fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'models', 'custom-whisper.bin'), Buffer.alloc(16));
});

afterAll(() => {
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runAlign without the alignment model installed', () => {
  it('fails with the structured error the Pairing page turns into a download', async () => {
    const pairId = makePair();

    const err = await align(pairId);

    expect(err).toBeInstanceOf(ModelMissingError);
    const missing = err as ModelMissingError;
    expect(missing.modelId).toBe(ALIGNER_MODEL_ID);
    // The Pairing page parses this prefix to offer the download; if the shape
    // drifts, the prompt silently degrades to a raw error string.
    const parsed = parseModelMissing(missing.message);
    expect(parsed).not.toBeNull();
    expect(parsed!.modelId).toBe(ALIGNER_MODEL_ID);
    expect(parsed!.message).toContain('Settings');
  });

  it('writes nothing at all when it could not run', async () => {
    const pairId = makePair();

    await align(pairId);

    expect(alignmentCount(pairId)).toBe(0);
    const pair = ctx.db.prepare('SELECT compat_json FROM pairs WHERE id = ?').get(pairId) as {
      compat_json: string | null;
    };
    expect(pair.compat_json).toBeNull();
  });

  it('has already settled the language before it asks for the model', async () => {
    // Language resolution used to need a speech model of its own. It now reads
    // the ebook, so it must complete even on a server with nothing installed —
    // and the answer is recorded whether or not the alignment can proceed.
    const pairId = makePair();

    await align(pairId);

    const row = ctx.db.prepare('SELECT detected_language FROM pairs WHERE id = ?').get(pairId) as {
      detected_language: string | null;
    };
    expect(row.detected_language).toBe('en');
  });
});
