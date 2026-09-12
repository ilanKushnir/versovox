import fs from 'node:fs';
import path from 'node:path';
import { type FastifyInstance } from 'fastify';
import { checkCtcEngine } from '../../alignment/ctc/emissions.js';
import { type AppContext } from '../../context.js';
import { enqueueJob } from '../../jobs/queue.js';
import { requeueAlignmentsWaitingFor } from '../../jobs/handlers.js';
import {
  isInstalled,
  LANGUAGES,
  modelById,
  modelPath,
  modelFiles,
  MODELS,
} from '../../transcription/models.js';

/** Speech-model catalog + download management (admin for mutations). */
export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;

  const activeDownloads = () =>
    db
      .prepare(
        `SELECT payload_json, state, progress, detail, error FROM jobs
         WHERE type = 'model-download' AND state IN ('queued','running')`,
      )
      .all() as { payload_json: string; state: string; progress: number; detail: string | null }[];

  const recentFailures = () =>
    db
      .prepare(
        `SELECT payload_json, error FROM jobs WHERE type = 'model-download' AND state = 'failed'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all() as { payload_json: string; error: string | null }[];

  app.get('/api/models', async () => {
    // A model may have appeared outside the app (CLI, file copy): unblock
    // any alignment that was waiting for it.
    try {
      requeueAlignmentsWaitingFor(ctx);
    } catch {
      /* best effort */
    }
    const active = new Map<string, { state: string; progress: number; detail: string | null }>();
    for (const j of activeDownloads()) {
      const { modelId } = JSON.parse(j.payload_json) as { modelId: string };
      active.set(modelId, { state: j.state, progress: Number(j.progress), detail: j.detail });
    }
    const failed = new Map<string, string>();
    for (const j of recentFailures()) {
      const { modelId } = JSON.parse(j.payload_json) as { modelId: string };
      if (!failed.has(modelId) && !active.has(modelId)) failed.set(modelId, j.error ?? 'failed');
    }
    return {
      modelsDir: config.modelsDir,
      whisperAvailable: Boolean(config.whisperBin) && fs.existsSync(config.whisperBin),
      // Whether the ONNX runtime actually loaded. A model on disk is not enough:
      // the settings page needs to distinguish "not downloaded" from "downloaded
      // but this build cannot run it".
      alignerRuntime: await checkCtcEngine(),
      models: MODELS.map((m) => {
        const installed = isInstalled(config.modelsDir, m);
        let installedBytes = 0;
        try {
          installedBytes = fs.statSync(modelPath(config.modelsDir, m)).size;
        } catch {
          /* not present */
        }
        const dl = active.get(m.id);
        return {
          ...m,
          installed,
          installedBytes,
          download: dl ?? null,
          lastError: installed ? null : (failed.get(m.id) ?? null),
        };
      }),
      languages: LANGUAGES,
    };
  });

  app.post('/api/models/:id/download', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const spec = modelById(id);
    if (!spec) return reply.code(404).send({ error: 'not-found' });
    if (isInstalled(config.modelsDir, spec)) return { queued: false, installed: true };
    const jobId = enqueueJob(db, 'model-download', { modelId: id }, { dedupeKey: `model:${id}` });
    return { queued: jobId !== null, installed: false, jobId };
  });

  app.delete('/api/models/:id', async (req, reply) => {
    if (req.user!.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    const { id } = req.params as { id: string };
    const spec = modelById(id);
    if (!spec) return reply.code(404).send({ error: 'not-found' });
    // Remove every artefact, not just the big one — a stray vocab.json would
    // otherwise linger for the life of the volume.
    for (const f of modelFiles(spec)) {
      const p = path.join(config.modelsDir, f.name);
      fs.rmSync(p, { force: true });
      fs.rmSync(`${p}.part`, { force: true });
    }
    return { ok: true };
  });
}
