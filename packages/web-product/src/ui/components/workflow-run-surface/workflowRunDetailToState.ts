import type { WorkflowResumeContract, WorkflowRunResult } from '@aflow/schemas';
import { WorkflowResumeContractSchema } from '@aflow/schemas';
import type {
  WorkflowRunSurfaceState,
  WorkflowSurfaceGraph,
  WorkflowSurfaceGraphFidelity,
  WorkflowSurfaceRunStatus,
  WorkflowSurfaceTaskState,
} from '../../lib/types.js';

export interface WorkflowRunDetailResponse {
  run: {
    runId: string;
    workflowSlug: string;
    workflowTitle?: string;
    status: string;
    pauseVersion: number;
    pausedReason?: string;
    startedAt: string;
    completedAt?: string;
  };
  tasks: Array<{
    taskId: string;
    label: string;
    status: string;
    attempt: number;
    workerSessionId?: string;
    operationId?: string;
    taskType?: 'agent' | 'operation' | 'human';
    stepCount?: number;
    totalTokens?: number;
    startedAt?: string;
    completedAt?: string;
    failureReason?: string;
    errorCode?: string;
    errorClassification?: string;
    errorRetryable?: boolean;
    inputRef?: string;
    outputRef?: string;
    errorRef?: string;
    summary?: string;
    humanIntent?: 'approve' | 'collect';
    humanDecision?: {
      decision: 'approved' | 'rejected';
      decidedAt?: string;
      decidedBy?: string;
      comment?: string;
    };
    resolutionSchema?: Record<string, unknown>;
    actionPreview?: { op: string; input: unknown };
    pauseVersion?: number;
    failureMode?: 'isolate' | 'cancel_siblings';
  }>;
  graphFidelity?: WorkflowSurfaceGraphFidelity;
  workflowGraph?: WorkflowSurfaceGraph;
  /** Structured run result (promoted outputs, score, outcome checks, …). */
  result?: WorkflowRunResult;
  originatingSessionId?: string;
  tailCursor?: string;
  resumeContract?: unknown;
}

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

export const TERMINAL_RUN_STATUSES = new Set<string>(['completed', 'failed', 'cancelled']);

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
      status: t.status as WorkflowSurfaceTaskState['status'],
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
      ...(t.actionPreview ? { actionPreview: t.actionPreview } : {}),
      ...(t.pauseVersion !== undefined ? { pauseVersion: t.pauseVersion } : {}),
      ...(t.failureMode ? { failureMode: t.failureMode } : {}),
      lastMutatedAtMs: nowMs,
    };
  }
  const status = detail.run.status as WorkflowSurfaceRunStatus;
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
    ...(detail.result ? { result: detail.result } : {}),
    ...(detail.result?.output ? { outputs: detail.result.output } : {}),
    isFrozen: TERMINAL_RUN_STATUSES.has(status),
    needsHydration: false,
  };
}

export async function fetchWorkflowRunSurfaceState(
  spaceId: string,
  runId: string,
  nowMs: number,
): Promise<WorkflowRunSurfaceState | null> {
  try {
    const res = await fetch(`/api/spaces/${spaceId}/workflow-runs/${runId}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) return null;
    const detail = (await res.json()) as WorkflowRunDetailResponse;
    return workflowRunDetailToSurfaceState(detail, nowMs);
  } catch {
    return null;
  }
}
