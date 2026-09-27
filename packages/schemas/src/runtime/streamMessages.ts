/**
 * Redis Streams message schemas for job scheduling and result transport.
 * These messages are the contract between orchestrator and executors.
 */
import { z } from 'zod';
import {
  TenantIdSchema,
  SessionIdSchema,
  StepExecutionIdSchema,
  StepIdSchema,
  OperationIdSchema,
  TraceIdSchema,
  IdempotencyKeySchema,
  MessageVersionSchema,
} from './ids.js';
import { SessionAgentTargetSchema } from './agentTarget.js';
import { StepTypeSchema, type StepType } from '../artifact/operationDefinition.js';
import { PayloadRefSchema } from './payloadRef.js';
import { StepExecutionTerminalStatusSchema, StepUsageBreakdownSchema } from './events.js';
import { ActorContextSchema } from '../identity/actorContext.js';
import { ErrorClassificationSchema } from './errors.js';
import { SimulationRunInputSchema } from '../simulation/runContext.js';
import { SimulatedFulfillmentReportSchema } from '../simulation/fulfillmentReport.js';

// ============================================================================
// Stream Keys (Constants)
// ============================================================================

/**
 * The live streaming channels. Separate everywhere — separate buffers,
 * separate frames — so who may read which stays a property of the
 * subscription rather than a per-frame filter.
 *
 * `activity` carries what a step is doing rather than what it is saying: one
 * JSON-encoded `HarnessActivityLine` per newline-terminated delta. It is a
 * channel of its own because a reader that folded it into `text` would render
 * a harness's tool calls as the agent's own message.
 */
export const LiveDeltaChannelSchema = z.enum(['text', 'thinking', 'activity']);
export type LiveDeltaChannel = z.infer<typeof LiveDeltaChannelSchema>;

/**
 * Redis stream key patterns.
 */
