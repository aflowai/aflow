import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import type { SkillConcurrencyPolicy } from '@aflow/schemas';

// ============================================================================

/**
 * Relational storage for workflow runs (replaces JSON ledger doc).
 * Part of the cybernetic loop's bounded-growth substrate.
 */
export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull(),
  workflowSlug: text('workflow_slug').notNull(),
  runId: text('run_id').notNull().unique(),
  sessionId: uuid('session_id'),
  /** 'running' | 'paused' | 'completed' | 'failed' */
  status: text('status').notNull(),
  workflowRevision: integer('workflow_revision').notNull(),
  /**
   * Concurrency policy frozen at run creation, alongside `workflow_revision` —
   * a manifest edit landing mid-run must not change the limits of a run
   * already in flight. NULL on rows created before the column; readers fall
   * back to the schema defaults.
   */
  effectiveConcurrencyPolicy: jsonb('effective_concurrency_policy').$type<SkillConcurrencyPolicy>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  totalCostCents: integer('total_cost_cents'),
  totalTokens: integer('total_tokens'),
  evaluationJson: jsonb('evaluation_json'),
  failureJson: jsonb('failure_json'),
  learningsJson: jsonb('learnings_json'),
  /**
   * Cancellation provenance (operator-cancel legibility). NULL unless
   * status === 'cancelled' and the cancel went through the harness
   * cascade. See `WorkflowRunCancelActorSchema` in @aflow/schemas:
   * 'operator' | 'system' | 'agent'.
   */
  cancelledBy: text('cancelled_by'),
  /** Optional human-readable cancellation reason (mirrors attention payload). */
  cancelReason: text('cancel_reason'),
  score: doublePrecision('score'),
  scoreProvenance: jsonb('score_provenance'),
  campaignId: uuid('campaign_id'),
  /**
   * Plan 269 D5 — frozen-mode marker. Set ONLY by the eval-batch launcher;
   * NULL for every production run. When set: learnings injection resolves to
   * the case fixture only, Coach/candidate/score post-run hooks are off,
   * production-suite evaluation is skipped (batch grading owns the verdict),
   * and campaign series / run listings exclude the run. Typed, never inferred.
   */
  evalBatchId: text('eval_batch_id'),
  /**
   * What this run pins its simulated worlds to — persona, baseline, seed,
   * disclosure and generation model, keyed by simulationId.
   *
   * Durable on the RUN because the Runner sessions the harness spawns are
   * separate sessions started later: each one has to be handed the same pins,
   * or a workflow told to act as one persona would run its tasks as another.
   * Set by whoever started the run; a skill's own Runner never sees the
   * operation that carries it.
   */
  simulationRunInputJson: jsonb('simulation_run_input_json'),
  schedulerCursorAt: timestamp('scheduler_cursor_at', { withTimezone: true }),
  /** 104d Phase 1: when the scheduler considers this run stalled. */
  schedulerCursorDeadline: timestamp('scheduler_cursor_deadline', { withTimezone: true }),
  /** 104d Phase 3: user who initiated this run (NULL for system/platform runs). */
  initiatedByUserId: uuid('initiated_by_user_id'),
  metadata: jsonb('metadata').notNull().default({}),
  /**
   * Typed pause cause. NULL when status !== 'paused'. See
   * WorkflowRunPauseReason in @aflow/schemas.
   */
  pausedReason: text('paused_reason'),
  /**
   * Payload-store ref to the structured WorkflowResumeContract (cause,
   * prompt, mode-specific schemas, harness fields). NULL when status !== 'paused'.
   */
  pausedPayloadRef: text('paused_payload_ref'),
  /**
   * What execution observed, recorded where it is known. The pause contract's
   * prompt carries a harness placeholder when the subject supplied nothing, so
   * silence is indistinguishable from a short answer by the time anything
   * reads the payload.
   */
  executionState: text('execution_state'),
  /**
   * agentId → the version this run is pinned to. Dispatch spawns its Runner at
   * `latest` unless a pin names otherwise, so this is what makes a recorded
   * pin the version that actually ran.
   */
  agentVersionPins: jsonb('agent_version_pins').$type<Record<string, string>>(),
  pauseVersion: integer('pause_version').notNull().default(0),
  /**
   * Random nonce stamped by the winning resume CAS; cleared on completion
   * or expiry. While non-NULL and unexpired, additional resumes get
   * RESUME_IN_PROGRESS.
   */
  resumeClaimToken: text('resume_claim_token'),
  /** When the current resume claim is treated as stale (default now() + 60s). */
  resumeClaimExpiresAt: timestamp('resume_claim_expires_at', { withTimezone: true }),
  /** Telemetry-only; bumped on every resume CAS attempt that succeeds. */
  resumeAttemptCount: integer('resume_attempt_count').notNull().default(0),
  schedulerCursorVersion: integer('scheduler_cursor_version').notNull().default(0),
});

