import { randomBytes } from 'node:crypto';
import { type DB, nowIso } from '../db/index.js';
import { newId } from '../util/ids.js';

/**
 * SQLite-backed job queue with renewable claim leases. A claim writes a
 * unique lease token and expiry; every subsequent write for that job
 * (progress, checkpoint, finish, failure) is conditional on still holding
 * the active lease. Stale-job recovery reclaims only jobs whose lease has
 * expired, and a reclaimed job gets a fresh token — so a worker that was
 * merely slow (not dead) can no longer double-run or clobber a job that was
 * handed to someone else.
 */

/** Lease duration; the worker renews at LEASE_MS / 3 while a job runs. */
export const LEASE_MS = 2 * 60_000;

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId}: lease lost (job was reclaimed by another worker)`);
    this.name = 'LeaseLostError';
  }
}

export interface JobRow {
  id: string;
  type: string;
  payload_json: string;
  state: string;
  progress: number;
  detail: string | null;
  checkpoint_json: string | null;
  error: string | null;
  attempts: number;
  priority: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  lease_token: string;
}

export function enqueueJob(
  db: DB,
  type: string,
  payload: unknown,
  opts: { dedupeKey?: string; priority?: number } = {},
): string | null {
  const id = newId('job');
  try {
    db.prepare(
      `INSERT INTO jobs (id, type, payload_json, dedupe_key, state, priority, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      id,
      type,
      JSON.stringify(payload ?? {}),
      opts.dedupeKey ?? null,
      opts.priority ?? 0,
      nowIso(),
    );
    return id;
  } catch (err) {
    // UNIQUE violation on dedupe key: an equivalent job is already pending.
    if (String(err).includes('UNIQUE')) return null;
    throw err;
  }
}

/** Job types that run for hours on the CPU (whisper). */
export const HEAVY_JOB_TYPES = ['align'] as const;
/** Long network transfers (gigabyte model files) — cheap on CPU, slow on the clock. */
export const DOWNLOAD_JOB_TYPES = ['model-download'] as const;
export type Lane = 'heavy' | 'download' | 'light';

export function laneOf(type: string): Lane {
  if ((HEAVY_JOB_TYPES as readonly string[]).includes(type)) return 'heavy';
  if ((DOWNLOAD_JOB_TYPES as readonly string[]).includes(type)) return 'download';
  return 'light';
}

export function claimNextJob(db: DB, opts: { lane?: Lane | 'any' } = {}): JobRow | null {
  const lane = opts.lane ?? 'any';
  const quote = (ts: readonly string[]) => ts.map((t) => `'${t}'`).join(',');
  const heavy = quote(HEAVY_JOB_TYPES);
  const downloads = quote(DOWNLOAD_JOB_TYPES);
  const where =
    lane === 'heavy'
      ? `AND type IN (${heavy})`
      : lane === 'download'
        ? `AND type IN (${downloads})`
        : lane === 'light'
          ? `AND type NOT IN (${heavy}, ${downloads})`
          : '';
  const candidate = db
    .prepare(
      `SELECT id FROM jobs WHERE state = 'queued' ${where} ORDER BY priority DESC, created_at LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (!candidate) return null;
  const token = randomBytes(16).toString('hex');
  const res = db
    .prepare(
      `UPDATE jobs SET state = 'running', started_at = ?, attempts = attempts + 1,
         lease_token = ?, lease_expires_at = ?
       WHERE id = ? AND state = 'queued'`,
    )
    .run(nowIso(), token, new Date(Date.now() + LEASE_MS).toISOString(), candidate.id);
  if (Number(res.changes) === 0) return null; // lost the race
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(candidate.id) as unknown as JobRow;
}

/** Extend the lease; returns false when the lease is no longer held. */
export function renewLease(db: DB, id: string, token: string): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ? AND state = 'running'`,
    )
    .run(new Date(Date.now() + LEASE_MS).toISOString(), id, token);
  return Number(res.changes) > 0;
}

export function jobProgress(
  db: DB,
  id: string,
  token: string,
  progress: number,
  detail?: string,
): void {
  const res = db
    .prepare(
      `UPDATE jobs SET progress = ?, detail = ?, lease_expires_at = ?
       WHERE id = ? AND lease_token = ? AND state = 'running'`,
    )
    .run(
      Math.min(1, Math.max(0, progress)),
      detail ?? null,
      new Date(Date.now() + LEASE_MS).toISOString(),
      id,
      token,
    );
  if (Number(res.changes) === 0) throw new LeaseLostError(id);
}

export function jobCheckpoint(db: DB, id: string, token: string, checkpoint: unknown): void {
  const res = db
    .prepare(
      `UPDATE jobs SET checkpoint_json = ?, lease_expires_at = ?
       WHERE id = ? AND lease_token = ? AND state = 'running'`,
    )
    .run(JSON.stringify(checkpoint), new Date(Date.now() + LEASE_MS).toISOString(), id, token);
  if (Number(res.changes) === 0) throw new LeaseLostError(id);
}

