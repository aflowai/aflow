import { z } from 'zod';

// ============================================================================
// workflow_run_waiters
// ============================================================================

/**
 * Outcome stamped on a waiter when it's notified by `notifyWaiters`.
 *
 * - `completed`  — workflow run reached terminal success
 * - `paused`     — workflow run paused (signal_blocked / contract / human task)
 * - `failed`     — workflow run reached terminal failure
 * - `cancelled`  — workflow run was cancelled (via workflow.run.cancel)
 * - `handed_off` — a different session took over this run via
 *                  `workflow.run.resume` with `takeOver: true`; this waiter is
 *                  released and no longer the active observer. A resume
 *                  WITHOUT takeover leaves waiters registered — they receive
 *                  the run's later pause/terminal notifications as normal.
 */
export const WaiterNotifiedOutcomeSchema = z.enum([
  'completed',
  'paused',
  'failed',
  'cancelled',
  'handed_off',
]);
export type WaiterNotifiedOutcome = z.infer<typeof WaiterNotifiedOutcomeSchema>;

// ============================================================================

/**
 * Who initiated a workflow-run cancellation:
 *
 * - `operator` — a human stopped the run deliberately (run-surface Cancel
 *   button / operator BFF route). This is INTENT, not a platform failure:
 *   downstream automation (Helmsman retry/resume, post-run eval + Coach
 *   review) must treat it as "stop, don't auto-retry, ask the user".
 * - `agent`    — an agent cancelled via `workflow.run.cancel` or the
 *   `replace_active` concurrency policy on `workflow.run.start`.
 * - `system`   — platform-driven teardown (archive sweeps, lifecycle).
 */
export const WorkflowRunCancelActorSchema = z.enum(['operator', 'system', 'agent']);
export type WorkflowRunCancelActor = z.infer<typeof WorkflowRunCancelActorSchema>;

/**
 * Cancellation provenance stamped on the run's terminal state
 * (`workflow_runs.cancelled_by` / `cancel_reason`), threaded through the
 * cancel cascade (`cancelRun` → `completeRun` → `notifyWaiters`), and
 * surfaced on `workflow.run.detail`. Defaults to `system` so unattributed
 * cancels stay system-classified.
 */
export const WorkflowRunCancellationSchema = z.object({
  cancelledBy: WorkflowRunCancelActorSchema.default('system'),
  reason: z.string().max(500).optional(),
});
export type WorkflowRunCancellation = z.infer<typeof WorkflowRunCancellationSchema>;
export type WorkflowRunCancellationInput = z.input<typeof WorkflowRunCancellationSchema>;

/**
 * The retry affordance carried INSIDE the waiter wake-up envelope (the
 * synthetic tool result the parked Helmsman reads on its next turn). The
 * rule rides the envelope value itself, not prompt prose:
 *
 * - `do_not_restart_without_explicit_user_instruction` — an operator
 *   stopped this run deliberately. The agent must not start or resume
 *   this workflow again unless the user explicitly asks.
 * - `may_restart` — agent/system cancellation; restarting is a normal
 *   agent decision.
 */
export const WorkflowRunCancelRetryPolicySchema = z.enum([
  'do_not_restart_without_explicit_user_instruction',
  'may_restart',
]);
export type WorkflowRunCancelRetryPolicy = z.infer<typeof WorkflowRunCancelRetryPolicySchema>;

/** Cancellation block of the waiter wake-up envelope (`outcome: 'cancelled'`). */
export const WorkflowRunWakeupCancellationSchema = WorkflowRunCancellationSchema.extend({
  retryPolicy: WorkflowRunCancelRetryPolicySchema,
});
export type WorkflowRunWakeupCancellation = z.infer<typeof WorkflowRunWakeupCancellationSchema>;

/**
 * Derive the wake-up envelope's cancellation block. Single source of the
 * actor → retry-policy rule: operator cancels are deliberate stops.
 */
export function buildWakeupCancellation(
  cancellation: WorkflowRunCancellation,
): WorkflowRunWakeupCancellation {
  return {
    ...cancellation,
    retryPolicy:
      cancellation.cancelledBy === 'operator'
        ? 'do_not_restart_without_explicit_user_instruction'
        : 'may_restart',
  };
}

