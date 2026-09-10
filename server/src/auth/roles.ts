import { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Role } from '@versovox/shared';

/**
 * Role checks. Roles are flat, not hierarchical by accident: an admin can do
 * everything a curator can, a curator everything a reader can.
 */
export const ROLE_RANK: Record<Role, number> = { reader: 0, curator: 1, admin: 2 };

export function hasRole(role: string | undefined, atLeast: Role): boolean {
  return (ROLE_RANK[role as Role] ?? -1) >= ROLE_RANK[atLeast];
}

/** Reply 403 unless the signed-in user holds at least `atLeast`. */
export function requireRole(req: FastifyRequest, reply: FastifyReply, atLeast: Role): boolean {
  if (!req.user || !hasRole(req.user.role, atLeast)) {
    void reply.code(403).send({ error: 'forbidden', detail: `Requires the ${atLeast} role` });
    return false;
  }
  return true;
}
