import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type FastifyInstance } from 'fastify';
import { type AppContext } from '../../context.js';
import { hasRole } from '../../auth/roles.js';
import { checkCtcEngine } from '../../alignment/ctc/emissions.js';
import {
  ALIGNER,
  isInstalled,
  modelFiles,
  modelPath,
} from '../../alignment/model.js';
import { alignmentRoots, libraryRoots } from '../../domain/settings.js';
import { checkLibraryPath } from '../../setup/paths.js';

/**
 * "Is this container actually able to align a book?" — one answer, in plain
 * language, for the setup wizard and for a self-hoster reading the logs.
 *
 * Everything here is READ-ONLY: it probes binaries with `-version`, stats
 * directories and asks the model catalog what is on disk. Nothing is written,
 * nothing is downloaded, no job is enqueued.
 *
 * POST rather than GET because the wizard checks the folders the operator is
 * ABOUT to save, which are not in the settings yet and must not travel in a
 * query string. With no body it checks the roots the server would use today.
 * `GET /api/health` stays the machine-readable liveness probe.
 */

export type PreflightState = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  /** Short human label, e.g. "Audio tools". */
  label: string;
  state: PreflightState;
  /** What was found. Always concrete: a version, a path, a byte count. */
  detail: string;
  /** What to do about it. Only set when the state is not `ok`. */
  fix?: string;
}

const bodySchema = z
  .object({
    ebookDirs: z.array(z.string().trim().min(1).max(1024)).max(16).optional(),
    audiobookDirs: z.array(z.string().trim().min(1).max(1024)).max(16).optional(),
    alignmentDirs: z.array(z.string().trim().min(1).max(1024)).max(16).optional(),
  })
  .optional();

/**
 * Binary probes spawn a process, and the wizard polls this route while a
 * download runs. A binary does not appear or vanish mid-setup, so the result
 * is memoised briefly — long enough to make polling free, short enough that
 * an operator who fixes their PATH and retries sees the truth.
 */
const PROBE_TTL_MS = 30_000;
const probeCache = new Map<string, { at: number; value: BinaryProbe }>();

interface BinaryProbe {
  found: boolean;
  /** First line of `<bin> -version`, trimmed, or the spawn error. */
  detail: string;
}

async function probeBinary(bin: string): Promise<BinaryProbe> {
  const hit = probeCache.get(bin);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
  const value = await new Promise<BinaryProbe>((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: BinaryProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ found: false, detail: (err as Error).message });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ found: false, detail: 'timed out' });
    }, 5_000);
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 400) out += d.toString('utf8');
    });
    child.on('error', (err) => done({ found: false, detail: err.message }));
    child.on('close', (code) => {
      const first = out.split('\n')[0]?.trim() ?? '';
      done(
        code === 0
          ? { found: true, detail: first || `${bin} responded` }
          : { found: false, detail: `${bin} exited with code ${code}` },
      );
    });
  });
  probeCache.set(bin, { at: Date.now(), value });
  return value;
}