export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type NewWorkflowRunRow = typeof workflowRuns.$inferInsert;

/**
 * Individual task results within a workflow run.
 */
export const workflowRunTasks = pgTable('workflow_run_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: text('run_id').notNull(),
  taskId: text('task_id').notNull(),
  /** 'scheduled' | 'running' | 'succeeded' | 'failed' | 'paused' | 'blocked' | 'skipped' */
  status: text('status').notNull(),
  attempt: integer('attempt').notNull().default(1),
  sessionId: text('session_id'),
  workerSessionId: uuid('worker_session_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
  costCents: integer('cost_cents'),
  metricsJson: jsonb('metrics_json'),
  summary: text('summary'),
  failureReason: text('failure_reason'),
  outputRef: text('output_ref'),
  reflectionJson: jsonb('reflection_json'),
  /** 104d Phase 1: which StepExecution is handling this task. */
  stepExecutionId: text('step_execution_id'),
  inputRef: text('input_ref'),
  pendingCompletionAt: timestamp('pending_completion_at', { withTimezone: true }),
  /**
   * When a task re-armed by retry or re-execute must have been claimed by.
   * Written by the commit that clears `worker_session_id`, cleared by the claim
   * — so `running` with no worker past this instant is a dispatch that never
   * happened rather than one that just has not happened yet.
   */
  dispatchDeadlineAt: timestamp('dispatch_deadline_at', { withTimezone: true }),
  dispatchAttemptToken: text('dispatch_attempt_token'),
  operationId: text('operation_id'),
  errorCode: text('error_code'),
  errorClassification: text('error_classification'),
  errorRetryable: boolean('error_retryable'),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  priorFailures: jsonb('prior_failures').notNull().default([]),
  humanTaskHydrationRef: text('human_task_hydration_ref'),
  humanTaskHydrationPauseVersion: integer('human_task_hydration_pause_version'),
  humanTaskHydrationAttempt: integer('human_task_hydration_attempt'),
  pollCycle: integer('poll_cycle').notNull().default(1),
});

export type WorkflowRunTaskRow = typeof workflowRunTasks.$inferSelect;
export type NewWorkflowRunTaskRow = typeof workflowRunTasks.$inferInsert;

// ============================================================================

export const workflowRunWaiters = pgTable('workflow_run_waiters', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: text('run_id').notNull(),
  waiterSessionId: uuid('waiter_session_id').notNull(),
  waiterStepExecutionId: uuid('waiter_step_execution_id').notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when the waiter is notified; row stays for audit. */
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  /**
   * 'completed' | 'paused' | 'failed' | 'cancelled' | 'handed_off'
   *
   * `handed_off`: a takeover resume (`workflow.run.resume` with
   * `takeOver: true`) released this waiter; the resuming session becomes the
   * active waiter via a freshly-inserted row. Resumes without takeover leave
   * existing waiters pending.
   */
  notifiedOutcome: text('notified_outcome'),
});

export type WorkflowRunWaiterRow = typeof workflowRunWaiters.$inferSelect;
export type NewWorkflowRunWaiterRow = typeof workflowRunWaiters.$inferInsert;

export const workflowRunCompletionPending = pgTable('workflow_run_completion_pending', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: text('run_id').notNull(),
  taskId: text('task_id').notNull(),
  attempt: integer('attempt').notNull(),
  workerSessionId: uuid('worker_session_id').notNull(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  /** Sweeper retry counter. Bumped on each "still alive, bumping" check. */
  attemptCount: integer('attempt_count').notNull().default(0),
  lastError: text('last_error'),
});

export type WorkflowRunCompletionPendingRow = typeof workflowRunCompletionPending.$inferSelect;
export type NewWorkflowRunCompletionPendingRow = typeof workflowRunCompletionPending.$inferInsert;

export const attentionItems = pgTable('attention_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id'),
  spaceId: uuid('space_id'),
  /**
   * 'workflow_run_completed' | 'workflow_run_paused' | 'workflow_run_failed'
   *   | 'workflow_run_cancelled' | (future: 'coach_proposal' etc.)
   */
  kind: text('kind').notNull(),
  /** Set when kind is `workflow_run_*`; null otherwise. */
  relatedRunId: text('related_run_id'),
  /** Generic resource pointer for non-workflow kinds. */
  relatedResource: text('related_resource'),
  payload: jsonb('payload').notNull().default({}),
  priority: integer('priority').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedBySession: uuid('consumed_by_session'),
});

export type AttentionItemRow = typeof attentionItems.$inferSelect;
export type NewAttentionItemRow = typeof attentionItems.$inferInsert;
