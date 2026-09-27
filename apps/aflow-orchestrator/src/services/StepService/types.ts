/**
 * StepService type contracts.
 *
 * These are the non-negotiable interfaces between FlowExecution,
 * StepService, and step handlers. Every step type produces one of
 * three outcomes, and StepService is the only place that translates
 * those outcomes into durable state + events.
 */
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  StepId,
  AgentDefinition,
  StepDefinition,
  TraceId,
  PayloadRef,
} from '@aflow/schemas';
import type { SessionHotState, StepHotState, SessionEvent } from '@aflow/redis';
import type { PayloadStore } from '@aflow/payload-store';
import type { Redis } from 'ioredis';

// ============================================================================
// Step Outcome (handler → StepService)
// ============================================================================

export interface RequiredVariable {
  variableId: string;
  name?: string;
  description?: string;
  typeSchema?: Record<string, unknown>;
  semanticType?: string;
  required: true;
  /** Structured response options for the UI (single/multi-select). */
  responseOptions?: {
    type: 'single' | 'multi';
    options: Array<{ value: string; label?: string | undefined }>;
  };
}

export type StepOutcome =
  | {
      kind: 'complete';
      output?: unknown;
      outputRef?: string;
    }
  | {
      kind: 'fail';
      error: { code: string; message: string; details?: unknown };
    }
  | {
      kind: 'waitForInput';
      requiredVariables: RequiredVariable[];
      prompt?: string;
      /** Extra metadata for the pause event (e.g. agentResponse) */
      eventMeta?: Record<string, unknown>;
    };

// ============================================================================
// Step Context (shared across StepService operations)
// ============================================================================

export interface StepServiceDeps {
  redis: Redis;
  payloadStore: PayloadStore;
}

export interface StepContext {
  tenantId: TenantId;
  runId: SessionId;
  agentDef: AgentDefinition;
  traceId: TraceId;
  stepDef: StepDefinition;
  stepExecutionId: StepExecutionId;
  attempt: number;
  runState: SessionHotState;
  parentStepExecutionId?: StepExecutionId;
}

// ============================================================================
// Scheduling instructions (StepService → FlowExecution)
// ============================================================================

/** After StepService processes an outcome, it tells FlowExecution what to do next. */
export type PostOutcomeAction =
  | {
      kind: 'paused';
      /** The pause's resume contract, for callers that must route it onward. */
      requestedInputRef?: string;
    }
  | { kind: 'failed_terminal'; nextStepId?: StepId }
  | { kind: 'completed'; nextStepId?: StepId }
  | { kind: 'schedule_steps'; steps: ScheduleRequest[] };

export interface ScheduleRequest {
  stepId: StepId;
  inputRef?: PayloadRef;
  parentStepExecutionId?: StepExecutionId;
}

// ============================================================================
// Result handler interface (per step-type / per operation)
// ============================================================================

/**
 * A ResultHandler interprets a step's execution result and returns a StepOutcome.
 * It does NOT emit events or mutate Redis — that's StepService's job.
 */
export interface ResultHandler {
  /**
   * Interpret the step result and return the canonical outcome.
   *
   * @param ctx - Step context (includes runState, agentDef, etc.)
   * @param result - The step result message from the executor
   * @param deps - Shared deps (payloadStore for reading output)
   * @returns StepOutcome and optional scheduling instructions
   */
  handleResult(
    ctx: StepContext,
    result: StepResultInfo,
    deps: StepServiceDeps,
  ): Promise<ResultHandlerOutput>;
}

export interface StepResultInfo {
  status: 'SUCCEEDED' | 'FAILED' | 'PAUSED';
  outputRef?: string | null;
  errorRef?: string | null;
  error?: { code?: string; message?: string; classification?: string; retryable?: boolean } | null;
  durationMs?: number;
}

export interface ResultHandlerOutput {
  outcome: StepOutcome;
  /** If the outcome is 'complete' and the handler wants specific steps scheduled */
  scheduleRequests?: ScheduleRequest[];
  /** Extra run state updates (e.g. variableDefsOverlay) */
  runStateUpdates?: Partial<SessionHotState>;
  /** Extra step state updates */
  stepStateUpdates?: Partial<StepHotState>;
  /** Updated runtime state (after output mapping, turn tracking, etc.) */
  runtimeState?: SessionHotState['runtimeState'];
  /** Runtime state patch for the event (what changed) */
  runtimeStatePatch?: SessionEvent['runtimeStatePatch'];
  /** Additional events to emit atomically with the outcome event */
  additionalEvents?: SessionEvent[];
}
