import { z } from 'zod';

// ============================================================================
// Entity Event Types
// ============================================================================

/**
 * All entity event types across the cybernetic agent sub-plans.
 */
export const EntityEventTypeSchema = z.enum([
  // Helmsman / interaction (from 102a)
  'entity.trigger.received',
  'entity.trigger.routed',
  'entity.mode.transition',
  'entity.interaction.started',
  'entity.interaction.ended',

  // Procedure lifecycle (from 102b)
  'entity.procedure.activated',
  'entity.procedure.completed',
  'entity.runner.dispatched',
  'entity.runner.completed',
  'entity.runner.reflection',
  'entity.context.assembled',

  // Workflow task lifecycle (from 102m §5.5d — drives the live Map without
  // polling). Fires once per task as it transitions through the cybernetic
  // workflow run engine. `dispatched` = claimed + scheduled; `completed` =
  // terminal status (succeeded / failed / skipped / blocked / cancelled).
  'entity.task.dispatched',
  'entity.task.completed',

  // Coach (from 102c)
  'entity.coach.activated',
  'entity.coach.completed',
  'entity.coach.proposal',
  'entity.coach.ratified',
  'entity.coach.rejected',
  'entity.coach.withdrawn',
  'entity.coach.platform_issue_acknowledged',
  'entity.coach.anomaly_acknowledged',
  'entity.coach.ratification_failed',
  'entity.coach.preview_failed',
  'entity.coach.apply_failed',
  'entity.coach.enrichment_suppressed',
  'entity.coach.sampling_adjusted',
  'entity.coach.anomaly',
  'entity.coach.consolidation',
  'entity.coach.promotion',
  'entity.coach.suppressed',
  'entity.coach.context_pressure',

  // Memory/Identity (from 102d)
  'entity.memory.mutation',
  'entity.identity.updated',

  // Evaluation (from 102f)
  'entity.eval.completed',
  'entity.eval.regression',

  // Bootstrap & activation (from 102h)
  'entity.space.bootstrapped',
  'entity.directives.updated',

  // Workflow-run lifecycle — a run was created or changed status. Space-level
  // signal so surfaces (the Workbench feed) can refresh without polling. Not
  // narrated (no console map entry); payload carries { runId, status }.
  'entity.run.updated',

  // Skill authoring (naming convention; payload carries stage + via)
  'entity.skill.authored',

  'entity.skill.maturity_transition',

  // Interaction phase (from 104b)
  'entity.interaction.phase',

  // Hot-path hardening (from 104c)
  'entity.hook.failed',
  'entity.budget.exceeded',
  'entity.scarcity.dormant',

  // User feedback (from 104e §4.5)
  'entity.user.feedback',

  // Causal measurement (from 104e §4.6)
  'entity.causal.measured',

  // Capability binding (from 104g)
  'entity.binding.ratified',
  'entity.binding.removed',

  // Something armed itself to run later, with nobody asked
  'entity.schedule.armed',

  // A conversation acquired or changed its name or summary. Space-level so the
  // conversation list refreshes without every row holding a subscription of
  // its own. Payload carries { sessionId }; it is never an unread message.
  'entity.session.described',
]);

export type EntityEventType = z.infer<typeof EntityEventTypeSchema>;

// ============================================================================
// Operating Mode
// ============================================================================

/** Operating mode of the entity when the event was emitted. */
export const EntityOperatingModeSchema = z.enum([
  'conversational',
  'exploratory',
  'procedural',
  'supervisory',
]);

export type EntityOperatingMode = z.infer<typeof EntityOperatingModeSchema>;

// ============================================================================
// Entity Event Envelope
// ============================================================================

/**
 * Canonical entity event envelope. Every entity event conforms to this shape.
 *
 * - `eventId`: globally unique UUID for the event
 * - `eventType`: discriminator from `EntityEventTypeSchema`
 * - `spaceId` / `tenantId`: scope (entity events are per-space)
 * - `timestamp`: epoch ms when the event was emitted
 * - `causedBy*`: optional causal linkage to sessions, steps, or prior entity events
 * - `payload`: event-type-specific data (discriminated by `eventType`)
 * - `summary`: short human-readable text for timeline rendering (max 500 chars)
 */
