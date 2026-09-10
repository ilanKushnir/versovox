import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryDatabase, type DB } from '../db/index.js';
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  jobCheckpoint,
  jobProgress,
  LEASE_MS,
  LeaseLostError,
  makeLeaseGuard,
  recoverStaleJobs,
  renewLease,
} from './queue.js';

let db: DB;

beforeEach(() => {
  db = openMemoryDatabase();
});

function expireLease(jobId: string): void {
  db.prepare('UPDATE jobs SET lease_expires_at = ? WHERE id = ?').run(
    new Date(Date.now() - 1000).toISOString(),
    jobId,
  );
}

describe('job leases', () => {
  it('claim grants a lease; a second claim finds nothing', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    expect(job.lease_token).toBeTruthy();
    expect(job.state).toBe('running');
    expect(claimNextJob(db)).toBeNull();
  });

  it('progress/checkpoint/finish require the active lease', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    jobProgress(db, job.id, job.lease_token, 0.5, 'halfway'); // ok
    jobCheckpoint(db, job.id, job.lease_token, { step: 1 }); // ok
    expect(() => jobProgress(db, job.id, 'wrong-token', 0.9)).toThrow(LeaseLostError);
    expect(() => jobCheckpoint(db, job.id, 'wrong-token', {})).toThrow(LeaseLostError);
    expect(finishJob(db, job.id, 'wrong-token')).toBe(false);
    expect(finishJob(db, job.id, job.lease_token)).toBe(true);
    const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string };
    expect(row.state).toBe('done');
  });

  it('renewLease extends only the current holder', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    expect(renewLease(db, job.id, job.lease_token)).toBe(true);
    expect(renewLease(db, job.id, 'stolen')).toBe(false);
  });

  it('recovery reclaims only expired leases', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    expect(recoverStaleJobs(db)).toBe(0); // fresh lease: untouchable
    expireLease(job.id);
    expect(recoverStaleJobs(db)).toBe(1);
    const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(job.id) as { state: string };
    expect(row.state).toBe('queued');
  });

  it('CONCURRENCY: a reclaimed job is immune to its old owner', () => {
    enqueueJob(db, 'align', { pairId: 'p1' });
    const first = claimNextJob(db)!;
    // The first worker stalls (long whisper run, no lease renewal)...
    expireLease(first.id);
    expect(recoverStaleJobs(db)).toBe(1);
    // ...and a second worker legitimately reclaims the job.
    const second = claimNextJob(db)!;
    expect(second.id).toBe(first.id);
    expect(second.lease_token).not.toBe(first.lease_token);
    expect(second.attempts).toBe(first.attempts + 1);
    // The zombie's writes are now inert: progress throws, finish no-ops.
    expect(() => jobProgress(db, first.id, first.lease_token, 0.99)).toThrow(LeaseLostError);
    expect(finishJob(db, first.id, first.lease_token, 'zombie failure')).toBe(false);
    // The new owner is unaffected.
    jobProgress(db, second.id, second.lease_token, 0.4);
    expect(finishJob(db, second.id, second.lease_token)).toBe(true);
    const row = db
      .prepare('SELECT state, error, progress FROM jobs WHERE id = ?')
      .get(second.id) as { state: string; error: string | null; progress: number };
    expect(row.state).toBe('done');
    expect(row.error).toBeNull();
  });

  it('a running job with a live lease is never requeued (slow-but-alive worker)', () => {
    enqueueJob(db, 'align', {});
    const job = claimNextJob(db)!;
    // Simulate the worker heartbeat extending the lease.
    expect(renewLease(db, job.id, job.lease_token)).toBe(true);
    expect(recoverStaleJobs(db)).toBe(0);
    expect(claimNextJob(db)).toBeNull(); // no double-run
  });
});

describe('lease guard (handler-side ownership revalidation)', () => {
  it('assertHeld passes while the lease is held and extends it', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    const guard = makeLeaseGuard(db, job);
    expect(() => guard.assertHeld()).not.toThrow();
    expect(guard.isLost()).toBe(false);
    // The revalidation also renewed: the sweeper cannot reclaim right after.
    expect(recoverStaleJobs(db)).toBe(0);
  });

  it('assertHeld throws once the job was reclaimed by another worker', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    const guard = makeLeaseGuard(db, job);
    expireLease(job.id);
    recoverStaleJobs(db);
    const second = claimNextJob(db)!;
    expect(second.lease_token).not.toBe(job.lease_token);
    expect(() => guard.assertHeld()).toThrow(LeaseLostError);
    expect(guard.isLost()).toBe(true);
    // Once lost, always lost — no write window reopens for this attempt.
    expect(() => guard.assertHeld()).toThrow(LeaseLostError);
  });

  it('FAILS CLOSED: a database error during revalidation refuses the write', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    const broken = {
      prepare: () => {
        throw new Error('database is locked');
      },
    } as unknown as DB;
    const guard = makeLeaseGuard(broken, job);
    // Ownership cannot be confirmed => the side effect must not happen.
    expect(() => guard.assertHeld()).toThrow(LeaseLostError);
    expect(guard.isLost()).toBe(true);
  });

  it('heartbeat tolerates transient renewal errors only within one lease window', () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    let failing = true;
    const flaky = {
      prepare: (...args: unknown[]) => {
        if (failing) throw new Error('disk I/O error');
        return (db.prepare as (...a: unknown[]) => unknown)(...(args as [string]));
      },
    } as unknown as DB;
    const guard = makeLeaseGuard(flaky, job);
    guard.heartbeat(); // error, but within the window: not yet lost
    expect(guard.isLost()).toBe(false);
    failing = false;
    guard.heartbeat(); // recovered
    expect(guard.isLost()).toBe(false);
  });

  it('heartbeat FAILS CLOSED when renewal stays unconfirmed past the lease window', async () => {
    enqueueJob(db, 'scan', {});
    const job = claimNextJob(db)!;
    const broken = {
      prepare: () => {
        throw new Error('database is locked');
      },
    } as unknown as DB;
    const guard = makeLeaseGuard(broken, job);
    // Simulate elapsed time past LEASE_MS since the last confirmation.
    const realNow = Date.now;
    try {
      const start = realNow();
      Date.now = () => start + LEASE_MS + 1000;
      guard.heartbeat();
    } finally {
      Date.now = realNow;
    }
    expect(guard.isLost()).toBe(true);
    expect(() => guard.assertHeld()).toThrow(LeaseLostError);
  });
});