/**
 * One row from `workflow_run_waiters`. Multiple historical rows per
 * (run_id, waiter_session_id) accumulate over the run's pause cycles;
 * the partial unique index `waiters_one_active_per_session` permits
 * only one ACTIVE (notified_at IS NULL) row per (run, session).
 */
export const WorkflowRunWaiterSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  waiterSessionId: z.string().uuid(),
  waiterStepExecutionId: z.string().uuid(),
  registeredAt: z.date(),
  notifiedAt: z.date().nullable(),
  notifiedOutcome: WaiterNotifiedOutcomeSchema.nullable(),
});
export type WorkflowRunWaiter = z.infer<typeof WorkflowRunWaiterSchema>;

/**
 * Inputs to `addWaiter`. The handler inserts (run_id, session, step) and
 * returns the generated row id.
 */
export const AddWaiterInputSchema = z.object({
  runId: z.string(),
  waiterSessionId: z.string().uuid(),
  waiterStepExecutionId: z.string().uuid(),
});
export type AddWaiterInput = z.infer<typeof AddWaiterInputSchema>;

// ============================================================================
// workflow_run_completion_pending
// ============================================================================

/**
 * One row from `workflow_run_completion_pending`. Inserted at task claim time
 * AND at Runner-terminal detection. Cleared on `recordTaskResult`.
 *
 * The sweeper (`reconcileStaleRun`) inspects rows past `dueAt`:
 *   - Worker session present + non-terminal → bump dueAt, skip.
 *   - Worker session missing → orphan; reset task to `scheduled`, re-dispatch.
 *   - Worker session present + terminal → re-run intercept.
 *   - Worker session present + cancelled → drop pending row.
 *
 * `dueAt` is sweep cadence (default 60s), NOT max task runtime.
 */
export const WorkflowRunCompletionPendingSchema = z.object({
  id: z.string().uuid(),
  runId: z.string(),
  taskId: z.string(),
  attempt: z.number().int().min(1),
  workerSessionId: z.string().uuid(),
  detectedAt: z.date(),
  dueAt: z.date(),
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type WorkflowRunCompletionPending = z.infer<typeof WorkflowRunCompletionPendingSchema>;

// ============================================================================
// attention_items
// ============================================================================

/**
 * Kinds of attention items we recognize today. v2 launches with the four
 * `workflow_run_*` kinds; future plans extend with `coach_proposal`,
 * `user_notification`, etc.
 */
export const AttentionItemKindSchema = z.enum([
  'workflow_run_completed',
  'workflow_run_paused',
  'workflow_run_failed',
  'workflow_run_cancelled',
]);
export type AttentionItemKind = z.infer<typeof AttentionItemKindSchema>;

/**
 * One row from `attention_items`. Written transactionally with the row-state
 * update that triggered it (terminal/pause/cancel). Helmsman queries via
 * `workflow.run.list_attention`; future UI surfaces auto-inject at session
 * start / agent.turn boundaries.
 */
export const AttentionItemSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  spaceId: z.string().uuid().nullable(),
  kind: AttentionItemKindSchema,
  relatedRunId: z.string().nullable(),
  relatedResource: z.string().nullable(),
  payload: z.record(z.unknown()),
  priority: z.number().int(),
  createdAt: z.date(),
  consumedAt: z.date().nullable(),
  consumedBySession: z.string().uuid().nullable(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

/**
 * Inputs to `addAttentionItem`. The handler appends a row inside the same
 * DB transaction as the workflow_runs / workflow_run_tasks state update
 * that triggered the attention. `tenantId` is taken from the trusted
 * parameter passed to the helper, not the args object — keeping schema
 * input free of tenant context prevents accidental cross-tenant inserts.
 */
export const AddAttentionItemInputSchema = z.object({
  userId: z.string().uuid().optional(),
  spaceId: z.string().uuid().optional(),
  kind: AttentionItemKindSchema,
  relatedRunId: z.string().optional(),
  relatedResource: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  priority: z.number().int().default(0),
});
export type AddAttentionItemInput = z.infer<typeof AddAttentionItemInputSchema>;