/** Finish (or fail) a job; a no-op returning false when the lease was lost. */
export function finishJob(db: DB, id: string, token: string, error?: string): boolean {
  const res = error
    ? db
        .prepare(
          `UPDATE jobs SET state = 'failed', error = ?, finished_at = ?, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(error.slice(0, 2000), nowIso(), id, token)
    : db
        .prepare(
          `UPDATE jobs SET state = 'done', progress = 1, finished_at = ?, lease_token = NULL, lease_expires_at = NULL
           WHERE id = ? AND lease_token = ? AND state = 'running'`,
        )
        .run(nowIso(), id, token);
  return Number(res.changes) > 0;
}

export function cancelJob(db: DB, id: string): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE id = ? AND state = 'queued'`,
    )
    .run(nowIso(), id);
  return Number(res.changes) > 0;
}

/**
 * Hand a running job back to the queue without burning its attempt as a
 * failure — used when the process is shutting down under a job (a container
 * restart mid-transcription is not the job's fault). Only the lease holder
 * may do this.
 */
export function requeueJob(db: DB, id: string, leaseToken: string | null): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET state = 'queued', error = NULL, started_at = NULL, finished_at = NULL,
         lease_token = NULL, lease_expires_at = NULL
       WHERE id = ? AND state = 'running' AND lease_token IS ? AND attempts < ?`,
    )
    .run(id, leaseToken, MAX_ATTEMPTS);
  return Number(res.changes) > 0;
}

export function retryJob(db: DB, id: string): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET state = 'queued', error = NULL, finished_at = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE id = ? AND state IN ('failed','cancelled')`,
    )
    .run(id);
  return Number(res.changes) > 0;
}

/**
 * Live ownership handle for one claimed job, passed into handlers so every
 * filesystem/database side effect can be made conditional on the attempt
 * still holding the lease.
 *
 * `assertHeld()` revalidates ownership against the database and atomically
 * extends the lease in the same conditional UPDATE, so a write performed
 * immediately after it cannot race the stale-job sweeper. It FAILS CLOSED:
 * a lost lease, a reclaimed job, or a database error that prevents
 * confirmation all throw LeaseLostError — an attempt that cannot prove it
 * still owns the job is not allowed to write.
 *
 * `heartbeat()` is the worker's background renewal. Transient renewal errors
 * are tolerated only while the last confirmed renewal is younger than the
 * lease duration; past that the lease may have been reclaimed elsewhere, so
 * the guard flips to lost (fail closed) instead of assuming the best.
 */
export interface LeaseGuard {
  jobId: string;
  isLost(): boolean;
  /** Throws LeaseLostError unless ownership was just re-confirmed. */
  assertHeld(): void;
  /** Background renewal; never throws. */
  heartbeat(): void;
}

export function makeLeaseGuard(db: DB, job: Pick<JobRow, 'id' | 'lease_token'>): LeaseGuard {
  let lost = false;
  let lastConfirmedAt = Date.now();
  const confirm = (): boolean => {
    if (lost) return false;
    let held: boolean;
    try {
      held = renewLease(db, job.id, job.lease_token);
    } catch {
      return false; // could not confirm — caller decides how closed to fail
    }
    if (!held) {
      lost = true;
      return false;
    }
    lastConfirmedAt = Date.now();
    return true;
  };
  return {
    jobId: job.id,
    isLost: () => lost,
    assertHeld: () => {
      if (!confirm()) {
        lost = true;
        throw new LeaseLostError(job.id);
      }
    },
    heartbeat: () => {
      if (lost) return;
      if (!confirm() && Date.now() - lastConfirmedAt > LEASE_MS) {
        // Renewal has not been confirmed for a full lease window: the job
        // may already belong to someone else. Fail closed.
        lost = true;
      }
    },
  };
}

/** A job that keeps losing its lease (e.g. it crashes the process) stops here. */
export const MAX_ATTEMPTS = 3;

/**
 * Requeue running jobs whose lease expired (worker died or lost contact).
 * Jobs that already burned MAX_ATTEMPTS are failed instead of re-run so a
 * pathological input cannot crash-loop the worker forever.
 */
export function recoverStaleJobs(db: DB): number {
  const now = nowIso();
  db.prepare(
    `UPDATE jobs SET state = 'failed', finished_at = ?, lease_token = NULL, lease_expires_at = NULL,
       error = 'Gave up after ' || attempts || ' attempts (worker lost the job each time)'
     WHERE state = 'running' AND lease_expires_at < ? AND attempts >= ?`,
  ).run(now, now, MAX_ATTEMPTS);
  const res = db
    .prepare(
      `UPDATE jobs SET state = 'queued', started_at = NULL, lease_token = NULL, lease_expires_at = NULL
       WHERE state = 'running' AND lease_expires_at < ?`,
    )
    .run(now);
  return Number(res.changes);
}
