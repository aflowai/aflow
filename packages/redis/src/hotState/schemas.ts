import { z } from 'zod';
import {
  StepUsageBreakdownSchema,
  RunUsageSummarySchema,
  WorkflowTaskUpdatePayloadSchema,
  WorkflowRunUpdatePayloadSchema,
  WorkflowTaskActivityPayloadSchema,
  WorkflowTaskSurfaceUpdatePayloadSchema,
  StepOutputPresentationSchema,
  SessionAgentTargetSchema,
  McpCredentialBlockSchema,
  StepJobMessageSchema,
  RunTriggerSchema,
} from '@aflow/schemas';

/** Default TTL for hot state (24 hours) */
export const HOT_STATE_TTL_SECONDS = 24 * 60 * 60;

export const CORRUPT_MARKER_TTL_SECONDS = 24 * 60 * 60;

// ============================================================================
// Run Hot State
// ============================================================================

/**
 * Session hot state schema - full session state stored in Redis.
 */
export const SessionHotStateSchema = z.object({
  // Core identifiers
  sessionId: z.string().uuid(),
  tenantId: z.string(),
  target: SessionAgentTargetSchema,
  /** Agent version (only meaningful for custom-agent target; '1' for platform). */
  agentVersion: z.string(),

  // Status tracking
  status: z.enum([
    'QUEUED',
    'RUNNING',
    'PAUSED',
    'WAITING_ON_CHILD',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'CANCELLING',
    'STALLED',
  ]),
  currentStepId: z.string().optional(),
  currentStepExecutionId: z.string().uuid().optional(),

  // Timing
  createdAt: z.number(), // epoch ms
  startedAt: z.number().optional(), // epoch ms
  endedAt: z.number().optional(), // epoch ms

  // Payload refs
  inputRef: z.string().optional(),
  finalOutputRef: z.string().optional(),
  errorRef: z.string().optional(),
  agentDefinitionRef: z.string().optional(),

  // Pause state
  pauseReason: z.string().optional(),
  requestedInputRef: z.string().optional(),

  pauseType: z.string().optional(), // PauseType enum value
  pauseMetadataJson: z.string().optional(), // JSON-serialized PauseMetadata

  // Metadata
  createdBy: z.string().optional(),
  traceId: z.string().optional(),
  idempotencyKey: z.string().optional(),

  // Space scope (immutable after creation)
  spaceId: z.string().uuid().optional(),

  // Sub-agent linkage: child sessions store their parent's session and step execution IDs
  // so the orchestrator can resume the parent when the child completes.
  parentSessionId: z.string().uuid().optional(),
  parentStepExecutionId: z.string().uuid().optional(),

  // Agent role override: set by agent.control.delegate to override the child flow's
  // default agentRole. When present, the orchestrator uses this instead of the step config value.
  agentRoleOverride: z.enum(['assistant', 'subagent']).optional(),

  waitingForChildSessionIds: z.array(z.string().uuid()).optional(),
  delegationPauseSource: z.enum(['child_running', 'child_input']).optional(),
  pausedChildSessionId: z.string().uuid().optional(),
  childPausedStepExecutionId: z.string().uuid().optional(),

  waitingOnWorkflowRunId: z.string().uuid().optional(),

  pendingCredentialBlock: McpCredentialBlockSchema.optional(),

  delegationWaitMode: z.enum(['true', 'until_pause', 'false']).optional(),

  delegationDepth: z.number().int().nonnegative().optional(),

  delegationContextJson: z.string().optional(),

  finalOutputSchemaOverrideJson: z.string().optional(),

  // Registered output validatorRefs (Plan 206) for the delegated task — run
  // after the JSON-Schema check at submit_output. Rides alongside
  // finalOutputSchemaOverrideJson from the delegate envelope.
  finalOutputValidatorRefs: z.array(z.string().min(1).max(120)).max(10).optional(),

  // Display-only delegation metadata for the chat UI. Set by the parent on
  // delegate so the child's forwarded events can render with workflow + task
  // labels (and a per-child accent color) instead of an opaque "cybernetic-runner"
  // badge — matters when multiple sub-agent sessions interleave in chat.
  delegationDisplayWorkflowSlug: z.string().max(128).optional(),
  delegationDisplayTaskId: z.string().max(128).optional(),
  delegationDisplayTaskName: z.string().max(256).optional(),
  delegationDisplayAgentName: z.string().max(128).optional(),

  /**
   * Highest room-message position handed out for this session.
   *
   * Lives on hot state rather than a side key so it rides the snapshot that
   * flushes at rest and rehydrates on resume — a counter that reset on Redis
   * expiry would hand two messages the same position.
   */
  lastMessageSeq: z.number().int().nonnegative().optional(),

  // How this session was triggered (immutable after creation)
  trigger: RunTriggerSchema.optional(),
  /**
   * Whether this session is attended as of its latest activation. When a run
   * sets another run going — delegating to it, starting it as a workflow task,
   * resuming or answering it, re-parenting it — the target is attended exactly
   * as the acting run is at that moment. When a person's authenticated request
   * sets a run going, it is attended. When nothing with a person behind it
   * does — a schedule, a webhook, a timer, a sweep, an API or MCP credential —
   * it is not. A child returning to the parent that waited on it changes
   * nothing in the parent, and neither does a resume that knows nothing of
   * who is present (finishing an OAuth consent). The orchestrator writes it in the same write that
   * starts or resumes the session and stamps it on every job the session
   * schedules; absent reads as nobody.
   */
  activatedByPerson: z.boolean().optional(),
  // Whether the user is currently interacting via voice (mutable — toggled on start/resume)
  // Stored as string 'true'/'false' in Redis, deserialized to boolean by deserializeFromHash
  voiceMode: z.boolean().optional(),

  actorContextJson: z.string().optional(),

  /**
   * Everyone who has spoken in this session — `SessionParticipant[]`,
   * insertion-ordered, deduped by userId, bounded.
   *
   * Distinct from `actorContextJson` (one scalar, whoever acted last): with
   * two people alternating, the scalar silently flips identity, so the agent
   * needs the accumulated set to know who is in the room at all.
   */

  /**
   * `ExecutionAuthoritySnapshot`, established once for the run.
   *
   * Distinct from `actorContextJson`, which is whoever acted most recently.
   * Advancing a run must never re-point the authority it executes under.
   */
  executionAuthorityJson: z.string().optional(),

  workflowExecution: z
    .object({
      runId: z.string(),
      taskId: z.string(),
      attempt: z.number().int().min(1),
    })
    .optional(),

  // Runtime state (flow variables)
  runtimeState: z
    .object({
      schemaVersion: z.literal(1).default(1),
      variables: z.record(z.string(), z.unknown()).default({}),
      version: z.number().int().nonnegative().default(0),
      updatedAtMs: z.number(),
    })
    .optional(),

  // Run-scoped variable definition overlay. Allows the orchestrator to
  // register additional variable definitions at runtime (e.g., agent chat
  // input) without mutating the flow artifact in Postgres. Stored as
  // serialized JSON keyed by variableId.
  variableDefsOverlay: z.string().optional(),

  // Dynamic steps injected at runtime (e.g., by agent.control.run_step).
  // Stored as serialized JSON array of StepDefinition objects so they survive
  // across result consumer iterations (which re-fetch flow from Postgres).
  dynamicSteps: z.string().optional(),

  grantJson: z.string().optional(),

  // The pinned SimulationRunContext is NOT a field here: it is keyed per
  // simulation as `simulationRunContextJson:<simulationId>` so HSETNX can pin
  // each one independently. Read it through `getSimulationRunContext`.

  // `SimulationRunInput` as the run was STARTED with — seed, rule profile,
  // baseline version, clock anchor. Written only in the create literal, from
  // the start-run command, so the environment a run is graded in is fixed by
  // whoever started it and never by the agent being graded.
  simulationRunInputJson: z.string().optional(),
  simulationDisclosedCallersJson: z.string().optional(),

  usageSummary: RunUsageSummarySchema.optional(),

  spaceContextJson: z.string().optional(),
  spaceContextBuiltAt: z.number().optional(), // epoch ms
  spaceContextGen: z.number().optional(), // per-space generation at build time

  coreAgentMetasJson: z.string().optional(),

  interruptRequested: z.boolean().optional(),

  retryCount: z.number().int().nonnegative().optional(),

  /**
   * When a person last said something here, or the agent last answered them.
   *
   * The conversation's clock, kept apart from `lastUpdatedAt` — which every
   * tool result, heartbeat and projection advances, and which therefore sorts
   * a room nobody has spoken in since Tuesday above one answered an hour ago.
   *
   * Absent until a human speaks, and that absence is load-bearing: a Runner
   * working through a skill's tasks, a scheduled job and a delegated child
   * executing a brief never acquire one, which is how the metadata plane knows
   * they are not conversations without enumerating them.
   */
  lastActivityAt: z.number().optional(), // epoch ms

  // Sync tracking
  lastUpdatedAt: z.number(), // epoch ms
});

