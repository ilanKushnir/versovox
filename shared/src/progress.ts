import { z } from 'zod';
import { locatorSchema } from './locator.js';

/**
 * Loss-resistant progress contract.
 *
 * Clients write every checkpoint to IndexedDB first, then sync events that
 * are idempotent (client-generated UUID) and ordered (device/session/seq).
 * The server appends to history and reconciles; it never trusts "largest
 * percentage wins".
 *
 * Reconciliation rules (implemented server-side, tested):
 *  1. A duplicate eventId is acknowledged idempotently and changes nothing.
 *  2. Explicit intents (open/pause/seek/switch/finish) claim playback: they
 *     apply when they are newer than the current state's explicit claim
 *     (occurredAt, with per-session seq as tiebreak).
 *  3. Heartbeats only apply when they come from the session holding the
 *     claim. A stale background tab's heartbeats cannot override a newer
 *     foreground seek/rewind from another session or device.
 *  4. Explicit rewind is forward progress: intent wins, not percentage.
 */

export const progressIntentSchema = z.enum([
  'open',
  'heartbeat',
  'pause',
  'seek',
  'switch',
  'finish',
]);
export type ProgressIntent = z.infer<typeof progressIntentSchema>;

export const EXPLICIT_INTENTS: ReadonlySet<ProgressIntent> = new Set([
  'open',
  'pause',
  'seek',
  'switch',
  'finish',
]);

export const progressEventSchema = z.object({
  eventId: z.uuid(),
  bookId: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  seq: z.number().int().min(0),
  /**
   * Client wall-clock time. Diagnostic metadata only: reconciliation clamps
   * it to the receiver's clock (+ small skew), so a device with a clock far
   * in the future cannot hold the claim forever (see reconcile.ts).
   */
  occurredAt: z.iso.datetime(),
  /**
   * Revision of the server state the client had last seen for this book.
   * When it matches the current revision, an explicit intent is causally
   * newer than the claim regardless of clock skew.
   */
  baseRevision: z.number().int().min(0).optional(),
  intent: progressIntentSchema,
  locator: locatorSchema,
});
export type ProgressEvent = z.infer<typeof progressEventSchema>;

export const progressBatchSchema = z.object({
  events: z.array(progressEventSchema).min(1).max(200),
});
export type ProgressBatch = z.infer<typeof progressBatchSchema>;

export const progressStateSchema = z.object({
  bookId: z.string(),
  revision: z.number().int().min(0),
  locator: locatorSchema,
  intent: progressIntentSchema,
  occurredAt: z.iso.datetime(),
  sessionId: z.string(),
  deviceId: z.string(),
  seq: z.number().int(),
  updatedAt: z.iso.datetime(),
  finished: z.boolean(),
});
export type ProgressState = z.infer<typeof progressStateSchema>;

export const progressAckSchema = z.object({
  results: z.array(
    z.object({
      eventId: z.uuid(),
      status: z.enum(['applied', 'recorded', 'duplicate', 'rejected']),
      reason: z.string().optional(),
    }),
  ),
  state: progressStateSchema.nullable(),
});
export type ProgressAck = z.infer<typeof progressAckSchema>;
