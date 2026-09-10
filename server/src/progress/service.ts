import {
  clampEventTime,
  decideApply,
  isExplicit,
  progressStateSchema,
  type ClaimView,
  type ProgressAck,
  type ProgressEvent,
  type ProgressState,
} from '@versovox/shared';
import { type DB, nowIso } from '../db/index.js';

/**
 * Authoritative progress pipeline: append-only event history + reconciled
 * current state with a revision counter. Decision logic lives in
 * @versovox/shared (decideApply) so client resume math matches exactly.
 *
 * Client timestamps are diagnostic metadata: the state's claim time is the
 * server-clamped effective time, so a device clock in the future cannot
 * permanently poison reconciliation for other devices.
 */

export function getProgressState(db: DB, userId: string, bookId: string): ProgressState | null {
  const row = db
    .prepare('SELECT * FROM progress_state WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const state = {
    bookId,
    revision: Number(row.revision),
    locator: JSON.parse(String(row.locator_json)),
    intent: String(row.intent),
    occurredAt: String(row.occurred_at),
    sessionId: String(row.session_uuid),
    deviceId: String(row.device_id),
    seq: Number(row.seq),
    updatedAt: String(row.updated_at),
    finished: Number(row.finished) === 1,
  };
  const parsed = progressStateSchema.safeParse(state);
  return parsed.success ? parsed.data : null;
}

export function applyProgressEvents(db: DB, userId: string, events: ProgressEvent[]): ProgressAck {
  const results: ProgressAck['results'] = [];
  const touched = new Set<string>();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const ev of events) {
      const dup = db
        .prepare('SELECT id FROM progress_events WHERE user_id = ? AND event_id = ?')
        .get(userId, ev.eventId);
      if (dup) {
        results.push({ eventId: ev.eventId, status: 'duplicate' });
        continue;
      }
      const nowMs = Date.now();
      // Server-observed ordering: clamp the client clock so it can never
      // lead server time by more than the skew window. The raw client
      // occurredAt is preserved in the event log as diagnostics only.
      const effectiveAt = new Date(clampEventTime(Date.parse(ev.occurredAt), nowMs)).toISOString();
      const state = getProgressState(db, userId, ev.bookId);
      const claim: ClaimView | null = state
        ? {
            sessionId: state.sessionId,
            deviceId: state.deviceId,
            explicitAt: state.occurredAt,
            seq: state.seq,
            intent: state.intent,
            revision: state.revision,
          }
        : null;
      const decision = decideApply(ev, claim, nowMs);
      db.prepare(
        `INSERT INTO progress_events
           (user_id, book_id, event_id, device_id, session_uuid, seq, intent, medium, locator_json, occurred_at, effective_at, base_revision, received_at, applied, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        userId,
        ev.bookId,
        ev.eventId,
        ev.deviceId,
        ev.sessionId,
        ev.seq,
        ev.intent,
        ev.locator.medium,
        JSON.stringify(ev.locator),
        ev.occurredAt,
        effectiveAt,
        ev.baseRevision ?? null,
        nowIso(),
        decision.apply ? 1 : 0,
        decision.apply ? null : decision.reason,
      );
      if (!decision.apply) {
        results.push({ eventId: ev.eventId, status: 'recorded', reason: decision.reason });
        continue;
      }
      const finished = ev.intent === 'finish' ? 1 : 0;
      if (state) {
        db.prepare(
          `UPDATE progress_state SET revision = revision + 1, locator_json = ?, intent = ?,
             occurred_at = ?, session_uuid = ?, device_id = ?, seq = ?, finished = ?, updated_at = ?
           WHERE user_id = ? AND book_id = ?`,
        ).run(
          JSON.stringify(ev.locator),
          ev.intent,
          // The stored claim time is the server-clamped effective time.
          // Heartbeats keep the explicit claim's time; state freshness
          // tracks updated_at.
          isExplicit(ev.intent) ? effectiveAt : state.occurredAt,
          isExplicit(ev.intent) ? ev.sessionId : state.sessionId,
          ev.deviceId,
          ev.seq,
          ev.intent === 'finish' ? 1 : isExplicit(ev.intent) ? 0 : state.finished ? 1 : 0,
          nowIso(),
          userId,
          ev.bookId,
        );
      } else {
        db.prepare(
          `INSERT INTO progress_state
             (user_id, book_id, revision, locator_json, intent, occurred_at, session_uuid, device_id, seq, finished, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          userId,
          ev.bookId,
          JSON.stringify(ev.locator),
          ev.intent,
          effectiveAt,
          ev.sessionId,
          ev.deviceId,
          ev.seq,
          finished,
          nowIso(),
        );
      }
      touched.add(ev.bookId);
      results.push({ eventId: ev.eventId, status: 'applied' });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const lastBook = events[events.length - 1]?.bookId;
  const state = lastBook ? getProgressState(db, userId, lastBook) : null;
  return { results, state };
}

/** Compact old heartbeat history (keep explicit events + recent heartbeats). */
export function compactProgressHistory(db: DB, keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const res = db
    .prepare(
      `DELETE FROM progress_events WHERE intent = 'heartbeat' AND received_at < ? AND applied = 0`,
    )
    .run(cutoff);
  return Number(res.changes);
}
