import type { Redis } from 'ioredis';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PayloadStore } from '@aflow/payload-store';
import type {
  TenantId,
  SessionId,
  StepExecutionId,
  TraceId,
  PayloadRef,
  ContractError,
  WaiterNotifiedOutcome,
  Workflow,
  WorkflowRunCancellation,
  WorkflowRunWakeupHandoff,
} from '@aflow/schemas';
import type { WorkflowRunDetail } from '@aflow/cybernetic-runtime';

/**
 * Typed correlation between a Runner session / executor job and the
 * workflow_runs row that owns its lifecycle. Mirrored from the schema:
 * `WorkflowExecutionRefSchema` in `packages/schemas/src/runtime/streamMessages.ts`
 * (envelope) and `SessionHotState.workflowExecution` (Runner hot state).
 */
export interface WorkflowExecutionRef {
  runId: string;
  taskId: string;
  attempt: number;
  dispatchAttemptToken?: string;
}

/**
 * Outcome shape passed to the unified `onWorkflowTaskComplete` handler.
 * Both intercept points (Runner-terminal + workflow-task-result) flatten
 * their input into this shape.
 */
export type WorkflowTaskOutcome =
  | { kind: 'succeeded'; outputRef: string }
  | {
      kind: 'failed';
      errorRef?: string;
      failureReason?: string;
      errorCode?: string;
      errorClassification?: string;
      errorRetryable?: boolean;
    }
  | {
      kind: 'paused';
      /** Run-level resume contract (`workflow_runs.paused_payload_ref`). */
      contractRef?: string;
      /**
       * Runner's attempted output ref for the task row. When set, the task
       * row keeps this ref (replace_output merge base) instead of the contract.
       */
      taskOutputRef?: string;
    };

export interface OnWorkflowTaskCompleteArgs {
  tenantId: TenantId;
  workflowExecution: WorkflowExecutionRef;
  outcome: WorkflowTaskOutcome;
  /** Trace id from the result/session for log correlation. */
  traceId?: TraceId;
}

export interface CancelRunResult {
  /** Wall-clock timestamp the cancel sequence completed. */
  cancelledAt: Date;
  /** Task ids whose row transitioned non-terminal → 'cancelled' on this call. */
  cancelledTaskIds: string[];
  /** Distinct Runner session ids the `cancel_run` cascade was sent to. */
  interruptedSessions: string[];
}

export class CancelCascadeDeliveryError extends Error {
  constructor(
    public readonly runId: string,
    public readonly failedCount: number,
    public readonly summary: string,
  ) {
    super(
      `cancel_run cascade failed for ${String(failedCount)} session(s) on run=${runId}: ${summary}`,
    );
    this.name = 'CancelCascadeDeliveryError';
  }
}

export type NotifyWaitersArgs = NotifyWaitersCommonArgs &
  (
    | {
        outcome: 'paused';
        /**
         * The `pause_version` the reported pause took, from the write that made
         * it. Re-reading the run instead would hand a notification that arrives
         * after the run resumed and paused again the newer pause's version.
         */
        pauseVersion: number;
      }
    | { outcome: Exclude<WaiterNotifiedOutcome, 'paused'> }
  );

interface NotifyWaitersCommonArgs {
  tenantId: TenantId;
  runId: string;
  /** Optional payload ref for the synthetic step result (e.g., resume contract for `paused`). */
  payloadRef?: string;
  /** For `handed_off` outcome — describes who took over the run and what the released waiter should do. */
  handoffPayload?: WorkflowRunWakeupHandoff;
  /**
   * For `cancelled` outcome — cancellation provenance. The wake-up envelope
   * derives its `cancellation` block (actor + retryPolicy) from this via
   * `buildWakeupCancellation` so the parked Helmsman sees an operator stop
   * as deliberate intent, not a transient platform failure.
   */
  cancellation?: WorkflowRunCancellation;
  runDetail?: WorkflowRunDetail;
  excludeSessionIds?: string[];
}

export type RunnerTerminalKind = 'SUCCEEDED' | 'FAILED' | 'PAUSED';

export interface RunnerTerminalPayloads {
  outputRef?: string | null;
  errorRef?: string | null;
  contractRef?: string | null;
  failureReason?: string;
}

export class PreClaimDispatchError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly originalMessage: string,
  ) {
    super(originalMessage);
    this.name = 'PreClaimDispatchError';
  }
}

export class PostClaimDispatchError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly originalMessage: string,
  ) {
    super(originalMessage);
    this.name = 'PostClaimDispatchError';
  }
}