export const StreamKeys = {
  /** Job stream for a step type: aflow:jobs:<step_type> */
  jobStream: (stepType: string) => `aflow:jobs:${stepType}` as const,

  /** Set of stream keys whose acked frontier may have advanced (Plan 294). */
  retentionCandidateSet: 'aflow:retention:candidates' as const,

  /** Dead-letter queue for jobs: aflow:dlq:jobs:<step_type> */
  dlqJobStream: (stepType: string) => `aflow:dlq:jobs:${stepType}` as const,

  /** Dead-letter queue for results: aflow:dlq:results */
  dlqResultsStream: 'aflow:dlq:results' as const,

  /** Pub/Sub channel for session events (non-durable, best-effort wakeup) */
  pubsubChannel: (tenantId: string, sessionId: string) =>
    `aflow:pubsub:session:${tenantId}:${sessionId}` as const,

  /** Pub/Sub channel for API catalog invalidation (definition/binding/credential mutations) */
  apiCatalogInvalidateChannel: (tenantId: string) =>
    `aflow:pubsub:api-catalog:${tenantId}` as const,

  /** Pub/Sub channel for MCP catalog invalidation (definition/binding/tool-cache mutations) */
  mcpCatalogInvalidateChannel: (tenantId: string) =>
    `aflow:pubsub:mcp-catalog:${tenantId}` as const,

  actionCenterFocusChannel: (tenantId: string, spaceId: string) =>
    `aflow:pubsub:action-center-focus:${tenantId}:${spaceId}` as const,

  /** Wakes the action-center topic after a producer changes what a space's
   *  action center shows. Best-effort; a residual audit repairs a lost wake. */
  actionCenterWakeChannel: (tenantId: string, spaceId: string) =>
    `aflow:pubsub:action-center-wake:${tenantId}:${spaceId}` as const,

  /** Tenant-wide variant for items that surface in every space of the tenant
   *  (integration host requests, tenant-scoped egress grants). */
  actionCenterTenantWakeChannel: (tenantId: string) =>
    `aflow:pubsub:action-center-wake:${tenantId}` as const,

  /** When a person last looked at a room, for the catch-up delta. */
  sessionLastSeenKey: (tenantId: string, sessionId: string, userId: string) =>
    `aflow:lastseen:${tenantId}:${sessionId}:${userId}` as const,

  /** Who is in a room, as a hash of per-tab entries. Ephemeral, TTL'd. */
  sessionPresenceKey: (tenantId: string, sessionId: string) =>
    `aflow:presence:${tenantId}:${sessionId}` as const,

  /** Roster changes, so every server instance sees them — not just the one
   *  holding the socket that produced the change. */
  sessionPresenceChannel: (tenantId: string, sessionId: string) =>
    `aflow:pubsub:presence:${tenantId}:${sessionId}` as const,

  /** Committed applet-instance deltas, fanned out to every server instance
   *  holding a subscriber. A missed publish self-heals through the client's
   *  version-gap refetch. */
  appletInstanceChannel: (tenantId: string, instanceId: string) =>
    `aflow:pubsub:applet-instance:${tenantId}:${instanceId}` as const,

  /** Which applet instance a session's agent is operating right now. One slot
   *  per session, TTL'd — the AppletFocus contract (Plan 264 §4.13). */
  sessionAppletFocusKey: (tenantId: string, sessionId: string) =>
    `aflow:applet-focus:${tenantId}:${sessionId}` as const,

  mcpElicitationRequestKey: (tenantId: string, elicitationId: string) =>
    `aflow:mcp:elicitation:request:${tenantId}:${elicitationId}` as const,

  hitlGateCallInputKey: (tenantId: string, sessionId: string, gateRequestId: string) =>
    `aflow:hitl:gate:call-input:${tenantId}:${sessionId}:${gateRequestId}` as const,

  hitlGateClearedKey: (tenantId: string, sessionId: string, gateRequestId: string) =>
    `aflow:hitl:gate:cleared:${tenantId}:${sessionId}:${gateRequestId}` as const,

  mcpElicitationLeaseKey: (elicitationId: string) =>
    `aflow:mcp:elicitation:lease:${elicitationId}` as const,

  mcpElicitationResponseChannel: (elicitationId: string) =>
    `aflow:pubsub:mcp-elicitation-response:${elicitationId}` as const,

  mcpElicitationRequestChannel: (tenantId: string) =>
    `aflow:pubsub:mcp-elicitation-request:${tenantId}` as const,

  /** Hot state key for session state */
  sessionStateKey: (tenantId: string, sessionId: string) =>
    `aflow:session:${tenantId}:${sessionId}:state` as const,

  /**
   * Per-space SpaceContext generation counter. Bumped post-commit on every
   * space-visible memory mutation; the cached SpaceContext records the gen it
   * was built at and rebuilds on mismatch. Advisory best-effort — a Redis
   * restart resets it and the 1h context TTL is the staleness backstop.
   */
  spaceContextGenKey: (tenantId: string, spaceId: string) =>
    `aflow:space:${tenantId}:${spaceId}:ctxgen` as const,

  sessionCorruptMarkerKey: (tenantId: string, sessionId: string) =>
    `aflow:session:${tenantId}:${sessionId}:corrupt` as const,

  sessionQuarantineKey: (tenantId: string, sessionId: string, tsMs: number) =>
    `aflow:session:${tenantId}:${sessionId}:state:corrupt:${tsMs}` as const,

  /** Hot state key for session metadata */
  sessionMetaKey: (tenantId: string, sessionId: string) =>
    `aflow:session:${tenantId}:${sessionId}:meta` as const,

  delegationParentKey: (tenantId: string, childRunId: string) =>
    `aflow:delegation:parent:${tenantId}:${childRunId}` as const,

  delegationPendingKey: 'aflow:delegation:pending' as const,

  delegationPendingDataKey: (tenantId: string, childRunId: string) =>
    `aflow:delegation:pending:data:${tenantId}:${childRunId}` as const,

  /**
   * Parents blocked in WAITING_ON_CHILD, scored by when the supervision sweep
   * should next look at them.
   *
   * Kept apart from `delegationPendingKey` because the two index opposite
   * events on different entities. A pending entry is child-keyed, armed when a
   * child comes to rest, and escalates once its attempts run out; this one is
   * parent-keyed, armed when the parent starts waiting, and its healthy
   * trajectory is to be pushed forward indefinitely — a child may legitimately
   * run for hours. Sharing a member space would also put a live supervision
   * entry behind the pending teardown, which deletes the reverse index a
   * supervision pass needs to resolve a vanished child's parent step.
   */
  delegationSupervisionCandidatesKey: 'aflow:delegation:supervision:candidates' as const,

  /** Scratch state for step execution */
  stepScratchKey: (tenantId: string, stepExecutionId: string) =>
    `aflow:step:${tenantId}:${stepExecutionId}:scratch` as const,

  /** Step execution state (Redis-first) */
  stepStateKey: (tenantId: string, stepExecutionId: string) =>
    `aflow:step:${tenantId}:${stepExecutionId}:state` as const,

  /** Session event stream (per-session, for SSE) */
  sessionEventsStream: (tenantId: string, sessionId: string) =>
    `aflow:session_events:${tenantId}:${sessionId}` as const,

  /**
   * Live streaming buffer for an in-flight step, one key per channel.
   *
   * A value, not a log: the accumulated partial text of the step currently
   * running. Appended as the model streams, read from a byte offset, deleted
   * when the step reaches a terminal event. It carries no audit meaning and no
   * durable cursor — that is what keeps it out of `sessionEventsStream`, whose
   * `MAXLEN` it would otherwise consume.
   *
   * `text` and `thinking` are separate keys so that who may read which is a
   * property of the subscription rather than a per-frame filter.
   */
  liveStreamBuffer: (tenantId: string, stepExecutionId: string, channel: LiveDeltaChannel) =>
    `aflow:live:${tenantId}:${stepExecutionId}:${channel}` as const,

  /**
   * Sessions awaiting projection, scored by a monotonic version.
   *
   * The version is what makes acknowledgement safe. With an unversioned set the
   * worker reads a session, projects it, and removes the marker — and a mutation
   * that landed in between is silently dropped, because its mark was the same
   * set member the worker just removed. Acknowledging a *version* means a
   * concurrent mutation leaves a marker the ack does not match, so it stays.
   *
   * The version lives here, on the index, and not on the session hash: that hash
   * has a TTL and is deleted-then-rewritten by several writers, so a counter on
   * it resets to zero and climbs back through values an in-flight worker already
   * read — which makes the acknowledgement match when it must not.
   */
  projectionCandidatesKey: 'aflow:projection:candidates' as const,

  /**
   * Where each projection candidate sits in the queue, scored by when it was
   * marked. Compared only against other marks, never against a clock, which is
   * what makes it safe for the caller to stamp.
   */
  projectionOrderKey: 'aflow:projection:order' as const,

  /**
   * When a worker's claim on a projection candidate expires, stamped from
   * Redis. Kept apart from the queue order because a score compared against the
   * server clock and a score compared against the caller's cannot share a key:
   * a caller one millisecond ahead had its own fresh mark judged not yet due.
   */
  projectionLeasesKey: 'aflow:projection:leases' as const,

  /**
   * Conversations owed a title or summary refresh, scored by a monotonic count
   * of the committed turn boundaries they have seen.
   *
   * The count is the evidence revision, and acknowledging it is what makes a
   * generation safe to apply: a boundary landing while the model was answering
   * raises the count, the acknowledgement no longer matches, and the
   * conversation stays a candidate rather than settling on a summary that
   * predates the exchange it is supposed to describe.
   *
   * Held on the index rather than on the session hash for the same reason the
   * projection version is: that hash has a TTL and is deleted-then-rewritten,
   * so a counter living on it climbs back through values an in-flight worker
   * has already read.
   */
  sessionMetadataCandidatesKey: 'aflow:session_metadata:candidates' as const,

  /**
   * The earliest instant each candidate may be generated, stamped from Redis.
   *
   * Carries the debounce, the floor between refreshes, and the retry backoff
   * all in one number, because all three are the same statement: not before
   * this. Separate from the revision above so a claim that finds new evidence
   * can push the next attempt forward without touching what it owes.
   */
  sessionMetadataDueKey: 'aflow:session_metadata:due' as const,

  /** When a worker's claim on a metadata candidate expires, stamped from Redis. */
  sessionMetadataLeasesKey: 'aflow:session_metadata:leases' as const,

  /** Consecutive failed generations per candidate, cleared on any settled outcome. */
  sessionMetadataAttemptsKey: 'aflow:session_metadata:attempts' as const,

  /**
   * Sessions whose current step is SCHEDULED or STARTED, scored by the earliest
   * instant at which that step could stop having a completion path.
   *
   * The score is a lower bound on when the stall watchdog needs to look, never a
   * verdict: `classifyStepCompletionPath` remains the only authority on whether
   * anything is reaped. A candidate that is still healthy when examined is
   * pushed forward rather than consumed, so reading is non-destructive and an
   * instance that dies mid-sweep loses nothing.
   */
  stepStallCandidatesKey: 'aflow:step_stall:candidates' as const,

  /**
   * Sessions sitting in QUEUED, scored by their creation time.
   *
   * The grace period belongs to the watchdog, not to the writers: three
   * services create queued sessions and none of them should have a reader's
   * tunable baked into the data they write. The reader turns its own grace into
   * a cutoff and asks for everything created before it.
   */
  queuedSessionCandidatesKey: 'aflow:queued_sessions:candidates' as const,

  /**
   * Held MCP elicitation leases, scored by the next instant the reconciler needs
   * to look at one.
   *
   * The reconciler acts on holder death, not on lease expiry — a healthy lease's
   * deadline is a whole TTL away while its holder can die at any moment — so the
   * score is a re-check time and the member carries the holder's instance id.
   * That is what lets one cycle resolve many leases to a handful of liveness
   * reads instead of one hash read each, and it is why the index replaces a
   * keyspace walk without trading away detection latency.
   */
  mcpElicitationLeaseCandidatesKey: 'aflow:mcp:elicitation:lease:candidates' as const,

  /** Memory embedding job stream */
  memoryEmbedStream: 'aflow:memory:embed' as const,

  /** Memory embedding DLQ stream */
  memoryEmbedDlqStream: 'aflow:memory:embed:dlq' as const,

  /** Memory v2 doc embedding job stream */
  memoryDocEmbedStream: 'aflow:memory:doc-embed' as const,

  /** Memory v2 doc embedding DLQ stream */
  memoryDocEmbedDlqStream: 'aflow:memory:doc-embed:dlq' as const,

  /** Guardrail check log stream (per-session, separate from session_events) */
  guardrailLogStream: (tenantId: string, sessionId: string) =>
    `aflow:guardrail_log:${tenantId}:${sessionId}` as const,

  /** Guardrail policy cache invalidation channel */
  guardrailInvalidateChannel: (tenantId: string) => `aflow:pubsub:guardrails:${tenantId}` as const,

  guardrailPolicyCacheKey: (tenantId: string, targetKey: string) =>
    `aflow:guardrails:${tenantId}:${targetKey}` as const,

  /** Shard-scoped control stream: aflow:shard:{shardId}:control */
  shardControlStream: (shardId: number) => `aflow:shard:${shardId}:control` as const,

  /** Shard-scoped results stream: aflow:shard:{shardId}:results */
  shardResultsStream: (shardId: number) => `aflow:shard:${shardId}:results` as const,

  /**
   * Per-shard key parts. The timer-claim Lua reads the due-shard index before
   * it knows which shards it will touch, so it has to build those keys itself;
   * it is handed these parts rather than repeating the format, so a rename here
   * reaches the script instead of silently diverging from it.
   */
  shardKeyParts: {
    prefix: 'aflow:shard:',
    timers: ':timers',
    timerData: ':timer-data',
  } as const,

  /** Shard-scoped timer ZSET — member is the stable timer id, score is due-at or lease-until. */
  shardTimersKey: (shardId: number) =>
    `${StreamKeys.shardKeyParts.prefix}${shardId}${StreamKeys.shardKeyParts.timers}` as const,

  /** Shard-scoped timer payload hash: `d:<timerId>` holds JSON, `c:<timerId>` the claim count. */
  shardTimerDataKey: (shardId: number) =>
    `${StreamKeys.shardKeyParts.prefix}${shardId}${StreamKeys.shardKeyParts.timerData}` as const,

  /**
   * Global due-shard index: member is a shard id, score is that shard's earliest
   * claimable timer. One bounded read replaces asking all 128 shards whether
   * anything is due.
   */
  dueShardsKey: 'aflow:timers:due-shards' as const,

  /** Shard registry hash: aflow:shards:registry */
  shardRegistryKey: 'aflow:shards:registry' as const,

  /**
   * Per-shard liveness marker from before liveness moved to the instance index.
   *
   * Kept only so the two protocols can run side by side through one rollout: a
   * process on either version must be able to see that the other is alive, or
   * the first instance to deploy steals every shard the other fleet owns.
   * Delete once no deployment can still be running the per-shard protocol.
   */
  legacyShardHeartbeatKey: (shardId: number) => `aflow:shard:${shardId}:heartbeat` as const,

  /**
   * Live orchestrator processes: member is the instance id, score is its lease
   * expiry. Separate from the registry on purpose — the registry says who owns
   * each shard, this says which processes are alive.
   */
  orchestratorLivenessKey: 'aflow:orchestrators:liveness' as const,

  /** Shard fencing token: aflow:shard:{shardId}:fence */
  shardFenceKey: (shardId: number) => `aflow:shard:${shardId}:fence` as const,

  /**
   * Active runs on a shard, as a SET of run ids rather than a counter.
   * Membership is idempotent, so a duplicated start or terminal delivery cannot
   * skew it the way an increment/decrement pair could.
   */
  shardActiveRunsKey: (shardId: number) => `aflow:shard:${shardId}:active` as const,

  /**
   * Active runs fleet-wide. Admission control reads its cardinality in O(1)
   * instead of pipelining one GET per configured shard on every session start.
   */
  activeRunsKey: 'aflow:runs:active' as const,

  /**
   * Shards that currently hold at least one active run.
   *
   * Recovery work that only matters where work exists reads this instead of
   * walking every configured shard: at idle the set is empty and the walk costs
   * one command, while a shard with live sessions is still checked at full
   * cadence.
   */
  activeShardsKey: 'aflow:shards:active' as const,

  /** Error reports stream (platform-operator diagnostics) */
  errorReportsStream: 'aflow:error_reports' as const,

  // ── Step abort Pub/Sub ────────────────────────────────────────────────

  /** Pub/Sub channel for aborting an in-flight step (orchestrator → executor) */
  stepAbortChannel: (stepExecutionId: string) => `aflow:abort:${stepExecutionId}` as const,

  /** Pattern for subscribing to all step abort signals */
  stepAbortPattern: 'aflow:abort:*' as const,

  /**
   * Durable record that a step attempt was cancelled, read by an executor before
   * it runs the job. The abort Pub/Sub above is the low-latency path and is lost
   * whenever nobody is listening yet — the job still queued, the executor between
   * claiming it and registering its abort controller, or Redis reconnecting.
   *
   * Keyed by ATTEMPT as well as step execution id, because a retry reuses the id
   * and only bumps the attempt (`updateStepStateForRetry`). Keyed on the id alone,
   * this would outlive the cancellation it records and silently drop the next
   * legitimate attempt of the same step.
   */
  stepCancelledKey: (stepExecutionId: string, attempt: number) =>
    `aflow:cancelled:${stepExecutionId}:${String(attempt)}` as const,

  /**
   * Per-task progress stream for workflow-task jobs that lack a `sessionId`.
   * Executor calls `ctx.emitWorkflowProgress` → XADD here; the harness's
   * `WorkflowRunHarness` consumer fans out `WorkflowTaskSurfaceUpdate`
   * events to each pending `workflow_run_waiter` session.
   *
   * Format: `aflow:workflow_task_progress:{tenantId}:{runId}:{taskId}`.
   * Trimmed by MAXLEN ~1000 to bound memory; surface mutations are the
   * canonical consumer (rendered live via WorkflowTaskSurfaceUpdate).
   */
  workflowTaskProgressStream: (tenantId: string, runId: string, taskId: string) =>
    `aflow:workflow_task_progress:${tenantId}:${runId}:${taskId}` as const,

  /**
   * Active per-task progress streams, as a SET of stream keys.
   *
   * The consumer needs to know which streams to read; discovering that by
   * scanning the keyspace made the cost proportional to every key in Redis
   * rather than to the tasks actually running. The producer adds its stream in
   * the same pipeline as the first event, and task completion removes it.
   */
  // Deliberately outside the `aflow:workflow_task_progress:*` namespace. A
  // consumer from before this index existed discovers streams by SCANning that
  // pattern and feeds every match straight to XREAD, so an index key inside it
  // would be handed to XREAD as a SET on rollback — WRONGTYPE rejects the whole
  // command and progress fan-out stops permanently.
  workflowTaskProgressIndexKey: 'aflow:workflow_task_progress_index' as const,

  /** Pattern for the one-time index seed and operator repair only. */
  workflowTaskProgressPattern: (tenantId: string) =>
    `aflow:workflow_task_progress:${tenantId}:*` as const,
} as const;

