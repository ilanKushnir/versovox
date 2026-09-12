import { BlockList, isIP } from 'node:net';
import { type FastifyRequest } from 'fastify';
import { type AppContext } from '../context.js';
import { type SessionUser } from './sessions.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../db/index.js';

/**
 * Reverse-proxy single sign-on (Authentik / Authelia / oauth2-proxy style).
 *
 * When RP_PROXY_AUTH_HEADER names a request header (e.g.
 * `x-authentik-username`), a request that arrives WITHOUT a ReadPort session
 * cookie is authenticated from that header — but only if the TCP peer that
 * delivered it is one of RP_PROXY_AUTH_SOURCES (the reverse proxy's
 * addresses/CIDRs). A client that reaches ReadPort directly (LAN port,
 * break-glass URL) is never a trusted source, so it cannot forge the
 * header; it sees the normal login page instead.
 *
 * Users are provisioned on first sight with an unusable password hash
 * (they sign in through the proxy). Roles: RP_PROXY_AUTH_ADMINS grants
 * admin; otherwise the very first user of an empty instance becomes admin
 * (the proxy already decides who may reach ReadPort at all).
 */

const USERNAME_RE = /^[a-zA-Z0-9._@-]{1,64}$/;
/** Never verifies: verifyPassword() requires the `scrypt$…` shape. */
export const UNUSABLE_PASSWORD = '!proxy-sso';

export interface ProxyAuthConfig {
  header: string;
  sources: string[];
  admins: string[];
}

export function buildSourceList(sources: string[]): BlockList | null {
  if (sources.length === 0) return null;
  const list = new BlockList();
  for (const raw of sources) {
    const s = raw.trim();
    if (!s) continue;
    const [addr, prefix] = s.split('/');
    const family = isIP(addr ?? '');
    if (!family) throw new Error(`RP_PROXY_AUTH_SOURCES: not an IP or CIDR: ${s}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix !== undefined) list.addSubnet(addr!, Number(prefix), type);
    else list.addAddress(addr!, type);
  }
  return list;
}

/** Peer address as dotted IPv4 when it is IPv4-mapped IPv6. */
export function normalizePeer(addr: string | undefined): string | null {
  if (!addr) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return mapped ? mapped[1]! : addr;
}

export function peerIsTrusted(list: BlockList | null, peer: string | null): boolean {
  if (!list || !peer) return false;
  const family = isIP(peer);
  if (!family) return false;
  return list.check(peer, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Resolve (and if needed provision) the user named by the proxy header.
 * Returns null when proxy auth is disabled, the peer is untrusted, or the
 * header is absent/malformed.
 */
export function proxyAuthUser(
  ctx: AppContext,
  req: FastifyRequest,
  list: BlockList | null,
): SessionUser | null {
  const { proxyAuthHeader, proxyAuthAdmins } = ctx.config;
  if (!proxyAuthHeader) return null;
  const peer = normalizePeer(req.raw.socket?.remoteAddress);
  if (!peerIsTrusted(list, peer)) return null;
  const raw = req.headers[proxyAuthHeader.toLowerCase()];
  const username = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!username || !USERNAME_RE.test(username)) return null;

  const { db } = ctx;
  const existing = db
    .prepare(
      'SELECT id, username, role, display_name, status, last_login_at FROM users WHERE username = ?',
    )
    .get(username) as
    | (SessionUser & { display_name: string | null; status: string; last_login_at: string | null })
    | undefined;
  if (existing) {
    // Disabled accounts stay out even when the proxy lets them through.
    if (existing.status !== 'active') return null;
    // "Last seen" for People: proxied users never hit /login, so touch it
    // here, at most every 15 minutes.
    const last = existing.last_login_at ? Date.parse(existing.last_login_at) : 0;
    if (Date.now() - last > 15 * 60_000) {
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), existing.id);
    }
    return {
      id: existing.id,
      username: existing.username,
      role: existing.role,
      displayName: existing.display_name,
    };
  }

  const wantsAdmin = proxyAuthAdmins.some((a) => a.toLowerCase() === username.toLowerCase());
  const id = newId('user');
  db.exec('BEGIN IMMEDIATE');
  try {
    const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
    const role = wantsAdmin || count === 0 ? 'admin' : 'reader';
    db.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, username, UNUSABLE_PASSWORD, role, nowIso());
    db.exec('COMMIT');
    ctx.log.info(`Provisioned ${role} "${username}" from proxy header ${proxyAuthHeader}`);
    if (count === 0) ctx.setupToken = null;
    return { id, username, role };
  } catch (err) {
    db.exec('ROLLBACK');
    // Lost a race with a concurrent first request for the same user.
    const again = db
      .prepare('SELECT id, username, role FROM users WHERE username = ?')
      .get(username) as SessionUser | undefined;
    if (again) return again;
    throw err;
  }
}
