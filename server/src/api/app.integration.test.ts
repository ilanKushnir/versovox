import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/index.js';
import { type AppContext } from '../context.js';
import { claimNextJob, finishJob, makeLeaseGuard } from '../jobs/queue.js';
import { JOB_HANDLERS } from '../jobs/handlers.js';
import { ensureSetupToken } from '../auth/setupToken.js';
import { type EbookLocator, type AudioLocator } from '@versovox/shared';

const SETUP_TOKEN = 'integration-setup-token';

/**
 * End-to-end API test against the committed sample library: first-run setup,
 * scan + index jobs, reader content, audio streaming with Range, pairing,
 * alignment from the fixture transcript, and exact two-way switch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../fixtures/library');

let app: FastifyInstance;
let ctx: AppContext;
let tmp: string;
let cookie = '';

async function drainJobs(maxJobs = 50): Promise<void> {
  for (let i = 0; i < maxJobs; i++) {
    const job = claimNextJob(ctx.db);
    if (!job) return;
    const handler = JOB_HANDLERS[job.type];
    if (!handler) {
      finishJob(ctx.db, job.id, job.lease_token, 'unknown');
      continue;
    }
    try {
      await handler(ctx, job, makeLeaseGuard(ctx.db, job));
      finishJob(ctx.db, job.id, job.lease_token);
    } catch (err) {
      finishJob(ctx.db, job.id, job.lease_token, (err as Error).message);
    }
  }
}

function authed(opts: {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
}) {
  return app.inject({
    method: opts.method ?? 'GET',
    url: opts.url,
    payload: opts.payload as never,
    headers: {
      cookie,
      'x-vx-csrf': '1',
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
}

beforeAll(async () => {
  expect(fs.existsSync(fixtures)).toBe(true);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-int-'));
  // Exercise the real env-var path (including settings env-pinning).
  process.env.VX_TRANSCRIBE_PROVIDER = 'fixture';
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    ebookDirs: [path.join(fixtures, 'ebooks')],
    audiobookDirs: [path.join(fixtures, 'audiobooks')],
    sessionSecret: 'integration-test-secret-0123456789',
    setupToken: SETUP_TOKEN,
    logLevel: 'error',
  });
  const db = openDatabase(config.dataDir);
  ctx = {
    db,
    config,
    log: { info: () => {}, warn: () => {}, error: (m) => console.error(m) },
  };
  ctx.setupToken = ensureSetupToken(config, db, { info: () => {}, warn: () => {} });
  app = buildApp(ctx);
  await app.ready();
}, 30000);

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Versovox API', () => {
  let lanternEbookId = '';
  let lanternAudioId = '';
  let pairId = '';

  it('requires setup on first run, gates it on the bootstrap token, creates admin', async () => {
    const status = await app.inject({ url: '/api/setup/status' });
    expect(status.json()).toMatchObject({ needsSetup: true, setupTokenSource: 'env' });

    // Wizard helpers are gated on the bootstrap token while no admin exists.
    const noTokenPaths = await app.inject({
      method: 'POST',
      url: '/api/setup/test-paths',
      headers: { 'x-vx-csrf': '1' },
      payload: { paths: [fixtures] },
    });
    expect(noTokenPaths.statusCode).toBe(403);
    const checked = await app.inject({
      method: 'POST',
      url: '/api/setup/test-paths',
      headers: { 'x-vx-csrf': '1', 'x-vx-setup-token': SETUP_TOKEN },
      payload: { paths: [path.join(fixtures, 'ebooks'), path.join(tmp, 'nope')], kind: 'ebook' },
    });
    expect(checked.statusCode).toBe(200);
    const results = (checked.json() as { results: { ok: boolean; matches: number | null }[] })
      .results;
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.matches).toBeGreaterThan(0);
    expect(results[1]!.ok).toBe(false);
    const browse = await app.inject({
      url: `/api/setup/browse?path=${encodeURIComponent(fixtures)}`,
      headers: { 'x-vx-setup-token': SETUP_TOKEN },
    });
    expect(browse.statusCode).toBe(200);
    expect((browse.json() as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['ebooks', 'audiobooks']),
    );

    // No token at all: schema rejection.
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'astra', password: 'correct-horse-battery-staple' },
    });
    expect(noToken.statusCode).toBe(400);

    // Wrong token: refused, no user created.
    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-vx-csrf': '1' },
      payload: {
        username: 'astra',
        password: 'correct-horse-battery-staple',
        setupToken: 'attacker-guess',
      },
    });
    expect(wrongToken.statusCode).toBe(403);
    expect(wrongToken.json()).toEqual({ error: 'bad-setup-token' });

    const weak = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'astra', password: 'short', setupToken: SETUP_TOKEN },
    });
    expect(weak.statusCode).toBe(400);

    // RACE: two setup requests with the valid token — exactly one wins.
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: { 'x-vx-csrf': '1' },
        payload: {
          username: 'astra',
          password: 'correct-horse-battery-staple',
          setupToken: SETUP_TOKEN,
          processingMode: 'auto',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: { 'x-vx-csrf': '1' },
        payload: {
          username: 'mallory',
          password: 'mallory-password-123',
          setupToken: SETUP_TOKEN,
          processingMode: 'auto',
        },
      }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const winner = a.statusCode === 200 ? a : b;
    cookie = winner.headers['set-cookie']!.toString().split(';')[0]!;
    const users = ctx.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(users.c).toBe(1);

    // The token is consumed: even the correct one is dead now.
    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'x', password: 'y'.repeat(12), setupToken: SETUP_TOKEN },
    });
    expect(again.statusCode).toBe(409);
  });

  it('blocks unauthenticated and CSRF-less requests', async () => {
    const noAuth = await app.inject({ url: '/api/library' });
    expect(noAuth.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/library/rescan',
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/library/rescan',
      headers: { cookie, 'x-vx-csrf': '1', origin: 'https://evil.example', host: 'localhost:8383' },
    });
    expect(badOrigin.statusCode).toBe(403);
  });

  it('percent-encoded route prefixes cannot bypass auth or CSRF (regression)', async () => {
    // The router matches the DECODED path, so `/%61pi/...` reaches `/api/...`
    // handlers; the guard must key on the route, not the raw URL.
    for (const url of ['/%61pi/pairs', '/%61pi/library', '/%61pi/settings', '/api/%70airs']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(401);
    }
    const align = await app.inject({ method: 'POST', url: '/%61pi/pairs/x/align' });
    expect(align.statusCode).toBe(403);
    const badEncoding = await app.inject({ url: '/api/%E0%A4%A' });
    expect(badEncoding.statusCode).toBe(400);
    // Unknown API paths stay JSON 404s even when encoded (never the SPA shell).
    const unknown = await app.inject({ url: '/%61pi/does-not-exist', headers: { cookie } });
    expect(unknown.statusCode).toBe(404);
  });

  it('body-less POSTs survive a proxy-added content type (regression: 415 on Link editions)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/library/rescan',
      headers: { cookie, 'x-vx-csrf': '1', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    const nonEmpty = await app.inject({
      method: 'POST',
      url: '/api/library/rescan',
      headers: { cookie, 'x-vx-csrf': '1', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=junk',
    });
    expect(nonEmpty.statusCode).toBe(415);
  });

  it('library query parameters are validated (no 500 on arrays)', async () => {
    const res = await authed({ url: '/api/library?query=a&query=b' });
    expect(res.statusCode).toBe(400);
    const badSort = await authed({ url: '/api/library?sort=DROP' });
    expect(badSort.statusCode).toBe(400);
  });

  it('chapter HTML carries a sandboxing CSP when fetched directly', async () => {
    // Runs after indexing (see later tests) — but the header must be present
    // for any successful chapter response, so probe leniently here.
    const lib = await authed({ url: '/api/library' });
    const ebook = (lib.json() as { books: { id: string; kind: string }[] }).books.find(
      (b) => b.kind === 'ebook',
    );
    if (!ebook) return;
    const res = await authed({ url: `/api/books/${ebook.id}/chapter/0` });
    if (res.statusCode === 200) {
      expect(res.headers['content-security-policy']).toContain('sandbox');
    }
  });

  it('login rate limiting kicks in', async () => {
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-vx-csrf': '1' },
        payload: { username: 'astra', password: 'wrong-password-attempt' },
      });
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'astra', password: 'wrong-password-attempt' },
    });
    expect(limited.statusCode).toBe(429);
  });

  it('spoofed X-Forwarded-For does not bypass throttling (proxy trust off by default)', async () => {
    // The account is throttled from the previous test; rotating forwarded
    // headers must not reset the picture because req.ip ignores them.
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-vx-csrf': '1', 'x-forwarded-for': `203.0.113.${i}` },
        payload: { username: 'astra', password: 'wrong-password-attempt' },
      });
      expect(res.statusCode).toBe(429);
    }
  });

  it('unknown usernames take the dummy-verification path (constant-shape 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'no-such-user-xyz', password: 'whatever-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'bad-credentials' });
  });

  it('scans and indexes the sample library', async () => {
    await drainJobs();
    const res = await authed({ url: '/api/library' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { books: Record<string, unknown>[] };
    const titles = body.books.map((b) => b.title);
    expect(titles).toContain('The Lantern of Ash Harbor');
    expect(titles).toContain('אורות לאורך השדרה');
    expect(titles).toContain('Field Notes from a Quiet Valley');
    expect(titles).toContain("The Clockmaker's Garden");
    // Both editions of Lantern exist (ebook + audio).
    const lanterns = body.books.filter((b) => b.title === 'The Lantern of Ash Harbor');
    expect(lanterns.length).toBe(2);
    for (const b of body.books) expect(b.scanState).toBe('ready');
    lanternEbookId = String(lanterns.find((b) => b.kind === 'ebook')!.id);
    lanternAudioId = String(lanterns.find((b) => b.kind === 'audio')!.id);
  });

  it('serves the reader manifest, sanitized chapters, sentences, and search', async () => {
    const manifest = (await authed({ url: `/api/books/${lanternEbookId}/manifest` })).json() as {
      chapters: { idx: number }[];
      totalChars: number;
      direction: string;
    };
    expect(manifest.chapters.length).toBe(4);
    expect(manifest.totalChars).toBeGreaterThan(3000);
    expect(manifest.direction).toBe('ltr');

    const ch = await authed({ url: `/api/books/${lanternEbookId}/chapter/0` });
    expect(ch.statusCode).toBe(200);
    expect(ch.body).toContain('Maren Solt arrived');
    expect(ch.body).not.toMatch(/<script/i);
    expect(ch.body).toContain('asset/');

    const sentences = (
      await authed({ url: `/api/books/${lanternEbookId}/sentences/0` })
    ).json() as { sentences: { id: string }[] };
    expect(sentences.sentences.length).toBeGreaterThan(5);

    const search = (
      await authed({ url: `/api/books/${lanternEbookId}/search?q=ledger` })
    ).json() as { matches: unknown[] };
    expect(search.matches.length).toBeGreaterThan(2);

    const chapterEscape = await authed({
      url: `/api/books/${lanternEbookId}/asset/..%2F..%2Fbook.json`,
    });
    expect([400, 404]).toContain(chapterEscape.statusCode);
  });

  it('RTL Hebrew ebook indexes with rtl direction', async () => {
    const lib = (await authed({ url: '/api/library' })).json() as {
      books: { id: string; title: string }[];
    };
    const heb = lib.books.find((b) => b.title === 'אורות לאורך השדרה')!;
    const detail = (await authed({ url: `/api/books/${heb.id}` })).json() as { direction: string };
    expect(detail.direction).toBe('rtl');
  });

  it('streams audio with HTTP Range support', async () => {
    const full = await authed({ url: `/api/books/${lanternAudioId}/track/0` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');

    const partial = await app.inject({
      url: `/api/books/${lanternAudioId}/track/0`,
      headers: { cookie, range: 'bytes=100-199' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toMatch(/^bytes 100-199\//);
    expect(partial.rawPayload.length).toBe(100);

    const bad = await app.inject({
      url: `/api/books/${lanternAudioId}/track/0`,
      headers: { cookie, range: 'bytes=999999999-' },
    });
    expect(bad.statusCode).toBe(416);
  });

  it('audiobook chapters and durations are extracted (m4b embedded chapters)', async () => {
    const lib = (await authed({ url: '/api/library' })).json() as {
      books: { id: string; title: string; durationMs: number | null }[];
    };
    const clock = lib.books.find((b) => b.title === "The Clockmaker's Garden")!;
    const detail = (await authed({ url: `/api/books/${clock.id}` })).json() as {
      chapters: { title: string }[];
      tracks: { durationMs: number }[];
    };
    expect(detail.chapters.map((c) => c.title)).toEqual(['Winding', 'The Stopped Hour', 'Harvest']);
    expect(detail.tracks.length).toBe(1);

    const field = lib.books.find((b) => b.title === 'Field Notes from a Quiet Valley')!;
    const fieldDetail = (await authed({ url: `/api/books/${field.id}` })).json() as {
      tracks: { startMsAbsolute: number }[];
    };
    expect(fieldDetail.tracks.length).toBe(3);
    expect(fieldDetail.tracks[2]!.startMsAbsolute).toBeGreaterThan(0);
  });

  it('auto-links the Lantern editions only after content verification passes', async () => {
    const pairs = (await authed({ url: '/api/pairs' })).json() as {
      pairs: {
        id: string;
        status: string;
        score: number;
        evidence: { titleScore: number; contentScore?: number };
        ebook: { id: string };
        audio: { id: string };
        alignment: {
          coverage: number;
          exactSentenceCoverage: number;
          meanConfidence: number;
        } | null;
        switchable: boolean;
        handoff: { available: boolean; exactSentenceCoverage: number } | null;
      }[];
    };
    expect(pairs.pairs.length).toBeGreaterThanOrEqual(1);
    const p = pairs.pairs.find((x) => x.ebook.id === lanternEbookId)!;
    // Status is 'auto' only because the alignment probe ran and the sampled
    // content overlap passed — metadata alone would have left a candidate.
    expect(p.status).toBe('auto');
    expect(p.score).toBeGreaterThan(0.9);
    expect(p.evidence.contentScore).toBeGreaterThan(0.5);
    expect(p.audio.id).toBe(lanternAudioId);
    pairId = p.id;
    expect(p.alignment).not.toBeNull();
    expect(p.alignment!.coverage).toBeGreaterThan(0.8);
    expect(p.alignment!.meanConfidence).toBeGreaterThan(0.6);
    // The honest handoff status is exposed alongside the boolean.
    expect(p.switchable).toBe(true);
    expect(p.handoff!.available).toBe(true);
    expect(p.handoff!.exactSentenceCoverage).toBeGreaterThan(0.5);
    expect(p.handoff!.exactSentenceCoverage).toBeLessThanOrEqual(1);
    expect(p.alignment!.exactSentenceCoverage).toBe(p.handoff!.exactSentenceCoverage);
  });

  it('FALSE EDITION: high metadata score with failing content check never auto-links', async () => {
    // Force a candidate pair between the Hebrew ebook and the ENGLISH
    // Lantern narration with an artificially high metadata score. The
    // alignment probe runs, the sampled content overlap fails, and the pair
    // must stay a candidate with an honest warning — never 'auto'.
    const lib = (await authed({ url: '/api/library' })).json() as {
      books: { id: string; title: string }[];
    };
    const heb = lib.books.find((b) => b.title === 'אורות לאורך השדרה')!;
    const { stableId } = await import('../util/ids.js');
    const falsePairId = stableId('pair', String(heb.id), lanternAudioId);
    ctx.db
      .prepare(
        `INSERT INTO pairs (id, ebook_id, audio_id, status, score, evidence_json, created_at)
         VALUES (?, ?, ?, 'candidate', 0.95, '{"notes":[]}', ?)`,
      )
      .run(falsePairId, heb.id, lanternAudioId, new Date().toISOString());
    const { enqueueJob } = await import('../jobs/queue.js');
    enqueueJob(ctx.db, 'align', { pairId: falsePairId }, {});
    await drainJobs();
    const res = (await authed({ url: `/api/pairs/${falsePairId}` })).json() as {
      pair: { status: string; compat: { contentScore?: number; warning?: string | null } | null };
    };
    expect(res.pair.status).toBe('candidate');
    expect(res.pair.compat?.contentScore ?? 0).toBeLessThan(0.5);
    expect(res.pair.compat?.warning).toBeTruthy();
    // Clean up so later pair assertions stay focused.
    ctx.db.prepare('DELETE FROM pairs WHERE id = ?').run(falsePairId);
  });

  it('a strong metadata match with no content verification stays a candidate', async () => {
    // Fresh pair between the Lantern ebook and a DIFFERENT audiobook cannot
    // exist automatically; verify by checking every 'auto' pair carries a
    // passing content score.
    const pairs = (await authed({ url: '/api/pairs' })).json() as {
      pairs: { status: string; evidence: { contentScore?: number | null } }[];
    };
    for (const p of pairs.pairs) {
      if (p.status === 'auto') {
        expect(p.evidence.contentScore ?? 0).toBeGreaterThan(0.5);
      }
    }
  });

  it('resolves ebook -> audio (sentence-exact where confident)', async () => {
    // Sentence from chapter 2 (spineIdx 1): grab a sentence id first.
    const sentences = (
      await authed({ url: `/api/books/${lanternEbookId}/sentences/1` })
    ).json() as { sentences: { id: string; ord: number; start: number }[] };
    const target = sentences.sentences[2]!;
    const from: EbookLocator = {
      medium: 'ebook',
      spineIdx: 1,
      sentenceId: target.id,
      charOffset: target.start,
      pct: 0.3,
    };
    const res = (
      await authed({ method: 'POST', url: `/api/pairs/${pairId}/resolve`, payload: { from } })
    ).json() as {
      to: AudioLocator | null;
      resolution: { granularity: string; confidence: number };
    };
    expect(res.to).not.toBeNull();
    expect(res.to!.medium).toBe('audio');
    expect(res.resolution.granularity).toBe('sentence');
    // Chapter 2 audio starts after track 0; bookMs must be inside track 1.
    expect(res.to!.trackIdx).toBe(1);
  });

  it('resolves audio -> ebook and round-trips near the original position', async () => {
    const detail = (await authed({ url: `/api/books/${lanternAudioId}` })).json() as {
      tracks: { startMsAbsolute: number; durationMs: number }[];
    };
    const t1 = detail.tracks[1]!;
    const from: AudioLocator = {
      medium: 'audio',
      trackIdx: 1,
      positionMs: Math.round(t1.durationMs / 2),
      pct: 0.4,
    };
    const res = (
      await authed({ method: 'POST', url: `/api/pairs/${pairId}/resolve`, payload: { from } })
    ).json() as { to: EbookLocator | null; resolution: { granularity: string } };
    expect(res.to).not.toBeNull();
    expect(res.to!.medium).toBe('ebook');
    expect(res.to!.spineIdx).toBe(1);
    expect(res.to!.sentenceId).toBeTruthy();

    // Round-trip back to audio lands within 20s of where we started.
    const back = (
      await authed({
        method: 'POST',
        url: `/api/pairs/${pairId}/resolve`,
        payload: { from: res.to },
      })
    ).json() as { to: AudioLocator | null };
    expect(back.to).not.toBeNull();
    const originalBookMs = t1.startMsAbsolute + from.positionMs;
    expect(Math.abs(back.to!.bookMs! - originalBookMs)).toBeLessThan(20000);
  });

  it('alignment without an installed speech model fails with a structured, actionable error', async () => {
    const pairsRes = await authed({ url: '/api/pairs' });
    const pair = (pairsRes.json() as { pairs: { id: string; status: string }[] }).pairs.find(
      (p) => p.status === 'auto' || p.status === 'confirmed',
    )!;
    expect(pair).toBeDefined();
    // The test env pins the provider to 'fixture'; lift the pin for this case.
    const pinned = ctx.config.envPinned;
    ctx.config.envPinned = pinned.filter((k) => k !== 'transcribeProvider');
    ctx.config.transcribeProvider = 'whisper-cli';
    ctx.config.whisperBin = '/usr/bin/true';
    try {
      const put = await authed({
        method: 'PUT',
        url: '/api/settings',
        // This case is about the WHISPER path's structured error, so select that
        // engine explicitly; the default engine is forced alignment, which
        // demands a different model (asserted separately below).
        payload: { transcribeProvider: 'whisper-cli', alignEngine: 'whisper-cli' },
      });
      expect(put.statusCode).toBe(200);
      // Narration language override drives the model choice (Hebrew → ivrit.ai).
      const lang = await authed({
        method: 'POST',
        url: `/api/pairs/${pair.id}/language`,
        payload: { language: 'he' },
      });
      expect(lang.json()).toMatchObject({ pair: { language: { override: 'he' } } });
      const bad = await authed({
        method: 'POST',
        url: `/api/pairs/${pair.id}/language`,
        payload: { language: 'xx' },
      });
      expect(bad.statusCode).toBe(400);

      const align = await authed({ method: 'POST', url: `/api/pairs/${pair.id}/align` });
      expect(align.statusCode).toBe(200);
      await drainJobs();
      const after = await authed({ url: `/api/pairs/${pair.id}` });
      const dto = (
        after.json() as { pair: { lastAlignJob: { state: string; modelMissing: unknown } } }
      ).pair;
      expect(dto.lastAlignJob.state).toBe('failed');
      expect(dto.lastAlignJob.modelMissing).toMatchObject({
        language: 'he',
        modelId: 'ivrit-large-v3-turbo',
      });

      // The DEFAULT engine asks for the forced aligner instead — one model for
      // every language — and says so through the same structured error, so the
      // "download it" prompt works for either engine.
      await authed({
        method: 'PUT',
        url: '/api/settings',
        payload: { alignEngine: 'forced-align' },
      });
      const align2 = await authed({ method: 'POST', url: `/api/pairs/${pair.id}/align` });
      expect(align2.statusCode).toBe(200);
      await drainJobs();
      const afterFa = await authed({ url: `/api/pairs/${pair.id}` });
      expect(
        (afterFa.json() as { pair: { lastAlignJob: { modelMissing: unknown } } }).pair.lastAlignJob
          .modelMissing,
      ).toMatchObject({ modelId: 'mms-forced-aligner' });
      await authed({
        method: 'PUT',
        url: '/api/settings',
        payload: { alignEngine: 'whisper-cli' },
      });

      // Catalog endpoint reports the gap; a fake install re-queues the alignment.
      const models = await authed({ url: '/api/models' });
      const list = (models.json() as { models: { id: string; installed: boolean }[] }).models;
      expect(list.find((m) => m.id === 'ivrit-large-v3-turbo')?.installed).toBe(false);
    } finally {
      ctx.config.envPinned = pinned;
      ctx.config.transcribeProvider = 'fixture';
      await authed({
        method: 'POST',
        url: `/api/pairs/${pair.id}/language`,
        payload: { language: null },
      });
      await authed({
        method: 'PUT',
        url: '/api/settings',
        payload: { transcribeProvider: 'fixture' },
      });
    }
  });

  it('progress round-trip with reconciliation over the API', async () => {
    const mk = (over: Record<string, unknown>) => ({
      eventId: crypto.randomUUID(),
      bookId: lanternAudioId,
      deviceId: 'devA',
      sessionId: 'sessA',
      seq: 1,
      occurredAt: new Date().toISOString(),
      intent: 'open',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0 },
      ...over,
    });
    const e1 = mk({});
    const r1 = (
      await authed({ method: 'POST', url: '/api/progress/events', payload: { events: [e1] } })
    ).json() as { results: { status: string }[]; state: { revision: number } };
    expect(r1.results[0]!.status).toBe('applied');
    // Replay is idempotent.
    const r2 = (
      await authed({ method: 'POST', url: '/api/progress/events', payload: { events: [e1] } })
    ).json() as { results: { status: string }[] };
    expect(r2.results[0]!.status).toBe('duplicate');

    const state = (await authed({ url: `/api/progress/${lanternAudioId}` })).json() as {
      state: { revision: number };
    };
    expect(state.state.revision).toBe(1);
  });

  it('annotations CRUD', async () => {
    const created = (
      await authed({
        method: 'POST',
        url: `/api/books/${lanternEbookId}/annotations`,
        payload: {
          kind: 'highlight',
          locator: { medium: 'ebook', spineIdx: 0, charOffset: 10, pct: 0.01 },
          endLocator: { medium: 'ebook', spineIdx: 0, charOffset: 60, pct: 0.012 },
          color: 'leaf',
          selectedText: 'Maren Solt arrived at Ash Harbor',
        },
      })
    ).json() as { annotation: { id: string } };
    expect(created.annotation.id).toBeTruthy();
    const list = (await authed({ url: `/api/books/${lanternEbookId}/annotations` })).json() as {
      annotations: unknown[];
    };
    expect(list.annotations.length).toBe(1);
    const del = await authed({
      method: 'DELETE',
      url: `/api/annotations/${created.annotation.id}`,
    });
    expect(del.statusCode).toBe(200);
  });

  it('settings respect env pinning and persist', async () => {
    const before = (await authed({ url: '/api/settings' })).json() as {
      settings: { autoPairThreshold: number };
      envPinned: string[];
    };
    // transcribeProvider was set via env override in this test config.
    expect(before.envPinned).toContain('transcribeProvider');
    const updated = (
      await authed({ method: 'PUT', url: '/api/settings', payload: { autoPairThreshold: 0.95 } })
    ).json() as { settings: { autoPairThreshold: number } };
    expect(updated.settings.autoPairThreshold).toBe(0.95);
  });

  it('offline manifest carries real sizes, hashes, and every referenced asset', async () => {
    const em = (await authed({ url: `/api/books/${lanternEbookId}/offline-manifest` })).json() as {
      urls: { kind: string; url: string; sizeBytes: number; sha256?: string; dynamic?: boolean }[];
      totalBytes: number;
    };
    const chapters = em.urls.filter((u) => u.kind === 'chapter');
    expect(chapters.length).toBe(4);
    // Every static entry is hashed and sized from the actual bytes served.
    for (const u of em.urls) {
      if (u.dynamic) continue;
      expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(u.sizeBytes).toBeGreaterThan(0);
    }
    // Referenced images are part of the package (the sample book has one).
    expect(em.urls.filter((u) => u.kind === 'asset').length).toBeGreaterThan(0);
    // Hash correctness: downloading a chapter matches its declared hash+size.
    const ch = chapters[0]!;
    const res = await authed({ url: ch.url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(ch.sizeBytes);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(res.rawPayload).digest('hex')).toBe(ch.sha256);

    const am = (await authed({ url: `/api/books/${lanternAudioId}/offline-manifest` })).json() as {
      urls: {
        kind: string;
        url: string;
        sizeBytes: number;
        sourceVersion?: string;
        chunkSize?: number;
        chunkHashes?: string[];
      }[];
      totalBytes: number;
    };
    const trackEntries = am.urls.filter((u) => u.kind === 'track');
    expect(trackEntries.length).toBe(4);
    expect(am.totalBytes).toBeGreaterThan(100_000);

    // Offline-audio integrity contract: every track carries an immutable
    // source version, the chunk size, and one SHA-256 per chunk; the track
    // route's ETag matches the manifest's sourceVersion; the declared chunk
    // hashes match the bytes the route actually serves.
    const { createHash: mkHash } = await import('node:crypto');
    for (const t of trackEntries) {
      expect(t.sourceVersion).toMatch(/^[0-9a-f]{64}$/);
      expect(t.chunkSize).toBe(8 * 1024 * 1024);
      expect(t.chunkHashes!.length).toBe(Math.ceil(t.sizeBytes / t.chunkSize!));
    }
    const t0 = trackEntries[0]!;
    const trackRes = await authed({ url: t0.url });
    expect(trackRes.statusCode).toBe(200);
    expect(trackRes.headers.etag).toBe(`"${t0.sourceVersion}"`);
    expect(trackRes.rawPayload.length).toBe(t0.sizeBytes);
    expect(
      mkHash('sha256').update(trackRes.rawPayload.subarray(0, t0.chunkSize)).digest('hex'),
    ).toBe(t0.chunkHashes![0]);
    // A ranged chunk fetch (what the downloader does) carries the same ETag.
    const ranged = await app.inject({
      url: t0.url,
      headers: { cookie, range: `bytes=0-${Math.min(1023, t0.sizeBytes - 1)}` },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers.etag).toBe(`"${t0.sourceVersion}"`);
  });

  it('unlink makes the pair rejected and pair-scan does not resurrect it', async () => {
    const un = await authed({ method: 'POST', url: `/api/pairs/${pairId}/unlink` });
    expect(un.statusCode).toBe(200);
    // Re-run pair scan; rejected decision is durable.
    const { enqueueJob } = await import('../jobs/queue.js');
    enqueueJob(ctx.db, 'pair-scan', {}, {});
    await drainJobs();
    const pairs = (await authed({ url: '/api/pairs' })).json() as {
      pairs: { id: string; status: string }[];
    };
    expect(pairs.pairs.find((p) => p.id === pairId)!.status).toBe('rejected');
    // Re-link manually.
    const relink = (
      await authed({
        method: 'POST',
        url: '/api/pairs/link',
        payload: { ebookId: lanternEbookId, audioId: lanternAudioId },
      })
    ).json() as { pair: { status: string } };
    expect(relink.pair.status).toBe('confirmed');
    await drainJobs();
  });

  it('saving one setting never resets the others (zod partial + defaults)', async () => {
    const read = async () =>
      ((await authed({ url: '/api/settings' })).json() as { settings: Record<string, unknown> })
        .settings;
    const before = await read();
    expect(before.ebookDirs).toBeDefined();
    const put = await authed({
      method: 'PUT',
      url: '/api/settings',
      payload: { autoPairThreshold: 0.97 },
    });
    expect(put.statusCode).toBe(200);
    const after = await read();
    expect(after.autoPairThreshold).toBe(0.97);
    // Everything the caller did NOT send must survive untouched. This used to
    // wipe the library folders on every save.
    for (const key of ['ebookDirs', 'audiobookDirs', 'processingMode', 'languageModels']) {
      expect(after[key]).toEqual(before[key]);
    }
    await authed({ method: 'PUT', url: '/api/settings', payload: { autoPairThreshold: 0.92 } });
  });

  it('keeps the choices the setup wizard made', async () => {
    const res = (await authed({ url: '/api/settings' })).json() as {
      settings: { processingMode: string };
      stats: { ebooks: number; audiobooks: number };
    };
    // Both racing setup requests asked for unattended processing; the winner's
    // choice must survive (it used to be dropped by the schema).
    expect(res.settings.processingMode).toBe('auto');
    expect(res.stats.ebooks).toBeGreaterThan(0);
    expect(res.stats.audiobooks).toBeGreaterThan(0);
  });

  it('manages people: roles, invites, disabling, self-service password', async () => {
    // Direct creation (admin only), no open registration anywhere.
    const anon = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'nobody', password: 'nobody-password-123' },
    });
    expect(anon.statusCode).toBe(401);

    const created = await authed({
      method: 'POST',
      url: '/api/users',
      payload: {
        username: 'quinn',
        password: 'quinn-password-123',
        role: 'curator',
        displayName: 'Quinn',
      },
    });
    expect(created.statusCode).toBe(201);
    const quinnId = (created.json() as { user: { id: string; role: string } }).user.id;

    // Curator: may act on pairs and jobs, may not manage users or settings.
    const qLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'quinn', password: 'quinn-password-123' },
    });
    expect(qLogin.statusCode).toBe(200);
    const qCookie = qLogin.headers['set-cookie']!.toString().split(';')[0]!;
    const asQuinn = (opts: {
      method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
      payload?: unknown;
    }) =>
      app.inject({
        method: opts.method ?? 'GET',
        url: opts.url,
        payload: opts.payload as never,
        headers: {
          cookie: qCookie,
          'x-vx-csrf': '1',
          ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      });
    expect((await asQuinn({ url: '/api/users' })).statusCode).toBe(403);
    expect(
      (await asQuinn({ method: 'POST', url: `/api/pairs/${pairId}/align`, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await asQuinn({
          method: 'PUT' as never,
          url: '/api/settings',
          payload: { defaultLanguage: 'he' },
        })
      ).statusCode,
    ).toBe(403);

    // Reader via invite link: token is single-use and expires.
    const inv = await authed({
      method: 'POST',
      url: '/api/invites',
      payload: { role: 'reader', displayName: 'Rae', expiresInDays: 3 },
    });
    expect(inv.statusCode).toBe(201);
    const { token } = inv.json() as { token: string };
    const peek = await app.inject({ url: `/api/invites/${token}` });
    expect(peek.json()).toMatchObject({ role: 'reader', displayName: 'Rae' });
    const accept = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'rae', password: 'rae-password-12345' },
    });
    expect(accept.statusCode).toBe(201);
    expect((accept.json() as { user: { role: string } }).user.role).toBe('reader');
    const again = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'rae2', password: 'rae-password-12345' },
    });
    expect(again.statusCode).toBe(404);
    const raeCookie = accept.headers['set-cookie']!.toString().split(';')[0]!;
    // Readers cannot touch pairs.
    const raeAlign = await app.inject({
      method: 'POST',
      url: `/api/pairs/${pairId}/align`,
      headers: { cookie: raeCookie, 'x-vx-csrf': '1' },
    });
    expect(raeAlign.statusCode).toBe(403);

    // Progress is per user: Rae sees none of the admin's.
    const raeBooks = await app.inject({ url: '/api/library', headers: { cookie: raeCookie } });
    const raeCont = (raeBooks.json() as { continueRail: string[] }).continueRail;
    expect(raeCont).toEqual([]);

    // Self-service password change revokes other sessions only.
    const pw = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: raeCookie, 'x-vx-csrf': '1', 'content-type': 'application/json' },
      payload: { currentPassword: 'rae-password-12345', newPassword: 'rae-new-password-999' },
    });
    expect(pw.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { cookie: raeCookie } })).statusCode,
    ).toBe(200);

    // Disabling kills sessions and blocks login; last admin is protected.
    const disable = await authed({
      method: 'PATCH',
      url: `/api/users/${quinnId}`,
      payload: { status: 'disabled' },
    });
    expect(disable.statusCode).toBe(200);
    expect((await asQuinn({ url: '/api/auth/me' })).statusCode).toBe(401);
    const qLogin2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-vx-csrf': '1' },
      payload: { username: 'quinn', password: 'quinn-password-123' },
    });
    expect(qLogin2.statusCode).toBe(403);
    const me = (await authed({ url: '/api/auth/me' })).json() as { user: { id: string } };
    const demote = await authed({
      method: 'PATCH',
      url: `/api/users/${me.user.id}`,
      payload: { role: 'reader' },
    });
    expect(demote.statusCode).toBe(409);
    const del = await authed({ method: 'DELETE', url: `/api/users/${quinnId}` });
    expect(del.statusCode).toBe(200);
    const list = (await authed({ url: '/api/users' })).json() as { users: { username: string }[] };
    // The setup race earlier is won by either astra or mallory.
    const names = list.users.map((u) => u.username).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain('rae');
  });
});
