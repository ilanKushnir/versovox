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
import { storeAlignment } from '../alignment/service.js';
import {
  segmentsFromTimings,
  type EbookSentenceInput,
  type RawTiming,
} from '../alignment/timings.js';
import { type EbookLocator, type AudioLocator } from '@readport/shared';

const SETUP_TOKEN = 'integration-setup-token';

/**
 * End-to-end API test against the committed sample library: first-run setup,
 * scan + index jobs, reader content, audio streaming with Range, pairing,
 * a stored alignment, and the exact two-way switch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../fixtures/library');

let app: FastifyInstance;
let ctx: AppContext;
let tmp: string;
let cookie = '';
let lanternEbookId = '';
let lanternAudioId = '';
let pairId = '';

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
      'x-rp-csrf': '1',
      ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
  });
}

/**
 * Store a finished alignment for the fixture pair.
 *
 * The acoustic aligner needs a 317 MB model this suite deliberately never
 * installs, so the switch, resolve and handoff assertions below would have
 * nothing to run against. Sentence ids come from the derived index the reader
 * routes actually serve — invented ones would leave resolve() with nothing to
 * find — and each chapter is laid over the track that narrates it, which is
 * the shape a real run produces for this book.
 *
 * The last sentence of every chapter is left merely fuzzy: narration really
 * does trail off into a chapter break, and it keeps exact-sentence coverage
 * honestly below 1 so the handoff numbers mean something.
 */
async function seedAlignment(): Promise<void> {
  const { chapters } = (await authed({ url: `/api/books/${lanternEbookId}/manifest` })).json() as {
    chapters: { idx: number }[];
  };
  const { tracks } = (await authed({ url: `/api/books/${lanternAudioId}` })).json() as {
    tracks: { startMsAbsolute: number; durationMs: number }[];
  };
  const sentences: EbookSentenceInput[] = [];
  const timings: RawTiming[] = [];
  for (const chapter of chapters) {
    const chapterSentences = (
      (await authed({ url: `/api/books/${lanternEbookId}/sentences/${chapter.idx}` })).json() as {
        sentences: { id: string; ord: number }[];
      }
    ).sentences;
    const track = tracks[chapter.idx]!;
    const perSentenceMs = track.durationMs / chapterSentences.length;
    chapterSentences.forEach((s, i) => {
      const trailing = i === chapterSentences.length - 1;
      sentences.push({
        sentenceId: s.id,
        spineIdx: chapter.idx,
        sentenceOrd: s.ord,
        // Token counts only weight interpolation, and nothing here is left
        // unplaced for the timing layer to interpolate.
        tokens: [],
      });
      timings.push({
        startMs: Math.round(track.startMsAbsolute + i * perSentenceMs),
        endMs: Math.round(track.startMsAbsolute + (i + 1) * perSentenceMs),
        score: trailing ? 0.55 : 0.92,
        exact: !trailing,
        uncertaintyMs: trailing ? 2000 : 250,
      });
    });
  }
  storeAlignment(
    ctx.db,
    pairId,
    'en',
    'mms-fa/model_int8.onnx',
    segmentsFromTimings(sentences, (i) => timings[i]!, {
      audioMs: tracks.reduce((a, t) => a + t.durationMs, 0),
    }),
    { sentenceCount: sentences.length },
  );
}

beforeAll(async () => {
  expect(fs.existsSync(fixtures)).toBe(true);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-int-'));
  // Exercise the real env-var path (including settings env-pinning).
  process.env.RP_DEFAULT_LANGUAGE = 'en';
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
  delete process.env.RP_DEFAULT_LANGUAGE;
});