/**
 * Progress-stream `eventType` for "this task's step appended to its live
 * buffer". Never a durable event and never appended to a session's event
 * stream: the consumer turns it into the Pub/Sub wake the step's own job had no
 * session to publish, and the reader goes to the buffer for the bytes.
 */
export const WORKFLOW_TASK_LIVE_DELTA_EVENT_TYPE = 'WorkflowTaskLiveDelta';

// ============================================================================
// Step Job Message (Orchestrator → Executor)
// ============================================================================

export const WorkflowExecutionRefSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  attempt: z.number().int().min(1),
  /** Stable per-attempt token: `dispatch:<runId>:<taskId>:<attempt>`. */
  dispatchAttemptToken: z.string(),
});
export type WorkflowExecutionRef = z.infer<typeof WorkflowExecutionRefSchema>;

/**
 * Message sent from orchestrator to executor via job streams.
 * Contains only small fields + payload_ref (no large payloads inline).
 */
export const StepJobMessageSchema = z
  .object({
    /** Message schema version */
    messageVersion: MessageVersionSchema.default(1),

    /** Tenant context */
    tenantId: TenantIdSchema,

    sessionId: SessionIdSchema.optional(),

    workflowExecution: WorkflowExecutionRefSchema.optional(),

    /** Step execution identifier */
    stepExecutionId: StepExecutionIdSchema,

    /** Parent step execution ID (for tool sub-steps) */
    parentStepExecutionId: StepExecutionIdSchema.nullable().optional(),

    /** Step ID within the flow */
    stepId: StepIdSchema,

    /** Step type (executor class) */
    stepType: StepTypeSchema,

    /** Operation to execute */
    operationId: OperationIdSchema,

    /** Retry attempt number (starts at 1) */
    attempt: z.number().int().min(1).default(1),

    /** Idempotency key for deduplication */
    idempotencyKey: IdempotencyKeySchema,

    /** Reference to input payload in GCS (unresolved template) */
    inputRef: PayloadRefSchema,

    /** Reference to resolution context in GCS (state + step outputs snapshot) */
    resolutionContextRef: PayloadRefSchema.nullable().optional(),

    /** OpenTelemetry trace ID */
    traceId: TraceIdSchema,

    /** Timestamp when job was scheduled (Unix ms) */
    scheduledAtMs: z.number().int().positive(),

    credentialOwnerId: z.string().optional(),

    spaceId: z.string().uuid().optional(),

    /**
     * Model the agent that scheduled this step is itself running on. Lets a
     * tool step that needs a model of its own prefer the one the run already
     * proved usable, instead of a hardcoded default whose provider the space
     * may hold no credential for — a mismatch that surfaces mid-run, after
     * the agent has already committed to the tool call.
     */
    callerModel: z.string().max(128).optional(),

    /**
     * Where this step sits in the sequence its agent decided on. Present only
     * for tool steps lowered from an agent turn; a workflow operation task has
     * no turn to be indexed within, and anything reading this must fall back
     * to arrival order there rather than assume one.
     */
  })
  .refine((msg) => (msg.sessionId !== undefined) !== (msg.workflowExecution !== undefined), {
    message: 'StepJobMessage must have exactly one of `sessionId` or `workflowExecution`',
    path: ['sessionId'],
  });