export type SessionHotState = z.infer<typeof SessionHotStateSchema>;

// ============================================================================
// Step Hot State
// ============================================================================

/**
 * Step execution hot state schema.
 */
export const StepHotStateSchema = z.object({
  // Core identifiers
  stepExecutionId: z.string().uuid(),
  tenantId: z.string(),
  sessionId: z.string().uuid(),
  stepId: z.string(),
  stepType: z.string(),
  operationId: z.string(),

  // Execution tracking
  attempt: z.number().int().min(1),
  status: z.enum(['SCHEDULED', 'STARTED', 'SUCCEEDED', 'FAILED', 'PAUSED']),

  // Timing
  scheduledAt: z.number(), // epoch ms
  startedAt: z.number().optional(), // epoch ms
  endedAt: z.number().optional(), // epoch ms

  // Payload refs
  inputRef: z.string(),
  outputRef: z.string().optional(),
  errorRef: z.string().optional(),

  // Idempotency
  idempotencyKey: z.string(),

  // Metadata
  traceId: z.string().optional(),
  parentStepExecutionId: z.string().uuid().optional(),

  /**
   * Set while this SCHEDULED step waits for its executor, which had no
   * heartbeat when the step was dispatched: since when (epoch ms), and the job
   * it waits to dispatch. Its `executor_wait` timer is its completion path
   * until `EXECUTOR_WAIT_LOOKS` have been taken; absent on a step whose job is
   * in its stream. The job is kept whole so a wait whose timer is lost is armed
   * again with the job that was parked, not one rebuilt without what only a
   * dispatch carries.
   */
  executorWait: z
    .object({
      sinceMs: z.number(),
      job: StepJobMessageSchema,
    })
    .optional(),

  /**
   * The attention items an agent turn's attention block shows. The block is
   * never written to history, so they are consumed by the session only when
   * this turn succeeds; a turn that fails or is retried shows them again.
   */
  attentionItemIds: z.array(z.string()).optional(),

  // Sync tracking
});

