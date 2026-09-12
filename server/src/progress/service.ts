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

/**
 * Read the stored row, reporting its existence separately from whether it
 * could be understood. A row that fails to parse still occupies the
 * (user_id, book_id) primary key: treating it as absent would make the next
 * event INSERT on top of it, and the collision would fail the whole batch —
 * every book behind it in the client's queue with it. Unreadable is therefore
 * "present but carries nothing forward", and the next event heals it.
 */
function readProgressRow(
  db: DB,
  userId: string,
  bookId: string,
): { exists: boolean; state: ProgressState | null } {
  const row = db
    .prepare('SELECT * FROM progress_state WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) as Record<string, unknown> | undefined;
  if (!row) return { exists: false, state: null };
  try {
    const parsed = progressStateSchema.safeParse({
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
    });
    return { exists: true, state: parsed.success ? parsed.data : null };
  } catch {
    return { exists: true, state: null };
  }
}

export function getProgressState(db: DB, userId: string, bookId: string): ProgressState | null {
  return readProgressRow(db, userId, bookId).state;
}

/**
 * A batch is a queue drain and routinely spans several books (read one,
 * listened to another). Every book it touched comes back, so each one's
 * client-side revision and cached position stay current — a book left with a
 * stale revision sends a stale baseRevision next time, and reconciliation
 * silently degrades from causal ordering to clock comparison.
 */
export interface ProgressBatchAck extends ProgressAck {
  states: ProgressState[];
}

export function applyProgressEvents(
  db: DB,
  userId: string,
  events: ProgressEvent[],
): ProgressBatchAck {
  const results: ProgressAck['results'] = [];
  const books = new Set<string>();
  for (const ev of events) books.add(ev.bookId);
  if (events.length === 0) return { results, state: null, states: [] };

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
      const { exists, state } = readProgressRow(db, userId, ev.bookId);
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
      // The stored claim time is the server-clamped effective time. A
      // heartbeat keeps the standing explicit claim (state freshness tracks
      // updated_at); everything else, including a heartbeat with no claim to
      // inherit, states its own.
      const inherits = !isExplicit(ev.intent) && state !== null;
      const finished = ev.intent === 'finish' ? 1 : inherits && state!.finished ? 1 : 0;
      if (exists) {
        db.prepare(
          `UPDATE progress_state SET revision = revision + 1, locator_json = ?, intent = ?,
             occurred_at = ?, session_uuid = ?, device_id = ?, seq = ?, finished = ?, updated_at = ?
           WHERE user_id = ? AND book_id = ?`,
        ).run(
          JSON.stringify(ev.locator),
          ev.intent,
          inherits ? state!.occurredAt : effectiveAt,
          inherits ? state!.sessionId : ev.sessionId,
          ev.deviceId,
          ev.seq,
          finished,
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
      results.push({ eventId: ev.eventId, status: 'applied' });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const states: ProgressState[] = [];
  for (const bookId of books) {
    const state = getProgressState(db, userId, bookId);
    if (state) states.push(state);
  }
  const lastBook = events[events.length - 1]?.bookId;
  return { results, state: states.find((s) => s.bookId === lastBook) ?? null, states };
}

/**
 * Compact old heartbeat history (keep explicit events + recent heartbeats).
 *
 * Applied heartbeats are pruned too: the current position lives in
 * progress_state, and history is diagnostic only (capped at 100 rows when
 * read). Keeping them meant a heavy listener's row count grew forever.
 */
export function compactProgressHistory(db: DB, keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString();
  const batch = 5000;
  // Bounded batches, each its own transaction: the first run on a server that
  // has been keeping every applied heartbeat faces years of backlog, and one
  // DELETE that large would hold the write lock past the busy timeout of a
  // checkpoint arriving at the same moment.
  const stmt = db.prepare(
    `DELETE FROM progress_events WHERE id IN (
       SELECT id FROM progress_events WHERE intent = 'heartbeat' AND received_at < ? LIMIT ${batch})`,
  );
  let total = 0;
  for (;;) {
    const n = Number(stmt.run(cutoff).changes);
    total += n;
    if (n < batch) return total;
  }
}
