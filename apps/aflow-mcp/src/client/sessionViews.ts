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
  };
  recentEvents?:
    | Array<{
        eventType?: string | undefined;
        data?: Record<string, unknown> | undefined;
        metadata?: Record<string, unknown> | undefined;
        stepExecutionId?: string | undefined;
        timestamp?: string | undefined;
      }>
    | undefined;
  currentStep?: DebugStepEntry | undefined;
  dynamicSteps?: DebugStepEntry[] | undefined;
  runtimeState?: Record<string, unknown> | undefined;
  agent?: Record<string, { lastDecision?: Record<string, unknown> }> | undefined;
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

export function buildStepSummaries(debug: SessionDebugResponse): StepSummary[] {
  const steps: StepSummary[] = [];

  if (debug.dynamicSteps && debug.dynamicSteps.length > 0) {
    for (const s of debug.dynamicSteps) {
      const entry: StepSummary = {
        step_id: s.stepId ?? 'unknown',
        status: s.status ?? 'unknown',
      };
      if (s.operation) entry.operation = s.operation;
      if (s.durationMs !== undefined) entry.duration_ms = s.durationMs;
      if (s.error?.message) entry.error = s.error.message;
      steps.push(entry);
    }
    return steps;
  }

  // Fallback: derive from recentEvents
  if (debug.recentEvents) {
    const stepMap = new Map<string, StepSummary>();
    for (const evt of debug.recentEvents) {
      const stepId = evt.data?.['stepId'] as string | undefined;
      if (!stepId) continue;

      const existing = stepMap.get(stepId) ?? {
        step_id: stepId,
        status: 'unknown',
      };

      const operation =
        (evt.metadata?.['operationId'] as string | undefined) ??
        (evt.data?.['operationId'] as string | undefined);
      if (operation) existing.operation = operation;

      const et = evt.eventType;
      if (et === 'StepScheduled') {
        if (existing.status === 'unknown') existing.status = 'SCHEDULED';
      } else if (et === 'StepStarted') {
        if (existing.status === 'unknown' || existing.status === 'SCHEDULED')
          existing.status = 'RUNNING';
      } else if (et === 'StepSucceeded') {
        existing.status = 'SUCCEEDED';
      } else if (et === 'StepFailed') {
        existing.status = 'FAILED';
        const errMsg =
          (evt.metadata?.['errorMessage'] as string | undefined) ??
          (evt.data?.['errorMessage'] as string | undefined);
        if (errMsg) existing.error = errMsg;
      } else if (et === 'StepPaused') {
        existing.status = 'PAUSED';
      }

      stepMap.set(stepId, existing);
    }
    return [...stepMap.values()];
  }

  return steps;
}
