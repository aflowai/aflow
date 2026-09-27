import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  bigserial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ============================================================================
// Sessions
// ============================================================================

/**
 * Sessions - active and completed agent sessions.
 */
export const sessions = pgTable('sessions', {
  /** Unique session identifier (UUID) */
  sessionId: uuid('session_id').primaryKey(),

  targetKind: text('target_kind')
    .notNull()
    .$type<'platform-role' | 'custom-agent' | 'inline-agent'>(),
  targetSystemRole: text('target_system_role'),
  targetAgentId: uuid('target_agent_id'),
  targetInlineDefRef: text('target_inline_def_ref'),

  /** Version of the agent (text, immutable handle on agent_versions; only meaningful for custom-agent target). */
  agentVersion: text('agent_version').notNull(),

  /** Current session status */
  status: text('status').notNull().default('QUEUED'),

  /** Starting step ID */
  startStepId: text('start_step_id'),

  /** Current step execution ID (if running) */
  currentStepExecutionId: uuid('current_step_execution_id'),

  /** When the session started */
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),

  /** When the session ended (if finished) */
  endedAt: timestamp('ended_at', { withTimezone: true }),

  /** Reason for pause (if paused) */
  pauseReason: text('pause_reason'),

  /** Reference to requested input (if paused for input) */
  requestedInputRef: text('requested_input_ref'),

  /** Reference to final output (if succeeded) */
  finalOutputRef: text('final_output_ref'),

  /** Reference to error details (if failed) */
  errorRef: text('error_ref'),

  /** Who initiated the session */
  createdBy: text('created_by'),

  /** Who started this run. Provenance, never authorization. */
  initiatedBy: uuid('initiated_by'),

  /**
   * Who is steering right now. A visible fact about the room, claimed and
   * handed over socially — it confers no authority of its own.
   */
  currentDriverUserId: uuid('current_driver_user_id'),
  currentDriverClaimedAt: timestamp('current_driver_claimed_at', { withTimezone: true }),

  /**
   * The authority the agent executes under, captured when the run was
   * established. Taking the wheel does not re-point it: whose credentials and
   * policy are in force is a property of the run, not of whoever last acted.
   */
  executionAuthority: jsonb('execution_authority'),

  /** OpenTelemetry trace ID */
  traceId: text('trace_id'),

  /** Total cost in cents */
  totalCostCents: numeric('total_cost_cents', { precision: 12, scale: 4 }).default('0'),

  /** Total tokens used */
  totalTokens: integer('total_tokens').default(0),

  /** Space scope (denormalized from agent for fast queries) */
  spaceId: uuid('space_id'),

  /**
   * Full hot state snapshot (JSONB) — stored when a PAUSED session is flushed.
   * Contains { sessionHotState, stepHotStates } so the session can be rehydrated
   * on-demand from Postgres when Redis state has expired.
   */
  hotStateSnapshot: jsonb('hot_state_snapshot'),

  /**
   * Parent session for delegated sub-sessions. Set at delegate time from
   * the QUEUED hot state; outlives Redis eviction so cascade scoping works
   * for completed/failed children too.
   */
  parentSessionId: uuid('parent_session_id'),

  /**
   * When this run's `on_completion` occurrences were recorded. Stamped in the
   * same transaction that writes them, so the pair is retriable without firing
   * twice — null on a terminal run means the firing is still owed.
   */
  completionSchedulesFiredAt: timestamp('completion_schedules_fired_at', { withTimezone: true }),

  /**
   * Redis stream id of the last session event flushed to event_log. Advanced
   * only by the projection flush, in the same transaction as its inserts —
   * never derived from event_log (room messages land there out of stream
   * order) and never stored Redis-side (the hash and the stream both reset).
   * Null: no incremental flush yet; the next one reads the stream from its
   * head and dedupes on event_id.
   */
  lastFlushedEventStreamId: text('last_flushed_event_stream_id'),

  /**
   * When a person last spoke here, or the agent last answered them.
   *
   * What a conversation list sorts on. Distinct from `started_at` (when it
   * opened) and from `hot_state_updated_at` (which every tool result and
   * heartbeat advances, and which therefore floats a busy background run above
   * the conversation someone is actually in). Metadata writes never touch it:
   * naming a conversation is not activity in it.
   */
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow(),

  /**
   * The generated name. Held apart from `manualTitle` so a generation that
   * lands after a rename writes a column nobody reads instead of racing it.
   */
  title: text('title'),

  /** How far the generated title got, and therefore whether it may still move. */
  titleState: text('title_state').$type<'fallback' | 'provisional' | 'established'>(),

  /** A person's name for this conversation. Outranks `title` at every read. */
  manualTitle: text('manual_title'),

  /** The generated synopsis — what happened, not whether it is running. */
  summary: text('summary'),

  /** How much of the conversation the summary actually saw. */
  summaryCoverage: text('summary_coverage').$type<'full' | 'partial'>(),

  /** Bumped by every committed metadata write. The rename conflict handle. */
  metadataRevision: integer('metadata_revision').notNull().default(0),

  /** The session activity count the stored generation was produced from. */
  metadataEvidenceRevision: integer('metadata_evidence_revision'),

  metadataUpdatedAt: timestamp('metadata_updated_at', { withTimezone: true }),

  /** Who last renamed it. Attribution, never authorization. */
  metadataEditedBy: uuid('metadata_edited_by'),

  /** Generation provenance and the last diagnostic, as a `SessionMetadataRecord`. */
  metadataJson: jsonb('metadata_json'),

  /**
   * Hot-state clock of the last projection that wrote this row. The upserts
   * fence on it — a projector resuming past its expired lease carries an older
   * clock and its write is skipped whole, so it cannot regress the durable
   * status or clear the completion mark. Null accepts any write.
   */
  hotStateUpdatedAt: timestamp('hot_state_updated_at', { withTimezone: true }),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

// ============================================================================
// Step Executions
// ============================================================================

/**
 * Step executions - individual step execution records.
 */
export const stepExecutions = pgTable('step_executions', {
  /** Unique step execution identifier */
  stepExecutionId: uuid('step_execution_id').primaryKey(),

  /** Parent session */
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.sessionId),

  /** Parent step execution (for tool sub-steps) */
  parentStepExecutionId: uuid('parent_step_execution_id'),

  /** Step ID within the flow */
  stepId: text('step_id').notNull(),

  /** Step type (executor class) */
  stepType: text('step_type').notNull(),

  /** Operation being executed */
  operationId: text('operation_id').notNull(),

  /** Retry attempt number */
  attempt: integer('attempt').notNull().default(1),

  /** Execution status */
  status: text('status').notNull().default('SCHEDULED'),

  /** When the step was scheduled */
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),

  /** When execution started */
  startedAt: timestamp('started_at', { withTimezone: true }),

  /** When execution ended */
  endedAt: timestamp('ended_at', { withTimezone: true }),

  /** Reference to input payload in GCS */
  inputRef: text('input_ref'),

  /** Reference to output payload in GCS */
  outputRef: text('output_ref'),

  /** Reference to error details in GCS */
  errorRef: text('error_ref'),

  /** Idempotency key for deduplication */
  idempotencyKey: text('idempotency_key').notNull(),

  /** Cost breakdown as JSON */
  costJson: jsonb('cost_json'),

  /** OpenTelemetry trace ID */
  traceId: text('trace_id'),
});

