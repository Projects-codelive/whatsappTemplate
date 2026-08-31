import type { BroadcastStatus } from '@/types'

/**
 * Single source of truth for the broadcast status machine.
 *
 * Phase 3 adds `paused` and `cancelled` to the status set. Every
 * transition in the app (composer, action endpoints, scheduled-send
 * cron, sender-loop finalize) must be a row of this table — asserting
 * elsewhere is a code smell and usually a race.
 *
 *   draft     → scheduled | sending
 *   scheduled → sending    | cancelled
 *   sending   → paused     | cancelled | sent | failed
 *   paused    → sending    | cancelled
 *   sent      → (terminal)
 *   failed    → (terminal)
 *   cancelled → (terminal)
 *
 * Transitions are *claimed* atomically at the DB layer:
 *   UPDATE broadcasts SET status = to
 *   WHERE id = X AND status = from [AND user_id = Y]
 * The status-machine table here only validates intent up front; the
 * `WHERE status = from` clause is the real lock.
 */
export const BROADCAST_TRANSITIONS: Record<
  BroadcastStatus,
  readonly BroadcastStatus[]
> = {
  draft: ['scheduled', 'sending'],
  scheduled: ['sending', 'cancelled'],
  sending: ['paused', 'cancelled', 'sent', 'failed'],
  paused: ['sending', 'cancelled'],
  sent: [],
  failed: [],
  cancelled: [],
}

/** True when `to` is a legal successor of `from`. */
export function canTransition(
  from: BroadcastStatus,
  to: BroadcastStatus,
): boolean {
  return BROADCAST_TRANSITIONS[from].includes(to)
}

/** Throws when `from → to` is not a legal step. */
export function assertTransition(
  from: BroadcastStatus,
  to: BroadcastStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal broadcast transition: ${from} → ${to}`)
  }
}

/** Statuses a finished send loop may finalize INTO from `sending`. */
export const SEND_LOOP_FINISHERS = ['sent', 'failed'] as const;

/**
 * Statuses that may be cancelled by a user (Cancel button / API).
 * `cancel` deliberately excludes `draft` (no recipients yet — just
 * delete it) and the terminal states.
 */
export const CANCELLABLE_STATUSES: readonly BroadcastStatus[] = [
  'scheduled',
  'sending',
  'paused',
];