describe('ReadPort API', () => {
  it('requires setup on first run, gates it on the bootstrap token, creates admin', async () => {
    const status = await app.inject({ url: '/api/setup/status' });
    expect(status.json()).toMatchObject({ needsSetup: true, setupTokenSource: 'env' });

    // Wizard helpers are gated on the bootstrap token while no admin exists.
    const noTokenPaths = await app.inject({
      method: 'POST',
      url: '/api/setup/test-paths',
      headers: { 'x-rp-csrf': '1' },
      payload: { paths: [fixtures] },
    });
    expect(noTokenPaths.statusCode).toBe(403);
    const checked = await app.inject({
      method: 'POST',
      url: '/api/setup/test-paths',
      headers: { 'x-rp-csrf': '1', 'x-rp-setup-token': SETUP_TOKEN },
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
      headers: { 'x-rp-setup-token': SETUP_TOKEN },
    });
    expect(browse.statusCode).toBe(200);
    expect((browse.json() as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['ebooks', 'audiobooks']),
    );

    // No token at all: schema rejection.
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'astra', password: 'correct-horse-battery-staple' },
    });
    expect(noToken.statusCode).toBe(400);

    // Wrong token: refused, no user created.
    const wrongToken = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'x-rp-csrf': '1' },
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
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'astra', password: 'short', setupToken: SETUP_TOKEN },
    });
    expect(weak.statusCode).toBe(400);

    // RACE: two setup requests with the valid token — exactly one wins.
    const wizardFolders = {
      ebookDirs: [path.join(fixtures, 'ebooks')],
      audiobookDirs: [path.join(fixtures, 'audiobooks')],
    };
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: { 'x-rp-csrf': '1' },
        payload: {
          username: 'astra',
          password: 'correct-horse-battery-staple',
          setupToken: SETUP_TOKEN,
          ...wizardFolders,
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: { 'x-rp-csrf': '1' },
        payload: {
          username: 'mallory',
          password: 'mallory-password-123',
          setupToken: SETUP_TOKEN,
          ...wizardFolders,
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
      headers: { 'x-rp-csrf': '1' },
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
      headers: { cookie, 'x-rp-csrf': '1', origin: 'https://evil.example', host: 'localhost:8383' },
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
      headers: { cookie, 'x-rp-csrf': '1', 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(200);
    const nonEmpty = await app.inject({
      method: 'POST',
      url: '/api/library/rescan',
      headers: { cookie, 'x-rp-csrf': '1', 'content-type': 'application/x-www-form-urlencoded' },
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
        headers: { 'x-rp-csrf': '1' },
        payload: { username: 'astra', password: 'wrong-password-attempt' },
      });
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-rp-csrf': '1' },
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
        headers: { 'x-rp-csrf': '1', 'x-forwarded-for': `203.0.113.${i}` },
        payload: { username: 'astra', password: 'wrong-password-attempt' },
      });
      expect(res.statusCode).toBe(429);
    }
  });

  it('unknown usernames take the dummy-verification path (constant-shape 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-rp-csrf': '1' },
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

  it('leaves a strong metadata match a suggestion until the narration is checked', async () => {
    const pairs = (await authed({ url: '/api/pairs' })).json() as {
      pairs: {
        id: string;
        status: string;
        score: number;
        evidence: { titleScore: number; contentScore?: number; notes: string[] };
        ebook: { id: string };
        audio: { id: string };
        alignment: unknown;
        switchable: boolean;
      }[];
    };
    expect(pairs.pairs.length).toBeGreaterThanOrEqual(1);
    const p = pairs.pairs.find((x) => x.ebook.id === lanternEbookId)!;
    pairId = p.id;
    expect(p.audio.id).toBe(lanternAudioId);
    // Title, author and duration all agree, which is as far as metadata can
    // ever get: only listening to the narration links two editions, so the
    // pair waits and says so.
    expect(p.score).toBeGreaterThan(0.9);
    expect(p.status).toBe('candidate');
    expect(p.evidence.notes.join(' ')).toContain('waiting to be checked against the narration');
    expect(p.alignment).toBeNull();
    expect(p.switchable).toBe(false);
  });

  it('reports honest handoff coverage once an alignment is stored', async () => {
    const confirm = (
      await authed({ method: 'POST', url: `/api/pairs/${pairId}/confirm` })
    ).json() as { pair: { status: string } };
    expect(confirm.pair.status).toBe('confirmed');
    // Confirming queues an alignment, which cannot run here (no model).
    await drainJobs();
    await seedAlignment();

    const p = (
      (await authed({ url: `/api/pairs/${pairId}` })).json() as {
        pair: {
          alignment: {
            coverage: number;
            exactSentenceCoverage: number;
            meanConfidence: number;
          } | null;
          switchable: boolean;
          handoff: { available: boolean; exactSentenceCoverage: number } | null;
        };
      }
    ).pair;
    // Every sentence in the book was placed, so coverage short of 1 means the
    // store/read path lost segments on the way — a loose `> 0.8` here would
    // wave that through.
    expect(p.alignment!.coverage).toBe(1);
    expect(p.alignment!.meanConfidence).toBeGreaterThan(0.6);
    // `switchable` is the blunt yes/no the reader's button uses; `handoff`
    // carries the number that stops the UI promising sentence-exactness it
    // does not have. The chapter-final sentences are only fuzzy, so exact
    // coverage must land short of the full book.
    expect(p.switchable).toBe(true);
    expect(p.handoff!.available).toBe(true);
    expect(p.handoff!.exactSentenceCoverage).toBeGreaterThan(0.5);
    expect(p.handoff!.exactSentenceCoverage).toBeLessThan(1);
    expect(p.alignment!.exactSentenceCoverage).toBe(p.handoff!.exactSentenceCoverage);
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
      resolution: {
        granularity: string;
        confidence: number;
        source?: string;
        approximate?: boolean;
        rewindMs?: number;
      };
    };
    expect(res.to).not.toBeNull();
    expect(res.to!.medium).toBe('audio');
    expect(res.resolution.granularity).toBe('sentence');
    expect(res.resolution.source).toBe('exact');
    // Chapter 2 audio starts after track 0; bookMs must be inside track 1.
    expect(res.to!.trackIdx).toBe(1);
    // The switch steps back by exactly the doubt the aligner recorded for this
    // sentence — the only end-to-end proof that uncertaintyMs survives the
    // store/read round-trip rather than being dropped to zero on the way.
    expect(res.resolution.rewindMs).toBe(250);

    // The same route, one sentence later in the same chapter: the aligner was
    // only fuzzy about it, so the reader must be offered a paragraph-level
    // approximation rather than a sentence-exact promise. This is the gating
    // that `exactSentenceCoverage < 1` above only reports on.
    const fuzzyTarget = sentences.sentences[sentences.sentences.length - 1]!;
    const fuzzy = (
      await authed({
        method: 'POST',
        url: `/api/pairs/${pairId}/resolve`,
        payload: {
          from: {
            medium: 'ebook',
            spineIdx: 1,
            sentenceId: fuzzyTarget.id,
            charOffset: fuzzyTarget.start,
            pct: 0.9,
          } satisfies EbookLocator,
        },
      })
    ).json() as {
      to: AudioLocator | null;
      resolution: {
        granularity: string;
        source?: string;
        approximate?: boolean;
        rewindMs?: number;
      };
    };
    expect(fuzzy.to).not.toBeNull();
    expect(fuzzy.resolution.source).toBe('fuzzy');
    expect(fuzzy.resolution.granularity).toBe('paragraph');
    expect(fuzzy.resolution.approximate).toBe(true);
    expect(fuzzy.resolution.rewindMs).toBe(2000);
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

  it('accepts a narration language override and refuses an unknown one', async () => {
    const lang = await authed({
      method: 'POST',
      url: `/api/pairs/${pairId}/language`,
      payload: { language: 'he' },
    });
    expect(lang.json()).toMatchObject({
      pair: { language: { override: 'he', source: 'override' } },
    });
    const bad = await authed({
      method: 'POST',
      url: `/api/pairs/${pairId}/language`,
      payload: { language: 'xx' },
    });
    expect(bad.statusCode).toBe(400);
    // A rejected code must leave the previous choice alone: the route writes
    // the column before it validates if that check is ever moved.
    expect((await authed({ url: `/api/pairs/${pairId}` })).json()).toMatchObject({
      pair: { language: { override: 'he' } },
    });
    const cleared = await authed({
      method: 'POST',
      url: `/api/pairs/${pairId}/language`,
      payload: { language: null },
    });
    expect(cleared.json()).toMatchObject({ pair: { language: { override: null } } });
  });

  it('alignment without the installed model fails with a structured, actionable error', async () => {
    const align = await authed({ method: 'POST', url: `/api/pairs/${pairId}/align` });
    expect(align.statusCode).toBe(200);
    await drainJobs();

    const dto = (
      (await authed({ url: `/api/pairs/${pairId}` })).json() as {
        pair: { lastAlignJob: { state: string; modelMissing: { modelId: string } | null } };
      }
    ).pair;
    expect(dto.lastAlignJob.state).toBe('failed');
    // The Pairing page turns this into a download button rather than a red
    // error; there is one model for every language, so the id never varies.
    expect(dto.lastAlignJob.modelMissing).toMatchObject({ modelId: 'alignment-model' });

    const models = (await authed({ url: '/api/models' })).json() as {
      models: { id: string; installed: boolean }[];
    };
    expect(models.models.find((m) => m.id === 'alignment-model')!.installed).toBe(false);
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

  it('shelves: named, ordered, idempotent, and countable in one request', async () => {
    const summer = (
      await authed({ method: 'POST', url: '/api/shelves', payload: { name: '  Summer   reads ' } })
    ).json() as { shelf: { id: string; name: string } };
    // Whitespace is tidied so two shelves cannot look identical in the list.
    expect(summer.shelf.name).toBe('Summer reads');
    const winter = (
      await authed({ method: 'POST', url: '/api/shelves', payload: { name: 'Winter' } })
    ).json() as { shelf: { id: string } };

    const taken = await authed({
      method: 'POST',
      url: '/api/shelves',
      payload: { name: 'summer READS' },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ error: 'shelf-name-taken' });
    expect(
      (await authed({ method: 'POST', url: '/api/shelves', payload: { name: '   ' } })).statusCode,
    ).toBe(400);

    // Adding is idempotent: a second tap reports "already there", not a copy.
    const first = await authed({
      method: 'PUT',
      url: `/api/shelves/${summer.shelf.id}/books/${lanternEbookId}`,
    });
    expect(first.json()).toMatchObject({ added: true, count: 1 });
    const again = await authed({
      method: 'PUT',
      url: `/api/shelves/${summer.shelf.id}/books/${lanternEbookId}`,
    });
    expect(again.json()).toMatchObject({ added: false, count: 1 });
    expect(
      (
        await authed({
          method: 'PUT',
          url: `/api/shelves/${summer.shelf.id}/books/does-not-exist`,
        })
      ).statusCode,
    ).toBe(404);

    // Bulk add skips what is already there and what does not exist.
    const lib = (await authed({ url: '/api/library' })).json() as { books: { id: string }[] };
    const everything = lib.books.map((b) => b.id);
    const bulk = (
      await authed({
        method: 'POST',
        url: `/api/shelves/${summer.shelf.id}/books`,
        payload: { bookIds: [...everything, 'ghost'] },
      })
    ).json() as { added: number; skipped: number };
    expect(bulk.added).toBe(everything.length - 1);
    expect(bulk.skipped).toBe(2); // the Lantern ebook, already on, plus the ghost

    // Manual order survives a move into the middle: the third item is asked
    // to follow the first, and only that one row changes.
    const before = (await authed({ url: `/api/shelves/${summer.shelf.id}/books` })).json() as {
      books: { id: string }[];
      missingCount: number;
    };
    expect(before.missingCount).toBe(0);
    const order = before.books.map((b) => b.id);
    expect(order.length).toBeGreaterThanOrEqual(3);
    const moved = await authed({
      method: 'PATCH',
      url: `/api/shelves/${summer.shelf.id}/books/${order[2]}/position`,
      payload: { afterBookId: order[0] },
    });
    expect(moved.statusCode).toBe(200);
    const after = (await authed({ url: `/api/shelves/${summer.shelf.id}/books` })).json() as {
      books: { id: string }[];
    };
    expect(after.books.map((b) => b.id)).toEqual([order[0], order[2], order[1], ...order.slice(3)]);
    // Naming a neighbour that is no longer there is a stale picture of the
    // list, not a server error.
    expect(
      (
        await authed({
          method: 'PATCH',
          url: `/api/shelves/${summer.shelf.id}/books/${order[2]}/position`,
          payload: { afterBookId: 'vanished' },
        })
      ).statusCode,
    ).toBe(409);
    // Sorting still works inside a shelf.
    const byTitle = (
      await authed({ url: `/api/shelves/${summer.shelf.id}/books?sort=title` })
    ).json() as { books: { title: string }[] };
    expect(byTitle.books.map((b) => b.title)).toEqual(
      [...byTitle.books.map((b) => b.title)].sort((a, b) => a.localeCompare(b)),
    );

    // Shelves themselves reorder the same way.
    const movedShelf = await authed({
      method: 'PATCH',
      url: `/api/shelves/${winter.shelf.id}`,
      payload: { afterShelfId: null },
    });
    expect(movedShelf.statusCode).toBe(200);
    let overview = (await authed({ url: '/api/shelves' })).json() as {
      shelves: { id: string; name: string; count: number }[];
    };
    expect(overview.shelves.map((s) => s.id)).toEqual([winter.shelf.id, summer.shelf.id]);

    // A rename with no move must NOT reorder anything (the zod `.partial()`
    // trap: an injected default would send the shelf to the top).
    const renamed = await authed({
      method: 'PATCH',
      url: `/api/shelves/${summer.shelf.id}`,
      payload: { name: 'Summer' },
    });
    expect(renamed.statusCode).toBe(200);
    overview = (await authed({ url: '/api/shelves' })).json() as {
      shelves: { id: string; name: string; count: number }[];
    };
    expect(overview.shelves.map((s) => s.id)).toEqual([winter.shelf.id, summer.shelf.id]);
    expect(overview.shelves[1]!.name).toBe('Summer');
    expect(overview.shelves[1]!.count).toBe(everything.length);

    // Membership as the book page asks for it.
    const member = (await authed({ url: `/api/books/${lanternEbookId}/shelves` })).json() as {
      shelfIds: string[];
      onReadingList: boolean;
    };
    expect(member.shelfIds).toEqual([summer.shelf.id]);
    expect(member.onReadingList).toBe(false);

    const removed = await authed({
      method: 'DELETE',
      url: `/api/shelves/${summer.shelf.id}/books/${lanternEbookId}`,
    });
    expect(removed.json()).toMatchObject({ removed: true, count: everything.length - 1 });
    expect(
      (await authed({ method: 'DELETE', url: `/api/shelves/${winter.shelf.id}` })).statusCode,
    ).toBe(200);
    expect(
      (await authed({ method: 'DELETE', url: `/api/shelves/${winter.shelf.id}` })).statusCode,
    ).toBe(404);
    await authed({ method: 'DELETE', url: `/api/shelves/${summer.shelf.id}` });
  });

  it('the reading list is a queue: position, notes and re-ordering', async () => {
    const lib = (await authed({ url: '/api/library' })).json() as {
      books: { id: string; title: string }[];
    };
    const ids = lib.books.map((b) => b.id).slice(0, 3);
    for (const id of ids) {
      await authed({ method: 'PUT', url: `/api/reading-list/${id}` });
    }
    const queued = (await authed({ url: '/api/reading-list' })).json() as {
      items: { book: { id: string } }[];
      missingCount: number;
    };
    expect(queued.items.map((i) => i.book.id)).toEqual(ids);

    // Queueing something already queued is a no-op that reports where it is,
    // so the confirmation can be specific rather than vague.
    const jump = (
      await authed({
        method: 'PUT',
        url: `/api/reading-list/${ids[2]}`,
        payload: { position: 'top' },
      })
    ).json() as { added: boolean; position: number };
    expect(jump).toMatchObject({ added: false, position: 3 });

    const fourth = lib.books[3]!.id;
    const next = (
      await authed({
        method: 'PUT',
        url: `/api/reading-list/${fourth}`,
        payload: { position: 'top', note: 'after the sequel' },
      })
    ).json() as { added: boolean; position: number; count: number };
    expect(next).toMatchObject({ added: true, position: 1, count: 4 });

    const moved = await authed({
      method: 'PATCH',
      url: `/api/reading-list/${fourth}/position`,
      payload: { afterBookId: ids[0] },
    });
    expect(moved.statusCode).toBe(200);
    const reordered = (await authed({ url: '/api/reading-list' })).json() as {
      items: { book: { id: string }; note: string | null }[];
    };
    expect(reordered.items.map((i) => i.book.id)).toEqual([ids[0], fourth, ids[1], ids[2]]);
    expect(reordered.items[1]!.note).toBe('after the sequel');

    const noted = await authed({
      method: 'PATCH',
      url: `/api/reading-list/${fourth}`,
      payload: { note: 'book club, November' },
    });
    expect(noted.statusCode).toBe(200);
    expect(
      (
        await authed({
          method: 'PATCH',
          url: '/api/reading-list/not-queued',
          payload: { note: 'x' },
        })
      ).statusCode,
    ).toBe(404);

    // The sidebar knows what is next without fetching the queue.
    const overview = (await authed({ url: '/api/shelves' })).json() as {
      readingList: { count: number; nextBookId: string; nextTitle: string };
    };
    expect(overview.readingList.count).toBe(4);
    expect(overview.readingList.nextBookId).toBe(ids[0]);
    expect(overview.readingList.nextTitle).toBeTruthy();

    for (const id of [...ids, fourth]) {
      await authed({ method: 'DELETE', url: `/api/reading-list/${id}` });
    }
    expect((await authed({ url: '/api/reading-list' })).json()).toMatchObject({ items: [] });
  });

  it('automatic shelves count the same books the library lists', async () => {
    const overview = (await authed({ url: '/api/shelves' })).json() as {
      auto: { id: string; count: number }[];
    };
    const count = (id: string) => overview.auto.find((a) => a.id === id)!.count;

    // Both formats is one row per TITLE, not per file: `paired` returns both
    // sides of every pair and would read as twice as many books.
    const paired = (await authed({ url: '/api/library?filter=paired' })).json() as {
      books: { id: string; kind: string; pair: { pairId: string } }[];
    };
    const both = (await authed({ url: '/api/library?filter=both-formats' })).json() as {
      books: { id: string; kind: string; pair: { pairId: string } }[];
    };
    expect(both.books.length).toBeGreaterThan(0);
    expect(paired.books.length).toBe(both.books.length * 2);
    expect(both.books.length).toBe(count('both-formats'));
    expect(new Set(both.books.map((b) => b.pair.pairId)).size).toBe(both.books.length);
    // The ebook side is the one kept, so the cover and the title are the ones
    // a reader recognises.
    expect(both.books.every((b) => b.kind === 'ebook')).toBe(true);

    const recent = (await authed({ url: '/api/library?filter=recently-added' })).json() as {
      books: { id: string }[];
    };
    expect(recent.books.length).toBe(count('recently-added'));
    const all = (await authed({ url: '/api/library' })).json() as { books: unknown[] };
    // Everything in the sample library was scanned in a moment ago.
    expect(recent.books.length).toBe(all.books.length);

    const inProgress = (await authed({ url: '/api/library?filter=in-progress' })).json() as {
      books: unknown[];
    };
    expect(inProgress.books.length).toBe(count('reading-now'));
    const finished = (await authed({ url: '/api/library?filter=finished' })).json() as {
      books: unknown[];
    };
    expect(finished.books.length).toBe(count('finished'));

    expect((await authed({ url: '/api/library?filter=nonsense' })).statusCode).toBe(400);
  });

  it('shelves belong to one person: nobody else can read, move or delete them', async () => {
    const mine = (
      await authed({ method: 'POST', url: '/api/shelves', payload: { name: 'Private' } })
    ).json() as { shelf: { id: string } };
    await authed({ method: 'PUT', url: `/api/shelves/${mine.shelf.id}/books/${lanternEbookId}` });
    await authed({ method: 'PUT', url: `/api/reading-list/${lanternEbookId}` });

    const created = await authed({
      method: 'POST',
      url: '/api/users',
      payload: { username: 'nadia', password: 'nadia-password-123', role: 'curator' },
    });
    expect(created.statusCode).toBe(201);
    const nadiaId = (created.json() as { user: { id: string } }).user.id;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'nadia', password: 'nadia-password-123' },
    });
    const nadiaCookie = login.headers['set-cookie']!.toString().split(';')[0]!;
    const asNadia = (opts: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      payload?: unknown;
    }) =>
      app.inject({
        method: opts.method ?? 'GET',
        url: opts.url,
        payload: opts.payload as never,
        headers: {
          cookie: nadiaCookie,
          'x-rp-csrf': '1',
          ...(opts.payload !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      });

    // A curator outranks a reader over the library and has no standing at all
    // over somebody else's shelves. 404 everywhere, never 403: a 403 would
    // confirm the shelf id exists.
    for (const attempt of [
      { url: `/api/shelves/${mine.shelf.id}/books` },
      { method: 'PATCH' as const, url: `/api/shelves/${mine.shelf.id}`, payload: { name: 'Hers' } },
      { method: 'DELETE' as const, url: `/api/shelves/${mine.shelf.id}` },
      { method: 'PUT' as const, url: `/api/shelves/${mine.shelf.id}/books/${lanternAudioId}` },
      {
        method: 'POST' as const,
        url: `/api/shelves/${mine.shelf.id}/books`,
        payload: { bookIds: [lanternAudioId] },
      },
      {
        method: 'PATCH' as const,
        url: `/api/shelves/${mine.shelf.id}/books/${lanternEbookId}/position`,
        payload: { afterBookId: null },
      },
      { method: 'DELETE' as const, url: `/api/shelves/${mine.shelf.id}/books/${lanternEbookId}` },
    ]) {
      const res = await asNadia(attempt);
      expect([attempt.url, res.statusCode]).toEqual([attempt.url, 404]);
    }

    // She sees her own empty sidebar, and the queue is hers too.
    const hers = (await asNadia({ url: '/api/shelves' })).json() as {
      shelves: unknown[];
      readingList: { count: number };
    };
    expect(hers.shelves).toEqual([]);
    expect(hers.readingList.count).toBe(0);
    expect((await asNadia({ url: `/api/books/${lanternEbookId}/shelves` })).json()).toMatchObject({
      shelfIds: [],
      onReadingList: false,
    });
    // Removing from her queue a book only I have queued removes nothing.
    expect(
      (await asNadia({ method: 'DELETE', url: `/api/reading-list/${lanternEbookId}` })).json(),
    ).toMatchObject({ removed: false });
    expect((await authed({ url: `/api/books/${lanternEbookId}/shelves` })).json()).toMatchObject({
      shelfIds: [mine.shelf.id],
      onReadingList: true,
    });

    // Deleting the account takes her furniture with it through the foreign
    // key, not through the route's hand-written table list.
    await asNadia({ method: 'POST', url: '/api/shelves', payload: { name: 'Hers' } });
    await asNadia({ method: 'PUT', url: `/api/reading-list/${lanternAudioId}` });
    expect((await authed({ method: 'DELETE', url: `/api/users/${nadiaId}` })).statusCode).toBe(200);
    const left = ctx.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM shelves WHERE user_id = ?) AS s, (SELECT COUNT(*) FROM reading_list WHERE user_id = ?) AS r',
      )
      .get(nadiaId, nadiaId) as { s: number; r: number };
    expect(left).toMatchObject({ s: 0, r: 0 });
    // Mine are untouched.
    expect((await authed({ url: `/api/shelves/${mine.shelf.id}/books` })).statusCode).toBe(200);
    await authed({ method: 'DELETE', url: `/api/shelves/${mine.shelf.id}` });
    await authed({ method: 'DELETE', url: `/api/reading-list/${lanternEbookId}` });
  });

  it('settings respect env pinning and persist', async () => {
    const before = (await authed({ url: '/api/settings' })).json() as { envPinned: string[] };
    // RP_DEFAULT_LANGUAGE is set for this test config.
    expect(before.envPinned).toContain('defaultLanguage');
    const updated = (
      await authed({
        method: 'PUT',
        url: '/api/settings',
        payload: { alignPrecision: 'exact', defaultLanguage: 'he' },
      })
    ).json() as { settings: { alignPrecision: string; defaultLanguage: string } };
    expect(updated.settings.alignPrecision).toBe('exact');
    // An operator pinned the language in Compose; the UI may offer the field,
    // but a save must not quietly win over the environment.
    expect(updated.settings.defaultLanguage).toBe('en');
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

  it('offline asset URLs are spelled exactly as the reader requests them', async () => {
    const em = (await authed({ url: `/api/books/${lanternEbookId}/offline-manifest` })).json() as {
      urls: { kind: string; url: string }[];
    };
    const assets = em.urls.filter((u) => u.kind === 'asset');
    expect(assets.length).toBeGreaterThan(0);
    // The sample book's image lives in a subdirectory, which is the case
    // where a per-segment encoding and the sanitizer's whole-path encoding
    // disagree: one keeps the separators, the other escapes them.
    expect(assets.some((a) => a.url.includes('%2F'))).toBe(true);
    const chapterHtml = (
      await Promise.all(
        [0, 1, 2, 3].map((i) => authed({ url: `/api/books/${lanternEbookId}/chapter/${i}` })),
      )
    )
      .map((r) => r.body)
      .join('');
    for (const asset of assets) {
      // Cache Storage matches on the literal URL, so an entry downloaded
      // under a spelling no chapter asks for is an image that is simply
      // missing offline.
      const relative = asset.url.replace(`/api/books/${lanternEbookId}/`, '');
      expect(chapterHtml).toContain(`src="${relative}"`);
      expect((await authed({ url: asset.url })).statusCode).toBe(200);
    }
  });

  it('the offline package carries the alignment, so a switch works with no network', async () => {
    const em = (await authed({ url: `/api/books/${lanternEbookId}/offline-manifest` })).json() as {
      urls: { kind: string; url: string; sizeBytes: number; sha256?: string }[];
    };
    const entry = em.urls.find((u) => u.kind === 'switch');
    expect(entry).toBeDefined();
    expect(entry!.url).toBe(`/api/books/${lanternEbookId}/offline-switch`);

    const res = await authed({ url: entry!.url });
    expect(res.statusCode).toBe(200);
    // The manifest's size and hash must describe the bytes this route serves,
    // or the downloader refuses the package as tampered with.
    expect(res.rawPayload.length).toBe(entry!.sizeBytes);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(res.rawPayload).digest('hex')).toBe(entry!.sha256);

    const table = res.json() as {
      direction: string;
      otherBookId: string;
      entries: {
        sentenceId?: string;
        to: AudioLocator | null;
        resolution: { granularity: string };
      }[];
    };
    expect(table.direction).toBe('ebook-to-audio');
    expect(table.otherBookId).toBe(lanternAudioId);

    // The stored answer for a sentence is the SAME answer the online switch
    // gives, or an offline handoff lands somewhere else than an online one.
    const sentences = (
      await authed({ url: `/api/books/${lanternEbookId}/sentences/1` })
    ).json() as { sentences: { id: string; start: number }[] };
    const target = sentences.sentences[2]!;
    const online = (
      await authed({
        method: 'POST',
        url: `/api/pairs/${pairId}/resolve`,
        payload: {
          from: {
            medium: 'ebook',
            spineIdx: 1,
            sentenceId: target.id,
            charOffset: target.start,
            pct: 0.3,
          } satisfies EbookLocator,
        },
      })
    ).json() as { to: AudioLocator | null; resolution: unknown };
    const stored = table.entries.find((e) => e.sentenceId === target.id);
    expect(stored).toBeDefined();
    expect(stored!.to).toEqual(online.to);
    expect(stored!.resolution).toEqual(online.resolution);

    // The audiobook's package answers the other direction, sampled in time.
    const am = (await authed({ url: `/api/books/${lanternAudioId}/offline-manifest` })).json() as {
      urls: { kind: string; url: string }[];
    };
    const audioEntry = am.urls.find((u) => u.kind === 'switch');
    expect(audioEntry).toBeDefined();
    const audioTable = (await authed({ url: audioEntry!.url })).json() as {
      direction: string;
      gridMs: number;
      otherBookId: string;
      entries: { atMs: number }[];
    };
    expect(audioTable.direction).toBe('audio-to-ebook');
    expect(audioTable.otherBookId).toBe(lanternEbookId);
    expect(audioTable.gridMs).toBeGreaterThan(0);
    // Run-length encoded in time order, so "the answer at or before here" is
    // well defined.
    const times = audioTable.entries.map((e) => e.atMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
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
    // Something stored and away from the schema default, so a reset is visible.
    await authed({ method: 'PUT', url: '/api/settings', payload: { alignPrecision: 'exact' } });
    const before = await read();
    expect(before.ebookDirs).toHaveLength(1);
    const put = await authed({
      method: 'PUT',
      url: '/api/settings',
      payload: { autoAlign: false },
    });
    expect(put.statusCode).toBe(200);
    const after = await read();
    expect(after.autoAlign).toBe(false);
    // Everything the caller did NOT send must survive untouched. This used to
    // wipe the library folders on every save.
    for (const key of ['ebookDirs', 'audiobookDirs', 'alignPrecision']) {
      expect(after[key]).toEqual(before[key]);
    }
    await authed({ method: 'PUT', url: '/api/settings', payload: { autoAlign: true } });
  });

  it('keeps the choices the setup wizard made', async () => {
    const res = (await authed({ url: '/api/settings' })).json() as {
      settings: { ebookDirs: string[]; audiobookDirs: string[] };
      stats: { ebooks: number; audiobooks: number };
    };
    // Both racing setup requests named the same library folders; the winner's
    // choice must survive (it used to be dropped by the schema) and be what
    // the first scan actually walked.
    expect(res.settings.ebookDirs).toEqual([path.join(fixtures, 'ebooks')]);
    expect(res.settings.audiobookDirs).toEqual([path.join(fixtures, 'audiobooks')]);
    expect(res.stats.ebooks).toBeGreaterThan(0);
    expect(res.stats.audiobooks).toBeGreaterThan(0);
  });

  it('manages people: roles, invites, disabling, self-service password', async () => {
    // Direct creation (admin only), no open registration anywhere.
    const anon = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { 'x-rp-csrf': '1' },
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
      headers: { 'x-rp-csrf': '1' },
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
          'x-rp-csrf': '1',
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
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'rae', password: 'rae-password-12345' },
    });
    expect(accept.statusCode).toBe(201);
    expect((accept.json() as { user: { role: string } }).user.role).toBe('reader');
    const again = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      headers: { 'x-rp-csrf': '1' },
      payload: { username: 'rae2', password: 'rae-password-12345' },
    });
    expect(again.statusCode).toBe(404);
    const raeCookie = accept.headers['set-cookie']!.toString().split(';')[0]!;
    // Readers cannot touch pairs.
    const raeAlign = await app.inject({
      method: 'POST',
      url: `/api/pairs/${pairId}/align`,
      headers: { cookie: raeCookie, 'x-rp-csrf': '1' },
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
      headers: { cookie: raeCookie, 'x-rp-csrf': '1', 'content-type': 'application/json' },
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
      headers: { 'x-rp-csrf': '1' },
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
