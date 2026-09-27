/**
 * Event envelope schema - the standard wrapper for all platform events.
 * Events are the source of truth for run/step state and history.
 */
import { z } from 'zod';
import {
  TenantIdSchema,
  SessionIdSchema,
  StepExecutionIdSchema,
  EventIdSchema,
  StepIdSchema,
  TraceIdSchema,
  IdempotencyKeySchema,
  EventVersionSchema,
} from './ids.js';
import { SessionAgentTargetSchema } from './agentTarget.js';
import { StepTypeSchema } from '../artifact/operationDefinition.js';
import { PayloadRefSchema } from './payloadRef.js';
import {
  WorkflowRunStatusSchema,
  WorkflowRunTaskStatusSchema,
  WorkflowHumanActionPreviewSchema,
  WorkflowHumanDecisionSchema,
  WorkflowHumanFailureModeSchema,
  WorkflowRunResultSchema,
} from '../operations/workflow.js';
import { StepOutputPresentationSchema } from './stepPresentation.js';

// ============================================================================
// Event Types
// ============================================================================

/**
 * All possible event types in the platform.
 */
export const EventTypeSchema = z.enum([
  // Session lifecycle events
  'SessionStarted',
  'SessionCompleted',
  'SessionFailed',
  'SessionPaused',
  'SessionResumed',
  'SessionRetried',
  'SessionCancelled',

  // Step execution events
  'StepScheduled',
  'StepStarted',
  'StepSucceeded',
  'StepFailed',
  'StepPaused',

  'WorkflowTaskUpdate',
  'WorkflowRunUpdate',

  'WorkflowTaskActivity',

  'WorkflowTaskSurfaceUpdate',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

// ============================================================================
// Event Envelope
// ============================================================================

/**
 * Standard event envelope that wraps all platform events.
 * This is the schema for events stored in the durable event_log.
 */
export const EventEnvelopeSchema = z.object({
  /** Event envelope schema version */
  eventVersion: EventVersionSchema.default(1),

  /** Unique event identifier */
  eventId: EventIdSchema,

  /** Event type discriminator */
  eventType: EventTypeSchema,

  /** Tenant context */
  tenantId: TenantIdSchema,

  /** Associated session */
  sessionId: SessionIdSchema,

  /** Associated step execution (null for flow-level events) */
  stepExecutionId: StepExecutionIdSchema.nullable(),

  /** Parent step execution ID (for tool sub-steps) */
  parentStepExecutionId: StepExecutionIdSchema.nullable().optional(),

  /** Step ID within the flow (null for flow-level events) */
  stepId: StepIdSchema.nullable().optional(),

  /** Step type (null for flow-level events) */
  stepType: StepTypeSchema.nullable().optional(),

  /** Retry/execution attempt number */
  attempt: z.number().int().min(1).default(1),

  /** Event timestamp (ISO 8601) */
  timestamp: z.string().datetime(),

  /** Reference to event payload in GCS */
  payloadRef: PayloadRefSchema.nullable().optional(),

  /** Reference to error details in GCS */
  errorRef: PayloadRefSchema.nullable().optional(),

  /** Reference to requested user input schema/prompt */
  requestedInputRef: PayloadRefSchema.nullable().optional(),

  /** Idempotency key for deduplication */
  idempotencyKey: IdempotencyKeySchema,

  /** OpenTelemetry trace ID for correlation */
  traceId: TraceIdSchema.optional(),

  /** Sequence number within the run (for ordering) */
  sequenceNumber: z.number().int().nonnegative().optional(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ============================================================================
// Event Payload Types (stored in GCS via payloadRef)
// ============================================================================

/**
 * Payload for SessionStarted event.
 */
export const SessionStartedPayloadSchema = z.object({
  target: SessionAgentTargetSchema,
  /** Agent version (only meaningful for custom-agent target; '1' for platform). */
  agentVersion: z.string(),
  inputRef: PayloadRefSchema.optional(),
  mode: z.enum(['api', 'chat', 'mcp']).default('api'),
  budgets: z
    .object({
      maxCostCents: z.number().nonnegative().optional(),
      maxTokens: z.number().int().nonnegative().optional(),
      maxDurationMs: z.number().int().nonnegative().optional(),
      maxSteps: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type SessionStartedPayload = z.infer<typeof SessionStartedPayloadSchema>;

/**
 * Payload for SessionCompleted event.
 */
export const SessionCompletedPayloadSchema = z.object({
  outputRef: PayloadRefSchema.optional(),
  durationMs: z.number().int().nonnegative(),
  totalSteps: z.number().int().nonnegative(),
  totalCostCents: z.number().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

export type SessionCompletedPayload = z.infer<typeof SessionCompletedPayloadSchema>;

/**
 * Payload for SessionPaused event.
 */
export const SessionPausedPayloadSchema = z.object({
  pausedAtStepId: z.string(),
  pausedAtStepExecutionId: StepExecutionIdSchema,
  reason: z.enum(['input_required', 'approval_required', 'budget_exceeded']),
  requestedInputRef: PayloadRefSchema.optional(),
});

export type SessionPausedPayload = z.infer<typeof SessionPausedPayloadSchema>;

/**
 * Payload for StepSucceeded event.
 */
export const StepSucceededPayloadSchema = z.object({
  outputRef: PayloadRefSchema.optional(),
  durationMs: z.number().int().nonnegative(),
  costCents: z.number().nonnegative().optional(),
  tokensUsed: z
    .object({
      prompt: z.number().int().nonnegative().optional(),
      completion: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type StepSucceededPayload = z.infer<typeof StepSucceededPayloadSchema>;

// ============================================================================

export const WorkflowTaskFailureSchema = z.object({
  code: z.string(),
  classification: z.string(),
  retryable: z.boolean(),
});
export type WorkflowTaskFailure = z.infer<typeof WorkflowTaskFailureSchema>;

export const WorkflowTaskUpdatePayloadSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string(),
  /** Display name from the workflow definition (`WorkflowTaskSchema.name`). */
  label: z.string(),
  status: WorkflowRunTaskStatusSchema,
  attempt: z.number().int().min(1),
  workerSessionId: z.string().uuid().optional(),
  operationId: z.string().optional(),
  /**
   * Dispatch family (`agent` | `operation` | `human`). Stamped on the
   * dispatch-time emit (and carried through catch-up) so the chat surface
   * can pick the right task-row icon before any BFF detail hydration. The
   * reducer preserves it across later lifecycle updates that omit it.
   */
  taskType: z.enum(['agent', 'operation', 'human']).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** Human-readable failure string, always available on failed tasks. */
  failureReason: z.string().optional(),
  failure: WorkflowTaskFailureSchema.optional(),
  summary: z.string().optional(),
  presentation: StepOutputPresentationSchema.optional(),
  humanIntent: z.enum(['approve', 'collect']).optional(),
  resolutionSchema: z.record(z.unknown()).optional(),
  actionPreview: WorkflowHumanActionPreviewSchema.optional(),
  resumeContract: z.unknown().optional(),
  pauseVersion: z.number().int().nonnegative().optional(),
  failureMode: WorkflowHumanFailureModeSchema.optional(),
  /**
   * Resolved-decision trace for a `type: 'human'`, `intent: 'approve'` row.
   * Stamped on the resume emit so the operator who just approved/rejected on
   * the surface sees the decision pill immediately (the BFF detail carries it
   * authoritatively on refresh). Preserved by the reducer across later updates.
   */
  humanDecision: WorkflowHumanDecisionSchema.optional(),
  /**
   * Run-level state variables this task just promoted (sanitized — sensitive
   * variables dropped, oversized values truncated). Stamped on the terminal
   * `succeeded` emit when the task declares `promoteOutputs`, so the chat
   * surface shows live output values mid-run without waiting for the
   * terminal `WorkflowRunUpdate.result`. The reducer accumulates these into
   * `WorkflowRunSurfaceState.outputs`.
   */
  promotedState: z.record(z.unknown()).optional(),
  /**
   * A producer-rerun deleted this task's row server-side (its descendant
   * closure is cleared so the scheduler re-dispatches it fresh once the
   * producer re-succeeds). Live reducers must DROP the row back to a
   * forward-DAG queued node — without this signal a descendant that already
   * emitted `running` in the pre-rerun wave stays stuck "running" forever.
   */
  cleared: z.literal(true).optional(),
});
export type WorkflowTaskUpdatePayload = z.infer<typeof WorkflowTaskUpdatePayloadSchema>;

export const WorkflowRunUpdatePayloadSchema = z.object({
  runId: z.string().uuid(),
  slug: z.string(),
  workflowTitle: z.string().optional(),
  status: WorkflowRunStatusSchema,
  pauseVersion: z.number().int().nonnegative(),
  pausedReason: z.string().optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  waiterStepExecutionId: z.string().uuid().optional(),
  /**
   * Structured run result, present on terminal transitions (completed /
   * failed / cancelled). Built once by `buildWorkflowRunResult` and shared
   * with the waiter wakeup envelope + `workflow.run.detail`, so the chat
   * surface's outcome block and Helmsman's tool result can never disagree.
   */
  result: WorkflowRunResultSchema.optional(),
});
export type WorkflowRunUpdatePayload = z.infer<typeof WorkflowRunUpdatePayloadSchema>;

export const WorkflowTaskActivityPayloadSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string(),
  /** Operation id of the *current* worker step (e.g. `ai.generate`, `api.http.call`). */
  operationId: z.string(),
  /** Human-readable step name from the worker's flow definition (when available). */
  stepName: z.string().optional(),
  /**
   * Per-op content-focused detail from `summarizeStepInput` (e.g. model
   * name, target hostname, search query). Capped at 200 chars; matches
   * the existing `metadata.stepDetail` field on StepScheduled events.
   */
  stepDetail: z.string().max(200).optional(),
  /**
   * Worker session this is sourced from; lets the client correlate with the
   * "Open runner" link. Optional: an operation task (e.g. `code.agent.run`)
   * emits its own activity from the executor and has no worker session.
   */
  workerSessionId: z.string().uuid().optional(),
  /** Monotonic per-task counter — guards against out-of-order delivery. */
  sequence: z.number().int().nonnegative(),
});
export type WorkflowTaskActivityPayload = z.infer<typeof WorkflowTaskActivityPayloadSchema>;

export const WorkflowTaskSurfaceUpdatePayloadSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string(),
  /** Anchors the inline-surface render-item in the chat reducer. */
  stepExecutionId: StepExecutionIdSchema,
  /** Live surface id from the surface engine (matches the op output's
   *  `presentation.surfaceId`). */
  surfaceId: z.string().min(1),
  /** Mutation batch — applied in order to the surface store. Validated
   *  against `SurfaceMutationSchema` by the emitter before fan-out. */
  surfaceMutations: z.array(z.record(z.unknown())),
  /** Monotonic per-task counter — guards against out-of-order delivery
   *  (mirrors `WorkflowTaskActivityPayload.sequence`). */
  sequence: z.number().int().nonnegative(),
});
export type WorkflowTaskSurfaceUpdatePayload = z.infer<
  typeof WorkflowTaskSurfaceUpdatePayloadSchema
>;

// ============================================================================

export const PauseContractSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('waiting_on_workflow_run'),
    runId: z.string().uuid(),
    slug: z.string(),
    status: WorkflowRunStatusSchema,
  }),
]);
export type PauseContract = z.infer<typeof PauseContractSchema>;

// ============================================================================
// Event Creation Helpers
// ============================================================================

/**
 * Create a new event ID (UUID v4).
 */
export function createEventId(): string {
  return crypto.randomUUID();
}

/**
 * Create a timestamp for events.
 */
export function createEventTimestamp(): string {
  return new Date().toISOString();
}
