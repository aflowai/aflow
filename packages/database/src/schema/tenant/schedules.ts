import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from 'drizzle-orm/pg-core';

// ============================================================================

/**
 * Agent schedules — durable records describing when/how to start or resume sessions.
 * Supports cron, one-shot datetime, and on-completion event triggers.
 */
export const agentSchedules = pgTable('agent_schedules', {
  /** Schedule ID */
  id: uuid('id').primaryKey().defaultRandom(),

  /** Space scope */
  spaceId: uuid('space_id').notNull(),

  // --- Identity ---
  name: text('name').notNull(),
  description: text('description'),

  // --- Action ---
  action: text('action').notNull().default('start_run'),
  targetKind: text('target_kind').$type<'platform-role' | 'custom-agent'>(),
  targetSystemRole: text('target_system_role'),
  targetAgentId: uuid('target_agent_id'),
  agentVersion: text('agent_version'),
  targetSessionId: uuid('target_session_id'),
  targetStepExecutionId: uuid('target_step_execution_id'),

  // --- When ---
  kind: text('kind').notNull(),
  cronExpression: text('cron_expression'),
  timezone: text('timezone').notNull().default('UTC'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  sourceKind: text('source_kind').$type<'platform-role' | 'custom-agent'>(),
  sourceSystemRole: text('source_system_role'),
  sourceAgentId: uuid('source_agent_id'),
  sourceStatus: text('source_status'),

  // --- Input ---
  inputTemplate: jsonb('input_template').notNull().default({}),

  // --- Lifecycle ---
  status: text('status').notNull().default('active'),
  maxFirings: integer('max_firings'),
  firingCount: integer('firing_count').notNull().default(0),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  lastSessionId: uuid('last_session_id'),
  nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastError: text('last_error'),

  // --- Provenance ---
  createdBy: text('created_by'),
  createdBySessionId: uuid('created_by_session_id'),
  metadata: jsonb('metadata').default({}),

  creatorUserId: uuid('creator_user_id'),
  creatorTenantRole: text('creator_tenant_role'),
  creatorSpaceRole: text('creator_space_role'),

  // --- Timestamps ---
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AgentScheduleRow = typeof agentSchedules.$inferSelect;
export type NewAgentScheduleRow = typeof agentSchedules.$inferInsert;

// ============================================================================

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  spaceId: uuid('space_id').notNull(),
  targetKind: text('target_kind').notNull().$type<'platform-role' | 'custom-agent'>(),
  targetSystemRole: text('target_system_role'),
  targetAgentId: uuid('target_agent_id'),
  name: text('name').notNull(),
  description: text('description'),
  secretEncrypted: text('secret_encrypted').notNull(),

  // Header configuration
  signatureHeader: text('signature_header').notNull().default('x-webhook-signature'),
  deliveryIdHeader: text('delivery_id_header').notNull().default('x-webhook-id'),
  timestampHeader: text('timestamp_header').notNull().default('x-webhook-timestamp'),

  // Replay / dedup policy
  replayWindowSeconds: integer('replay_window_seconds').notNull().default(300),
  requireDeliveryId: boolean('require_delivery_id').notNull().default(false),

  // Input transformation
  inputMapping: jsonb('input_mapping'),
  filterExpression: text('filter_expression'),

  // Status
  status: text('status').notNull().default('active'),

  creatorUserId: uuid('creator_user_id'),
  creatorTenantRole: text('creator_tenant_role'),
  creatorSpaceRole: text('creator_space_role'),

  // Lifecycle tracking
  lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: text('created_by'),

  metadata: jsonb('metadata').notNull().default({}),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type NewWebhookEndpointRow = typeof webhookEndpoints.$inferInsert;
