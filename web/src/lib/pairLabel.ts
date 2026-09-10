import { type HandoffStatus, type PairStatus } from '@versovox/shared';
import { formatPct } from './format';

/**
 * Honest paired-edition status line. Claims are grounded in what the
 * alignment actually provides:
 *  - switchable + handoff: quotes the measured exact-sentence coverage.
 *  - candidate: a possible match awaiting review.
 *  - linked but not yet aligned: switching is UNAVAILABLE until alignment
 *    exists — no accuracy of any kind is promised (a linked pair without an
 *    alignment cannot resolve positions at all).
 */
export function pairStatusLabel(pair: {
  status: PairStatus;
  switchable: boolean;
  handoff: HandoffStatus | null;
}): string {
  if (pair.switchable && pair.handoff) {
    return `Read/listen handoff is ready — ${formatPct(
      pair.handoff.exactSentenceCoverage,
    )} of sentences switch exactly; the rest is approximate or unavailable.`;
  }
  if (pair.status === 'candidate') {
    return 'A possible matching edition was found — review it in Pairing.';
  }
  return 'Paired edition linked. Switching between text and audio is unavailable until alignment completes.';
}

/**
 * Pairing-page copy for a linked-but-unaligned pair. With no alignment the
 * resolver returns nothing at all (granularity 'none'), so switching is
 * UNAVAILABLE — it is never "approximate", and the UI must not claim any
 * accuracy.
 */
export const UNALIGNED_PAIR_NOTE =
  'Not aligned yet — switching between editions is unavailable until alignment completes.';

/** Manual-link sheet copy; same honesty rule as UNALIGNED_PAIR_NOTE. */
export const MANUAL_LINK_NOTE =
  'Choose an ebook and an audiobook of the same work. Alignment runs after linking; switching between editions is unavailable until alignment completes.';