export const EntityEventEnvelopeSchema = z.object({
  /** Globally unique event identifier. */
  eventId: z.string().uuid(),

  /** Discriminated event type. */
  eventType: EntityEventTypeSchema,

  /** Space this event belongs to. */
  spaceId: z.string().uuid(),

  /** Tenant this event belongs to. */
  tenantId: z.string(),

  /** Epoch ms when the event was emitted. */
  timestamp: z.number(),

  // ── Causal linkage ──────────────────────────────────────────────────────

  /** Session that caused this event (if any). */
  causedBySessionId: z.string().uuid().optional(),

  /** Step execution that caused this event (if any). */
  causedByStepExecutionId: z.string().uuid().optional(),

  /** Prior entity event that caused this event (for causal chain walking). */
  causedByEntityEventId: z.string().uuid().optional(),

  // ── Trace correlation ────────────────────────────────────────────────────

  /** OpenTelemetry trace ID for correlation with existing spans/traces. */
  traceId: z.string().max(64).optional(),

  // ── Context ─────────────────────────────────────────────────────────────

  /** Which procedure (workflow slug) this event relates to, if any. */
  workflowSlug: z.string().optional(),

  /** Workflow run ID, if this event relates to a specific run. */
  workflowRunId: z.string().uuid().optional(),

  /** Operating mode of the entity when the event was emitted. */
  operatingMode: EntityOperatingModeSchema.optional(),

  // ── Payload & summary ───────────────────────────────────────────────────

  /** Event-type-specific payload (discriminated by `eventType` at the consumer level). */
  payload: z.record(z.unknown()),

  /** Short human-readable summary for timeline rendering. */
  summary: z.string().max(500),
});

export type EntityEventEnvelope = z.infer<typeof EntityEventEnvelopeSchema>;

// ============================================================================
// 104c event payload schemas
// ============================================================================

/** Hook names for `entity.hook.failed` events. Frozen per 104c section 4.4. */
export const CyberneticHookNameSchema = z.enum([
  'workflow-bootstrap-completed',
  'workflow-task-completed',
  'workflow-run-completed',
  'eval-runner',
  'learner-trigger',
  'interaction-consolidator',
  'attention-cache-read',
  'attention-cache-invalidator',
  'budget-tracker',
  'orphan-recovery',
  // 104b hooks
  'reflection-persist',
  'skill-projection-on-run-completed',
  'skill-attention-load',
]);

export type CyberneticHookName = z.infer<typeof CyberneticHookNameSchema>;

export const HookFailedPayloadSchema = z.object({
  hookName: CyberneticHookNameSchema,
  workflowSlug: z.string().optional(),
  runId: z.string().optional(),
  errorMessage: z.string().max(2048),
  errorCode: z.string().optional(),
});

export type HookFailedPayload = z.infer<typeof HookFailedPayloadSchema>;

export const BudgetExceededPayloadSchema = z.object({
  dimension: z.enum(['tokens_in', 'tokens_out', 'cost_cents', 'elapsed_ms']),
  limit: z.number(),
  observed: z.number(),
  interactionId: z.string().optional(),
  sessionId: z.string().optional(),
});

export type BudgetExceededPayload = z.infer<typeof BudgetExceededPayloadSchema>;

export const ScarcityDormantPayloadSchema = z.object({
  skillSlug: z.string(),
  lastUsedAt: z.string().datetime().nullable(),
  policy: z.enum(['exclude_from_attention', 'hide_from_helmsman', 'archive']),
});

export type ScarcityDormantPayload = z.infer<typeof ScarcityDormantPayloadSchema>;

// ============================================================================
// 104b interaction phase payload
// ============================================================================

/** Interaction phase values for the `entity.interaction.phase` event. */
export const InteractionPhaseValueSchema = z.enum(['idle', 'decide', 'execute', 'review']);

export type InteractionPhaseValue = z.infer<typeof InteractionPhaseValueSchema>;

export const InteractionPhasePayloadSchema = z.object({
  phase: InteractionPhaseValueSchema,
  skillId: z.string().optional(),
  computedAt: z.string().datetime(),
});

export type InteractionPhasePayload = z.infer<typeof InteractionPhasePayloadSchema>;
