import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../../config.js';
import { openMemoryDatabase } from '../../db/index.js';
import { type AppContext } from '../../context.js';

/**
 * The sync endpoint's contract with an offline queue: a batch is whatever the
 * client accumulated while it was away, so one bad event in it must not cost
 * the others their durability, and it must come back named so the client can
 * stop resending it.
 */

let app: FastifyInstance;
let ctx: AppContext;
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-progress-route-'));
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'),
    cacheDir: path.join(tmp, 'cache'),
    sessionSecret: 'progress-route-test-secret-0123456789',
    logLevel: 'error',
    proxyAuthHeader: 'x-vx-test-user',
    proxyAuthSources: ['10.0.0.0/8'],
  });
  ctx = {
    db: openMemoryDatabase(),
    config,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  app = buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (events: unknown) =>
  app.inject({
    method: 'POST',
    url: '/api/progress/events',
    remoteAddress: '10.0.0.5',
    headers: {
      'x-vx-csrf': '1',
      'content-type': 'application/json',
      'x-vx-test-user': 'dana',
    },
    payload: { events } as never,
  });

const stateOf = async (bookId: string) =>
  (
    await app.inject({
      url: `/api/progress/${bookId}`,
      remoteAddress: '10.0.0.5',
      headers: { 'x-vx-test-user': 'dana' },
    })
  ).json() as { state: { revision: number; locator: { positionMs?: number } } | null };

function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: crypto.randomUUID(),
    bookId: 'book1',
    deviceId: 'devA',
    sessionId: 'sessA',
    seq: 1,
    occurredAt: new Date().toISOString(),
    intent: 'open',
    locator: { medium: 'audio', trackIdx: 0, positionMs: 0, pct: 0 },
    ...over,
  };
}

type Ack = { results: { eventId: string; status: string }[]; states: { bookId: string }[] };

describe('POST /api/progress/events', () => {
  it('one malformed event is rejected on its own; the rest of the batch is durable', async () => {
    const good = ev({
      seq: 1,
      locator: { medium: 'audio', trackIdx: 0, positionMs: 500, pct: 0.1 },
    });
    const bad = ev({ seq: 2, locator: { medium: 'audio', trackIdx: 0 } });
    const later = ev({
      seq: 3,
      intent: 'heartbeat',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 900, pct: 0.2 },
    });
    const res = await post([good, bad, later]);
    expect(res.statusCode).toBe(200);
    const ack = res.json() as Ack;
    const byId = new Map(ack.results.map((r) => [r.eventId, r.status]));
    expect(byId.get(good.eventId as string)).toBe('applied');
    expect(byId.get(later.eventId as string)).toBe('applied');
    expect(byId.get(bad.eventId as string)).toBe('rejected');
    // Durable, not merely acknowledged.
    expect((await stateOf('book1')).state?.locator.positionMs).toBe(900);
  });

  it('a malformed event with no id to name is skipped, and the batch still applies', async () => {
    const good = ev({ bookId: 'book2', seq: 1 });
    const res = await post([{ nonsense: true }, good]);
    expect(res.statusCode).toBe(200);
    const ack = res.json() as Ack;
    expect(ack.results).toHaveLength(1);
    expect(ack.results[0]!.status).toBe('applied');
    expect((await stateOf('book2')).state?.revision).toBe(1);
  });

  it('acks every book in the batch, not just the last one', async () => {
    const res = await post([ev({ bookId: 'book3', seq: 1 }), ev({ bookId: 'book4', seq: 2 })]);
    expect((res.json() as Ack).states.map((s) => s.bookId)).toEqual(['book3', 'book4']);
  });

  it('an unusable envelope is still refused', async () => {
    expect((await post([])).statusCode).toBe(400);
    expect((await post('not-an-array')).statusCode).toBe(400);
    expect((await post(Array.from({ length: 201 }, () => ev()))).statusCode).toBe(400);
  });

  it('a batch of nothing but malformed events does not fail', async () => {
    const bad = ev({ bookId: 'book5', locator: { medium: 'audio' } });
    const res = await post([bad]);
    expect(res.statusCode).toBe(200);
    expect((res.json() as Ack).results[0]!.status).toBe('rejected');
    expect((await stateOf('book5')).state).toBeNull();
  });
});
