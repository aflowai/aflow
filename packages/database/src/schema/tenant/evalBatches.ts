import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ============================================================================

/**
 * Eval batch head (Plan 269 D5/D17): one execution of
 * (dataset version × skill revision × trials) as durable state. The row IS
 * the batch's state machine — dispatch, cancellation, cost ceiling, and
 * terminalization all CAS against `status` here. Jsonb content is typed by
 * `EvalBatchProvenanceManifestSchema` / `EvalBatchSummarySchema`
 * (@aflow/schemas).
 */
export const evalBatches = pgTable(
  'eval_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    workflowSlug: text('workflow_slug').notNull(),
    datasetId: uuid('dataset_id').notNull(),
    datasetVersion: integer('dataset_version').notNull(),
    /** Immutable skill revision every trial runs at. */
    workflowRevision: integer('workflow_revision').notNull(),
    /** 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' */
    status: text('status').notNull(),
    trialsPerCase: integer('trials_per_case').notNull(),
    /** Batch-level dispatch cap, composed with the skill's concurrency policy. */
    maxConcurrentTrials: integer('max_concurrent_trials').notNull(),
    /** Hard ceiling: dispatch aborts when costSpentCents crosses it. */
    costCeilingCents: integer('cost_ceiling_cents').notNull(),
    costSpentCents: integer('cost_spent_cents').notNull().default(0),
    /** D10: graded trials drawn uniformly into the validation label queue at completion. */
    validationSliceSize: integer('validation_slice_size').notNull().default(0),
    provenanceManifestJson: jsonb('provenance_manifest_json').notNull(),
    /** Terminal scorecard summary; NULL until the batch terminalizes. */
    summaryJson: jsonb('summary_json'),
    /** Operator-supplied purpose of the batch, for the record. */
    notes: text('notes'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('eval_batches_space_workflow_idx').on(table.spaceId, table.workflowSlug, table.createdAt),
    index('eval_batches_status_idx').on(table.status),
  ],
);

export type EvalBatchRow = typeof evalBatches.$inferSelect;
export type NewEvalBatchRow = typeof evalBatches.$inferInsert;

// ============================================================================

/**
 * The exact case-revision set a batch ran, persisted at launch — a batch's
 * input set survives even a dataset-repair migration (D4).
 */
export const evalBatchMembers = pgTable(
  'eval_batch_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').notNull(),
    caseRevisionId: uuid('case_revision_id').notNull(),
  },
  (table) => [
    uniqueIndex('eval_batch_members_identity_idx').on(table.batchId, table.caseRevisionId),
  ],
);

export type EvalBatchMemberRow = typeof evalBatchMembers.$inferSelect;
export type NewEvalBatchMemberRow = typeof evalBatchMembers.$inferInsert;

// ============================================================================

/**
 * Per-trial durable state + verdict (D17). Dispatch is idempotent per
 * `(batchId, caseRevisionId, trial)` — the unique index is the idempotency
 * key. In-flight trials hold `leaseOwner`/`leaseExpiresAt`; abandoned work
 * is reclaimed after the lease expires. Jsonb results are typed by
 * `EvalCaseTrialResultsSchema` (@aflow/schemas).
 */
export const evalCaseResults = pgTable(
  'eval_case_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id').notNull(),
    caseRevisionId: uuid('case_revision_id').notNull(),
    /** 1-based trial index within the case. */
    trial: integer('trial').notNull(),
    /** The frozen workflow run executing this trial; NULL until dispatched. */
    runId: text('run_id'),
    /** 'scheduled' | 'running' | 'graded' | 'infra_retry' | 'cancelled' | 'never_started' */
    disposition: text('disposition').notNull(),
    /** Deterministic grading record; NULL until graded. */
    resultsJson: jsonb('results_json'),
    /** 'pass' | 'fail' | 'error' — set with disposition 'graded'. */
    verdict: text('verdict'),
    /**
     * The stored fold of the trial's four axes. Every surface reads this one
     * value; `aggregationVersion` says which ordered rule produced it, so a
     * rule change is an explicit recompute rather than four surfaces drifting.
     */
    outcomeClass: text('outcome_class'),
    aggregationVersion: text('aggregation_version'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    costCents: integer('cost_cents'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Dispatch attempt counter (bumped on infra retries). */
    attempt: integer('attempt').notNull().default(0),
  },
  (table) => [
    uniqueIndex('eval_case_results_trial_idx').on(table.batchId, table.caseRevisionId, table.trial),
    index('eval_case_results_batch_idx').on(table.batchId, table.disposition),
    index('eval_case_results_run_idx').on(table.runId),
    // Partial, matching migration 201. A non-partial declaration of the same
    // name drifts from what the database actually holds.
    index('eval_case_results_outcome_idx')
      .on(table.batchId, table.outcomeClass)
      .where(sql`${table.outcomeClass} IS NOT NULL`),
  ],
);

export type EvalCaseResultRow = typeof evalCaseResults.$inferSelect;
export type NewEvalCaseResultRow = typeof evalCaseResults.$inferInsert;

// ============================================================================

/**
 * Replay verdicts from operator-triggered re-judging (Plan 269 D9): a new
 * judge version re-judges labeled trials over their stored evidence — no
 * runs re-executed. Rows are keyed by judgeVersion ALONGSIDE the original
 * batch-time verdicts in `eval_case_results.results_json`, never replacing
 * them, so scorecards recompute per version and compare.
 */
export const evalRejudgeVerdicts = pgTable(
  'eval_rejudge_verdicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    caseRevisionId: uuid('case_revision_id').notNull(),
    trial: integer('trial').notNull(),
    /** Workflow-run business key whose stored artifacts were re-judged. */
    runId: text('run_id'),
    criterionId: text('criterion_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    /** D9 hash the replay verdict was produced under. */
    judgeVersion: text('judge_version').notNull(),
    judgeModel: text('judge_model').notNull(),
    /** 'pass' | 'fail' */
    verdict: text('verdict').notNull(),
    rationale: text('rationale').notNull(),
    score: numeric('score', { precision: 3, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_rejudge_verdicts_subject_version_idx').on(
      table.batchId,
      table.caseRevisionId,
      table.trial,
      table.criterionId,
      table.scopeKey,
      table.judgeVersion,
    ),
    index('eval_rejudge_verdicts_batch_idx').on(table.batchId, table.criterionId),
  ],
);

export type EvalRejudgeVerdictRow = typeof evalRejudgeVerdicts.$inferSelect;
export type NewEvalRejudgeVerdictRow = typeof evalRejudgeVerdicts.$inferInsert;

// ============================================================================

/**
 * The skill's pinned baseline batch (Plan 269 D12): one completed batch per
 * (space, workflow) the operator declared the ruler. Pin/repin upserts on
 * the identity; unpin deletes. Comparison reads resolve `batchId` at read —
 * the row never caches scorecard content.
 */
export const evalBaselines = pgTable(
  'eval_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    workflowSlug: text('workflow_slug').notNull(),
    batchId: uuid('batch_id').notNull(),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
    pinnedByUserId: uuid('pinned_by_user_id'),
  },
  (table) => [uniqueIndex('eval_baselines_identity_idx').on(table.spaceId, table.workflowSlug)],
);

export type EvalBaselineRow = typeof evalBaselines.$inferSelect;
export type NewEvalBaselineRow = typeof evalBaselines.$inferInsert;