export type StepExecutionRow = typeof stepExecutions.$inferSelect;
export type NewStepExecutionRow = typeof stepExecutions.$inferInsert;

// ============================================================================
// Event Log
// ============================================================================

/**
 * Event log - append-only durable event store.
 * Source of truth for run/step state and timeline.
 */
export const eventLog = pgTable('event_log', {
  /** Unique event identifier */
  eventId: uuid('event_id').primaryKey(),

  /** Event type discriminator */
  eventType: text('event_type').notNull(),

  /** Event envelope version */
  eventVersion: integer('event_version').notNull().default(1),

  /** Associated session */
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.sessionId),

  /** Associated step execution (if step-level event) */
  stepExecutionId: uuid('step_execution_id'),

  /** Parent step execution (for tool sub-steps) */
  parentStepExecutionId: uuid('parent_step_execution_id'),

  /** Step ID (if step-level event) */
  stepId: text('step_id'),

  /** Step type (if step-level event) */
  stepType: text('step_type'),

  /** Retry attempt number */
  attempt: integer('attempt').notNull().default(1),

  /** Event timestamp */
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull().defaultNow(),

  /** Reference to event payload in GCS */
  payloadRef: text('payload_ref'),

  /** Reference to error details in GCS */
  errorRef: text('error_ref'),

  /** Reference to requested input (for pause events) */
  requestedInputRef: text('requested_input_ref'),

  /** Operation ID (e.g. 'user.notification.send_email') — for operation-scoped queries */
  operationId: text('operation_id'),

  /** Idempotency key */
  idempotencyKey: text('idempotency_key').notNull(),

  /** Monotonic sequence number for ordering */
  sequenceNumber: bigserial('sequence_number', { mode: 'number' }),

  envelope: jsonb('envelope').notNull().default({}),
});

