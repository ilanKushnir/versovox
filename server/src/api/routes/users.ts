import { createHash, randomBytes } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import {
  acceptInviteSchema,
  changePasswordSchema,
  createInviteSchema,
  createUserSchema,
  updateUserSchema,
  type InviteDto,
  type Role,
  type UserDto,
} from '@readport/shared';
import { type AppContext } from '../../context.js';
import { hashPassword, verifyPassword } from '../../auth/passwords.js';
import { createSession, destroyUserSessions, LoginThrottle } from '../../auth/sessions.js';
import { requireRole } from '../../auth/roles.js';
import { UNUSABLE_PASSWORD } from '../../auth/proxyAuth.js';
import { newId } from '../../util/ids.js';
import { nowIso } from '../../db/index.js';
import { SESSION_COOKIE } from '../guards.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  display_name: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
  sessions: number;
  books_in_progress: number;
}

const USER_SELECT = `
  SELECT u.id, u.username, u.password_hash, u.role, u.display_name, u.status, u.created_at,
         u.last_login_at,
         (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS sessions,
         (SELECT COUNT(*) FROM progress_state p WHERE p.user_id = u.id AND p.finished = 0)
           AS books_in_progress
  FROM users u`;

export function toUserDto(r: UserRow): UserDto {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role as Role,
    status: r.status === 'disabled' ? 'disabled' : 'active',
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    proxyManaged: r.password_hash === UNUSABLE_PASSWORD,
    sessions: Number(r.sessions),
    booksInProgress: Number(r.books_in_progress),
  };
}