export type StepJobMessage = z.infer<typeof StepJobMessageSchema>;

// ============================================================================
// Step Result Message (Executor → Orchestrator)
// ============================================================================

/**
 * Message sent from executor to orchestrator via results stream.
 */
export const StepResultMessageSchema = z
  .object({
    /** Message schema version */
    messageVersion: MessageVersionSchema.default(1),

    /** Tenant context */
    tenantId: TenantIdSchema,

    sessionId: SessionIdSchema.optional(),

    workflowExecution: WorkflowExecutionRefSchema.optional(),

    /** Step execution identifier */
    stepExecutionId: StepExecutionIdSchema,

    /** Parent step execution ID (for tool sub-steps) */
    parentStepExecutionId: StepExecutionIdSchema.nullable().optional(),

    /** Step ID within the flow */
    stepId: StepIdSchema,

    /** Step type (executor class) */
    stepType: StepTypeSchema,

    /** Operation that was executed */
    operationId: OperationIdSchema,

    /** Retry attempt number */
    attempt: z.number().int().min(1),

    /** Idempotency key for deduplication */
    idempotencyKey: IdempotencyKeySchema,

    /** Terminal status of the step execution */
    status: StepExecutionTerminalStatusSchema,

    /** Reference to output payload in GCS (for SUCCEEDED) */
    outputRef: PayloadRefSchema.nullable().optional(),

    /** Reference to error details in GCS (for FAILED) */
    errorRef: PayloadRefSchema.nullable().optional(),

    /** Reference to requested input (for PAUSED) */
    requestedInputRef: PayloadRefSchema.nullable().optional(),

    pauseType: z.string().nullable().optional(),

    resumeSchema: z.record(z.unknown()).nullable().optional(),

    /** Reference to resolved input in GCS (for auditability) */
    resolvedInputRef: PayloadRefSchema.nullable().optional(),

    /** Inline error details (for FAILED) */
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        classification: ErrorClassificationSchema.optional(),
        retryable: z.boolean().optional(),
        timestamp: z.string().datetime(),
        details: z.unknown().optional(),
        providerRequestId: z.string().optional(),
      })
      .nullable()
      .optional(),

    usage: StepUsageBreakdownSchema.nullable().optional(),

    /** Execution duration in milliseconds */
    durationMs: z.number().int().nonnegative().optional(),

    /**
     * Present when a simulation answered this step. The executor resolves
     * fulfillment at call time, so this — and nothing derived from the lowered
     * step — is what the run's simulated marking is read from.
     */
    simulatedFulfillment: SimulatedFulfillmentReportSchema.nullable().optional(),

    /** Reference to surface snapshot payload (for ui.surface.visualize steps) */
    surfaceSnapshotRef: PayloadRefSchema.nullable().optional(),

    /** Surface ID associated with this step (for ui.surface.visualize steps) */
    surfaceId: z.string().max(256).nullable().optional(),

    /** OpenTelemetry trace ID */
    traceId: TraceIdSchema,

    /** Timestamp when step finished (Unix ms) */
    finishedAtMs: z.number().int().positive(),
  })
  .refine((msg) => (msg.sessionId !== undefined) !== (msg.workflowExecution !== undefined), {
    message: 'StepResultMessage must have exactly one of `sessionId` or `workflowExecution`',
    path: ['sessionId'],
  });

