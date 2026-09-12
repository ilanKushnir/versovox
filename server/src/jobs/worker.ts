import { type AppContext } from '../context.js';
import {
  claimNextJob,
  finishJob,
  laneOf,
  requeueJob,
  type JobRow,
  type Lane,
  LEASE_MS,
  LeaseLostError,
  makeLeaseGuard,
  recoverStaleJobs,
} from './queue.js';
import { JOB_HANDLERS } from './handlers.js';

/**
 * Bounded-concurrency worker loop over the SQLite job queue. Runs inline in
 * the web process (VX_INLINE_WORKER=1, default) or as a dedicated container
 * (compose `worker` service). Both modes share the queue safely because
 * claims are atomic lease grants.
 *
 * While a handler runs — including long external processes that
 * produce no database writes of their own — the worker renews the job lease
 * on a timer, independent of handler code. If renewal ever fails the job
 * was reclaimed elsewhere; the handler's subsequent conditional writes
 * become no-ops/throws instead of corrupting the new owner's run.
 */

export interface WorkerHandle {
  stop: () => Promise<void>;
}

/**
 * Three lanes: `concurrency` slots for heavy jobs (aligning a book),
 * one slot for model downloads (gigabytes over the network), and one slot for
 * everything light (scans, indexing, pairing), so neither an alignment nor a
 * download can hold the library hostage.
 */
export function startWorker(ctx: AppContext, concurrency: number): WorkerHandle {
  const running: Record<Lane, number> = { heavy: 0, download: 0, light: 0 };
  const capacity: Record<Lane, number> = { heavy: concurrency, download: 1, light: 1 };
  const runningTotal = () => running.heavy + running.download + running.light;
  let stopped = false;
  let staleSweepAt = 0;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    if (now - staleSweepAt > 60_000) {
      staleSweepAt = now;
      try {
        const recovered = recoverStaleJobs(ctx.db);
        if (recovered > 0) ctx.log.warn(`Recovered ${recovered} stale job(s)`);
      } catch (err) {
        ctx.log.error(`Stale job sweep failed: ${(err as Error).message}`);
      }
    }
    // Each pass offers every lane with a free slot one job; stop when a full
    // pass claims nothing.
    for (;;) {
      const free = (['heavy', 'light', 'download'] as Lane[]).filter(
        (l) => running[l] < capacity[l],
      );
      if (free.length === 0) return;
      let job: JobRow | null = null;
      try {
        for (const lane of free) {
          job = claimNextJob(ctx.db, { lane });
          if (job) break;
        }
      } catch (err) {
        ctx.log.error(`Job claim failed: ${(err as Error).message}`);
        return;
      }
      if (!job) return;
      const jobLane = laneOf(job.type);
      running[jobLane] += 1;

      // Shared ownership guard: the background heartbeat renews through it,
      // and the SAME guard travels into the handler so every side effect is
      // conditional on the lease still being held. Heartbeat errors that
      // outlive a lease window flip the guard to lost (fail closed).
      const guard = makeLeaseGuard(ctx.db, job);
      const heartbeat = setInterval(
        () => {
          guard.heartbeat();
          if (guard.isLost()) {
            clearInterval(heartbeat);
            ctx.log.warn(`Job ${job.id} lease lost; abandoning result writes`);
          }
        },
        Math.max(1000, Math.floor(LEASE_MS / 3)),
      );
      heartbeat.unref?.();

      const done = (error?: string, skipFinish = false) => {
        clearInterval(heartbeat);
        try {
          // A job that dies while we are shutting down (ffmpeg killed by the
          // container stop) goes back to the queue instead of counting as
          // failed; the next start resumes it.
          if (error && stopped && !guard.isLost() && requeueJob(ctx.db, job.id, job.lease_token)) {
            ctx.log.warn(`Job ${job.id} (${job.type}) interrupted by shutdown — re-queued`);
          } else if (
            !skipFinish &&
            !guard.isLost() &&
            !finishJob(ctx.db, job.id, job.lease_token, error)
          ) {
            ctx.log.warn(`Job ${job.id} finish skipped: lease no longer held`);
          }
        } catch (err) {
          ctx.log.error(`Failed to finish job ${job.id}: ${(err as Error).message}`);
        }
        running[jobLane] -= 1;
      };
      const handler = JOB_HANDLERS[job.type];
      if (!handler) {
        ctx.log.error(`Unknown job type: ${job.type}`);
        done(`Unknown job type: ${job.type}`);
        continue;
      }
      ctx.log.info(`Job ${job.id} (${job.type}) started`);
      handler(ctx, job, guard)
        .then(() => {
          ctx.log.info(`Job ${job.id} (${job.type}) done`);
          done();
        })
        .catch((err: Error) => {
          if (err instanceof LeaseLostError) {
            ctx.log.warn(err.message);
            done(undefined, true);
            return;
          }
          ctx.log.error(`Job ${job.id} (${job.type}) failed: ${err.message}`);
          done(err.message || 'Job failed');
        });
    }
  };

  const interval = setInterval(tick, 1000);
  interval.unref?.();
  tick();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      // Give in-flight jobs a moment to checkpoint.
      const deadline = Date.now() + 5000;
      while (runningTotal() > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
