import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { progressEventSchema, type ProgressAck, type ProgressEvent } from '@versovox/shared';
import { type AppContext } from '../../context.js';
import { applyProgressEvents, getProgressState } from '../../progress/service.js';

/** The envelope must hold, but each event stands or falls on its own. */
const progressEnvelopeSchema = z.object({ events: z.array(z.unknown()).min(1).max(200) });

export function registerProgressRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/progress/events', async (req, reply) => {
    const envelope = progressEnvelopeSchema.safeParse(req.body);
    if (!envelope.success) {
      return reply.code(400).send({ error: 'invalid', detail: envelope.error.issues[0]?.message });
    }
    // A batch is a drained offline queue, not a form. Refusing all 200 events
    // because one is malformed loses the other 199 and leaves the client
    // resending the same slice forever, blocking every later checkpoint for
    // every book. Each bad event comes back named and rejected instead, which
    // is a durable verdict the client can act on by dropping it.
    const events: ProgressEvent[] = [];
    const rejected: ProgressAck['results'] = [];
    for (const raw of envelope.data.events) {
      const parsed = progressEventSchema.safeParse(raw);
      if (parsed.success) {
        events.push(parsed.data);
        continue;
      }
      const eventId = (raw as { eventId?: unknown } | null)?.eventId;
      // Without an id there is no verdict to deliver; the rest still applies.
      if (typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 64) {
        rejected.push({
          eventId,
          status: 'rejected',
          reason: parsed.error.issues[0]?.message ?? 'invalid',
        });
      }
    }
    const ack = applyProgressEvents(ctx.db, req.user!.id, events);
    return { ...ack, results: [...ack.results, ...rejected] };
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
