import { type BlockList } from 'node:net';
import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type AppContext } from '../context.js';
import { resolveSession, type SessionUser } from '../auth/sessions.js';
import { buildSourceList, proxyAuthUser } from '../auth/proxyAuth.js';

export const SESSION_COOKIE = 'rp_session';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    /** How the request was authenticated (undefined when anonymous). */
    authVia?: 'session' | 'proxy';
  }
}

const sourceLists = new WeakMap<AppContext, BlockList | null>();
function proxySources(ctx: AppContext): BlockList | null {
  if (!sourceLists.has(ctx)) {
    const list = buildSourceList(ctx.config.proxyAuthSources);
    if (ctx.config.proxyAuthHeader && !list) {
      ctx.log.warn(
        'RP_PROXY_AUTH_HEADER is set but RP_PROXY_AUTH_SOURCES is empty — proxy sign-in stays disabled (fail closed).',
      );
    }
    sourceLists.set(ctx, list);
  }
  return sourceLists.get(ctx) ?? null;
}

/**
 * CSRF defense in depth for cookie-authenticated mutations:
 *  1. Session cookie is SameSite=Lax (blocks cross-site POST subresources).
 *  2. Mutating requests must carry the custom `x-rp-csrf: 1` header, which a
 *     cross-origin form/img cannot set.
 *  3. When Origin / Sec-Fetch-Site headers are present they must indicate a
 *     same-origin request.
 */
export function csrfCheck(req: FastifyRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers['x-rp-csrf'] !== '1') return false;
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && !['same-origin', 'none'].includes(secFetchSite)) {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    const host = req.headers.host;
    try {
      const originHost = new URL(origin).host;
      if (host && originHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function attachUser(ctx: AppContext, req: FastifyRequest): void {
  const token = (req.cookies ?? {})[SESSION_COOKIE];
  req.user = token ? resolveSession(ctx.db, ctx.config.sessionSecret, token) : null;
  if (req.user) {
    req.authVia = 'session';
    return;
  }
  const proxied = proxyAuthUser(ctx, req, proxySources(ctx));
  if (proxied) {
    req.user = proxied;
    req.authVia = 'proxy';
  }
}

export function requireUser(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.user) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  return true;
}