const hashInvite = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * People management. Accounts are only ever created by an admin (directly,
 * with a password) or through a one-time invite link — there is no open
 * registration. Invite tokens are stored hashed and expire.
 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, config } = ctx;
  const inviteThrottle = new LoginThrottle(db, 20, 10 * 60_000);

  const cookieOpts = () => ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.trustHttps,
    maxAge: config.sessionDays * 86400,
  });

  const listUsers = (): UserDto[] =>
    (
      db.prepare(`${USER_SELECT} ORDER BY u.created_at ASC`).all(nowIso()) as unknown as UserRow[]
    ).map(toUserDto);
  const getUser = (id: string): UserRow | undefined =>
    db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(nowIso(), id) as unknown as UserRow | undefined;
  const adminCount = () =>
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND status = 'active'")
        .get() as { c: number }
    ).c;

  const inviteDto = (r: Record<string, unknown>): InviteDto => ({
    id: String(r.id),
    role: r.role as Role,
    displayName: (r.display_name as string | null) ?? null,
    username: (r.username as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    usedAt: (r.used_at as string | null) ?? null,
  });
  const listInvites = (): InviteDto[] =>
    (
      db
        .prepare(
          `SELECT i.*, u.username AS created_by FROM invites i LEFT JOIN users u ON u.id = i.created_by
           WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`,
        )
        .all(nowIso()) as Record<string, unknown>[]
    ).map(inviteDto);

  /* ------------------------------------------------------------ admin */
  app.get('/api/users', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    return { users: listUsers(), invites: listInvites() };
  });

  app.post('/api/users', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const exists = db
      .prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)')
      .get(parsed.data.username);
    if (exists) return reply.code(409).send({ error: 'username-taken' });
    const id = newId('user');
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, display_name, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      parsed.data.username,
      await hashPassword(parsed.data.password),
      parsed.data.role,
      parsed.data.displayName ?? null,
      req.user!.id,
      nowIso(),
    );
    ctx.log.info(
      `Admin ${req.user!.username} created ${parsed.data.role} "${parsed.data.username}"`,
    );
    return reply.code(201).send({ user: toUserDto(getUser(id)!) });
  });

  app.patch('/api/users/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'not-found' });
    const self = target.id === req.user!.id;
    const p = parsed.data;
    // Never lock yourself (or the whole server) out.
    const losesAdmin =
      target.role === 'admin' &&
      target.status === 'active' &&
      ((p.role && p.role !== 'admin') || p.status === 'disabled');
    if (losesAdmin && adminCount() <= 1) {
      return reply.code(409).send({ error: 'last-admin' });
    }
    if (self && (p.status === 'disabled' || (p.role && p.role !== 'admin'))) {
      return reply.code(409).send({ error: 'self-lockout' });
    }
    if (p.password !== undefined && target.password_hash === UNUSABLE_PASSWORD) {
      return reply.code(409).send({ error: 'proxy-managed' });
    }
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (p.role) {
      sets.push('role = ?');
      args.push(p.role);
    }
    if (p.status) {
      sets.push('status = ?');
      args.push(p.status);
    }
    if (p.displayName !== undefined) {
      sets.push('display_name = ?');
      args.push(p.displayName);
    }
    if (p.password !== undefined) {
      sets.push('password_hash = ?');
      args.push(await hashPassword(p.password));
    }
    if (sets.length) {
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    // Role changes, disabling and password resets all invalidate old sessions.
    if (p.status === 'disabled' || p.password !== undefined || (p.role && p.role !== target.role)) {
      const keep =
        self && (req.cookies ?? {})[SESSION_COOKIE]
          ? { secret: config.sessionSecret, token: (req.cookies ?? {})[SESSION_COOKIE]! }
          : undefined;
      destroyUserSessions(db, id, keep);
    }
    return { user: toUserDto(getUser(id)!) };
  });

  app.post('/api/users/:id/sign-out-everywhere', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    if (!getUser(id)) return reply.code(404).send({ error: 'not-found' });
    return { revoked: destroyUserSessions(db, id) };
  });

  app.delete('/api/users/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    const target = getUser(id);
    if (!target) return reply.code(404).send({ error: 'not-found' });
    if (target.id === req.user!.id) return reply.code(409).send({ error: 'self-lockout' });
    if (target.role === 'admin' && target.status === 'active' && adminCount() <= 1) {
      return reply.code(409).send({ error: 'last-admin' });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      // Personal data goes with the account; library content is untouched.
      // Shelves, shelf membership and the reading list are NOT in this list:
      // they carry ON DELETE CASCADE to users(id) (migration 7) and go with
      // the row below. A table named here and a table with a cascade are two
      // mechanisms for one rule, and this list is the fragile one — anything
      // added from now on should carry its own cascade instead.
      for (const t of ['progress_events', 'progress_state', 'annotations', 'sessions']) {
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    ctx.log.info(`Admin ${req.user!.username} deleted user "${target.username}"`);
    return { ok: true };
  });

  /* ------------------------------------------------------------ invites */
  app.post('/api/invites', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const parsed = createInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    if (parsed.data.username) {
      const taken = db
        .prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)')
        .get(parsed.data.username);
      if (taken) return reply.code(409).send({ error: 'username-taken' });
    }
    const token = randomBytes(24).toString('base64url');
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString();
    db.prepare(
      `INSERT INTO invites (id, token_hash, role, display_name, username, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      hashInvite(token),
      parsed.data.role,
      parsed.data.displayName ?? null,
      parsed.data.username ?? null,
      req.user!.id,
      nowIso(),
      expiresAt,
    );
    // The raw token is returned exactly once; the client builds the link.
    return reply.code(201).send({
      invite: { id, role: parsed.data.role, expiresAt },
      token,
      path: `/join/${token}`,
    });
  });

  app.delete('/api/invites/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return reply;
    const { id } = req.params as { id: string };
    const res = db.prepare('DELETE FROM invites WHERE id = ?').run(id);
    return { ok: Number(res.changes) > 0 };
  });

  const validInvite = (token: string) => {
    if (!token || token.length > 128) return undefined;
    return db
      .prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(hashInvite(token), nowIso()) as Record<string, unknown> | undefined;
  };

  // Public: what an invite link offers (no secrets, no user enumeration).
  app.get('/api/invites/:token', { config: { public: true } }, async (req, reply) => {
    if (!inviteThrottle.allow(`inv:${req.ip}`))
      return reply.code(429).send({ error: 'rate-limited' });
    const { token } = req.params as { token: string };
    const inv = validInvite(token);
    if (!inv) return reply.code(404).send({ error: 'invalid-invite' });
    const by = inv.created_by
      ? (db
          .prepare('SELECT display_name, username FROM users WHERE id = ?')
          .get(String(inv.created_by)) as
          { display_name: string | null; username: string } | undefined)
      : undefined;
    return {
      role: inv.role,
      displayName: inv.display_name ?? null,
      username: inv.username ?? null,
      invitedBy: by ? (by.display_name ?? by.username) : null,
      expiresAt: inv.expires_at,
    };
  });

  app.post('/api/invites/:token/accept', { config: { public: true } }, async (req, reply) => {
    if (!inviteThrottle.allow(`inv:${req.ip}`))
      return reply.code(429).send({ error: 'rate-limited' });
    const { token } = req.params as { token: string };
    const parsed = acceptInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const inv = validInvite(token);
    if (!inv) return reply.code(404).send({ error: 'invalid-invite' });
    const passwordHash = await hashPassword(parsed.data.password);
    const id = newId('user');
    db.exec('BEGIN IMMEDIATE');
    try {
      const again = validInvite(token);
      if (!again) {
        db.exec('ROLLBACK');
        return reply.code(404).send({ error: 'invalid-invite' });
      }
      const taken = db
        .prepare('SELECT 1 FROM users WHERE lower(username) = lower(?)')
        .get(parsed.data.username);
      if (taken) {
        db.exec('ROLLBACK');
        return reply.code(409).send({ error: 'username-taken' });
      }
      db.prepare(
        `INSERT INTO users (id, username, password_hash, role, display_name, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      ).run(
        id,
        parsed.data.username,
        passwordHash,
        String(inv.role),
        parsed.data.displayName ?? (inv.display_name as string | null) ?? null,
        (inv.created_by as string | null) ?? null,
        nowIso(),
      );
      db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(
        nowIso(),
        id,
        String(inv.id),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const session = createSession(
      db,
      config.sessionSecret,
      id,
      config.sessionDays,
      req.headers['user-agent'],
    );
    reply.setCookie(SESSION_COOKIE, session.token, cookieOpts());
    const u = getUser(id)!;
    return reply.code(201).send({
      user: { id, username: u.username, role: u.role, displayName: u.display_name },
    });
  });

  /* ------------------------------------------------------------ self service */
  app.post('/api/auth/password', async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as
      { password_hash: string } | undefined;
    if (!row || row.password_hash === UNUSABLE_PASSWORD) {
      return reply.code(409).send({ error: 'proxy-managed' });
    }
    if (!(await verifyPassword(parsed.data.currentPassword, row.password_hash))) {
      return reply.code(403).send({ error: 'bad-credentials' });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      await hashPassword(parsed.data.newPassword),
      req.user!.id,
    );
    // Other devices must sign in again; this one keeps its session.
    const token = (req.cookies ?? {})[SESSION_COOKIE];
    const revoked = token
      ? destroyUserSessions(db, req.user!.id, { secret: config.sessionSecret, token })
      : 0;
    return { ok: true, revokedOtherSessions: revoked };
  });

  app.patch('/api/auth/me', async (req, reply) => {
    const parsed = updateUserSchema.pick({ displayName: true }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid' });
    if (parsed.data.displayName !== undefined) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
        parsed.data.displayName,
        req.user!.id,
      );
    }
    return { user: toUserDto(getUser(req.user!.id)!) };
  });
}
