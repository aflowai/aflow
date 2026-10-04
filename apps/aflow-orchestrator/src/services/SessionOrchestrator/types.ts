import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  AgentDefinition,
  TraceId,
  PayloadRef,
  StepResultMessage,
  IdempotencyKey,
  ActorContext,
  AgentToolError,
  ToolResultObservation,
  SessionAgentTarget,
  SimulationRunInput,
  StepImage,
  RunTrigger,
} from '@aflow/schemas';

// ============================================================================
// Public types
// ============================================================================

export type SessionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PAUSED'
  | 'WAITING_ON_CHILD'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'CANCELLING'
  | 'STALLED';

export type StepExecutionStatus = 'SCHEDULED' | 'STARTED' | 'SUCCEEDED' | 'FAILED' | 'PAUSED';

export interface FlowExecutionContext {
  tenantId: TenantId;
  runId: SessionId;
  agentDefinition: AgentDefinition;
  traceId: TraceId;
  /** Space this run belongs to (immutable, from run hot state) */
  spaceId?: string;
}

/** Tool result summary for passing back to agent turns */
export interface ToolResultSummary {
  toolCallId: string;
  toolId: string;
  name: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PAUSED';
  summary?: string;
  /** The operation that was executed (e.g., 'ai.media.image') */
  operationId?: string;
  /** State variable key(s) where the output was stored */
  outputStoredIn?: string[];
  /** Whether the output was displayed to the user (from stepDef.outputOptions.displayToUser) */
  displayedToUser?: boolean;
  /** Execution duration in milliseconds */
  durationMs?: number;
  /** Whether this tool call's output has a per-call output ref (for output.<toolCallId> refs) */
  hasOutputRef?: boolean;
  /** Available field paths for virtual path access (e.g., ['data', 'outputFiles/train.csv']) */
  outputFields?: string[];
  error?: AgentToolError;
  nextSteps?: Array<{ action: string; note: string }>;
  /** Images at the output paths the operation declares — references only, never bytes. */
  images?: StepImage[];
  /** Images found there and not carried, each with where and why. */
  imagesWithheld?: string[];
  /** What the result observes or ends, when its operation declares an observation. */
  observation?: ToolResultObservation;
}

export interface ScheduleStepParams {
  context: FlowExecutionContext;
  stepId: StepId;
  parentStepExecutionId?: StepExecutionId;
  inputRef: PayloadRef;
  attempt?: number;
  delayMs?: number;
  lastToolResults?: ToolResultSummary[];
}

export interface ApplyResultParams {
  result: StepResultMessage;
  messageId: string;
}

// ============================================================================
// Service interface
// ============================================================================

export interface SessionOrchestrator {
  /**
   * Start a new flow run.
   */
  startRun(params: {
    tenantId: TenantId;
    /** Run ID is assigned by the caller (API/control plane) */
    runId: SessionId;
    target: SessionAgentTarget;
    agentVersion: string;
    inputRef: PayloadRef;
    traceId: TraceId;
    createdBy?: string;
    idempotencyKey: IdempotencyKey;
    /** Space this run belongs to (immutable) */
    spaceId?: string;
    /** How this run was triggered */
    trigger?: RunTrigger;
    /** Whether a person sets the run going with this command — see `SessionHotState.activatedByPerson`. */
    activatedByPerson: boolean;
    /** Whether the user is interacting via voice */
    voiceMode?: boolean;
    actorContext?: ActorContext;
    clientMessageId?: string;
    /**
     * Pins the world any simulated binding this run calls answers from.
     * Absent means derived. Settable only here, at the start boundary, so the
     * agent under test cannot choose the environment it is measured in.
     */
    simulationRunInput?: SimulationRunInput;
  }): Promise<{ runId: SessionId; status: SessionStatus }>;

  /**
   * Schedule a step for execution.
   */
  scheduleStep(params: ScheduleStepParams): Promise<StepExecutionId>;

  /**
   * Apply a step result (called by result consumer loop).
   */
  applyResult(params: ApplyResultParams): Promise<void>;

  /**
   * Resume a paused run with user input.
   */
  resumeRun(params: {
    tenantId: TenantId;
    runId: SessionId;
    stepExecutionId: StepExecutionId;
    inputRef: PayloadRef;
    traceId: TraceId;
    actorContext?: ActorContext;
    /** Whether the user is interacting via voice (mutable per-turn) */
    voiceMode?: boolean;
    clientMessageId?: string;
    /** Whether a person sets the run going with this command — see `SessionHotState.activatedByPerson`. */
    activatedByPerson: boolean;
    idempotencyKey: IdempotencyKey;
  }): Promise<{ status: SessionStatus }>;

  /**
   * Cancel a running flow (terminal — not resumable).
   */
  cancelRun(params: { tenantId: TenantId; runId: SessionId }): Promise<{ status: SessionStatus }>;

  interruptRun(params: {
    tenantId: TenantId;
    runId: SessionId;
  }): Promise<{ status: SessionStatus }>;

  /**
   * Retry a failed run from the failed step or its parent agent turn.
   */
  retryRun(params: {
    tenantId: TenantId;
    runId: SessionId;
    /** Optional: retry from a specific failed step (default: last failed step) */
    stepExecutionId?: StepExecutionId;
    /** Optional corrective input to use instead of original step input */
    inputRef?: PayloadRef;
    traceId: TraceId;
    actorContext?: ActorContext;
    /** Whether a person sets the run going with this command — see `SessionHotState.activatedByPerson`. */
    activatedByPerson: boolean;
    idempotencyKey: IdempotencyKey;
  }): Promise<{ status: SessionStatus }>;

  /**
   * Process due timers (called periodically).
   */
  processDueTimers(): Promise<number>;

  /**
   * Recover orphaned sessions after orchestrator restart.
   * Scans all RUNNING sessions in Redis and pauses those with dead executors.
   * Should be called once at startup, after shard recovery is complete.
   */
  recoverOrphanedSessions(): Promise<{ paused: number; failed: number; rearmed: number }>;
}
