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
 * Golden dataset head — a versioned, per-skill collection of golden cases
 * (Plan 269 Part 1). `datasetVersion` tracks dataset content only, orthogonal
 * to skill revisions.
 */
export const goldenDatasets = pgTable(
  'golden_datasets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    workflowSlug: text('workflow_slug').notNull(),
    datasetVersion: integer('dataset_version').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('golden_datasets_identity_idx').on(table.spaceId, table.workflowSlug)],
);

export type GoldenDatasetRow = typeof goldenDatasets.$inferSelect;
export type NewGoldenDatasetRow = typeof goldenDatasets.$inferInsert;

// ============================================================================

/**
 * Immutable case revision. Every case add/edit/remove inserts one and bumps
 * the dataset's `datasetVersion`; closing the superseded revision's validity
 * interval (`removedInVersion`) is the single permitted mutation. Historical
 * versions reconstruct via `resolveDatasetVersion` (@aflow/schemas).
 * Queryable axes are first-class columns; the Zod-validated content
 * (GoldenCaseSchema parts) rides the jsonb columns.
 */
export const goldenCaseRevisions = pgTable(
  'golden_case_revisions',
  {
    /** The revisionId. */
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    datasetId: uuid('dataset_id').notNull(),
    /** Stable case identity across revisions (edit chains). */
    caseId: uuid('case_id').notNull(),
    addedInVersion: integer('added_in_version').notNull(),
    removedInVersion: integer('removed_in_version'),
    /** 'draft' | 'active' — an unreviewed draft never enters an active version. */
    status: text('status').notNull(),
    /** 'regression' | 'capability' */
    tier: text('tier').notNull(),
    /** 'should_succeed' | 'should_pause' | 'should_block' */
    direction: text('direction').notNull(),
    scenario: text('scenario').notNull(),
    /** 'curated' | 'promoted_from_run' */
    source: text('source').notNull(),
    /** Workflow revision pinned at capture. */
    workflowRevision: integer('workflow_revision').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    triggerJson: jsonb('trigger_json').notNull(),
    fixtureJson: jsonb('fixture_json').notNull(),
    // Declared independently of the checks that detect them: a gate deriving
    // what to test from the checks under test cannot notice a missing check.
    requirementsJson: jsonb('requirements_json').notNull().default([]),
    expectationsJson: jsonb('expectations_json').notNull().default([]),
    rubricsJson: jsonb('rubrics_json').notNull().default([]),
    provenanceJson: jsonb('provenance_json').notNull(),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('golden_case_revisions_case_version_idx').on(
      table.datasetId,
      table.caseId,
      table.addedInVersion,
    ),
    index('golden_case_revisions_dataset_idx').on(table.datasetId, table.addedInVersion),
    index('golden_case_revisions_case_idx').on(table.datasetId, table.caseId),
  ],
);

export type GoldenCaseRevisionRow = typeof goldenCaseRevisions.$inferSelect;
export type NewGoldenCaseRevisionRow = typeof goldenCaseRevisions.$inferInsert;

// ============================================================================

/**
 * Human labels for judged runs (Plan 269 D10) — absorbs eval_judge_calibration.
 * A run-scoped label (the judge-calibration path) has NULL caseRevisionId; a
 * case-scoped label carries the batch trial it judges — trials are per-batch
 * subjects (batch #2 re-mints trial 1..k for the same case revisions), so
 * `batchId` is part of the case-scoped identity, and `partition` is too so an
 * exemplar-stream write can never claim a drawn validation subject's slot.
 * Only human labels are ground truth; `labeledByUserId` is server-stamped.
 */