export type StepResultMessage = z.infer<typeof StepResultMessageSchema>;

// ============================================================================
// Timer Item (for delayed scheduling)
// ============================================================================

export const TimerItemSchema = z
  .object({
    /** Tenant context */
    tenantId: TenantIdSchema,

    sessionId: SessionIdSchema.optional(),

    workflowExecution: WorkflowExecutionRefSchema.optional(),

    /** Step execution identifier */
    stepExecutionId: StepExecutionIdSchema,

    /** Step ID within the flow */
    stepId: StepIdSchema,

    /** Operation ID */
    operationId: OperationIdSchema,

    /** Step type for routing to correct job stream */
    stepType: StepTypeSchema,

    /** Reason for the timer */
    reason: z.enum(['retry', 'timeout', 'resume', 'delayed_start']),

    /** Retry attempt number */
    attempt: z.number().int().min(1),

    /** Reference to input payload */
    inputRef: PayloadRefSchema,

    /** Trace ID for distributed tracing */
    traceId: TraceIdSchema,

    /** When to trigger (Unix ms) - also used as ZSET score */
    dueAtMs: z.number().int().positive(),

    /**
     * Parent step execution (session-scoped tool sub-steps). Preserved so
     * results emitted after the delayed dispatch keep parent linkage.
     */
    parentStepExecutionId: StepExecutionIdSchema.optional(),

    credentialOwnerId: z.string().optional(),

    spaceId: z.string().uuid().optional(),
  })
  .refine((t) => (t.sessionId !== undefined) !== (t.workflowExecution !== undefined), {
    message: 'TimerItem must have exactly one of `sessionId` or `workflowExecution`',
    path: ['sessionId'],
  });

