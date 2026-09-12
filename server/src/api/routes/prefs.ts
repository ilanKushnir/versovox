import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FACET_KINDS, type SidebarPrefs } from '@readport/shared';
import { type AppContext } from '../../context.js';
import { nowIso } from '../../db/index.js';

/**
 * Per-person interface state.
 *
 * Not in `settings`, which is the server's configuration and belongs to the
 * admin. Which groups someone wants in their sidebar is theirs alone: two
 * people share every book on a ReadPort server and no furniture at all, and
 * one of them turning off Narrators must not take it from the other.
 *
 * Every key is validated by its own schema on the way in. A key/value table
 * makes the next preference a write rather than a migration, but it would
 * also happily store anything, so nothing is trusted on the way out either —
 * a row that no longer parses is treated as absent, which is what happens to
 * a preference written by a newer version and read back by an older one.
 */

const sidebarSchema = z.object({
  facets: z.array(z.enum(FACET_KINDS)).max(FACET_KINDS.length),
  chosen: z.boolean(),
});

/** The keys this build knows, and how each is validated. */
const KEYS = {
  sidebar: sidebarSchema,
} as const;

type PrefKey = keyof typeof KEYS;

export function readPref<K extends PrefKey>(
  ctx: AppContext,
  userId: string,
  key: K,
): z.infer<(typeof KEYS)[K]> | null {
  const row = ctx.db
    .prepare('SELECT value_json FROM user_prefs WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed = KEYS[key].safeParse(JSON.parse(row.value_json));
    return parsed.success ? (parsed.data as z.infer<(typeof KEYS)[K]>) : null;
  } catch {
    return null;
  }
}

export function registerPrefsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/prefs/sidebar', async (req) => {
    const value = readPref(ctx, req.user!.id, 'sidebar');
    // `chosen: false` is the honest answer for someone who has never opened
    // the customise sheet, and is what makes the client's defaults apply
    // without hard-coding them in two places.
    const prefs: SidebarPrefs = value ?? { facets: [], chosen: false };
    return { sidebar: prefs };
  });

  app.put('/api/prefs/sidebar', async (req, reply) => {
    const body = sidebarSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid', detail: body.error.issues[0]?.message });
    }
    // Duplicates would render the same group twice; order is meaningful, so
    // the first mention of each wins rather than the last.
    const facets = body.data.facets.filter((f, i, all) => all.indexOf(f) === i);
    const value: SidebarPrefs = { facets, chosen: body.data.chosen };
    db.prepare(
      `INSERT INTO user_prefs (user_id, key, value_json, updated_at) VALUES (?, 'sidebar', ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    ).run(req.user!.id, JSON.stringify(value), nowIso());
    return { sidebar: value };
  });
}
