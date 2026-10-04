/**
 * Loosely-typed views over the platform's session read endpoints
 * (GET /v1/sessions/:id and /v1/sessions/:id/debug), shared by the
 * tools that poll them.
 */

export interface SessionRunStatusView {
  sessionId: string;
  status: string;
  updatedAt?: string | undefined;
  outputRef?: string | undefined;
  error?: { title?: string; message?: string; code?: string } | undefined;
  errorRef?: string | undefined;
  requiredInput?:
    | {
        stepExecutionId: string;
        prompt?: string | undefined;
        missingVariables?:
          | Array<{
              variableId: string;
              name?: string;
              description?: string;
              responseOptions?: {
                type: string;
                options: Array<{ value: string; label?: string }>;
              };
            }>
          | undefined;
      }
    | undefined;
  currentStepId?: string | undefined;
  blockedOn?:
    | { kind: 'workflow_run'; runId: string }
    | { kind: 'child_session'; sessionIds: string[] }
    | { kind: 'user_input'; stepExecutionId: string }
    | null
    | undefined;
}

export interface DebugStepEntry {
  stepExecutionId?: string | undefined;
  stepId?: string | undefined;
  operation?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
  error?: { message?: string } | undefined;
  durationMs?: number | undefined;
}

export interface DebugCurrentStep {
  stepExecutionId?: string | undefined;
  stepId?: string | undefined;
  operationId?: string | undefined;
  status?: string | undefined;
  errorRef?: string | undefined;
}

export interface DebugEvent {
  eventType?: string | undefined;
  data?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  stepExecutionId?: string | undefined;
  timestamp?: string | undefined;
  usageSummary?:
    { totalPromptTokens: number; totalCompletionTokens: number; totalTokens: number } | undefined;
}

export interface SessionDebugResponse {
  session: {
    sessionId: string;
    status: string;
    target?:
      | { kind: 'platform-role'; systemRole: string }
      | { kind: 'custom-agent'; agentId: string }
      | { kind: 'inline-agent'; definitionRef: string }
      | undefined;
    durationMs?: number | undefined;
    outputRef?: string | undefined;
    errorRef?: string | undefined;
    requiredInput?: SessionRunStatusView['requiredInput'];
    blockedOn?: SessionRunStatusView['blockedOn'];
  };
  /** The newest events, oldest first. */
  recentEvents?: DebugEvent[] | undefined;
  currentStep?: DebugCurrentStep | undefined;
  dynamicSteps?: DebugStepEntry[] | undefined;
  /** How far back the dynamic steps' statuses were read, and whether that placed them all. */
  stepEvents?: { read: number; complete: boolean } | undefined;
  hotState?: 'present' | 'expired' | 'corrupt' | undefined;
  runtimeState?: Record<string, unknown> | undefined;
  refs?: Record<string, string | undefined> | undefined;
  warnings?: string[] | undefined;
}

export interface StepSummary {
  step_id: string;
  operation?: string;
  status: string;
  duration_ms?: number;
  error?: string;
}

/** A step whose state can no longer be read: no event left records it and no hot state holds it. */
export const STEP_HOT_STATE_EXPIRED = 'HOT_STATE_EXPIRED';
/** A step whose status lies further back than the events read for it. */
export const STEP_STATUS_NOT_READ = 'NOT_READ';

const STATUS_OF_EVENT: Readonly<Record<string, string>> = {
  StepScheduled: 'SCHEDULED',
  StepStarted: 'RUNNING',
  StepSucceeded: 'SUCCEEDED',
  StepFailed: 'FAILED',
  StepPaused: 'PAUSED',
};

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The session's steps, oldest first. From the hot state's step list while it
 * is held; once it has expired, from the steps the newest events name.
 */
export function buildStepSummaries(debug: SessionDebugResponse): StepSummary[] {
  if (debug.dynamicSteps && debug.dynamicSteps.length > 0) {
    const unplaced =
      debug.stepEvents?.complete === false ? STEP_STATUS_NOT_READ : STEP_HOT_STATE_EXPIRED;
    return debug.dynamicSteps.flatMap((s) => {
      if (!s.stepId) return [];
      const entry: StepSummary = { step_id: s.stepId, status: s.status ?? unplaced };
      if (s.operation) entry.operation = s.operation;
      if (s.durationMs !== undefined) entry.duration_ms = s.durationMs;
      if (s.error?.message) entry.error = s.error.message;
      return [entry];
    });
  }

  const stepMap = new Map<string, StepSummary>();
  for (const evt of debug.recentEvents ?? []) {
    const stepId = stringField(evt.data, 'stepId');
    if (!stepId) continue;
    const existing = stepMap.get(stepId) ?? { step_id: stepId, status: STEP_STATUS_NOT_READ };
    const operation =
      stringField(evt.metadata, 'operationId') ?? stringField(evt.data, 'operationId');
    if (operation) existing.operation = operation;
    const status = evt.eventType === undefined ? undefined : STATUS_OF_EVENT[evt.eventType];
    if (status !== undefined) {
      existing.status = status;
      if (status === 'FAILED') {
        const message =
          stringField(evt.metadata, 'errorMessage') ?? stringField(evt.data, 'errorMessage');
        if (message) existing.error = message;
      }
    }
    stepMap.set(stepId, existing);
  }
  return [...stepMap.values()];
}
