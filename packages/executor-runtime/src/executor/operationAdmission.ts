/**
 * Admission for an operation this executor runs only so many of at once.
 *
 * The step waits once it is claimed rather than in the stream's backlog: a
 * claimed step keeps the in-flight record that tells every stall watchdog its
 * executor is still on it, which an unread message has no way to say, and its
 * timeout starts only once it is admitted, so the wait is not charged to the
 * work. While it waits it gives back its executor-wide slot, so the
 * operations behind it that have no limit of their own are not held up by it.
 * The signal ends the wait and leaves the place in the queue; a step it
 * reaches has neither slot. Resolves to whether the step had to wait.
 */
import type { ConcurrencyLimiter } from '../concurrency.js';
import type { SlotController } from '../types.js';
import { STEP_HEARTBEAT_INTERVAL_MS } from './constants.js';

export async function admitOperation(admission: {
  readonly limiter: ConcurrencyLimiter;
  readonly slotController: SlotController;
  readonly refreshInFlight: () => void;
  readonly waiting: () => void;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const { limiter, slotController, refreshInFlight, waiting, signal } = admission;
  signal.throwIfAborted();
  if (limiter.tryAcquire()) return false;
  waiting();
  slotController.release();
  const heartbeat = setInterval(refreshInFlight, STEP_HEARTBEAT_INTERVAL_MS);
  try {
    await limiter.acquire(signal);
  } finally {
    clearInterval(heartbeat);
  }
  await slotController.acquire();
  return true;
}
