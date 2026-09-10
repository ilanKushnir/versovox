# Loss-resistant progress

The design goal: **a checkpoint, once made, survives anything short of
losing the device — and no stale client can silently move you backward or
forward.**

## Client (local-first)

1. Every checkpoint (open/heartbeat/pause/seek/switch/finish) is written to
   IndexedDB **before** any network I/O, as an idempotent event:
   client-generated UUID, stable `deviceId`, per-load `sessionId`, monotonic
   `seq`, client timestamp, explicit intent, and the canonical locator.
2. A background flusher syncs pending events when online, on an interval, on
   `visibilitychange`/`pagehide` (with `keepalive` fetch), and on `online`.
3. Acknowledged events are deleted; the server's reconciled state is cached
   locally.
4. **Resume** combines the newest acknowledged server state with any newer
   unacknowledged local events — using the _same_ decision function the
   server runs (`@tandemleaf/shared` `resolveResume`), so offline reading
   resumes correctly and reconciles idempotently later.

## Server (append-only + reconciled state)

- `progress_events` is append-only history (rejected events are recorded
  with their reason — nothing is dropped silently); `progress_state` holds
  the reconciled current position with a revision counter. Batches apply in
  one transaction.
- Reconciliation (`decideApply`, unit + integration tested):
  - duplicates (same eventId) acknowledge idempotently;
  - **explicit intents claim playback** — a newer seek/open/switch/finish
    wins by client time (per-session `seq` as tiebreak), and an explicit
    rewind is _forward progress_ even though the percentage decreases;
  - **heartbeats only apply from the session holding the claim** — the
    stale-background-tab scenario (user rewinds on the phone, a forgotten
    desktop tab keeps heartbeating a later position) is recorded but not
    applied;
  - a stale session re-claims by emitting its own explicit intent (`open`
    on load), after which its heartbeats count again.
- Old unapplied heartbeats are compacted after 30 days; explicit history is
  kept for conflict diagnostics (visible at
  `GET /api/progress/:bookId/history`).