export type TimerItem = z.infer<typeof TimerItemSchema>;

// ============================================================================
// Consumer Group Configuration
// ============================================================================

/**
 * Consumer group names for stream processing.
 */
/**
 * Step types dispatched to a dedicated executor over a job stream. Inline
 * operations the orchestrator runs itself have a `StepType` but no lane, so
 * this is a subset of `StepTypeSchema` rather than a derivation of it.
 */
export const EXECUTOR_JOB_STEP_TYPES = [
  'ai',
  'memory',
  'api',
  'compute',
  'search',
  'agent',
  'user',
  'eval',
  'guardrail',
  'ui',
  'mcp',
  'catalog',
  'space',
  'workflow',
  'code',
  'host',
] as const satisfies readonly StepType[];

export const ConsumerGroups = {
  /** Orchestrator consumer group for control stream */
  orchestratorControl: 'orchestrator_control' as const,

  /** Orchestrator consumer group for results stream */
  orchestrator: 'orchestrator' as const,

  /** Executor consumer group prefix (e.g., exec_ai, exec_api) */
  executor: (stepType: string) => `exec_${stepType}` as const,
} as const;

// ============================================================================
// Control Messages (API → Orchestrator)
// ============================================================================

export const ClientMessageIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (id) => {
      try {
        JSON.parse(id);
        return false;
      } catch {
        return true;
      }
    },
    {
      message:
        'clientMessageId must not be valid JSON (e.g. "123", "true", "null", "\\"quoted\\"") — the Redis stream round-trip would re-type it. Use a UUID or a letter-prefixed id.',
    },
  );