export const evalLabels = pgTable(
  'eval_labels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    runId: text('run_id').notNull(),
    caseRevisionId: uuid('case_revision_id'),
    batchId: uuid('batch_id'),
    trial: integer('trial'),
    evalSuitePath: text('eval_suite_path'),
    criterionId: text('criterion_id').notNull(),
    /** 'goal', 'trajectory', or 'task:{taskId}' — disambiguates same-named criteria. */
    scopeKey: text('scope_key').notNull(),
    /** 'pass' | 'fail' — binary is the only scale precision/recall is defined over. */
    verdict: text('verdict').notNull(),
    /** The judge's own verdict on the same subject, when one exists. */
    judgeLabel: text('judge_label'),
    judgeScore: numeric('judge_score', { precision: 3, scale: 2 }),
    critique: text('critique').notNull(),
    judgeVersion: text('judge_version'),
    /** 'exemplar' | 'validation' — validation labels alone power scorecards. */
    partition: text('partition').notNull(),
    labeledByUserId: uuid('labeled_by_user_id').notNull(),
    labeledAt: timestamp('labeled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('eval_labels_run_scoped_idx')
      .on(table.spaceId, table.criterionId, table.scopeKey, table.runId)
      .where(sql`${table.caseRevisionId} IS NULL`),
    uniqueIndex('eval_labels_case_scoped_idx')
      .on(
        table.spaceId,
        table.batchId,
        table.caseRevisionId,
        table.trial,
        table.criterionId,
        table.scopeKey,
        table.partition,
      )
      .where(sql`${table.caseRevisionId} IS NOT NULL`),
    index('eval_labels_crit_idx').on(table.spaceId, table.criterionId, table.scopeKey),
    index('eval_labels_case_idx').on(table.caseRevisionId),
  ],
);

export type EvalLabelRow = typeof evalLabels.$inferSelect;
export type NewEvalLabelRow = typeof evalLabels.$inferInsert;

// ============================================================================

/**
 * Pending label work for the operator (Plan 269 D10). A row is one
 * (batch trial × rubric criterion) awaiting a human verdict; `partition` is
 * preassigned by the minting stream and stamped onto the label at submit —
 * only `random_slice` rows carry 'validation'. The persisted draw (with its
 * inclusion probability) is what makes the validation sample honest: it
 * never re-rolls.
 */
export const evalLabelQueue = pgTable(
  'eval_label_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    caseRevisionId: uuid('case_revision_id').notNull(),
    trial: integer('trial').notNull(),
    /** Workflow-run business key of the trial run — the labeling UI's context ref. */
    runId: text('run_id'),
    criterionId: text('criterion_id').notNull(),
    scopeKey: text('scope_key').notNull(),
    /** 'exemplar' | 'validation' — preassigned at mint, stamped onto the label. */
    partition: text('partition').notNull(),
    /** 'random_slice' | 'judge_disagreement' | 'judge_fail' | 'operator_flag' */
    source: text('source').notNull(),
    /** P(this trial was drawn) — recorded for the uniform random slice only. */
    inclusionProbability: numeric('inclusion_probability', { precision: 7, scale: 6 }),
    /** D9 judge version in force when the item was minted (context, not authority). */
    judgeVersion: text('judge_version'),
    /** 'pending' | 'labeled' | 'dismissed' */
    status: text('status').notNull().default('pending'),
    /**
     * The exchange under review, captured when the item was minted.
     *
     * A trial run lives in a fixture space that is collected at expiry, so an
     * item that waited too long could no longer be reviewed at all. The two
     * strings a reviewer actually reads are kept here instead of re-derived.
     *
     * Superseded by `evidenceJson`, which carries the exchange along with the
     * rest of the pack; kept for items minted before that column existed.
     */
    conversationJson: jsonb('conversation_json').$type<{
      request: string | null;
      reply: string | null;
    }>(),
    /**
     * The whole pack the JUDGE read, frozen at mint.
     *
     * Rebuilding it at read time needs the trial run, and the run's fixture
     * space is collected within hours while a queue item waits indefinitely —
     * so every item outlived its own evidence and degraded to the exchange
     * alone. A label read from a narrower pack than the judge's measures the
     * gap in evidence rather than the judge, which is the one thing these
     * labels exist to do. Frozen here it is bounded by the schema's own caps
     * and dies with the item. Absent on rows minted before this column, which
     * still fall back to the live rebuild.
     */
    evidenceJson: jsonb('evidence_json'),
    /** The eval_labels row a submitted item produced. */
    labelId: uuid('label_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('eval_label_queue_subject_idx').on(
      table.batchId,
      table.caseRevisionId,
      table.trial,
      table.criterionId,
      table.scopeKey,
    ),
    index('eval_label_queue_pending_idx').on(table.spaceId, table.status, table.createdAt),
    index('eval_label_queue_batch_idx').on(table.batchId),
  ],
);

export type EvalLabelQueueRow = typeof evalLabelQueue.$inferSelect;
export type NewEvalLabelQueueRow = typeof evalLabelQueue.$inferInsert;