/** Same units and precision as the web client's formatter, so the two agree. */
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Nearest existing ancestor of `p` — what a writability test can actually stat. */
function nearestExisting(p: string): string {
  let dir = path.resolve(p);
  for (let i = 0; i < 32; i++) {
    if (fs.existsSync(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

function freeBytes(dir: string): number | null {
  try {
    const st = fs.statfsSync(nearestExisting(dir));
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

function writable(dir: string): boolean {
  try {
    fs.accessSync(nearestExisting(dir), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerPreflightRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const userCount = () => (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;

  /**
   * Same gate as the other wizard helpers (see routes/auth.ts): an admin
   * session, or — only while no account exists at all — the bootstrap token
   * in a header. The report names paths and binaries, so it is never public.
   */
  const allowed = (req: { user: { role: string } | null; headers: Record<string, unknown> }) => {
    if (req.user) return hasRole(req.user.role, 'admin');
    if (userCount() > 0) return false;
    const raw = req.headers['x-vx-setup-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    return typeof token === 'string' && !!ctx.setupToken && ctx.setupToken.matches(token);
  };

  /** The aligner's own download job, if one is queued or running right now. */
  const alignerDownload = (): { state: string; progress: number; detail: string | null } | null => {
    const rows = db
      .prepare(
        `SELECT payload_json, state, progress, detail FROM jobs
         WHERE type = 'model-download' AND state IN ('queued','running')`,
      )
      .all() as { payload_json: string; state: string; progress: number; detail: string | null }[];
    for (const r of rows) {
      const { modelId } = JSON.parse(r.payload_json) as { modelId: string };
      if (modelId === ALIGNER.id) {
        return { state: r.state, progress: Number(r.progress), detail: r.detail };
      }
    }
    return null;
  };

  const alignerFailure = (): string | null => {
    const rows = db
      .prepare(
        `SELECT payload_json, error FROM jobs WHERE type = 'model-download' AND state = 'failed'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all() as { payload_json: string; error: string | null }[];
    for (const r of rows) {
      const { modelId } = JSON.parse(r.payload_json) as { modelId: string };
      if (modelId === ALIGNER.id) return r.error ?? 'failed';
    }
    return null;
  };

  app.post('/api/preflight', { config: { public: true } }, async (req, reply) => {
    if (!allowed(req)) return reply.code(403).send({ error: 'forbidden' });
    const body = bodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid' });

    const checks: PreflightCheck[] = [];
    const spec = ALIGNER;
    const alignerInstalled = isInstalled(config.modelsDir, spec);
    const download = alignerDownload();

    // 1. ffmpeg / ffprobe. Every path into the aligner decodes audio through
    // them, so a missing one is fatal rather than degraded.
    const [ffmpeg, ffprobe] = await Promise.all([probeBinary('ffmpeg'), probeBinary('ffprobe')]);
    const missingAudio = [
      ...(ffmpeg.found ? [] : ['ffmpeg']),
      ...(ffprobe.found ? [] : ['ffprobe']),
    ];
    checks.push({
      id: 'audio-tools',
      label: 'Audio tools',
      state: missingAudio.length ? 'fail' : 'ok',
      detail: missingAudio.length
        ? `${missingAudio.join(' and ')} not runnable — ${ffmpeg.found ? ffprobe.detail : ffmpeg.detail}`
        : ffmpeg.detail,
      ...(missingAudio.length
        ? {
            fix: 'The Docker image bundles both. On a bare install, put ffmpeg and ffprobe on the server process PATH.',
          }
        : {}),
    });

    // 2. The ONNX runtime that executes the aligner. It is a native module, so
    // "installed" and "loads on this CPU" are different questions.
    const engine = await checkCtcEngine();
    checks.push({
      id: 'onnx-runtime',
      label: 'Alignment runtime',
      state: engine.available ? 'ok' : 'fail',
      detail: engine.available
        ? 'onnxruntime-node loaded'
        : (engine.error ?? 'onnxruntime-node did not load'),
      ...(engine.available
        ? {}
        : {
            fix: 'Reinstall dependencies for this platform (npm ci) — the Docker image ships a matching build. Without it, nothing can be aligned.',
          }),
    });

    // 3. The model itself. Missing is a warning, not a failure: everything
    // else works, and it is one click away here or in Settings.
    checks.push({
      id: 'aligner-model',
      label: 'Aligner model',
      state: alignerInstalled ? 'ok' : 'warn',
      detail: alignerInstalled
        ? `Installed in ${config.modelsDir}`
        : download
          ? `Downloading — ${Math.round(download.progress * 100)}%`
          : `Not downloaded (${formatBytes(spec.sizeBytes)}, one time, covers every language)`,
      ...(alignerInstalled || download
        ? {}
        : {
            fix: 'Tick the download on the last step, or fetch it later under Settings → Alignment.',
          }),
    });

    // 4. Disk. The aligner needs its own size; derived indexes and covers grow
    // with the library, so a nearly-full data volume is worth flagging early.
    const modelsFree = freeBytes(config.modelsDir);
    const dataFree = freeBytes(config.dataDir);
    const needed = alignerInstalled ? 0 : spec.sizeBytes;
    const tight =
      (modelsFree !== null && modelsFree < needed + 512 * 1024 ** 2) ||
      (dataFree !== null && dataFree < 1024 ** 3);
    checks.push({
      id: 'disk',
      label: 'Free space',
      state: modelsFree === null && dataFree === null ? 'warn' : tight ? 'fail' : 'ok',
      detail:
        modelsFree === null && dataFree === null
          ? 'Could not read free space on this filesystem'
          : `${formatBytes(modelsFree ?? dataFree ?? 0)} free for models, ${formatBytes(dataFree ?? modelsFree ?? 0)} for data`,
      ...(tight
        ? {
            fix: `Free up space or mount a larger volume: the aligner needs ${formatBytes(spec.sizeBytes)} and indexing writes to ${config.dataDir}.`,
          }
        : {}),
    });

    // 5. Writable state directories. A read-only bind mount is a classic
    // Compose mistake and produces baffling failures much later.
    const dirs: [string, string][] = [
      ['data', config.dataDir],
      ['cache', config.cacheDir],
      ['models', config.modelsDir],
    ];
    const unwritable = dirs.filter(([, d]) => !writable(d));
    checks.push({
      id: 'writable',
      label: 'Writable folders',
      state: unwritable.length ? 'fail' : 'ok',
      detail: unwritable.length
        ? `Not writable: ${unwritable.map(([n, d]) => `${n} (${d})`).join(', ')}`
        : dirs.map(([n]) => n).join(', ') + ' are writable',
      ...(unwritable.length
        ? {
            fix: 'Mount these read-write and make sure the container user owns them (VX_DATA_DIR, VX_CACHE_DIR, VX_MODELS_DIR).',
          }
        : {}),
    });

    // 6. Library folders — the ones the wizard is about to save, when it sends
    // them, otherwise whatever the server would use today.
    const roots = libraryRoots(db, config);
    const ebookDirs = body.data?.ebookDirs ?? roots.ebookDirs;
    const audiobookDirs = body.data?.audiobookDirs ?? roots.audiobookDirs;
    const folderChecks = [
      ...ebookDirs.map((p) => checkLibraryPath(p, 'ebook')),
      ...audiobookDirs.map((p) => checkLibraryPath(p, 'audio')),
    ];
    const unreadable = folderChecks.filter((c) => !c.ok);
    const found = folderChecks.reduce((n, c) => n + (c.matches ?? 0), 0);
    // The walk is capped, so a "+" is only honest when it actually stopped early.
    const sampledAny = folderChecks.some((c) => c.sampled);
    checks.push({
      id: 'libraries',
      label: 'Library folders',
      state: folderChecks.length === 0 ? 'warn' : unreadable.length ? 'fail' : 'ok',
      detail:
        folderChecks.length === 0
          ? 'No folders configured yet'
          : unreadable.length
            ? `Cannot read ${unreadable.map((c) => c.path).join(', ')}`
            : `${folderChecks.length} folder${folderChecks.length === 1 ? '' : 's'}, ${found}${sampledAny ? '+' : ''} file${found === 1 && !sampledAny ? '' : 's'} visible`,
      ...(folderChecks.length === 0
        ? {
            fix: 'Add them here or later under Settings → Libraries. Versovox only ever reads them.',
          }
        : unreadable.length
          ? {
              fix: 'Check the path as the SERVER sees it (inside the container) and that the container user may read it.',
            }
          : {}),
    });

    // 7. The alignment folder. Never a failure — alignment works without one,
    // the timings simply do not survive rebuilding the container. But it is
    // the likeliest mistake in the whole setup: every other library line in
    // the stock compose file ends in `:ro`, and people copy the pattern.
    const alignDirs = body.data?.alignmentDirs ?? alignmentRoots(db, config);
    const alignChecks = alignDirs.map((p) => checkLibraryPath(p, 'alignment'));
    const notWritable = alignChecks.filter((c) => c.writable !== true);
    const saved = alignChecks.reduce((n, c) => n + (c.matches ?? 0), 0);
    checks.push({
      id: 'alignments',
      label: 'Alignment folder',
      state: notWritable.length ? 'warn' : 'ok',
      detail: notWritable.length
        ? `Cannot save into ${notWritable.map((c) => c.path).join(', ')}`
        : saved > 0
          ? `${alignDirs.join(', ')} — ${saved} already saved`
          : alignDirs.join(', '),
      ...(notWritable.length
        ? {
            fix: 'Mount it read-write (no :ro) and make sure the container user owns it. Without it, alignments are kept inside the app data and a rebuild takes them with it.',
          }
        : {}),
    });

    return {
      ok: checks.every((c) => c.state !== 'fail'),
      checks,
      modelsDir: config.modelsDir,
      aligner: {
        id: spec.id,
        label: spec.label,
        licence: spec.licence ?? null,
        note: spec.note,
        sizeBytes: modelFiles(spec).reduce((n, f) => n + f.sizeBytes, 0),
        installed: alignerInstalled,
        installedBytes: (() => {
          try {
            return fs.statSync(modelPath(config.modelsDir, spec)).size;
          } catch {
            return 0;
          }
        })(),
        download,
        lastError: alignerInstalled ? null : alignerFailure(),
      },
    };
  });
}