export interface DispatchTaskArgs {
  tenantId: TenantId;
  runId: string;
  taskId: string;
  attempt: number;
  /**
   * The Helmsman session that triggered this run. Used as the source of
   * actorContext / createdBy / spaceContext for Runner spawns; carried
   * onto operation-task jobs so credential resolution works.
   */
  helmsmanSessionId: SessionId;
}

export interface DispatchRetriedTaskArgs {
  tenantId: TenantId;
  runId: string;
  taskId: string;
  /** The task's new attempt value (post-commit; equals oldAttempt + 1). */
  attempt: number;
  /** Helmsman session id from the resume call (for actorContext + grants). */
  helmsmanSessionId: SessionId;
  /** Typed ContractError injected into the task's `system_feedback` binding on a producer rerun. */
  systemFeedback?: ContractError;
}

export interface SpawnRunnerSessionArgs {
  tenantId: TenantId;
  spaceId: string;
  /** Pre-allocated by `dispatchTask`; must equal `workflow_run_tasks.worker_session_id`. */
  workerSessionId: SessionId;
  /** For execution-context inheritance only — NOT a cascade parent. */
  helmsmanSessionId: SessionId;
  workflowExecution: WorkflowExecutionRef;
  /**
   * Runner's `start_run` input — must be the `{ input, config }` shape
   * `processFlowInput` expects. Callers go through `dispatchTask`, which
   * encodes exactly that slice of `buildDelegateTaskInput`'s result.
   */
  inputRef: PayloadRef;
  /** Agent definition slug; e.g., 'cybernetic-runner'. */
  agentDefinitionRef: string;
  /**
   * The version this run is pinned to, when it pins one. Absent resolves
   * `latest`, which is right for production and wrong for a measured run: the
   * manifest would record a version the trial did not necessarily execute.
   */
  agentVersion?: string | undefined;
  traceId: TraceId;
  /**
   * Optional structured fields — when present, stamp onto the QUEUED
   * Runner state so the Runner sees its delegation context, output
   * schema override, and display metadata. The QUEUED→RUNNING rebuild
   * preserves all of these (see SessionOrchestrator/index.ts).
   */
  delegationContextJson?: string;
  finalOutputSchemaOverrideJson?: string;
  finalOutputValidatorRefs?: string[];
  delegationDisplayWorkflowSlug?: string;
  delegationDisplayTaskId?: string;
  delegationDisplayTaskName?: string;
}

export interface StartRunArgs {
  tenantId: TenantId;
  spaceId: string;
  /** The Helmsman session calling workflow.run.start. Becomes the run's first waiter. */
  callingHelmsmanSessionId: SessionId;
  /** Helmsman's step that wants to be notified when the workflow pauses/completes. */
  /**
   * Carried for telemetry / future use. The waiter row is inserted by
   * the caller (Phase 132v2.3.1b) before startRun runs, using this
   * stepExecutionId — so startRun itself doesn't read this field
   * directly.
   */
  callingHelmsmanStepExecutionId: StepExecutionId;
  /** The workflow run id (already pre-allocated by the caller). */
  runId: string;
  /** Resolved + revision-pinned workflow definition. */
  workflow: Workflow;
  /**
   * Wait semantics — currently informational. The harness always
   * registers a waiter; Phase 2.5 wires the Helmsman flow to honour
   * `until_pause` vs `until_complete`. Forward-compatible.
   */
  wait?: 'until_pause' | 'until_complete';
}

export interface StartRunResult {
  runId: string;
  /** Task ids dispatched on the first wave. Empty if the workflow has no immediately-ready tasks (everything blocked on when-predicates). */
  activeTasks: string[];
}

export interface ReconcileStaleRunResult {
  /** Pending rows examined this pass. */
  scanned: number;
  /** Rows where the Runner hot state was missing → orphan recovered + re-dispatched. */
  orphans: number;
  /** Rows where the Runner reached terminal but the intercept dropped → re-driven via routeRunnerTerminalToHarness. */
  redrives: number;
  /** Rows where the Runner is still working → due_at bumped. */
  bumps: number;
  /**
   * Rows for operation tasks (sessionId is NULL on the task row — not a
   * Runner-backed agent task). Operation tasks have no SessionHotState
   * to inspect; the sweeper just bumps due_at. Counted separately so the
   * orphan branch isn't accidentally credited for executor jobs.
   */
  operationBumps: number;
  zombies: number;
  escalations: number;
  /** Rows that errored during processing → due_at bumped with last_error. */
  errors: number;
}

export interface HarnessDeps {
  db: PostgresJsDatabase;
  redis: Redis;
  payloadStore: PayloadStore;
}
