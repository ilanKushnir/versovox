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
   The `pagehide` flush is trimmed to a 48 KiB keepalive budget, because the
   browser silently drops a keepalive body over 64 KiB — which is exactly the
   moment the backlog is largest and the loss would be worst. Alongside it the
   live locator is written synchronously to `localStorage`, because a tab being
   frozen may never let an IndexedDB transaction commit.
3. Acknowledged events are deleted; the server's reconciled state is cached
   locally.
4. **A revoked session does not discard the queue.** A 401 stops the app
   trusting cached _content_ — the offline packages, the cached server state —
   but the reader's own unsent writes are theirs, and an expiry discovered on
   landing after a flight would otherwise erase the flight. The queue is
   stamped with the account that made it and is cleared only on a deliberate
   sign-out (after a flush attempt) or when a _different_ account signs in on
   the same browser.
5. **Resume** combines the newest acknowledged server state with any newer
   unacknowledged local events — using the _same_ decision function the
   server runs (`@versovox/shared` `resolveResume`), so offline reading
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
- A batch is validated per event, not as a whole: one malformed event is
  rejected with a reason and the rest of the batch still applies. A single bad
  row used to 400 the request, and a client that could not identify which row
  to drop would retry the same batch forever.
- The acknowledgement carries the reconciled state of **every** book in the
  batch, not just the last one, so a client syncing several books at once
  learns all of their revisions in one round trip.
- Heartbeats older than the retention window (30 days) are compacted, applied
  or not — the current position lives in `progress_state`, so an applied
  heartbeat from last year is history nobody reads. Explicit intents are kept
  for conflict diagnostics (visible at `GET /api/progress/:bookId/history`).
  Compaction runs in bounded batches so the first pass on a long-running
  server cannot hold the write lock against an arriving checkpoint.
