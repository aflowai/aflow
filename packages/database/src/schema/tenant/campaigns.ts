import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * Identity is `(space_id, workflow_slug, goal_ref)`; a goal change starts a
 * new campaign (the old one ends). At most one `active` campaign per identity
 * (enforced by a partial unique index). `score_metric_key`/`direction` are a
 * materialized copy of the typed goal (183f chain) — not an independent truth.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    workflowSlug: text('workflow_slug').notNull(),
    goalRef: text('goal_ref').notNull(),
    scoreMetricKey: text('score_metric_key').notNull(),
    /** 'maximize' | 'minimize' */
    direction: text('direction').notNull(),
    config: jsonb('config'),
    contractHash: text('contract_hash'),
    configHistory: jsonb('config_history').notNull().default([]),
    /** 'active' | 'ended' */
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 'goal_met' | 'explicit' | 'budget' | 'inactivity' */
    endedReason: text('ended_reason'),
  },
  (table) => [
    // The partial-unique "one active campaign per identity" constraint is
    // enforced in the migration DDL (a partial unique index WHERE status =
    // 'active'); this plain index covers the identity lookup.
    index('campaigns_identity_idx').on(table.spaceId, table.workflowSlug, table.goalRef),
    index('campaigns_space_workflow_started_idx').on(
      table.spaceId,
      table.workflowSlug,
      table.startedAt,
    ),
  ],
);

export type CampaignRow = typeof campaigns.$inferSelect;
export type NewCampaignRow = typeof campaigns.$inferInsert;

// ============================================================================

/**
 * A per-run `WorkflowLearning` written as a skill-keyed candidate —
 * campaign-keyed additionally when the run belongs to a campaign. First-
 * class storage — NOT buried in `workflow_runs.learnings_json`. Promotion
 * target is `CoachLearning.promotedFrom = { candidateLedgerEntryId, campaignId? }`.
 */
export const coachCandidateLearnings = pgTable(
  'coach_candidate_learnings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    skillSlug: text('skill_slug').notNull(),
    campaignId: uuid('campaign_id'),
    runId: text('run_id').notNull(),
    /** `WorkflowLearning.id`, extracted so the (run, learning) uniqueness
     *  can be DB-enforced (race-safe idempotent writes). */
    learningId: text('learning_id').notNull(),
    learningJson: jsonb('learning_json').notNull(),
    /** 'pending' | 'reviewed-promoted' | 'reviewed-rejected' | 'reviewed-noise' */
    status: text('status').notNull().default('pending'),
    compactEvalOutcome: jsonb('compact_eval_outcome'),
    refs: jsonb('refs'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    coachSessionId: uuid('coach_session_id'),
  },
  (table) => [
    index('coach_candidate_campaign_status_idx').on(table.campaignId, table.status),
    index('coach_candidate_campaign_created_idx').on(table.campaignId, table.createdAt),
    index('coach_candidate_space_skill_status_idx').on(
      table.spaceId,
      table.skillSlug,
      table.status,
    ),
    // Race-safe idempotency: run ids are globally unique, so (run, learning)
    // is the exact candidate identity — campaign membership is an attribute.
    uniqueIndex('coach_candidate_identity_idx').on(table.runId, table.learningId),
  ],
);

export type CoachCandidateLearningRow = typeof coachCandidateLearnings.$inferSelect;
export type NewCoachCandidateLearningRow = typeof coachCandidateLearnings.$inferInsert;

// ============================================================================

/**
 * Durable `CoachLearning` storage — first-class columns mirroring the zod
 * shape so the per-task injection read is an indexed query. `id` IS the
 * `learningId`. The discriminated scope flattens to `scope_kind` +
 * `campaign_id`/`skill_slug`; a space-scope learning reconstructs its scope
 * from `space_id`.
 */
export const coachLearnings = pgTable(
  'coach_learnings',
  {
    id: uuid('id').primaryKey(),
    coachSessionId: uuid('coach_session_id').notNull(),
    runId: uuid('run_id'),
    spaceId: uuid('space_id').notNull(),
    /** 'campaign' | 'skill' | 'space' */
    scopeKind: text('scope_kind').notNull(),
    campaignId: uuid('campaign_id'),
    skillSlug: text('skill_slug'),
    kind: text('kind').notNull(),
    appliesTo: jsonb('applies_to'),
    statement: text('statement').notNull(),
    detailRef: text('detail_ref'),
    evidence: jsonb('evidence').notNull(),
    confidence: text('confidence').notNull(),
    supersedes: jsonb('supersedes').notNull().default([]),
    /** 'auto_record' | 'stage_for_review' */
    authorityLevel: text('authority_level').notNull(),
    /** CoachLearning['status'] — only 'auto_recorded' | 'ratified' inject. */
    status: text('status').notNull().default('auto_recorded'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolutionNote: text('resolution_note'),
    promotedFrom: jsonb('promoted_from'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('coach_learnings_scope_idx').on(
      table.spaceId,
      table.scopeKind,
      table.skillSlug,
      table.status,
    ),
    index('coach_learnings_space_status_created_idx').on(
      table.spaceId,
      table.status,
      table.createdAt,
    ),
  ],
);

export type CoachLearningRow = typeof coachLearnings.$inferSelect;
export type NewCoachLearningRow = typeof coachLearnings.$inferInsert;
