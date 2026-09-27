import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * Tenant-scoped audit log for tenant admins to review activity.
 * Platform-level events go to public.platform_audit_log.
 * Append-only, immutable.
 */
export const tenantAuditLog = pgTable('tenant_audit_log', {
  /** Audit entry ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** When the event occurred */
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),

  /** Actor user ID (internal Phoenix UUID) */
  actorId: uuid('actor_id'),

  /** Actor kind: human, service_principal, system */
  actorKind: text('actor_kind').notNull(),

  /** Event category: auth, authz, resource, admin, security */
  category: text('category').notNull(),

  /** Specific action (e.g., flow.created, permission_denied) */
  action: text('action').notNull(),

  /** Outcome: success, failure, denied */
  outcome: text('outcome').notNull(),

  /** Resource type affected */
  resourceType: text('resource_type'),

  /** Resource ID affected */
  resourceId: text('resource_id'),

  /** Space ID (if action is space-scoped) */
  spaceId: uuid('space_id'),

  /** Additional details as JSON */
  details: jsonb('details'),

  /** IP address of the actor */
  ipAddress: text('ip_address'),

  /** Immutable creation timestamp */
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type TenantAuditLogEntry = typeof tenantAuditLog.$inferSelect;
export type NewTenantAuditLogEntry = typeof tenantAuditLog.$inferInsert;

// ============================================================================

/**
 * Structured user feedback linked to a subject (run, proposal, skill, message).
 * Independent first-class input consumed by the Coach alongside reflections
 * and evals.
 */
export const userFeedback = pgTable(
  'user_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    subjectKind: text('subject_kind').notNull(), // 'run' | 'proposal' | 'skill' | 'message'
    subjectId: text('subject_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    freeText: text('free_text'),
    createdByUserId: uuid('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('user_feedback_subject_idx').on(table.spaceId, table.subjectKind, table.subjectId),
    index('user_feedback_space_time_idx').on(table.spaceId, table.createdAt),
  ],
);

export type UserFeedbackRow = typeof userFeedback.$inferSelect;
export type NewUserFeedbackRow = typeof userFeedback.$inferInsert;

// ============================================================================

/**
 * Binds each ratified proposal to eval-score deltas over baseline and post
 * windows. V2 populates; V3 consumes via 105 §4.6.
 */
export const causalMeasurements = pgTable(
  'causal_measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    proposalId: text('proposal_id').notNull(),
    subjectKind: text('subject_kind').notNull(), // 'skill' | 'context_strategy' | 'identity' | 'eval_suite'
    subjectId: text('subject_id').notNull(),
    ratifiedAt: timestamp('ratified_at', { withTimezone: true }).notNull(),
    baselineWindowStart: timestamp('baseline_window_start', { withTimezone: true }).notNull(),
    baselineWindowEnd: timestamp('baseline_window_end', { withTimezone: true }).notNull(),
    postWindowStart: timestamp('post_window_start', { withTimezone: true }).notNull(),
    postWindowEnd: timestamp('post_window_end', { withTimezone: true }),
    baselineMetrics: jsonb('baseline_metrics'),
    postMetrics: jsonb('post_metrics'),
    deltaComputedAt: timestamp('delta_computed_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
  },
  (table) => [
    uniqueIndex('causal_measurements_proposal_idx').on(table.proposalId),
    index('causal_measurements_space_subject_idx').on(
      table.spaceId,
      table.subjectKind,
      table.subjectId,
    ),
  ],
);

export type CausalMeasurementRow = typeof causalMeasurements.$inferSelect;
export type NewCausalMeasurementRow = typeof causalMeasurements.$inferInsert;

// ============================================================================

/**
 * Per-review activity projection. Append-only; one row per terminated
 * review (`with_proposals`, `observation_only`, `learning_only`,
 * `silent`) plus one row per suppressed review (`suppressed:<reason>`).
 * Deep-link refs (`contextDocPath`, `factsDocPath`) point at the durable
 * `/coach/contexts/` and `/coach/facts/` evidence docs — this table is
 * not a second source of truth, only a query surface for the operator
 * Coach Activity timeline (§13.2.2).
 */
export const coachActivity = pgTable(
  'coach_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    coachSessionId: text('coach_session_id'),
    skillSlug: text('skill_slug'),
    triggerKind: text('trigger_kind').notNull(),
    triggerCause: text('trigger_cause'),
    outcome: text('outcome').notNull(),
    status: text('status').notNull(),
    proposalCount: integer('proposal_count').notNull().default(0),
    observationCount: integer('observation_count').notNull().default(0),
    learningCount: integer('learning_count').notNull().default(0),
    previewFailedCount: integer('preview_failed_count').notNull().default(0),
    bypassesGate: boolean('bypasses_gate').notNull().default(false),
    costCents: numeric('cost_cents', { precision: 12, scale: 4 }),
    durationMs: integer('duration_ms'),
    contextDocPath: text('context_doc_path'),
    factsDocPath: text('facts_doc_path'),
    rationale: text('rationale'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('coach_activity_session_idx').on(table.spaceId, table.coachSessionId),
    index('coach_activity_space_created_idx').on(table.spaceId, table.createdAt),
    index('coach_activity_skill_created_idx').on(table.spaceId, table.skillSlug, table.createdAt),
    index('coach_activity_outcome_idx').on(table.spaceId, table.outcome, table.createdAt),
  ],
);

export type CoachActivityRow = typeof coachActivity.$inferSelect;
export type NewCoachActivityRow = typeof coachActivity.$inferInsert;

// ============================================================================

export const guardrailPolicies = pgTable('guardrail_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  policyId: text('policy_id').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  version: text('version').notNull().default('1'),
  scope: jsonb('scope').notNull(),
  rails: jsonb('rails').notNull(),
  settings: jsonb('settings'),
  tags: text('tags').array(),
  spaceId: uuid('space_id'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GuardrailPolicyRow = typeof guardrailPolicies.$inferSelect;
export type NewGuardrailPolicyRow = typeof guardrailPolicies.$inferInsert;

// ============================================================================

export const guardrailViolations = pgTable('guardrail_violations', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull(),
  stepExecutionId: text('step_execution_id'),
  policyId: text('policy_id').notNull(),
  railId: text('rail_id').notNull(),
  trigger: text('trigger').notNull(),
  violationType: text('violation_type').notNull(),
  actionTaken: text('action_taken').notNull(),
  detail: jsonb('detail'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GuardrailViolationRow = typeof guardrailViolations.$inferSelect;
export type NewGuardrailViolationRow = typeof guardrailViolations.$inferInsert;

// ============================================================================

export const guardrailChecks = pgTable('guardrail_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: text('session_id').notNull(),
  stepExecutionId: text('step_execution_id'),
  policyId: text('policy_id').notNull(),
  railId: text('rail_id').notNull(),
  trigger: text('trigger').notNull(),
  layer: text('layer').notNull(),
  result: text('result').notNull(),
  actionTaken: text('action_taken'),
  detail: jsonb('detail'),
  durationMs: integer('duration_ms').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GuardrailCheckRow = typeof guardrailChecks.$inferSelect;
export type NewGuardrailCheckRow = typeof guardrailChecks.$inferInsert;