export type EventLogRow = typeof eventLog.$inferSelect;
export type NewEventLogRow = typeof eventLog.$inferInsert;

// ============================================================================
// Idempotency Keys
// ============================================================================

/**
 * Idempotency keys - for request deduplication.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  /** The idempotency key (primary key) */
  idempotencyKey: text('idempotency_key').primaryKey(),

  /** Scope of the key (e.g., 'start_run', 'resume_run') */
  scope: text('scope').notNull(),

  /** When the key was first seen */
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),

  /** Associated session ID */
  sessionId: uuid('session_id'),

  /** Associated step execution ID */
  stepExecutionId: uuid('step_execution_id'),

  /**
   * Hash of the payload this key was claimed for. An exact retry replays;
   * the same key carrying something else is a different action, not a retry.
   */
  payloadHash: text('payload_hash'),

  /** Reference to the cached result */
  resultRef: text('result_ref'),

  /** When the key expires */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;

// ============================================================================
// Session participants — the durable roster (membership is a first-class fact)
// ============================================================================

/**
 * One person's membership in one session. The sole authority for the roster —
 * nothing membership-shaped lives in hot state, so a rehydrated snapshot can
 * never resurrect an obsolete roster. A row is a social fact for the agent
 * and the UI: it grants no read, write, steering, or applet right (space RBAC
 * stays authoritative; applet seats stay in applet_role_bindings).
 */
export const sessionParticipants = pgTable(
  'session_participants',
  {
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** invited | joined | declined | left */
    status: text('status').notNull(),
    /** Null for speech/self-joins — and after the inviter's erasure. */
    invitedBy: uuid('invited_by'),
    /** Bumped per re-invitation — the Action Center CAS / dedupe identity. */
    generation: integer('generation').notNull().default(1),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('session_participants_unique').on(table.sessionId, table.userId),
    index('idx_session_participants_user_status').on(table.userId, table.status),
  ],
);

export type SessionParticipantRow = typeof sessionParticipants.$inferSelect;
export type NewSessionParticipantRow = typeof sessionParticipants.$inferInsert;

// ============================================================================
// Schema Migrations
// ============================================================================

/**
 * Schema migrations tracking for tenant schema.
 */
export const schemaMigrations = pgTable('schema_migrations', {
  /** Migration version number */
  version: integer('version').primaryKey(),

  /** When the migration was applied */
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),

  /** Description of the migration */
  description: text('description'),
});

export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;
export type NewSchemaMigrationRow = typeof schemaMigrations.$inferInsert;
