import { isDispatchOverdue } from '../ledger/dispatchArming.js';
import { LIVE_TASK_STATUSES, SCHEDULED_TASK_STATUSES } from '../ledger/concurrencySlots.js';
import type { WorkflowRunDetail } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Liveness states for a non-terminal workflow run.
 *
 * - `executing`:         At least one task is actively in progress.
 * - `waiting_for_input`: At least one task is paused for human input;
 *                        no task is actively executing. The run should
 *                        surface as "waiting", not generic "running".
 * - `stalled`:           No task is making progress and the scheduler
 *                        cursor has expired (or never advanced). The run
 *                        may be orphaned and should be recovered.
 * - `idle`:              The run is non-terminal but has no active or
 *                        paused tasks. Typically a transient state between
 *                        scheduling passes (e.g., bootstrap just completed,
 *                        next task not yet claimed).
 */
export type RunLiveness = 'executing' | 'waiting_for_input' | 'stalled' | 'idle';

export interface RunLivenessResult {
  liveness: RunLiveness;
  /** Human-readable explanation for operators/debugging. */
  reason: string;
  /** Task IDs in active states (scheduled, running, claimed). */
  activeTaskIds: string[];
  /** Task IDs waiting for human input (paused). */
  pausedTaskIds: string[];
}

// ============================================================================
// Constants
// ============================================================================

/** Task statuses that indicate paused-for-input. */
const PAUSED_TASK_STATUSES = new Set(['paused']);

/** Default stale threshold: if scheduler cursor is older than this, consider stalled. */
const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Derivation
// ============================================================================

/**
 * Derive the liveness state of a workflow run from its current data.
 *
 * @param run - Full run detail including task rows
 * @param opts.now - Current time (injectable for testing)
 * @param opts.staleThresholdMs - How old the scheduler cursor can be before
 *   the run is considered stalled. Defaults to 5 minutes.
 */
export function deriveRunLiveness(
  run: WorkflowRunDetail,
  opts?: { now?: Date; staleThresholdMs?: number },
): RunLivenessResult {
  const now = opts?.now ?? new Date();
  const staleThresholdMs = opts?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  // Terminal runs don't have liveness — but handle gracefully
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return {
      liveness: 'idle',
      reason: `Run is terminal (${run.status}).`,
      activeTaskIds: [],
      pausedTaskIds: [],
    };
  }

  const tasks = run.tasks;
  // A task re-armed by retry or re-execute is durably `running` with no worker
  // until the claim lands, and status alone reads that as the most confident
  // "everything is fine" verdict this function has. Its own commit wrote the
  // deadline it is racing, so past that instant the dispatch did not happen.
  const overdueDispatchTaskIds = tasks
    .filter((t) => isDispatchOverdue(t, now))
    .map((t) => t.taskId);
  const overdue = new Set(overdueDispatchTaskIds);
  const liveTaskIds = tasks
    .filter((t) => LIVE_TASK_STATUSES.has(t.status) && !overdue.has(t.taskId))
    .map((t) => t.taskId);
  const scheduledTaskIds = tasks
    .filter((t) => SCHEDULED_TASK_STATUSES.has(t.status) && !overdue.has(t.taskId))
    .map((t) => t.taskId);
  const activeTaskIds = [...liveTaskIds, ...scheduledTaskIds];
  const pausedTaskIds = tasks
    .filter((t) => PAUSED_TASK_STATUSES.has(t.status))
    .map((t) => t.taskId);

  // Only when nothing else is in flight. A live sibling means the run really is
  // executing, and failing it over one lost dispatch would take the sibling's
  // work with it — the deadline stays on the row for the next pass either way.
  // A paused run is never stalled, whatever its rows say — the operator paused
  // it, and classifying it stalled lets the force-archive path cancel it.
  if (
    overdueDispatchTaskIds.length > 0 &&
    activeTaskIds.length === 0 &&
    pausedTaskIds.length === 0 &&
    run.status !== 'paused'
  ) {
    return {
      liveness: 'stalled',
      reason:
        `${String(overdueDispatchTaskIds.length)} retried task(s) were never claimed for ` +
        `dispatch: ${overdueDispatchTaskIds.join(', ')}; still 'running' with no worker session ` +
        `past their dispatch deadline.`,
      activeTaskIds,
      pausedTaskIds,
    };
  }

  if (liveTaskIds.length === 0 && pausedTaskIds.length === 0 && scheduledTaskIds.length > 0) {
    const referenceTime = run.schedulerCursorAt ?? run.startedAt;
    const referenceAge = now.getTime() - referenceTime.getTime();
    if (referenceAge > staleThresholdMs) {
      const source = run.schedulerCursorAt ? 'scheduler cursor' : 'run start time';
      return {
        liveness: 'stalled',
        reason:
          `${String(scheduledTaskIds.length)} task(s) scheduled but never claimed: ` +
          `${scheduledTaskIds.join(', ')}; ${source} is ` +
          `${String(Math.round(referenceAge / 1000))}s old (threshold: ` +
          `${String(Math.round(staleThresholdMs / 1000))}s).`,
        activeTaskIds,
        pausedTaskIds,
      };
    }
    // else: fall through to "executing" — transient pre-dispatch state.
  }

  // 1. If any task is actively executing → executing
  if (activeTaskIds.length > 0) {
    return {
      liveness: 'executing',
      reason: `${String(activeTaskIds.length)} task(s) actively executing: ${activeTaskIds.join(', ')}.`,
      activeTaskIds,
      pausedTaskIds,
    };
  }

  // 2. If any task is paused (waiting for input) → waiting_for_input
  if (pausedTaskIds.length > 0) {
    return {
      liveness: 'waiting_for_input',
      reason: `${String(pausedTaskIds.length)} task(s) waiting for human input: ${pausedTaskIds.join(', ')}.`,
      activeTaskIds,
      pausedTaskIds,
    };
  }

  // 3. If run.status is 'paused' at the run level (e.g., paused by operator
  //    or by a human task that already completed but run wasn't resumed) and
  //    no tasks are paused, this is explicitly waiting for external resume.
  //    Checked before staleness — a paused run is never stalled, regardless of age.
  if (run.status === 'paused') {
    return {
      liveness: 'waiting_for_input',
      reason: 'Run is paused at the run level (no individual tasks paused).',
      activeTaskIds,
      pausedTaskIds,
    };
  }

  // 4. No active or paused tasks, run is not paused — check staleness.
  //    If the scheduler cursor exists, use it. If absent, fall back to startedAt.
  //    A 'running' run with no cursor and no active tasks that has been
  //    alive longer than the stale threshold is orphaned — it never got
  //    a scheduling pass, or the session that owned it is gone.
  const referenceTime = run.schedulerCursorAt ?? run.startedAt;
  const referenceAge = now.getTime() - referenceTime.getTime();
  if (referenceAge > staleThresholdMs) {
    const source = run.schedulerCursorAt ? 'scheduler cursor' : 'run start time';
    return {
      liveness: 'stalled',
      reason: `No active tasks and ${source} is ${String(Math.round(referenceAge / 1000))}s old (threshold: ${String(Math.round(staleThresholdMs / 1000))}s).`,
      activeTaskIds,
      pausedTaskIds,
    };
  }

  // 5. No tasks active, no tasks paused, reference time is fresh → idle
  //    This is transient: between scheduling passes, or bootstrap just started.
  return {
    liveness: 'idle',
    reason: 'No active or paused tasks. May be between scheduling passes.',
    activeTaskIds,
    pausedTaskIds,
  };
}

