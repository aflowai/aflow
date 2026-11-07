import type {
  WorkflowResumeContract,
  WorkflowRunDetailOutput,
  WorkflowRunResult,
} from '@aflow/schemas';
import { WorkflowResumeContractSchema, isTerminalRunStatus } from '@aflow/schemas';
import { HARNESS_RUN_OPERATION } from './op-labels.js';
import type { WorkflowRunSurfaceState, WorkflowSurfaceTaskState } from './types.js';

/** The run detail (`GET /spaces/:spaceId/workflow-runs/:runId`) the surface reads. */
export type WorkflowRunDetailResponse = WorkflowRunDetailOutput;

function extractAllowedResumeModes(contract: unknown): string[] | undefined {
  if (!contract || typeof contract !== 'object') return undefined;
  const modes = (contract as { allowedResumeModes?: unknown }).allowedResumeModes;
  if (!Array.isArray(modes)) return undefined;
  const strs = modes.filter((m): m is string => typeof m === 'string');
  return strs.length > 0 ? strs : undefined;
}

// Strict parse for the rich `<PauseExplanation>` render — needs `pauseCause`
// + `resumePrompt`. Returns undefined on a partial/legacy contract (the
// surface then shows the coarse `pausedReason` fallback). Distinct from
// `extractAllowedResumeModes`, which stays loose so resume controls gate even
// on a minimal contract.
function parseResumeContract(contract: unknown): WorkflowResumeContract | undefined {
  if (!contract || typeof contract !== 'object') return undefined;
  const parsed = WorkflowResumeContractSchema.safeParse(contract);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Split a run result into the surface's two fields: the output bag goes to
 * `outputs`, the rest stays on `result`. Holding the bag once is what keeps a
 * serialized run state from carrying it twice.
 */
export function splitRunResult(result: WorkflowRunResult | undefined): {
  result?: WorkflowRunResult;
  outputs?: Record<string, unknown>;
} {
  if (!result) return {};
  const { output, ...rest } = result;
  return { result: rest, ...(output ? { outputs: output } : {}) };
}

/**
 * The run's output bag, wherever the state holds it. A state from a writer
 * that kept the bag on `result.output` renders the same rows.
 */
export function runSurfaceOutputs(
  state: Pick<WorkflowRunSurfaceState, 'outputs' | 'result'>,
): Record<string, unknown> | undefined {
  return state.outputs ?? state.result?.output;
}

/**
 * Whether a run card has to read the run detail before it can render.
 *
 * The live event stream does not carry `workflowGraph` / `graphFidelity`;
 * only the run detail resolves the workflow definition. A state that has the
 * graph, and is not a sparse seed, mounts as it stands.
 */
export function runSurfaceNeedsDetailRead(state: WorkflowRunSurfaceState | undefined): boolean {
  return state === undefined || state.needsHydration || state.graphFidelity === undefined;
}

/**
 * Convert the detail DTO into reducer surface state. `nowMs` stamps
 * `lastMutatedAtMs` on every task so stalled-detection clocks rows from the
 * hydration moment (a rehydrate counts as a fresh mutation).
 */
export function workflowRunDetailToSurfaceState(
  detail: WorkflowRunDetailResponse,
  nowMs: number,
): WorkflowRunSurfaceState {
  const tasks: Record<string, WorkflowSurfaceTaskState> = {};
  for (const t of detail.tasks) {
    tasks[t.taskId] = {
      taskId: t.taskId,
      label: t.label,
      status: t.status,
      attempt: t.attempt,
      ...(t.workerSessionId ? { workerSessionId: t.workerSessionId } : {}),
      ...(t.operationId ? { operationId: t.operationId } : {}),
      ...(t.taskType ? { taskType: t.taskType } : {}),
      ...(t.stepCount != null ? { stepCount: t.stepCount } : {}),
      ...(t.totalTokens != null ? { totalTokens: t.totalTokens } : {}),
      ...(t.startedAt ? { startedAt: t.startedAt } : {}),
      ...(t.completedAt ? { completedAt: t.completedAt } : {}),
      ...(t.failureReason ? { failureReason: t.failureReason } : {}),
      ...(t.errorCode
        ? {
            failure: {
              code: t.errorCode,
              classification: t.errorClassification ?? 'unknown',
              retryable: t.errorRetryable ?? false,
            },
          }
        : {}),
      ...(t.inputRef ? { inputRef: t.inputRef } : {}),
      ...(t.outputRef ? { outputRef: t.outputRef } : {}),
      ...(t.errorRef ? { errorRef: t.errorRef } : {}),
      ...(t.summary ? { summary: t.summary } : {}),
      ...(t.humanIntent ? { humanIntent: t.humanIntent } : {}),
      ...(t.humanDecision ? { humanDecision: t.humanDecision } : {}),
      ...(t.resolutionSchema ? { resolutionSchema: t.resolutionSchema } : {}),
      ...(t.actionPreview
        ? { actionPreview: { op: t.actionPreview.op, input: t.actionPreview.input ?? null } }
        : {}),
      ...(t.pauseVersion !== undefined ? { pauseVersion: t.pauseVersion } : {}),
      ...(t.failureMode ? { failureMode: t.failureMode } : {}),
      lastMutatedAtMs: nowMs,
    };
  }
  const status = detail.run.status;
  const resumeContract = parseResumeContract(detail.resumeContract);
  const allowedResumeModes = extractAllowedResumeModes(detail.resumeContract);
  return {
    runId: detail.run.runId,
    slug: detail.run.workflowSlug,
    ...(detail.run.workflowTitle ? { workflowTitle: detail.run.workflowTitle } : {}),
    status,
    pauseVersion: detail.run.pauseVersion,
    ...(detail.run.pausedReason ? { pausedReason: detail.run.pausedReason } : {}),
    ...(allowedResumeModes ? { allowedResumeModes } : {}),
    ...(resumeContract ? { resumeContract } : {}),
    startedAt: detail.run.startedAt,
    ...(detail.run.completedAt ? { completedAt: detail.run.completedAt } : {}),
    tasks,
    ...(detail.graphFidelity ? { graphFidelity: detail.graphFidelity } : {}),
    ...(detail.workflowGraph ? { workflowGraph: detail.workflowGraph } : {}),
    ...splitRunResult(detail.result),
    isFrozen: isTerminalRunStatus(status),
    needsHydration: false,
  };
}

/**
 * Inline refs longer than this stay out of the mount snapshot unless the card
 * reads them on mount. Matches the compact `workflow.run.detail` projection.
 */
export const MOUNT_INLINE_REF_MAX = 1500;

function isLargeInlineRef(ref: string | undefined): boolean {
  return ref !== undefined && ref.startsWith('inline:') && ref.length > MOUNT_INLINE_REF_MAX;
}

/**
 * The task as the mount snapshot carries it.
 *
 * An `inline:` ref is the payload itself, so a run's refs are most of its
 * detail's bytes. The card reads a task's refs in two places only: the
 * harness card, which renders on mount, and the execution panel of an
 * operation task, which renders when the operator opens it. So:
 *   - a non-operation task keeps no refs, because nothing on the card reads them
 *   - a harness task keeps every ref, because its card reads them on mount
 *   - any other operation task keeps pointer refs and small inline ones, and marks the rest `refsElided`
 */
export function projectTaskForMount(task: WorkflowSurfaceTaskState): WorkflowSurfaceTaskState {
  if (task.inputRef === undefined && task.outputRef === undefined && task.errorRef === undefined) {
    return task;
  }
  if (task.taskType !== 'operation') {
    const rest = { ...task };
    delete rest.inputRef;
    delete rest.outputRef;
    delete rest.errorRef;
    return rest;
  }
  if (task.operationId === HARNESS_RUN_OPERATION) return task;
  const elide = {
    inputRef: isLargeInlineRef(task.inputRef),
    outputRef: isLargeInlineRef(task.outputRef),
    errorRef: isLargeInlineRef(task.errorRef),
  };
  if (!elide.inputRef && !elide.outputRef && !elide.errorRef) return task;
  const projected: WorkflowSurfaceTaskState = { ...task, refsElided: true };
  if (elide.inputRef) delete projected.inputRef;
  if (elide.outputRef) delete projected.outputRef;
  if (elide.errorRef) delete projected.errorRef;
  return projected;
}

/** The run as the mount snapshot carries it — see `projectTaskForMount`. */
export function projectRunForMount(state: WorkflowRunSurfaceState): WorkflowRunSurfaceState {
  const tasks: Record<string, WorkflowSurfaceTaskState> = {};
  for (const [taskId, task] of Object.entries(state.tasks)) {
    tasks[taskId] = projectTaskForMount(task);
  }
  // `result.output` supersedes the live bag, as it does in the reducer.
  const split = splitRunResult(state.result);
  const outputs = split.outputs ?? state.outputs;
  return {
    ...state,
    ...(split.result ? { result: split.result } : {}),
    ...(outputs ? { outputs } : {}),
    tasks,
  };
}
