/**
 * Core types for executor runtime.
 */
import type { TimeoutSpec } from './timeout.js';
import type { Redis } from 'ioredis';
import type { BlockingRedisConnection } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { z } from 'zod';
import type {
  StepJobMessage,
  StepDefinition,
  OperationDefinition,
  PayloadRef,
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  OperationId,
  AflowError,
  StepType,
  LiveDeltaChannel,
  SimulatedFulfillmentReport,
} from '@aflow/schemas';
import type { ResolutionContext, ResolutionError, ValidationError } from '@aflow/input-resolution';

// ============================================================================
// Step Result Types
// ============================================================================

/**
 * Successful step execution result.
 */
export interface SuccessResult {
  readonly status: 'SUCCEEDED';
  readonly outputRef: PayloadRef;
  readonly costJson?: Record<string, unknown>;
  readonly durationMs: number;
}

/**
 * Failed step execution result.
 */
export interface FailureResult {
  readonly status: 'FAILED';
  readonly error: AflowError;
  readonly errorRef: PayloadRef;
  readonly durationMs: number;
}

/**
 * Paused step execution result (awaiting user input).
 */
export interface PausedResult {
  readonly status: 'PAUSED';
  readonly requestedInputRef: PayloadRef;
  readonly durationMs: number;
}

/**
 * Union of all step result types.
 */
export type StepResult = SuccessResult | FailureResult | PausedResult;

// ============================================================================
// Executor Context
// ============================================================================

/**
 * Context provided to step handlers.
 * Contains everything needed to execute a step.
 */
export interface ExecutorContext {
  /** The validated job message */
  readonly job: StepJobMessage;

  /** Tenant ID for this execution */
  readonly tenantId: TenantId;

  /**
   * Space the originating session/run belongs to — the cybernetic boundary.
   * System-carried (stamped on the job by the orchestrator from session/run
   * state); operations execute only in this space and must never accept a
   * caller-supplied space. Absent only on legacy in-flight jobs — handlers
   * that need it fail loud.
   */
  readonly spaceId?: string;

  /** Run ID */
  readonly runId: SessionId;

  /** Step execution ID */
  readonly stepExecutionId: StepExecutionId;

  /**
   * The unit of work this execution is one attempt at, stable across attempts.
   * Work that must not be repeated — anything a provider is paid for at
   * dispatch — is keyed on this and never on `stepExecutionId`, which names an
   * attempt on the workflow path.
   */
  readonly logicalExecutionId: string;

  /** Current attempt number */
  readonly attempt: number;

  /** Idempotency key for this execution */
  readonly idempotencyKey: string;

  /** Trace ID for distributed tracing */
  readonly traceId: string;

  /** Operation ID being executed */
  readonly operationId: OperationId;

  /**
   * Model the scheduling agent is itself running on, when the run pins one.
   * A handler that needs a model of its own should prefer this over a
   * hardcoded default: the run already proved this provider resolvable in
   * this space, so it cannot fail the way a default the space holds no
   * credential for does — mid-run, after the tool call is committed.
   */
  readonly callerModel?: string;

  /** Step definition (if available) */
  readonly stepDefinition?: StepDefinition;

  /** Operation definition (if available) */
  readonly operationDefinition?: OperationDefinition;

  /** Read a payload from the store */
  readonly readPayload: <T = unknown>(ref: PayloadRef) => Promise<T>;

  /** Write a payload to the store */
  readonly writePayload: (
    kind:
      'output' | 'error' | 'input_request' | 'body' | 'raw_body' | 'activity' | 'patch' | 'logs',
    data: unknown,
  ) => Promise<PayloadRef>;

  /** Check if output already exists (for idempotency) */
  readonly outputExists: () => Promise<PayloadRef | null>;

  /** Resolution context (loaded from resolutionContextRef if provided) */
  readonly resolutionContext?: ResolutionContext;

  /**
   * Resolve input template and validate against schema.
   * This is the recommended way for handlers to get typed input.
   *
   * @param inputTemplate - Raw input with ${...} references
   * @param schema - Zod schema for validation
   * @returns Resolved and validated input, or throws with detailed error
   */
  readonly resolveAndValidateInput: <T>(
    inputTemplate: unknown,
    // Zod's ZodType<T, Def, Input> uses any for Def/Input in generic contexts
    schema: z.ZodType<T>,
  ) => Promise<ResolvedInput<T>>;

