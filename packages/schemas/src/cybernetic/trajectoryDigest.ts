import { z } from 'zod';

// ============================================================================
// Failure Category (closed set)
// ============================================================================

export const FailureCategorySchema = z.enum([
  'validation', // Input shape rejected before execution
  'config', // Missing credentials, binding, capability grant, definition
  'permission', // Authz/RBAC denial
  'rate_limit', // Throttled
  'provider_error', // External 5xx, network failure
  'timeout', // Step or tool timed out
  'model_mistake', // Agent emitted invalid tool args, hallucinated, malformed JSON
  'unknown', // Doesn't fit above
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

// ============================================================================
// Stable Evidence Reference
// ============================================================================

/**
 * Stable evidence reference into the persisted digest.
 *
 * Citations resolve via stable identifiers, not array paths. The optional
 * `locator` is a UI rendering hint, not a canonical reference.
 *
 * Within an `ai.agent.turn` step, `stepExecutionId` identifies the whole
 * turn — not an individual message inside it. If the conversation store
 * later exposes per-message atom IDs, an optional `messageId` can be added
 * without breaking existing citations.
 */
export const EvidenceRefSchema = z.object({
  runId: z.string(),
  taskId: z.string().optional(),
  attemptId: z.string().optional(),
  sessionId: z.string().optional(),
  stepExecutionId: z.string().optional(),
  locator: z.string().max(256).optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ============================================================================
// Chat Thread Entry — discriminated union
// ============================================================================

const BaseThreadEntrySchema = z.object({
  /** Position within the task's chat thread, used for digestPath rendering. */
  index: z.number().int().nonnegative(),
  /** Stable step execution ID this entry derives from (for citations). */
  stepExecutionId: z.string().optional(),
});

/** Visible assistant text emitted by the Runner between tool calls. */
export const AssistantMessageEntrySchema = BaseThreadEntrySchema.extend({
  kind: z.literal('assistant_message'),
  /** Verbatim assistant text (after redaction). Hidden reasoning content excluded. */
  text: z.string(),
  /** Turn number from AgentTurnOutput. */
  turnNumber: z.number().int().nonnegative().optional(),
});
export type AssistantMessageEntry = z.infer<typeof AssistantMessageEntrySchema>;

/** A tool the Runner invoked. Args are redacted + truncated per §5.1a. */
export const ToolCallEntrySchema = BaseThreadEntrySchema.extend({
  kind: z.literal('tool_call'),
  /** Operation ID (e.g. compute.sandbox.exec) or tool callName. */
  operationId: z.string(),
  /** Optional human-readable tool name shown to the agent. */
  toolName: z.string().optional(),
  /** Redacted + truncated arg representation. Keys preserved; values per §5.1a policy. */
  args: z.record(z.unknown()),
  /** Step status at the time of digest build. */
  status: z.enum(['ok', 'fail', 'paused', 'unknown']),
  /** When status='fail', the categorized failure reason. */
  errorCategory: FailureCategorySchema.optional(),
  /** When status='fail', the original error message (after redaction). */
  errorMessage: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
  /** Attempt number (defaults to 1). */
  attempt: z.number().int().positive().optional(),
});
export type ToolCallEntry = z.infer<typeof ToolCallEntrySchema>;

/** The result the Runner saw for the tool call. */
export const ToolResultEntrySchema = BaseThreadEntrySchema.extend({
  kind: z.literal('tool_result'),
  /** Operation ID matching the preceding tool_call. */
  operationId: z.string(),
  /** Did the tool return successfully (ok) or error (fail)? */
  outcome: z.enum(['ok', 'fail', 'paused']),
  /** Verbatim content the agent saw, after redaction. PayloadRef where the platform substituted. */
  content: z.unknown(),
  /** Set when content was substituted for a PayloadRef. */
  payloadRef: z.string().optional(),
  /** When outcome='fail', the categorized failure reason (mirrors tool_call.errorCategory). */
  errorCategory: FailureCategorySchema.optional(),
});
export type ToolResultEntry = z.infer<typeof ToolResultEntrySchema>;

/** Pause / resume marker for human-in-the-loop interactions or scheduler waits. */
export const PauseMarkerEntrySchema = BaseThreadEntrySchema.extend({
  kind: z.literal('pause_marker'),
  type: z.enum(['paused', 'resumed']),
  /** Reason or label for the pause/resume. */
  detail: z.string().max(200).optional(),
  /** When the pause/resume occurred. */
  at: z.string().datetime(),
});
export type PauseMarkerEntry = z.infer<typeof PauseMarkerEntrySchema>;

/** Sub-agent delegation entry — Phase 1b will inline child threads here. */
export const DelegationEntrySchema = BaseThreadEntrySchema.extend({
  kind: z.literal('delegation'),
  /** Child session ID. */
  childSessionId: z.string(),
  /** Header summary; full nested thread comes in Phase 1b. */
  childTaskId: z.string().optional(),
  childStatus: z.enum(['succeeded', 'failed', 'paused', 'unknown']),
  childDurationMs: z.number().int().nonnegative().optional(),
  childCostCents: z.number().nonnegative().optional(),
});
export type DelegationEntry = z.infer<typeof DelegationEntrySchema>;

/** Discriminated union of all chat thread entry kinds. */
export const ChatThreadEntrySchema = z.discriminatedUnion('kind', [
  AssistantMessageEntrySchema,
  ToolCallEntrySchema,
  ToolResultEntrySchema,
  PauseMarkerEntrySchema,
  DelegationEntrySchema,
]);
export type ChatThreadEntry = z.infer<typeof ChatThreadEntrySchema>;

// ============================================================================
// Task Digest
// ============================================================================

export const TaskDigestSchema = z.object({
  taskId: z.string(),
  status: z.enum(['succeeded', 'failed', 'skipped', 'paused', 'running', 'unknown']),
  attempts: z.number().int().nonnegative(),
  attemptId: z.string().optional(),
  sessionId: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  costCents: z.number().nonnegative().optional(),
  agentTurns: z.number().int().nonnegative().optional(),
  thread: z.array(ChatThreadEntrySchema),
  /** Final task output content (verbatim, redacted). PayloadRef included alongside. */
  finalOutput: z
    .object({
      payloadRef: z.string().optional(),
      content: z.unknown().optional(),
    })
    .optional(),
  /** Concise failure summary when status='failed'. */
  failureReason: z.string().max(2000).optional(),
});
export type TaskDigest = z.infer<typeof TaskDigestSchema>;

// ============================================================================
// Cross-Task Notes
// ============================================================================

/** A payload-ref handoff between tasks. */
export const CrossTaskFlowSchema = z.object({
  fromTaskId: z.string(),
  toTaskId: z.string(),
  payloadRef: z.string(),
});
export type CrossTaskFlow = z.infer<typeof CrossTaskFlowSchema>;

export const CrossTaskNotesSchema = z.object({
  /** Tasks that blocked or were blocked by others (dependency satisfaction). */
  dependencyEdges: z
    .array(
      z.object({
        fromTaskId: z.string(),
        toTaskId: z.string(),
        satisfied: z.boolean(),
      }),
    )
    .default([]),
  /** Payload-ref flows between tasks (Phase 1b will populate these). */
  payloadFlows: z.array(CrossTaskFlowSchema).default([]),
});
export type CrossTaskNotes = z.infer<typeof CrossTaskNotesSchema>;

// ============================================================================
// Workflow Run Digest
// ============================================================================

/** Summary of the run that the digest is built for. */
export const WorkflowRunDigestHeaderSchema = z.object({
  workflowSlug: z.string(),
  runId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled', 'paused', 'running', 'unknown']),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  totalCostCents: z.number().nonnegative().optional(),
  taskCount: z.number().int().nonnegative(),
  agentTurns: z.number().int().nonnegative().optional(),
  costApproximate: z.boolean().default(true),
});
export type WorkflowRunDigestHeader = z.infer<typeof WorkflowRunDigestHeaderSchema>;

export const OutcomeRollupSchema = z.object({
  outcomesMet: z.number().int().nonnegative(),
  outcomesTotal: z.number().int().nonnegative(),
  evalVerdict: z.enum(['pass', 'fail', 'partial', 'error', 'none']).default('none'),
  evalScoreOverall: z.number().min(0).max(1).optional(),
  regressionDetected: z.boolean().default(false),
});
export type OutcomeRollup = z.infer<typeof OutcomeRollupSchema>;

/** Marker emitted into the digest when a budget tier was dropped or compacted. */
export const BudgetMarkerSchema = z.object({
  tier: z.number().int().min(1).max(6),
  /** Where the marker appeared (free-form for rendering hints). */
  location: z.string().max(200),
  /** What was dropped or compacted. */
  detail: z.string().max(500),
});
export type BudgetMarker = z.infer<typeof BudgetMarkerSchema>;

export const WorkflowRunDigestTierSchema = z.enum(['reflections_first', 'full_trace']);
export type WorkflowRunDigestTier = z.infer<typeof WorkflowRunDigestTierSchema>;

export const WorkflowRunDigestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  tier: WorkflowRunDigestTierSchema.default('full_trace'),
  header: WorkflowRunDigestHeaderSchema,
  outcomeRollup: OutcomeRollupSchema,
  crossTaskNotes: CrossTaskNotesSchema.default({ dependencyEdges: [], payloadFlows: [] }),
  tasks: z.array(TaskDigestSchema),
  /** Markers describing any budget-driven drops/compactions. Empty when budget held. */
  budgetMarkers: z.array(BudgetMarkerSchema).default([]),
  /** Set when context-pressure event was emitted during build. */
  contextPressure: z.boolean().default(false),
  /** When the digest was built. */
  builtAt: z.string().datetime(),
});
export type WorkflowRunDigest = z.infer<typeof WorkflowRunDigestSchema>;

// ============================================================================
// Persisted Digest Envelope
// ============================================================================

/**
 * Persisted form of the digest at /coach/digests/{coachSessionId}.json.
 * Wraps the digest with content-addressed metadata for tamper detection.
 */
export const PersistedDigestEnvelopeSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  coachSessionId: z.string(),
  spaceId: z.string(),
  tenantId: z.string(),
  /** sha256 of canonical JSON of `digest`. */
  digestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  digest: WorkflowRunDigestSchema,
  persistedAt: z.string().datetime(),
});
export type PersistedDigestEnvelope = z.infer<typeof PersistedDigestEnvelopeSchema>;
