import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { type AppContext } from './context.js';
import { startWorker } from './jobs/worker.js';

/**
 * Dedicated worker process (compose `worker` service). Shares the SQLite
 * database (same /data volume, same host) with the web container; claims are
 * atomic so both can run concurrently. Set VX_INLINE_WORKER=0 on the web
 * container when using this.
 */

const config = loadConfig();
const db = openDatabase(config.dataDir);

const ctx: AppContext = {
  db,
  config,
  log: {
    info: (m) => console.log(`[versovox-worker] ${m}`),
    warn: (m) => console.warn(`[versovox-worker] ${m}`),
    error: (m) => console.error(`[versovox-worker] ${m}`),
  },
};

const worker = startWorker(ctx, config.jobConcurrency);
ctx.log.info(`Worker started (concurrency ${config.jobConcurrency})`);

async function shutdown(): Promise<void> {
  await worker.stop();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
