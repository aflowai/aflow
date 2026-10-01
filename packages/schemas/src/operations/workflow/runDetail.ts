import { z } from 'zod';
import { WorkflowRunStatusSchema } from './enums.js';
import {
  WorkflowHumanActionPreviewSchema,
  WorkflowHumanDecisionSchema,
  WorkflowHumanFailureModeSchema,
} from './taskHuman.js';
import { WorkflowSuggestedActionSchema } from './suggestedAction.js';
import { WorkflowWhenViewSchema } from './task.js';
import { WorkflowRunResultSchema } from './runResult.js';
import { StepOutputPresentationSchema } from '../../runtime/stepPresentation.js';
import { WorkflowRunCancelActorSchema } from '../../runtime/workflowRun.js';

// --- workflow.run.detail ---

export const WorkflowRunDetailInputSchema = z.object({
  runId: z.string().uuid(),
  present: z.boolean().optional(),
  /**
   * Compact projection — drop the large inline per-task payloads (inline refs over a
   * size cap) while keeping gs:// pointers, status/timing, the pause contract + action
   * preview (the plan), and the result. Defaults TRUE for token-efficient driving;
   * pass false for the full per-task input/output payloads.
   */
  compact: z.boolean().optional(),
  taskOutput: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'The output of one task, by id — the findings, the diff, the checks a review or a ' +
        "harness task returned. Read it only when the run's promoted result is not enough; " +
        'it can be large.',
    ),
});
export type WorkflowRunDetailInput = z.infer<typeof WorkflowRunDetailInputSchema>;

export const WorkflowRunTaskStatusSchema = z.enum([
  'scheduled',
  'running',
  'succeeded',
  'failed',
  'paused',
  'blocked',
  'skipped',
  'cancelled',
]);
export type WorkflowRunTaskStatus = z.infer<typeof WorkflowRunTaskStatusSchema>;

export const WorkflowTaskPriorFailureSchema = z.object({
  attempt: z.number().int().positive(),
  failedAt: z.string().datetime(),
  errorCode: z.string().optional(),
  errorClassification: z.string().optional(),
  errorRetryable: z.boolean().optional(),
  failureReason: z.string().optional(),
  /** Operator/Helmsman remediation note carried into the retry call. */
  remediationNote: z.string().max(2000).optional(),
});
export type WorkflowTaskPriorFailure = z.infer<typeof WorkflowTaskPriorFailureSchema>;

export const WorkflowRunDetailTaskSchema = z.object({
  taskId: z.string(),
  label: z.string(),
  status: WorkflowRunTaskStatusSchema,
  attempt: z.number().int().nonnegative(),
  workerSessionId: z.string().uuid().optional(),
  operationId: z.string().optional(),
  /**
   * Dispatch family this task lowers into (`WorkflowTaskSchema` invariant —
   * every task is exactly one of agent / operation / human). Derived from the
   * workflow definition via `inferTaskType`, with an `operationId`-based
   * fallback when the definition can't be resolved (drift). Distinct from
   * `operationId`: an `agent` task runs a whole sub-graph of ops and only
   * records its dispatch op (`ai.agent.turn`), while a `human` task records
   * no op at all. Surfaces use it to pick the right task-row icon — a
   * completed human row has no `operationId` and (post-resolution) no
   * `humanIntent`, so `taskType` is the only durable signal of its family.
   */
  taskType: z.enum(['agent', 'operation', 'human']).optional(),
  stepCount: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
  outputRef: z.string().optional(),
  inputRef: z.string().optional(),
  errorRef: z.string().optional(),
  failureReason: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  /** AflowError.code (e.g., `EGRESS_HTTP_400`, `PARENT_INPUTS_INVALID`). */
  errorCode: z.string().max(64).optional(),
  /** AflowError.classification slot — see `ErrorClassificationSchema`. */
  errorClassification: z.string().max(64).optional(),
  /** AflowError.retryable — the error-level hint. Orthogonal to the
   *  workflow-task-level `retryability` declaration. */
  errorRetryable: z.boolean().optional(),
  /** Wall-clock failure timestamp. Half of the CAS token for
   *  `retry_failed_task` (the other half is `attempt`). */
  failedAt: z.string().datetime().optional(),
  /** JSONB array — prior failure snapshots from earlier attempts. */
  priorFailures: z.array(WorkflowTaskPriorFailureSchema).optional(),
  suggestedAction: WorkflowSuggestedActionSchema.optional(),
  humanIntent: z.enum(['approve', 'collect']).optional(),
  /** JSON Schema driving `<SchemaForm>` for `intent: 'collect'`. */
  resolutionSchema: z.record(z.unknown()).optional(),
  /** Proposed op call preview for `intent: 'approve'`. */
  actionPreview: WorkflowHumanActionPreviewSchema.optional(),
  /** Surfaced resume contract (with live `pauseVersion` injected). */
  resumeContract: z.unknown().optional(),
  /** CAS token for `workflow.run.resume` (mirrors run-level pauseVersion). */
  pauseVersion: z.number().int().nonnegative().optional(),
  /** Failure blast-radius hint for reject UX. */
  failureMode: WorkflowHumanFailureModeSchema.optional(),
  /**
   * Resolved-decision trace for a `type: 'human'`, `intent: 'approve'`
   * task row that has been resolved (approve → `succeeded`; reject →
   * `failed`). Lets the parent agent confirm the operator decided —
   * and who/when — after an out-of-band resolution, instead of reporting
   * "it completed without pausing". Absent on unresolved rows, on
   * `collect` human tasks, and on non-human rows.
   */
  humanDecision: WorkflowHumanDecisionSchema.optional(),
});
export type WorkflowRunDetailTask = z.infer<typeof WorkflowRunDetailTaskSchema>;

