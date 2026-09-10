import { type FastifyInstance } from 'fastify';
import { progressBatchSchema } from '@versovox/shared';
import { type AppContext } from '../../context.js';
import { applyProgressEvents, getProgressState } from '../../progress/service.js';

export function registerProgressRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/progress/events', async (req, reply) => {
    const parsed = progressBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid', detail: parsed.error.issues[0]?.message });
    }
    return applyProgressEvents(ctx.db, req.user!.id, parsed.data.events);
  });

  app.get('/api/progress/:bookId', async (req) => {
    const { bookId } = req.params as { bookId: string };
    return { state: getProgressState(ctx.db, req.user!.id, bookId) };
  });

  app.get('/api/progress/:bookId/history', async (req) => {
    const { bookId } = req.params as { bookId: string };
    const rows = ctx.db
      .prepare(
        `SELECT event_id, device_id, session_uuid, seq, intent, medium, locator_json, occurred_at, received_at, applied, reject_reason
         FROM progress_events WHERE user_id = ? AND book_id = ? ORDER BY received_at DESC LIMIT 100`,
      )
      .all(req.user!.id, bookId) as Record<string, unknown>[];
    return {
      events: rows.map((r) => ({
        eventId: String(r.event_id),
        deviceId: String(r.device_id),
        sessionId: String(r.session_uuid),
        seq: Number(r.seq),
        intent: String(r.intent),
        locator: JSON.parse(String(r.locator_json)),
        occurredAt: String(r.occurred_at),
        receivedAt: String(r.received_at),
        applied: Number(r.applied) === 1,
        rejectReason: (r.reject_reason as string) ?? null,
      })),
    };
  });
}
