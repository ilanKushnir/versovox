import { describe, expect, it } from 'vitest';
import { clampEventTime, decideApply, MAX_FUTURE_SKEW_MS, resolveResume } from './reconcile.js';
import { type ProgressEvent, type ProgressState } from './progress.js';

const loc = (pct: number): ProgressEvent['locator'] => ({
  medium: 'audio',
  trackIdx: 0,
  positionMs: Math.round(pct * 100000),
  pct,
});

let uuidCounter = 0;
function ev(partial: Partial<ProgressEvent>): ProgressEvent {
  uuidCounter += 1;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return {
    eventId: `00000000-0000-4000-8000-${hex}`,
    bookId: 'b1',
    deviceId: 'dev1',
    sessionId: 'sess1',
    seq: 1,
    occurredAt: '2026-01-01T10:00:00.000Z',
    intent: 'heartbeat',
    locator: loc(0.5),
    ...partial,
  };
}

const claimOf = (e: ProgressEvent) => ({
  sessionId: e.sessionId,
  deviceId: e.deviceId,
  explicitAt: e.occurredAt,
  seq: e.seq,
  intent: e.intent,
});

describe('decideApply', () => {
  it('applies anything to empty state', () => {
    expect(decideApply(ev({}), null).apply).toBe(true);
  });

  it('newer explicit intent beats older explicit claim', () => {
    const claim = claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:00.000Z' }));
    const d = decideApply(
      ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:01.000Z', sessionId: 'sess2' }),
      claim,
    );
    expect(d.apply).toBe(true);
  });

  it('older explicit intent is stale', () => {
    const claim = claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:05.000Z' }));
    const d = decideApply(
      ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:01.000Z', sessionId: 'sess2' }),
      claim,
    );
    expect(d).toEqual({ apply: false, reason: 'stale-explicit' });
  });

  it('THE rollback scenario: stale background heartbeat cannot override a newer foreground rewind', () => {
    // User listened to 2h on sess1, explicitly rewound to 1h on sess2.
    const rewind = ev({
      intent: 'seek',
      sessionId: 'sess2',
      occurredAt: '2026-01-01T10:00:10.000Z',
      seq: 3,
      locator: loc(0.5),
    });
    const claim = claimOf(rewind);
    // sess1's player is still running and heartbeats a LATER wall-clock time
    // at the pre-rewind position. It must be recorded but not applied.
    const staleHb = ev({
      intent: 'heartbeat',
      sessionId: 'sess1',
      occurredAt: '2026-01-01T10:00:12.000Z',
      seq: 99,
      locator: loc(0.9),
    });
    expect(decideApply(staleHb, claim)).toEqual({ apply: false, reason: 'unclaimed-session' });
    // The rewinding session's own next heartbeat DOES apply.
    const goodHb = ev({
      intent: 'heartbeat',
      sessionId: 'sess2',
      occurredAt: '2026-01-01T10:00:15.000Z',
      seq: 4,
      locator: loc(0.51),
    });
    expect(decideApply(goodHb, claim).apply).toBe(true);
  });

  it('explicit rewind is valid even though pct decreases', () => {
    const claim = claimOf(
      ev({ intent: 'heartbeat', occurredAt: '2026-01-01T10:00:00.000Z', seq: 10 }),
    );
    const rewind = ev({
      intent: 'seek',
      occurredAt: '2026-01-01T10:00:02.000Z',
      seq: 11,
      locator: loc(0.1),
    });
    expect(decideApply(rewind, claim).apply).toBe(true);
  });

  it('duplicate/out-of-order heartbeats from the claiming session are rejected by seq', () => {
    const claim = claimOf(ev({ intent: 'seek', seq: 5 }));
    const late = ev({ intent: 'heartbeat', seq: 4, occurredAt: '2026-01-01T09:59:00.000Z' });
    expect(decideApply(late, claim)).toEqual({ apply: false, reason: 'stale-heartbeat' });
  });

  it('a stale session re-claims with an explicit open', () => {
    const claim = claimOf(
      ev({ intent: 'seek', sessionId: 'sess2', occurredAt: '2026-01-01T10:00:10.000Z' }),
    );
    const reopen = ev({
      intent: 'open',
      sessionId: 'sess1',
      occurredAt: '2026-01-01T10:05:00.000Z',
      seq: 100,
    });
    expect(decideApply(reopen, claim).apply).toBe(true);
  });
});

