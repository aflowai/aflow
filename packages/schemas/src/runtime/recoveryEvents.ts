import { z } from 'zod';

// ============================================================================
// Recovery Event Types
// ============================================================================

export const RecoveryEventTypeSchema = z.enum([
  // Run lifecycle
  'run.created', // initial SessionHotState + first StepHotState(s)
  'run.status_changed', // status transition
  'run.completed', // terminal (SUCCEEDED/FAILED/CANCELLED)

  // Step lifecycle
  'step.scheduled', // new StepHotState created
  'step.claimed', // executor claimed the step (STARTED)
  'step.succeeded', // result applied, output stored
  'step.failed', // error captured
  'step.paused', // paused for input
  'step.cancelled', // cancelled

  // State mutations
  'state.variable_patch', // runtime variable update
  'state.agent_decision', // agent turn decision applied
  'state.timer_set', // timer scheduled
  'state.timer_fired', // timer triggered
]);

export type RecoveryEventType = z.infer<typeof RecoveryEventTypeSchema>;

// ============================================================================
// Recovery Event Envelope
// ============================================================================

export const RecoveryEventEnvelopeSchema = z.object({
  /** Schema version for upcasting */
  version: z.literal(1),

  /** Event type discriminant */
  type: RecoveryEventTypeSchema,

  /** Tenant context */
  tenantId: z.string(),

  /** Run this event belongs to */
  runId: z.string().uuid(),

  /** Monotonic sequence number within this run. Allocated via Redis INCR. */
  seq: z.number().int().nonnegative(),

  /** When this event occurred (epoch ms) */
  timestamp: z.number(),

  /** Step execution this event relates to (if applicable) */
  stepExecutionId: z.string().uuid().optional(),

  /** Event-specific data. Shape depends on `type`. */
  data: z.record(z.unknown()),
});

export type RecoveryEventEnvelope = z.infer<typeof RecoveryEventEnvelopeSchema>;

// ============================================================================
// Recovery Stream Key Patterns (added to StreamKeys)
// ============================================================================

/**
 * Recovery stream key helpers.
 * Separate from StreamKeys to avoid circular imports — consumers import these
 * directly from this module.
 */
export const RecoveryStreamKeys = {
  /** Per-run recovery event stream */
  recoveryStream: (tenantId: string, runId: string) =>
    `aflow:recovery:${tenantId}:${runId}` as const,

  /** Per-run monotonic sequence counter */
  recoverySeqKey: (tenantId: string, runId: string) =>
    `aflow:recovery_seq:${tenantId}:${runId}` as const,

  /** Snapshot cache (latest snapshot ref) */
  snapshotRefKey: (tenantId: string, runId: string) =>
    `aflow:snapshot:${tenantId}:${runId}:ref` as const,

  /** Recovery event count since last snapshot (for triggering snapshots) */
  recoveryEventCountKey: (tenantId: string, runId: string) =>
    `aflow:recovery_count:${tenantId}:${runId}` as const,
} as const;