export const WorkflowRunGraphFidelitySchema = z.enum(['full', 'degraded']);
export type WorkflowRunGraphFidelity = z.infer<typeof WorkflowRunGraphFidelitySchema>;

export const WorkflowRunDetailGraphTaskHintSchema = z.object({
  taskId: z.string().max(64),
  /** Display name from `WorkflowTaskSchema.name`. */
  label: z.string().max(120),
  taskType: z.enum(['agent', 'operation', 'human']).optional(),
  humanIntent: z.enum(['approve', 'collect']).optional(),
  operationId: z.string().optional(),
  /** Present when the task is guarded — display-ready `when` clauses. */
  when: WorkflowWhenViewSchema.optional(),
});
export type WorkflowRunDetailGraphTaskHint = z.infer<typeof WorkflowRunDetailGraphTaskHintSchema>;

export const WorkflowRunDetailGraphSchema = z.object({
  taskIds: z.array(z.string().max(64)).max(200),
  edges: z
    .array(
      z.object({
        from: z.string().max(64),
        to: z.string().max(64),
      }),
    )
    .max(500),
  /** Definition-sourced labels + icon hints for forward-DAG rows. */
  taskHints: z.array(WorkflowRunDetailGraphTaskHintSchema).max(200).optional(),
});
export type WorkflowRunDetailGraph = z.infer<typeof WorkflowRunDetailGraphSchema>;

/**
 * One task's recorded output, returned only when the request named that task.
 *
 * It is the only read of it an agent has: `/run/outputs/...` indexes the
 * calling session's own tool calls, and a workflow task's `outputRef` is a
 * payload ref no memory path resolves.
 */
export const WorkflowRunTaskOutputSchema = z.object({
  taskId: z.string(),
  output: z
    .unknown()
    .describe(
      'The output as it was recorded. When `truncated` is true this is the leading bytes of ' +
        'it as text, not the value.',
    ),
  truncated: z
    .boolean()
    .optional()
    .describe('True when the output was larger than the inline cap and only its start is here.'),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Byte length of the whole output. Present only when it was truncated.'),
});
export type WorkflowRunTaskOutput = z.infer<typeof WorkflowRunTaskOutputSchema>;

export const WorkflowRunDetailOutputSchema = z.object({
  run: z.object({
    runId: z.string().uuid(),
    workflowSlug: z.string(),
    workflowTitle: z.string().optional(),
    workflowRevision: z.number().int().nonnegative(),
    status: WorkflowRunStatusSchema,
    pauseVersion: z.number().int().nonnegative(),
    pausedReason: z.string().optional(),
    /**
     * Cancellation provenance — present iff `status === 'cancelled'` and the
     * cancel went through the harness. `'operator'` means a human stopped the
     * run deliberately: do not re-start it without explicit user instruction.
     */
    cancelledBy: WorkflowRunCancelActorSchema.optional(),
    /** Optional human-readable cancellation reason. */
    cancelReason: z.string().optional(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  }),
  tasks: z.array(WorkflowRunDetailTaskSchema),
  graphFidelity: WorkflowRunGraphFidelitySchema.optional(),
  workflowGraph: WorkflowRunDetailGraphSchema.optional(),
  activeWaiters: z.array(
    z.object({
      sessionId: z.string().uuid(),
      /** Absent when the session started the run without waiting on it. */
      stepExecutionId: z.string().uuid().optional(),
      registeredAt: z.string().datetime(),
    }),
  ),
  /**
   * Present iff status='paused'. The `surfaceWorkflowResumeContract`
   * helper validates the stored payload + injects the live pauseVersion
   * into `suggestedResumeCall.args.pauseVersion`, so the resume call is
   * actionable as-returned.
   */
  resumeContract: z.unknown().optional(),
  /**
   * Structured run result — promoted output values, primary score,
   * deterministic outcome checks, terminal summary, rendered-artifact
   * pointer, and declared caller guidance. Partial (output + summary only)
   * while the run is in flight; full on terminal runs. Same object the
   * wakeup envelope and the terminal `WorkflowRunUpdate` carry.
   */
  result: WorkflowRunResultSchema.optional(),
  /**
   * Present iff the request named a task by id AND that task has a recorded
   * output. A named task with nothing recorded yet is absent, not an error.
   */
  taskOutput: WorkflowRunTaskOutputSchema.optional(),
  originatingSessionId: z.string().uuid().optional(),
  tailCursor: z.string().optional(),
  presentation: StepOutputPresentationSchema.optional(),
});
export type WorkflowRunDetailOutput = z.infer<typeof WorkflowRunDetailOutputSchema>;
