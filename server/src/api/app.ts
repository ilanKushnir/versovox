import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { type AppContext } from '../context.js';
import { attachUser, csrfCheck, requireUser } from './guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerReaderRoutes } from './routes/reader.js';
import { registerAudioRoutes } from './routes/audio.js';
import { registerProgressRoutes } from './routes/progress.js';
import { registerAnnotationRoutes } from './routes/annotations.js';
import { registerPairRoutes } from './routes/pairs.js';
import { registerJobRoutes, registerOfflineRoutes, registerSettingsRoutes } from './routes/misc.js';

const PUBLIC_PATHS = new Set(['/api/health', '/api/setup/status', '/api/setup', '/api/auth/login']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

export interface BuildAppOptions {
  /** Absolute path of the built web app (index.html etc). Optional in tests. */
  webDist?: string;
}

export function buildApp(ctx: AppContext, opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: ctx.config.logLevel },
    bodyLimit: 2 * 1024 * 1024,
    // Default false: forwarded headers are ignored so clients cannot spoof
    // their IP (rate-limit keys). Operators behind a reverse proxy opt in
    // with TL_TRUST_PROXY (see config.ts).
    trustProxy: ctx.config.trustProxy,
  });

  app.register(fastifyCookie);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!req.url.startsWith('/api/books/')) {
      // Book chapter fragments/assets carry their own stricter handling.
      reply.header('content-security-policy', CSP);
    }
    attachUser(ctx, req);
    if (req.url.startsWith('/api/') && !PUBLIC_PATHS.has(req.url.split('?')[0]!)) {
      if (!csrfCheck(req)) {
        return reply.code(403).send({ error: 'csrf' });
      }
      if (!requireUser(req, reply)) return reply;
    } else if (req.url.startsWith('/api/') && !csrfCheck(req)) {
      return reply.code(403).send({ error: 'csrf' });
    }
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    time: new Date().toISOString(),
  }));

  registerAuthRoutes(app, ctx);
  registerLibraryRoutes(app, ctx);
  registerReaderRoutes(app, ctx);
  registerAudioRoutes(app, ctx);
  registerProgressRoutes(app, ctx);
  registerAnnotationRoutes(app, ctx);
  registerPairRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerOfflineRoutes(app, ctx);

  // Static web app + SPA fallback (everything not under /api).
  if (opts.webDist && fs.existsSync(path.join(opts.webDist, 'index.html'))) {
    app.register(fastifyStatic, {
      root: opts.webDist,
      wildcard: false,
      index: ['index.html'],
      setHeaders: (reply, filePath) => {
        if (/\.(js|css|woff2|png|svg)$/.test(filePath) && /-[A-Za-z0-9_-]{8}\./.test(filePath)) {
          reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          reply.header('cache-control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      reply.header('content-security-policy', CSP);
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html').send(fs.readFileSync(path.join(opts.webDist!, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not-found' });
      return reply
        .code(503)
        .type('text/plain')
        .send('TandemLeaf web assets are not built. Run: npm run build');
    });
  }

  return app;
}