  readonly emitRunEvent: (event: {
    eventType: string;
    metadata?: Record<string, unknown>;
    surfaceMutations?: Array<Record<string, unknown>>;
    surfaceId?: string;
  }) => Promise<void>;

  /**
   * Append to this step's live streaming buffer.
   *
   * Deliberately not `emitRunEvent`: a delta is the current value of an
   * in-flight step, not a record of something that happened. It carries no
   * durable cursor, is superseded by the step's terminal event, and must never
   * consume the session event stream's bounded capacity.
   *
   * A step a workflow dispatched streams the same way. The buffer is keyed by
   * the step, so only the wake differs: with no session to publish on, it rides
   * the task's progress stream to whoever is watching the run.
   */
  readonly emitLiveDelta: (channel: LiveDeltaChannel, delta: string) => Promise<void>;

  readonly emitWorkflowProgress: (event: {
    eventType: string;
    metadata?: Record<string, unknown>;
    surfaceMutations?: Array<Record<string, unknown>>;
    surfaceId?: string;
    /** Monotonic per-task counter; pass through if the handler tracks it. */
    sequence?: number;
  }) => Promise<void>;

  /** Signal for cancellation */
  readonly signal: AbortSignal;

  /**
   * Report observable progress (e.g. each streamed model chunk). Slides the
   * idle deadline when the step runs under a progress-aware timeout; a no-op
   * under a flat one — call it unconditionally.
   */
  readonly reportProgress?: () => void;

  /**
   * Declare that a simulation answered this step, once the handler has
   * resolved fulfillment. The report rides every terminal result the attempt
   * produces — including one raised from a throw — so a handler states it
   * once at the point of resolution rather than at each exit.
   */
  readonly reportSimulatedFulfillment?: (report: SimulatedFulfillmentReport) => void;

  /** Logger for structured logging */
  readonly log: ExecutorLogger;

  readonly slotController?: SlotController;
}

export interface SlotController {
  /** Release the slot if currently held. Idempotent. */
  release(): void;
  /** Re-acquire a slot if not currently held. Idempotent. May block. */
  acquire(): Promise<void>;
  /** Whether the handler currently holds a slot. */
  readonly held: boolean;
}

/**
 * Result of input resolution and validation.
 */
export interface ResolvedInput<T> {
  /** The resolved and validated data */
  data: T;

  /** Reference to the resolved input stored in payload store */
  resolvedInputRef: PayloadRef;
}

/**
 * Error thrown when input resolution or validation fails.
 */
export class InputResolutionError extends Error {
  readonly code: string;
  readonly phase: 'resolution' | 'validation';
  readonly originalError?: ResolutionError | ValidationError | undefined;

  constructor(
    message: string,
    phase: 'resolution' | 'validation',
    code: string,
    originalError?: ResolutionError | ValidationError,
  ) {
    super(message);
    this.name = 'InputResolutionError';
    this.phase = phase;
    this.code = code;
    if (originalError !== undefined) {
      this.originalError = originalError;
    }
  }

