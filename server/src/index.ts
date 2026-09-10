import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { buildApp } from './api/app.js';
import { ensureSetupToken } from './auth/setupToken.js';
import { type AppContext } from './context.js';
import { startWorker } from './jobs/worker.js';
import { enqueueJob } from './jobs/queue.js';
import { compactProgressHistory } from './progress/service.js';

const config = loadConfig();
const db = openDatabase(config.dataDir);

const ctx: AppContext = {
  db,
  config,
  log: {
    info: (m) => console.log(`[tandemleaf] ${m}`),
    warn: (m) => console.warn(`[tandemleaf] ${m}`),
    error: (m) => console.error(`[tandemleaf] ${m}`),
  },
};

ctx.setupToken = ensureSetupToken(config, db, ctx.log);

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/index.js -> ../../web/dist ; src/index.ts (dev) -> ../../web/dist
const webDist = path.resolve(here, '../../web/dist');

const app = buildApp(ctx, { webDist });

let worker: { stop: () => Promise<void> } | null = null;
if (config.inlineWorker) {
  worker = startWorker(ctx, config.jobConcurrency);
  ctx.log.info(`Inline worker started (concurrency ${config.jobConcurrency})`);
} else {
  ctx.log.info('Inline worker disabled — run the dedicated worker container');
}

// Initial scan if libraries are configured and DB has users already.
const hasUsers = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c > 0;
if (hasUsers && (config.ebookDirs.length || config.audiobookDirs.length)) {
  enqueueJob(db, 'scan', {}, { dedupeKey: 'scan' });
}

// Daily heartbeat-history compaction.
const compactTimer = setInterval(
  () => {
    try {
      const n = compactProgressHistory(db);
      if (n > 0) ctx.log.info(`Compacted ${n} old heartbeat events`);
    } catch (err) {
      ctx.log.error(`Compaction failed: ${(err as Error).message}`);
    }
  },
  24 * 3600 * 1000,
);
compactTimer.unref?.();

app
  .listen({ port: config.port, host: config.host })
  .then(() => {
    ctx.log.info(`TandemLeaf listening on http://${config.host}:${config.port}`);
    if (!config.trustHttps) {
      ctx.log.warn(
        'Running without TL_TRUST_HTTPS: cookies are not marked Secure. Serve behind HTTPS in production (required for PWA install).',
      );
    }
  })
  .catch((err) => {
    ctx.log.error(String(err));
    process.exit(1);
  });

async function shutdown(): Promise<void> {
  ctx.log.info('Shutting down…');
  try {
    await app.close();
    if (worker) await worker.stop();
    db.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
