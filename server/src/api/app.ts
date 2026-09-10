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
import { registerModelRoutes } from './routes/models.js';
import { registerUserRoutes } from './routes/users.js';
import { createRequire } from 'node:module';

const APP_VERSION: string = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route is reachable without a session (still CSRF-checked). */
    public?: boolean;
  }
}

/**
 * Decoded request path. The router matches on the DECODED path, so a guard
 * keyed on the raw `req.url` would let `/%61pi/...` reach `/api/...` routes
 * unauthenticated. Returns null for malformed encodings.
 */
export function decodedPathname(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url, 'http://versovox.invalid').pathname);
  } catch {
    return null;
  }
}

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
    // with VX_TRUST_PROXY (see config.ts).
    trustProxy: ctx.config.trustProxy,
  });

  app.register(fastifyCookie);

  // Body-less mutations (confirm/unlink/align/…) may arrive through proxies
  // that add a content type; an unknown type with an EMPTY body is harmless
  // and must not be a 415. Non-empty bodies of unknown types stay rejected.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body, done) => {
    if ((body as Buffer).length === 0) return done(null, undefined);
    const err = new Error('Unsupported Media Type') as Error & { statusCode?: number };
    err.statusCode = 415;
    done(err, undefined);
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    if (!(decodedPathname(req.url) ?? '').startsWith('/api/books/')) {
      // Book chapter fragments/assets carry their own stricter handling.
      reply.header('content-security-policy', CSP);
    }
    attachUser(ctx, req);
    const pathname = decodedPathname(req.url);
    if (pathname === null) return reply.code(400).send({ error: 'bad-url' });
    // Gate on BOTH the matched route pattern and the decoded path, so an
    // encoded prefix can neither reach a route nor dodge the check.
    const routeUrl = req.routeOptions?.url ?? '';
    const isApi = routeUrl.startsWith('/api/') || pathname.startsWith('/api/');
    if (!isApi) return;
    if (!csrfCheck(req)) return reply.code(403).send({ error: 'csrf' });
    if (req.routeOptions?.config?.public === true) return;
    if (!requireUser(req, reply)) return reply;
  });

  // Never leak internal error messages (paths, SQL, stack fragments).
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { statusCode?: number; code?: string };
    const status = e.statusCode && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled route error');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.code(status).send({ error: typeof e.code === 'string' ? e.code : 'error' });
  });

  app.get('/api/health', { config: { public: true } }, async () => ({
    status: 'ok',
    version: APP_VERSION,
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
  registerModelRoutes(app, ctx);
  registerUserRoutes(app, ctx);

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
      if ((decodedPathname(req.url) ?? '/api/').startsWith('/api/')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      reply.header('content-security-policy', CSP);
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html').send(fs.readFileSync(path.join(opts.webDist!, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if ((decodedPathname(req.url) ?? '/api/').startsWith('/api/')) {
        return reply.code(404).send({ error: 'not-found' });
      }
      return reply
        .code(503)
        .type('text/plain')
        .send('Versovox web assets are not built. Run: npm run build');
    });
  }

  return app;
}