  toAflowError(): AflowError {
    return {
      code: this.code,
      message: this.message,
      classification: 'validation',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Structured logger interface.
 */
export interface ExecutorLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ============================================================================
// Step Handler Interface
// ============================================================================

/**
 * Step handler interface.
 * Each step type implements this to handle its business logic.
 */
export interface StepHandler {
  /**
   * The step type this handler supports (e.g., "ai", "api", "user").
   */
  readonly stepType: string;

  /**
   * Execute the step.
   * @param ctx - Execution context with job, helpers, etc.
   * @returns Step result (success, failure, or paused)
   */
  execute(ctx: ExecutorContext): Promise<StepResult>;

  /**
   * Optional: Validate the job before execution.
   * Return null if valid, or an error if invalid.
   */
  validate?(ctx: ExecutorContext): Promise<AflowError | null>;

  /**
   * Optional: the executor-level (outer) timeout this step needs, in ms.
   *
   * The outer `withTimeout` and the watchdog's zombie-reap deadline are both
   * sized off this. A handler whose op self-enforces a wall-clock with its OWN
   * inner timer (e.g. the sandbox's docker `--stop-timeout`) MUST return a value
   * that exceeds that inner cap, or the outer guard reaps the step before the
   * inner timer can return its graceful result. Returning undefined falls back to
   * the step definition's timeout, then the executor's flat default.
   */
  resolveTimeoutMs?(ctx: ExecutorContext): Promise<TimeoutSpec | undefined>;

  /**
   * Optional: Initialize handler (called once on startup).
   */
  initialize?(): Promise<void>;

  /**
   * Optional: Shutdown handler (called on graceful shutdown).
   */
  shutdown?(): Promise<void>;
}

// ============================================================================
// Executor Configuration
// ============================================================================

/**
 * Configuration for an executor instance.
 */
export interface ExecutorConfig {
  /** Consumer name for Redis Streams */
  consumerName: string;

  /** Consumer group name */
  consumerGroup: string;

  /** Stream to consume from (e.g., "aflow:jobs:ai") */
  streamKey: string;

  /** Step type this executor handles */
  stepType: StepType;

  /** Maximum concurrent job processing */
  concurrency: number;

  /** Default timeout for step execution in ms */
  defaultTimeoutMs: number;

  /** How long to block on XREADGROUP */
  blockMs: number;

  /** Batch size for XREADGROUP */
  batchSize: number;

  /** Whether to claim pending messages on startup */
  claimPendingOnStart: boolean;

  /** Max time a message can be pending before reclaiming (ms) */
  pendingTimeoutMs: number;
}

/** AI steps (LLM calls) can take minutes; use 5 min before considering consumer dead. */
export const PENDING_TIMEOUT_MS_AI = 5 * 60_000;

/** Default for fast steps (api, compute, etc.). */
export const PENDING_TIMEOUT_MS_DEFAULT = 120_000;

export function getDefaultPendingTimeoutMs(stepType: StepType): number {
  switch (stepType) {
    case 'ai':
      return PENDING_TIMEOUT_MS_AI;
    case 'memory':
    case 'api':
    case 'compute':
    case 'search':
    case 'agent':
    case 'workflow':
    case 'user':
    case 'catalog':
    case 'space':
    case 'eval':
    case 'guardrail':
    case 'ui':
    case 'mcp':
    case 'learner':
    case 'proposal':
    case 'skill':
    case 'capability':
    case 'integration':
    case 'human':
    case 'artifact':
    case 'code':
    case 'store':
    case 'host':
    case 'browser':
      return PENDING_TIMEOUT_MS_DEFAULT;
  }
}

/**
 * Default executor configuration values.
 * Use these as defaults when constructing ExecutorConfig.
 * Override pendingTimeoutMs with getDefaultPendingTimeoutMs(stepType) for step-type-aware defaults.
 */
export const DEFAULT_EXECUTOR_CONFIG = {
  concurrency: 10,
  defaultTimeoutMs: 30_000,
  blockMs: 5_000,
  batchSize: 10,
  claimPendingOnStart: true,
  pendingTimeoutMs: PENDING_TIMEOUT_MS_DEFAULT,
} as const;

// ============================================================================
// Executor Runtime Dependencies
// ============================================================================

/**
 * Dependencies injected into the executor runtime.
 */
export interface ExecutorDependencies {
  /** Redis client */
  redis: Redis;

  redisBlocking: BlockingRedisConnection;

  /**
   * Optional dedicated Redis connection for Pub/Sub abort signals.
   *
   * When provided, the executor subscribes to `aflow:abort:*` on start and
   * routes abort messages to in-flight step AbortControllers. This connection
   * enters subscriber mode and cannot be used for regular commands.
   *
   * If not provided, external abort is disabled — steps rely on timeout only.
   */
  redisSubscriber?: Redis;

  /** Payload store for reading/writing payloads */
  payloadStore: PayloadStore;

  /** Optional: Step definition resolver (keyed by stepId) */
  resolveStepDefinition?: (stepId: StepId) => Promise<StepDefinition | undefined>;

  /** Optional: Operation definition resolver (keyed by operationId) */
  resolveOperationDefinition?: (
    operationId: OperationId,
  ) => Promise<OperationDefinition | undefined>;
}
