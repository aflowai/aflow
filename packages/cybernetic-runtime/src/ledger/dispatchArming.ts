/**
 * The one definition of "this task row has been re-armed and is waiting to be
 * dispatched".
 *
 * Several ledger writes produce it, from different operator surfaces. Each
 * clears the worker session inside its own transaction and leaves the claim to
 * a later, separate call, so everything in between is a durably `running` row
 * with no worker behind it — which every liveness reader would otherwise count
 * as executing.
 *
 * The deadline is what makes that state legible, and it is derived here rather
 * than written at each commit so a new re-arming path cannot be added without
 * it. Counting the paths in prose would be the same mistake one layer up: a
 * guard test fails if any of them stops going through this.
 */

/**
 * How long a re-armed task may go unclaimed before its dispatch is treated as
 * lost.
 *
 * A domain constant: it bounds the commit-then-dispatch handoff — one
 * definition load, one input build, one claim — not how often anything looks.
 * Generous, because the expensive direction of error is deciding a dispatch
 * that is merely slow has failed.
 */
export const DISPATCH_CLAIM_GRACE_MS = 120_000;

export interface AwaitingDispatchPatch {
  status: 'running';
  workerSessionId: null;
  startedAt: null;
  dispatchDeadlineAt: Date;
}

export function awaitingDispatchPatch(nowMs: number = Date.now()): AwaitingDispatchPatch {
  return {
    status: 'running',
    workerSessionId: null,
    startedAt: null,
    dispatchDeadlineAt: new Date(nowMs + DISPATCH_CLAIM_GRACE_MS),
  };
}

/**
 * Whether a task row is a dispatch that never happened.
 *
 * The deadline alone is not the test — a row that carries one but has been
 * claimed has a worker session, and the claim clears the deadline in the same
 * statement. Both halves are required so a stale deadline on a live row can
 * never be read as an anomaly.
 *
 * `scheduled` counts as well as `running`: a slot reservation commits its row
 * before the dispatch it is for, so a process that dies in that window leaves
 * one behind holding a slot with no worker that will ever claim it.
 */
export function isDispatchOverdue(
  task: { status: string; workerSessionId: string | null; dispatchDeadlineAt: Date | null },
  now: Date,
): boolean {
  if (task.status !== 'running' && task.status !== 'scheduled') return false;
  if (task.workerSessionId !== null) return false;
  if (!task.dispatchDeadlineAt) return false;
  return task.dispatchDeadlineAt.getTime() <= now.getTime();
}
