import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, type DB } from '../db/index.js';
import { applyProgressEvents, getProgressState } from './service.js';
import { type ProgressEvent } from '@versovox/shared';

let db: DB;
let n = 0;
const uid = 'user1';

function ev(partial: Partial<ProgressEvent>): ProgressEvent {
  n += 1;
  return {
    eventId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    bookId: 'book1',
    deviceId: 'devA',
    sessionId: 'sessA',
    seq: n,
    occurredAt: new Date(1700000000000 + n * 1000).toISOString(),
    intent: 'heartbeat',
    locator: { medium: 'audio', trackIdx: 0, positionMs: n * 1000, pct: Math.min(1, n / 100) },
    ...partial,
  };
}

beforeEach(() => {
  db = openMemoryDatabase();
  n = 0;
});

describe('applyProgressEvents', () => {
  it('applies events, bumps revision, is idempotent by eventId', () => {
    const e1 = ev({ intent: 'open' });
    const ack1 = applyProgressEvents(db, uid, [e1]);
    expect(ack1.results[0]!.status).toBe('applied');
    expect(ack1.state?.revision).toBe(1);
    const ack2 = applyProgressEvents(db, uid, [e1]);
    expect(ack2.results[0]!.status).toBe('duplicate');
    expect(ack2.state?.revision).toBe(1);
  });

  it('server-side rollback protection: stale session heartbeats are recorded, not applied', () => {
    applyProgressEvents(db, uid, [ev({ intent: 'open', sessionId: 'sessA' })]);
    applyProgressEvents(db, uid, [
      ev({
        intent: 'heartbeat',
        sessionId: 'sessA',
        locator: { medium: 'audio', trackIdx: 0, positionMs: 7_200_000, pct: 0.9 },
      }),
    ]);
    // Explicit rewind from another device/session.
    const rewind = ev({
      intent: 'seek',
      sessionId: 'sessB',
      deviceId: 'devB',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 3_600_000, pct: 0.45 },
    });
    applyProgressEvents(db, uid, [rewind]);
    // Stale tab keeps heartbeating ahead.
    const stale = ev({
      intent: 'heartbeat',
      sessionId: 'sessA',
      locator: { medium: 'audio', trackIdx: 0, positionMs: 7_205_000, pct: 0.902 },
    });
    const ack = applyProgressEvents(db, uid, [stale]);
    expect(ack.results[0]!.status).toBe('recorded');
    const state = getProgressState(db, uid, 'book1')!;
    expect(state.locator.medium).toBe('audio');
    expect((state.locator as { positionMs: number }).positionMs).toBe(3_600_000);
    // History keeps the rejected event with its reason.
    const hist = db
      .prepare('SELECT applied, reject_reason FROM progress_events WHERE event_id = ?')
      .get(stale.eventId) as { applied: number; reject_reason: string };
    expect(hist.applied).toBe(0);
    expect(hist.reject_reason).toBe('unclaimed-session');
  });

  it('finish then reopen clears finished', () => {
    applyProgressEvents(db, uid, [
      ev({ intent: 'finish', locator: { medium: 'audio', trackIdx: 0, positionMs: 1, pct: 1 } }),
    ]);
    expect(getProgressState(db, uid, 'book1')?.finished).toBe(true);
    applyProgressEvents(db, uid, [ev({ intent: 'open' })]);
    expect(getProgressState(db, uid, 'book1')?.finished).toBe(false);
  });

  it('a batch replayed after reconnect acks each event exactly once', () => {
    const batch = [ev({ intent: 'open' }), ev({}), ev({})];
    const ack1 = applyProgressEvents(db, uid, batch);
    expect(ack1.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
    const ack2 = applyProgressEvents(db, uid, batch);
    expect(ack2.results.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(getProgressState(db, uid, 'book1')?.revision).toBe(3);
  });

  it('progress is per-user', () => {
    applyProgressEvents(db, uid, [ev({ intent: 'open' })]);
    expect(getProgressState(db, 'user2', 'book1')).toBeNull();
  });

  it('ADVERSARIAL future clock: a poisoned claim cannot lock out honest devices', () => {
    // Device with a clock a year ahead claims playback.
    const poisoned = ev({
      intent: 'seek',
      sessionId: 'sessEvil',
      deviceId: 'devEvil',
      occurredAt: new Date(Date.now() + 365 * 86400_000).toISOString(),
      locator: { medium: 'audio', trackIdx: 0, positionMs: 1000, pct: 0.01 },
    });
    applyProgressEvents(db, uid, [poisoned]);
    const stored = getProgressState(db, uid, 'book1')!;
    // The stored claim time is clamped near server time, not a year ahead.
    expect(Date.parse(stored.occurredAt)).toBeLessThan(Date.now() + 3 * 60_000);
    // An honest device that read the current state (baseRevision) wins
    // immediately; without it, the poisoned claim decays within the small
    // skew window instead of holding for a year.
    const honest = ev({
      intent: 'seek',
      sessionId: 'sessGood',
      deviceId: 'devGood',
      occurredAt: new Date(Date.now() + 5000).toISOString(),
      baseRevision: stored.revision,
      locator: { medium: 'audio', trackIdx: 0, positionMs: 500_000, pct: 0.5 },
    });
    const ack = applyProgressEvents(db, uid, [honest]);
    expect(ack.results[0]!.status).toBe('applied');
    expect((getProgressState(db, uid, 'book1')!.locator as { positionMs: number }).positionMs).toBe(
      500_000,
    );
    // Raw client timestamp preserved as diagnostics; effective time clamped.
    const row = db
      .prepare('SELECT occurred_at, effective_at FROM progress_events WHERE event_id = ?')
      .get(poisoned.eventId) as { occurred_at: string; effective_at: string };
    expect(row.occurred_at).toBe(poisoned.occurredAt);
    expect(Date.parse(row.effective_at)).toBeLessThan(Date.parse(row.occurred_at));
  });

  it('multi-device: explicit rewind from a device with a LAGGING clock wins via baseRevision', () => {
    applyProgressEvents(db, uid, [
      ev({
        intent: 'seek',
        sessionId: 'sessA',
        occurredAt: new Date(Date.now()).toISOString(),
        locator: { medium: 'audio', trackIdx: 0, positionMs: 7_200_000, pct: 0.9 },
      }),
    ]);
    const rev = getProgressState(db, uid, 'book1')!.revision;
    // Device B read the current state (revision) and rewinds, but its clock
    // is 90 seconds behind device A's.
    const rewind = ev({
      intent: 'seek',
      sessionId: 'sessB',
      deviceId: 'devB',
      occurredAt: new Date(Date.now() - 90_000).toISOString(),
      baseRevision: rev,
      locator: { medium: 'audio', trackIdx: 0, positionMs: 3_600_000, pct: 0.45 },
    });
    const ack = applyProgressEvents(db, uid, [rewind]);
    expect(ack.results[0]!.status).toBe('applied');
    expect((getProgressState(db, uid, 'book1')!.locator as { positionMs: number }).positionMs).toBe(
      3_600_000,
    );
  });

  it('stale-revision explicit event with an older clock stays rejected', () => {
    applyProgressEvents(db, uid, [
      ev({
        intent: 'seek',
        sessionId: 'sessA',
        occurredAt: new Date(Date.now()).toISOString(),
      }),
    ]);
    const stale = ev({
      intent: 'seek',
      sessionId: 'sessB',
      occurredAt: new Date(Date.now() - 3600_000).toISOString(),
      baseRevision: 0, // acted on ancient state
    });
    const ack = applyProgressEvents(db, uid, [stale]);
    expect(ack.results[0]!.status).toBe('recorded');
    expect(ack.results[0]!.reason).toBe('stale-explicit');
  });
});
