import { EXPLICIT_INTENTS, type ProgressEvent, type ProgressState } from './progress.js';

/**
 * Pure reconciliation decision, shared verbatim by the server (authoritative
 * apply) and the client (choosing between acknowledged server state and newer
 * unacknowledged local events on resume).
 *
 * Ordering authority: client timestamps are treated as hints, never as
 * absolute truth. Every timestamp is clamped to the deciding party's own
 * clock plus a small allowed skew, so one device with a clock years in the
 * future cannot poison the claim and lock out every other device. Causal
 * ordering (baseRevision — "I saw revision N before acting") beats clock
 * ordering when available.
 */

/** Maximum tolerated forward clock skew before a timestamp is clamped. */
export const MAX_FUTURE_SKEW_MS = 2 * 60_000;

/** Clamp a client-supplied time so it can never lead the local clock by more than the skew window. */
export function clampEventTime(occurredAtMs: number, nowMs: number): number {
  if (!Number.isFinite(occurredAtMs)) return nowMs;
  return Math.min(occurredAtMs, nowMs + MAX_FUTURE_SKEW_MS);
}

export type ReconcileDecision =
  | { apply: true }
  | {
      apply: false;
      reason: 'duplicate' | 'stale-explicit' | 'stale-heartbeat' | 'unclaimed-session';
    };

export interface ClaimView {
  /** Session holding the playback claim (last applied explicit intent). */
  sessionId: string;
  deviceId: string;
  /** Effective (already clamped) occurredAt of the last applied explicit intent (ISO). */
  explicitAt: string;
  /** seq of the last applied event from the claiming session. */
  seq: number;
  intent: ProgressState['intent'];
  /** Current state revision, when known (server always knows it). */
  revision?: number;
}

export function isExplicit(intent: ProgressEvent['intent']): boolean {
  return EXPLICIT_INTENTS.has(intent);
}

/**
 * Decide whether `event` should move current state given the current claim.
 * `claim` is null when the book has no progress yet. `nowMs` is the deciding
 * party's clock (server time on the server, device time on client replay).
 */
export function decideApply(
  event: ProgressEvent,
  claim: ClaimView | null,
  nowMs: number = Date.now(),
): ReconcileDecision {
  if (!claim) return { apply: true };

  const eventTime = clampEventTime(Date.parse(event.occurredAt), nowMs);
  const claimTime = clampEventTime(Date.parse(claim.explicitAt), nowMs);

  if (isExplicit(event.intent)) {
    // Causal ordering first: a client that acted after seeing the current
    // revision is newer than the claim even if its clock lags.
    if (
      event.baseRevision !== undefined &&
      claim.revision !== undefined &&
      event.baseRevision === claim.revision
    ) {
      return { apply: true };
    }
    if (eventTime > claimTime) return { apply: true };
    if (eventTime === claimTime) {
      // Same instant: fall back to session/seq ordering, deterministic.
      if (event.sessionId === claim.sessionId && event.seq > claim.seq) return { apply: true };
      return { apply: false, reason: 'stale-explicit' };
    }
    return { apply: false, reason: 'stale-explicit' };
  }

  // Heartbeats: only the claiming session may advance state. A stale
  // background tab (different session) can keep sending heartbeats after the
  // user explicitly rewound elsewhere — those must be recorded but not applied.
  if (event.sessionId !== claim.sessionId) {
    return { apply: false, reason: 'unclaimed-session' };
  }
  // Same session: require monotonic seq so late-delivered duplicates or
  // out-of-order heartbeats cannot rewind or replay.
  if (event.seq <= claim.seq) {
    return { apply: false, reason: 'stale-heartbeat' };
  }
  return { apply: true };
}

/**
 * Client resume: pick what position to resume from, given the newest
 * acknowledged server state and any locally queued (unacknowledged) events.
 * Local events replay through the same decision function in order.
 */
export function resolveResume(
  server: ProgressState | null,
  localPending: ProgressEvent[],
  nowMs: number = Date.now(),
): { locator: ProgressEvent['locator']; source: 'server' | 'local' } | null {
  let claim: ClaimView | null = server
    ? {
        sessionId: server.sessionId,
        deviceId: server.deviceId,
        explicitAt: server.occurredAt,
        seq: server.seq,
        intent: server.intent,
        revision: server.revision,
      }
    : null;
  let locator = server?.locator ?? null;
  let source: 'server' | 'local' = 'server';

  const ordered = [...localPending].sort(
    (a, b) =>
      clampEventTime(Date.parse(a.occurredAt), nowMs) -
        clampEventTime(Date.parse(b.occurredAt), nowMs) || a.seq - b.seq,
  );
  for (const ev of ordered) {
    const d = decideApply(ev, claim, nowMs);
    if (!d.apply) continue;
    locator = ev.locator;
    source = 'local';
    const effectiveAt = new Date(clampEventTime(Date.parse(ev.occurredAt), nowMs)).toISOString();
    if (isExplicit(ev.intent)) {
      claim = {
        sessionId: ev.sessionId,
        deviceId: ev.deviceId,
        explicitAt: effectiveAt,
        seq: ev.seq,
        intent: ev.intent,
        revision: claim?.revision,
      };
    } else if (claim) {
      claim = { ...claim, seq: ev.seq };
    } else {
      claim = {
        sessionId: ev.sessionId,
        deviceId: ev.deviceId,
        explicitAt: effectiveAt,
        seq: ev.seq,
        intent: ev.intent,
      };
    }
  }
  if (!locator) return null;
  return { locator, source };
}