// ============================================================================
// Counts-based derivation (104d Phase 1a — eliminates N+1 in attention)
// ============================================================================

export interface RunLivenessInputs {
  status: string;
  startedAt: Date;
  schedulerCursorAt: Date | null;
  /** Count of tasks in live statuses (running, claimed, in_flight). */
  liveTasks: number;
  /** Count of tasks in scheduled status (claimed by scheduler, not yet dispatched). */
  scheduledTasks: number;
  /** Count of tasks in paused status. */
  pausedTasks: number;
  /** Count of tasks in succeeded status. */
  succeededTasks: number;
  /** Total task count. */
  totalTasks: number;
}

/**
 * Derive liveness from pre-aggregated task counts, for the surfaces that list
 * many runs and cannot afford their task rows.
 *
 * Not identical to `deriveRunLiveness()`: the aggregates carry statuses only,
 * so a retried task still awaiting its claim counts as live here and this
 * returns `executing` for it. That is a display verdict — the recovery decision
 * is made from task rows by `deriveRunLiveness`, which is the authority on the
 * undispatched-retry anomaly.
 */
export function deriveRunLivenessFromCounts(
  inputs: RunLivenessInputs,
  opts?: { now?: Date; staleThresholdMs?: number },
): RunLiveness {
  const now = opts?.now ?? new Date();
  const staleThresholdMs = opts?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

  // Terminal
  if (
    inputs.status === 'completed' ||
    inputs.status === 'failed' ||
    inputs.status === 'cancelled'
  ) {
    return 'idle';
  }

  if (inputs.liveTasks === 0 && inputs.pausedTasks === 0 && inputs.scheduledTasks > 0) {
    const referenceTime = inputs.schedulerCursorAt ?? inputs.startedAt;
    const referenceAge = now.getTime() - referenceTime.getTime();
    if (referenceAge > staleThresholdMs) return 'stalled';
    // else: fall through to executing (transient pre-dispatch).
  }

  // Active tasks (live or scheduled) → executing
  if (inputs.liveTasks + inputs.scheduledTasks > 0) return 'executing';

  // Paused tasks → waiting
  if (inputs.pausedTasks > 0) return 'waiting_for_input';

  // Run-level paused → waiting (before staleness check)
  if (inputs.status === 'paused') return 'waiting_for_input';

  // Staleness check
  const referenceTime = inputs.schedulerCursorAt ?? inputs.startedAt;
  const referenceAge = now.getTime() - referenceTime.getTime();
  if (referenceAge > staleThresholdMs) return 'stalled';

  return 'idle';
}

/**
 * Convenience: check if a run is resumable (waiting for input or paused).
 */
export function isRunResumable(liveness: RunLiveness): boolean {
  return liveness === 'waiting_for_input';
}

/**
 * Convenience: check if a run needs recovery attention.
 */
export function isRunRecoverable(liveness: RunLiveness): boolean {
  return liveness === 'stalled';
}
