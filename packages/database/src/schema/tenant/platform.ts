import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  boolean,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================

export const capabilityProfiles = pgTable('capability_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),

  // Capability allowlist/denylist (JSONB)
  allowedCapabilities: jsonb('allowed_capabilities').notNull(),
  deniedCapabilities: jsonb('denied_capabilities').notNull(),
  gatedCapabilities: jsonb('gated_capabilities').notNull().default([]),
  allowedRiskModifiers: jsonb('allowed_risk_modifiers').notNull(),
  deniedRiskModifiers: jsonb('denied_risk_modifiers').notNull(),
  allowPrivileged: boolean('allow_privileged').notNull().default(false),

  // Role defaults
  isDefault: boolean('is_default').notNull().default(false),
  isSystemProfile: boolean('is_system_profile').notNull().default(false),
  defaultForRole: text('default_for_role'),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CapabilityProfileRow = typeof capabilityProfiles.$inferSelect;
export type NewCapabilityProfileRow = typeof capabilityProfiles.$inferInsert;

// ============================================================================

export const spaceCapabilityAssignments = pgTable('space_capability_assignments', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull().unique(),
  profileId: uuid('profile_id').notNull(),
  assignedBy: uuid('assigned_by'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SpaceCapabilityAssignmentRow = typeof spaceCapabilityAssignments.$inferSelect;
export type NewSpaceCapabilityAssignmentRow = typeof spaceCapabilityAssignments.$inferInsert;

// ============================================================================

/**
 * Durable entity event storage. Events are written to Redis streams in real-time
 * and periodically flushed here for long-term retention and querying.
 */
export const entityEventLog = pgTable('entity_event_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  eventId: uuid('event_id').notNull(),
  eventType: text('event_type').notNull(),
  spaceId: uuid('space_id').notNull(),
  timestamp: bigint('timestamp', { mode: 'number' }).notNull(),
  traceId: text('trace_id'),
  causedBySessionId: uuid('caused_by_session_id'),
  causedByStepExecutionId: uuid('caused_by_step_execution_id'),
  causedByEntityEventId: uuid('caused_by_entity_event_id'),
  workflowSlug: text('workflow_slug'),
  workflowRunId: uuid('workflow_run_id'),
  operatingMode: text('operating_mode'),
  payload: jsonb('payload').notNull().default({}),
  summary: text('summary').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type EntityEventLogRow = typeof entityEventLog.$inferSelect;
export type NewEntityEventLogRow = typeof entityEventLog.$inferInsert;

// ============================================================================

export const hitlActionAudit = pgTable(
  'hitl_action_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    /** 'step' | 'proposal' | 'gate' | 'settings' (matches ActionCenterItemOrigin.type) */
    originKind: text('origin_kind').notNull(),
    originId: text('origin_id').notNull(),
    /** The platform operation that was gated/asked, when applicable. */
    operationId: text('operation_id'),
    /** ActionCenterItemKind. */
    kind: text('kind').notNull(),
    resolverUserId: uuid('resolver_user_id').notNull(),
    /** 'submit' | 'approve' | 'reject' | 'ratify' | 'dismiss' */
    resolutionKind: text('resolution_kind').notNull(),
    /** Time between item open and resolution, in ms. */
    latencyMs: integer('latency_ms'),
    /** Snapshot of `GateContext` when this audit row corresponds to a gate clearance. */
    gateContext: jsonb('gate_context'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    spaceCreatedIdx: index('idx_hitl_action_audit_space_created').on(
      table.spaceId,
      table.createdAt,
    ),
    originIdx: index('idx_hitl_action_audit_origin').on(table.originKind, table.originId),
  }),
);

export type HitlActionAuditRow = typeof hitlActionAudit.$inferSelect;
export type NewHitlActionAuditRow = typeof hitlActionAudit.$inferInsert;

// ============================================================================

/**
 * Who an Action Center request is currently being asked of.
 *
 * Attention, never authority: assignment redirects whose Workbench a request
 * leads on, and confers no right to answer it — that stays with the resolver
 * policy the request carries. Keyed by the item's deterministic id so the
 * assignment survives the item being a recompute-at-read projection.
 */
export const actionItemAssignments = pgTable(
  'action_item_assignments',
  {
    itemId: text('item_id').primaryKey(),
    spaceId: uuid('space_id').notNull(),
    assigneeUserId: uuid('assignee_user_id').notNull(),
    assignedBy: uuid('assigned_by'),
    reason: text('reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    assigneeIdx: index('idx_action_item_assignments_assignee').on(table.assigneeUserId),
  }),
);

export type ActionItemAssignmentRow = typeof actionItemAssignments.$inferSelect;
export type NewActionItemAssignmentRow = typeof actionItemAssignments.$inferInsert;

// ============================================================================

/**
 * Who was told about what, exactly once.
 *
 * The routing record behind person-directed notifications: recipients are
 * derived from assignment / resolver policy — never chosen by an agent — and
 * the unique (kind, subject, recipient) tuple is the idempotency, so a pause
 * that flushes twice tells nobody twice. In-app surfaces read the live
 * projections, not this table; it exists so delivery to slower channels can
 * be added without inventing a second routing decision.
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    spaceId: uuid('space_id').notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    /** 'pause' | 'reassign' — what happened. */
    kind: text('kind').notNull(),
    /** 'step' | 'action_item' — what it happened to. */
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => ({
    dedupe: uniqueIndex('notification_outbox_dedupe').on(
      table.kind,
      table.subjectId,
      table.recipientUserId,
    ),
    recipientIdx: index('idx_notification_outbox_recipient').on(
      table.recipientUserId,
      table.createdAt,
    ),
  }),
);

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
export type NewNotificationOutboxRow = typeof notificationOutbox.$inferInsert;

// ============================================================================

export const actionCenterItemsProjection = pgTable(
  'action_center_items_projection',
  {
    spaceId: uuid('space_id').notNull(),
    itemId: text('item_id').notNull(),
    kind: text('kind').notNull(),
    origin: jsonb('origin').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    bodyRef: text('body_ref'),
    uiHints: jsonb('ui_hints'),
    resolutionSchema: jsonb('resolution_schema'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    requestedBy: jsonb('requested_by').notNull(),
    priority: text('priority').notNull().default('normal'),
    gateContext: jsonb('gate_context'),
    relatesTo: jsonb('relates_to').notNull().default([]),
    resolverPolicy: jsonb('resolver_policy'),
    status: text('status').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    resolution: jsonb('resolution'),
    resolutionError: jsonb('resolution_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.spaceId, table.itemId] }),
    openIdx: index('idx_action_center_items_open').on(table.spaceId, table.requestedAt),
    kindOpenIdx: index('idx_action_center_items_kind_open').on(table.spaceId, table.kind),
  }),
);

export type ActionCenterItemProjectionRow = typeof actionCenterItemsProjection.$inferSelect;
export type NewActionCenterItemProjectionRow = typeof actionCenterItemsProjection.$inferInsert;