/**
 * Start run command (durable intent).
 * API publishes; orchestrator consumes and performs scheduling.
 */
export const StartRunCommandSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),
  type: z.literal('start_run'),
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  target: SessionAgentTargetSchema,
  /** Agent version. Only meaningful for custom-agent target; '1' for platform; ignored for inline. */
  // Coerce to string - Redis deserialization may convert "1" to number 1
  agentVersion: z.coerce.string(),
  inputRef: PayloadRefSchema,
  traceId: TraceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  createdBy: z.string().optional(),
  requestedAtMs: z.number().int().positive(),
  actorContext: ActorContextSchema.optional(),
  /** Space that this run belongs to (immutable after creation) */
  spaceId: z.string().uuid().optional(),
  /** How this run was triggered — surfaces in agent FlowRunContext */
  trigger: z.enum(['chat', 'api', 'eval', 'mcp', 'schedule', 'voice', 'webhook']).optional(),
  /** Whether the user is interacting via voice — mutable, can change on resume */
  voiceMode: z.boolean().optional(),
  clientMessageId: ClientMessageIdSchema.optional(),
  /**
   * Pins the world any simulated binding this run calls answers from. Absent
   * means derived from the run id. Carried on the start command because the
   * environment a run is measured in belongs to whoever started it — an agent
   * that could set its own seed would be choosing the world it is graded in.
   */
  simulationRunInput: SimulationRunInputSchema.optional(),
});

