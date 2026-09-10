import { type FastifyInstance } from 'fastify';
import { loginSchema, setupSchema } from '@tandemleaf/shared';
import { type AppContext } from '../../context.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../../auth/passwords.js';
import { createSession, destroySession, LoginThrottle } from '../../auth/sessions.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../db/index.js';
import { SESSION_COOKIE } from '../guards.js';
import { enqueueJob } from '../../jobs/queue.js';

const ATTEMPT_LIMIT = 10;
const IP_ATTEMPT_LIMIT = 30;
const WINDOW_MS = 5 * 60_000;

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const accountThrottle = new LoginThrottle(db, ATTEMPT_LIMIT, WINDOW_MS);
  const ipThrottle = new LoginThrottle(db, IP_ATTEMPT_LIMIT, WINDOW_MS);

  const cookieOpts = () => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.trustHttps,
    maxAge: config.sessionDays * 86400,
  });

  const userCount = () => (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;

  app.get('/api/setup/status', { config: { public: true } }, async () => ({
    needsSetup: userCount() === 0,
    // The client shows where to find the token; the token itself is never
    // exposed over HTTP.
    setupTokenSource: userCount() === 0 ? (ctx.setupToken?.source ?? 'env') : null,
  }));

  // First-run admin creation. Requires the one-time bootstrap token (env or
  // generated at boot, see auth/setupToken.ts); no default credentials exist.
  app.post('/api/setup', { config: { public: true } }, async (req, reply) => {
    if (userCount() > 0) return reply.code(409).send({ error: 'already-configured' });
    if (!ipThrottle.allow(`setup:${req.ip}`)) {
      return reply.code(429).send({ error: 'rate-limited' });
    }
    const body = setupSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid', detail: body.error.issues[0]?.message });
    }
    const token = ctx.setupToken;
    if (!token || !token.matches(body.data.setupToken)) {
      return reply.code(403).send({ error: 'bad-setup-token' });
    }
    const passwordHash = await hashPassword(body.data.password);
    const id = newId('user');
    // Transactional create: two racing setup calls cannot both succeed.
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      if (count > 0) {
        db.exec('ROLLBACK');
        return reply.code(409).send({ error: 'already-configured' });
      }
      db.prepare(
        'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, body.data.username, passwordHash, 'admin', nowIso());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // The bootstrap token is single-use: disable it the moment setup succeeds.
    token.consume();
    ctx.setupToken = null;
    const session = createSession(
      db,
      config.sessionSecret,
      id,
      config.sessionDays,
      req.headers['user-agent'],
    );
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts());
    // Kick off the first library scan right away.
    enqueueJob(db, 'scan', {}, { dedupeKey: 'scan' });
    return { user: { id, username: body.data.username, role: 'admin' } };
  });

  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = loginSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    // Throttle by (account, client IP) AND by client IP alone. req.ip only
    // reflects forwarded headers when TL_TRUST_PROXY explicitly trusts the
    // proxy, so a direct attacker cannot rotate X-Forwarded-For past the
    // limits — and a remote attacker cannot lock the real owner out of a
    // known username by burning its attempts from elsewhere.
    const acctKey = `acct:${body.data.username.toLowerCase()}@${req.ip}`;
    const ipKey = `ip:${req.ip}`;
    if (!accountThrottle.allow(acctKey) || !ipThrottle.allow(ipKey)) {
      return reply.code(429).send({ error: 'rate-limited' });
    }
    const row = db
      .prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?')
      .get(body.data.username) as
      { id: string; username: string; password_hash: string; role: string } | undefined;
    // Constant-shape response AND constant work: unknown users verify against
    // a dummy hash so timing does not reveal account existence.
    if (!row) {
      await verifyAgainstDummy(body.data.password);
      return reply.code(401).send({ error: 'bad-credentials' });
    }
    if (!(await verifyPassword(body.data.password, row.password_hash))) {
      return reply.code(401).send({ error: 'bad-credentials' });
    }
    accountThrottle.reset(acctKey);
    const session = createSession(
      db,
      config.sessionSecret,
      row.id,
      config.sessionDays,
      req.headers['user-agent'],
    );
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts());
    return { user: { id: row.id, username: row.username, role: row.role } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = (req.cookies ?? {})[SESSION_COOKIE];
    if (token) destroySession(db, config.sessionSecret, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthorized' });
    return { user: req.user };
  });
}