export type StepHotState = z.infer<typeof StepHotStateSchema>;

// ============================================================================
// Run Event (for SSE stream)
// ============================================================================

/**
 * Run event schema for the per-run event stream.
 */
export const SessionEventSchema = z.object({
  eventId: z.string(),
  eventType: z.enum([
    'SessionQueued',
    'SessionStarted',
    'StepScheduled',
    'StepStarted',
    'StepSucceeded',
    'StepFailed',
    'StepPaused',
    'StepWaitingOnExecutor',
    'SessionCompleted',
    'SessionFailed',
    'SessionPaused',
    'SessionCancelled',
    'SessionResumed',
    'SessionRetried',
    'ControlRejected',
    'RoomMessage',
    'WorkflowRunWakeup',
    'AuthorityLost',
    'SessionStalled',
    'GuardrailViolation',
    'GuardrailRunSummary',
    'SubflowEventForwarded',
    'SurfaceUpdate',
    'WorkflowTaskUpdate',
    'WorkflowRunUpdate',
    'WorkflowTaskActivity',
    'WorkflowTaskSurfaceUpdate',
    'McpElicitationRequested',
    'McpElicitationResolved',
    'McpElicitationTimedOut',
    'McpElicitationExecutorLost',
  ]),
  timestamp: z.number(), // epoch ms
  sessionId: z.string().uuid(),
  stepId: z.string().optional(),
  stepExecutionId: z.string().uuid().optional(),
  stepType: z.string().optional(),
  attempt: z.number().int().optional(),
  outputRef: z.string().optional(),
  errorRef: z.string().optional(),
  requestedInputRef: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),

  usage: StepUsageBreakdownSchema.optional(),

  usageSummary: RunUsageSummarySchema.optional(),

  runtimeStatePatch: z
    .object({
      version: z.number().int().nonnegative(),
      changed: z.array(
        z.object({
          key: z.string(),
          value: z.unknown(),
        }),
      ),
    })
    .optional(),

  surfaceMutations: z.array(z.record(z.unknown())).optional(),
  surfaceId: z.string().optional(),

  // Output variables for FlowRunSucceeded/FlowRunCompleted events
  outputVariables: z
    .array(
      z.object({
        key: z.string(),
        name: z.string().optional(),
        value: z.unknown(), // StateValueRef (inline or ref)
        semanticType: z.string().optional(),
      }),
    )
    .optional(),

  workflowTaskUpdate: WorkflowTaskUpdatePayloadSchema.optional(),
  workflowRunUpdate: WorkflowRunUpdatePayloadSchema.optional(),
  workflowTaskActivity: WorkflowTaskActivityPayloadSchema.optional(),
  workflowTaskSurfaceUpdate: WorkflowTaskSurfaceUpdatePayloadSchema.optional(),
  presentation: StepOutputPresentationSchema.optional(),
});

export type SessionEvent = z.infer<typeof SessionEventSchema>;