export const ResumeRunCommandSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),
  type: z.literal('resume_run'),
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  stepExecutionId: StepExecutionIdSchema,
  inputRef: PayloadRefSchema,
  traceId: TraceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestedAtMs: z.number().int().positive(),
  actorContext: ActorContextSchema.optional(),
  /** Whether the user is interacting via voice — mutable, can change per-turn */
  voiceMode: z.boolean().optional(),
  clientMessageId: ClientMessageIdSchema.optional(),
});

export const CancelRunCommandSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),
  type: z.literal('cancel_run'),
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  traceId: TraceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestedAtMs: z.number().int().positive(),
});

export const InterruptRunCommandSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),
  type: z.literal('interrupt_run'),
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  traceId: TraceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestedAtMs: z.number().int().positive(),
});

export const RetryRunCommandSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),
  type: z.literal('retry_run'),
  tenantId: TenantIdSchema,
  runId: SessionIdSchema,
  /** Optional: retry from a specific failed step (default: last failed) */
  stepExecutionId: StepExecutionIdSchema.optional(),
  /** Optional corrective input */
  inputRef: PayloadRefSchema.optional(),
  traceId: TraceIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestedAtMs: z.number().int().positive(),
  actorContext: ActorContextSchema.optional(),
});

export const ControlMessageSchema = z.discriminatedUnion('type', [
  StartRunCommandSchema,
  ResumeRunCommandSchema,
  CancelRunCommandSchema,
  InterruptRunCommandSchema,
  RetryRunCommandSchema,
]);

export type ControlMessage = z.infer<typeof ControlMessageSchema>;

// ============================================================================
// Memory Embedding Job Message
// ============================================================================

/**
 * Message sent to the memory embedding queue for asynchronous embedding generation.
 * Published when memory entries are written/updated.
 */
export const MemoryEmbedJobSchema = z.object({
  /** Message schema version */
  messageVersion: MessageVersionSchema.default(1),

  /** Tenant context */
  tenantId: TenantIdSchema,

  /** Memory entry ID (UUID) */
  entryId: z.string().uuid(),

  /** Embedding model identifier (e.g., "openai:text-embedding-3-small") */
  embeddingModel: z.string().min(1).max(256),

  /** SHA256 hash of normalized content (for idempotency) */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a valid SHA-256 hex string'),

  /** Payload reference for large content (preferred) */
  contentRef: PayloadRefSchema.optional(),

  /** Inline content text (ONLY for small payloads, max 16KB) */
  contentText: z.string().max(16384).optional(),

  /** Namespace (for debugging) */
  namespace: z.string().max(128).optional(),

  /** Scope information (one of spaceId, flowId, or runId) */
  scope: z
    .union([
      z.object({ spaceId: z.string().uuid() }),
      z.object({ flowId: z.string().max(128) }),
      z.object({ runId: z.string().uuid() }),
    ])
    .optional(),

  /** ISO timestamp when job was created */
  createdAt: z.string().datetime(),
});

export type MemoryEmbedJob = z.infer<typeof MemoryEmbedJobSchema>;

// ============================================================================
// Memory v2 Doc Embedding Job Message
// ============================================================================

/**
 * Job message for embedding memory v2 documents.
 * Published when a doc is put/patched and indexing != 'disabled'.
 * The worker reads chunks from DB, generates embeddings, and writes them back.
 */
export const MemoryDocEmbedJobSchema = z.object({
  messageVersion: MessageVersionSchema.default(1),

  tenantId: TenantIdSchema,

  /** Space the doc lives in — scopes the idempotency read fail-closed. */
  spaceId: z.string().uuid(),

  /** Memory doc ID */
  docId: z.string().uuid(),

  /** Specific version to embed */
  docVersionId: z.string().uuid(),

  /** Version number (for logging/idempotency) */
  version: z.number().int().positive(),

  /** Document path (for logging) */
  path: z.string(),

  /** SHA256 of the content at write time (idempotency check) */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a valid SHA-256 hex string'),

  /** Embedding model to use */
  embeddingModel: z.string().min(1).max(256),

  /** ISO timestamp when job was created */
  createdAt: z.string().datetime(),
});

export type MemoryDocEmbedJob = z.infer<typeof MemoryDocEmbedJobSchema>;