describe('clock-skew poisoning and causal ordering', () => {
  const NOW = Date.parse('2026-01-01T10:00:00.000Z');

  it('clampEventTime bounds future client clocks to now + skew', () => {
    expect(clampEventTime(NOW + 999_999_999, NOW)).toBe(NOW + MAX_FUTURE_SKEW_MS);
    expect(clampEventTime(NOW - 5000, NOW)).toBe(NOW - 5000);
    expect(clampEventTime(NaN, NOW)).toBe(NOW);
  });

  it('ADVERSARIAL: a device with a clock a year ahead cannot lock out other devices', () => {
    // Device X (future clock) seeks; its stored claim time gets clamped, so
    // the claim the server keeps is at most now + skew.
    const poisoned = ev({
      intent: 'seek',
      sessionId: 'sessX',
      occurredAt: '2027-01-01T10:00:00.000Z', // one year in the future
    });
    const clampedClaimAt = new Date(
      clampEventTime(Date.parse(poisoned.occurredAt), NOW),
    ).toISOString();
    const claim = { ...claimOf(poisoned), explicitAt: clampedClaimAt };
    // Device Y with a correct clock acts 5 minutes later: it must win.
    const honest = ev({
      intent: 'seek',
      sessionId: 'sessY',
      occurredAt: '2026-01-01T10:05:00.000Z',
    });
    expect(decideApply(honest, claim, NOW + 5 * 60_000).apply).toBe(true);
  });

  it('an event whose OWN clock is in the future is clamped at decision time', () => {
    const claim = claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:04:00.000Z' }));
    // Attacker time far ahead — clamped to now+skew, which is < claim time.
    const d = decideApply(
      ev({ intent: 'seek', sessionId: 'sessZ', occurredAt: '2030-01-01T00:00:00.000Z' }),
      claim,
      Date.parse('2026-01-01T10:00:00.000Z'),
    );
    expect(d).toEqual({ apply: false, reason: 'stale-explicit' });
  });

  it('baseRevision: acting on the current revision beats a lagging clock', () => {
    // Claim from device A at 10:00:10; device B saw revision 7 and rewinds,
    // but B's clock lags behind A's. Causal ordering must let B win.
    const claim = {
      ...claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:10.000Z' })),
      revision: 7,
    };
    const rewind = ev({
      intent: 'seek',
      sessionId: 'sessB',
      occurredAt: '2026-01-01T10:00:05.000Z', // lagging clock
      baseRevision: 7,
      locator: loc(0.2),
    });
    expect(decideApply(rewind, claim, NOW).apply).toBe(true);
  });

  it('baseRevision: a stale revision does not shortcut the time comparison', () => {
    const claim = {
      ...claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:10.000Z' })),
      revision: 7,
    };
    const stale = ev({
      intent: 'seek',
      sessionId: 'sessB',
      occurredAt: '2026-01-01T10:00:05.000Z',
      baseRevision: 3, // acted on old state AND has an older clock
    });
    expect(decideApply(stale, claim, NOW)).toEqual({ apply: false, reason: 'stale-explicit' });
  });

  it('baseRevision: a fabricated future revision gains nothing', () => {
    const claim = {
      ...claimOf(ev({ intent: 'seek', occurredAt: '2026-01-01T10:00:10.000Z' })),
      revision: 7,
    };
    const bogus = ev({
      intent: 'seek',
      sessionId: 'sessB',
      occurredAt: '2026-01-01T10:00:05.000Z',
      baseRevision: 999,
    });
    expect(bogus.baseRevision).not.toBe(claim.revision);
    expect(decideApply(bogus, claim, NOW)).toEqual({ apply: false, reason: 'stale-explicit' });
  });
});

describe('resolveResume', () => {
  const serverState: ProgressState = {
    bookId: 'b1',
    revision: 4,
    locator: loc(0.4),
    intent: 'pause',
    occurredAt: '2026-01-01T10:00:00.000Z',
    sessionId: 'sessA',
    deviceId: 'devA',
    seq: 10,
    updatedAt: '2026-01-01T10:00:00.500Z',
    finished: false,
  };

  it('prefers newer unacknowledged local explicit events over server state', () => {
    const local = [
      ev({
        intent: 'seek',
        sessionId: 'sessB',
        occurredAt: '2026-01-01T10:00:30.000Z',
        seq: 2,
        locator: loc(0.7),
      }),
    ];
    const r = resolveResume(serverState, local);
    expect(r?.source).toBe('local');
    expect(r?.locator.pct).toBe(0.7);
  });

  it('discards stale local events older than server state', () => {
    const local = [
      ev({
        intent: 'seek',
        sessionId: 'sessB',
        occurredAt: '2026-01-01T09:00:00.000Z',
        seq: 2,
        locator: loc(0.9),
      }),
    ];
    const r = resolveResume(serverState, local);
    expect(r?.source).toBe('server');
    expect(r?.locator.pct).toBe(0.4);
  });

  it('handles empty everything', () => {
    expect(resolveResume(null, [])).toBeNull();
  });

  it('local-only resume works fully offline', () => {
    const local = [
      ev({ intent: 'open', occurredAt: '2026-01-01T10:00:00.000Z', seq: 1, locator: loc(0.1) }),
      ev({
        intent: 'heartbeat',
        occurredAt: '2026-01-01T10:00:30.000Z',
        seq: 2,
        locator: loc(0.12),
      }),
    ];
    const r = resolveResume(null, local);
    expect(r?.locator.pct).toBe(0.12);
  });
});
