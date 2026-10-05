/** Narrow projection for list views (no task rows, no learnings blob). */
export interface WorkflowRunSummary {
  id: string;
  spaceId: string;
  workflowSlug: string;
  runId: string;
  sessionId: string | null;
  status: string;
  workflowRevision: number;
  startedAt: Date;
  completedAt: Date | null;
  totalCostCents: number | null;
  totalTokens: number | null;
  pausedReason: string | null;
  pausedPayloadRef: string | null;
  pauseVersion: number;
  resumeAttemptCount: number;
  /** Cancellation provenance — 'operator' | 'system' | 'agent'; NULL unless cancelled via the harness. */
  cancelledBy: string | null;
  /** Optional human-readable cancellation reason. */
  cancelReason: string | null;
  learningCount: number;
  score: number | null;
  /** Frozen-mode marker (Plan 269 D5) — NULL for every production run. */
  evalBatchId: string | null;
  /** The plan node the run serves (Plan 322 D5). */
  planNodeId?: string;
}

/** Full run detail including task rows. */
export interface WorkflowRunDetail extends WorkflowRunSummary {
  evaluationJson: unknown;
  failureJson: unknown;
  learningsJson: unknown;
  schedulerCursorAt: Date | null;
  metadata: unknown;
  tasks: WorkflowTaskRow[];
}

/** Task row projection. */
export interface WorkflowTaskRow {
  id: string;
  runId: string;
  taskId: string;
  status: string;
  attempt: number;
  sessionId: string | null;
  workerSessionId: string | null;
  /** Set while a re-armed task is waiting to be claimed; cleared by the claim. */
  dispatchDeadlineAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
  costCents: number | null;
  metricsJson: unknown;
  summary: string | null;
  failureReason: string | null;
  outputRef: string | null;
  inputRef: string | null;
  reflectionJson: unknown;
  operationId: string | null;
  errorCode: string | null;
  errorClassification: string | null;
  errorRetryable: boolean | null;
  failedAt: Date | null;
  priorFailures: unknown;
  pollCycle: number;
}

/** Aggregate statistics for a workflow in a space. */
export interface RunStats {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  avgDurationMs: number | null;
}

export interface ActiveRunWithTaskCounts {
  runId: string;
  spaceId: string;
  workflowSlug: string;
  sessionId: string | null;
  status: string;
  startedAt: Date;
  completedAt?: Date | null;
  schedulerCursorAt: Date | null;
  totalTasks: number;
  succeededTasks: number;
  liveTasks: number;
  scheduledTasks: number;
  pausedTasks: number;
  /** The plan node the run serves (Plan 322 D5). */
  planNodeId?: string;
}

/** An active run in a space, and whether a conversation still owns it. */
export interface ActiveSpaceRun extends ActiveRunWithTaskCounts {
  /** Its `sessionId` names a Helmsman conversation that still owns it (`isReadersWork`). */
  drivenByLiveConversation: boolean;
}
