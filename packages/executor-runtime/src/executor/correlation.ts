import type { StepJobMessage, StepResultMessage, SessionId } from '@aflow/schemas';

/**
 * Result correlation. The schema requires exactly one of
 * `sessionId` or `workflowExecution`; mirror whichever the job carries.
 */
export function buildResultCorrelation(
  job: StepJobMessage,
): Pick<StepResultMessage, 'sessionId' | 'workflowExecution'> {
  return job.workflowExecution !== undefined
    ? { workflowExecution: job.workflowExecution }
    : { sessionId: job.sessionId };
}

/**
 * Derive the execution-run id used for payload paths and ai-client
 * usage tracking.
 */
export function deriveExecutionRunId(job: StepJobMessage): SessionId {
  if (job.sessionId) return job.sessionId;
  if (job.workflowExecution) return job.workflowExecution.runId as SessionId;
  throw new Error(
    'StepJobMessage missing both sessionId and workflowExecution — schema invariant violated',
  );
}

/**
 * The unit of work this job is one attempt at, stable across every attempt at
 * it. Whatever a handler keys paid or otherwise unrepeatable work on has to
 * come from here rather than from `stepExecutionId`.
 *
 * A workflow task is named by its task id: both workflow dispatchers mint a
 * fresh worker session per attempt, so on that path the step execution id names
 * the attempt and not the work. A session-dispatched step is re-dispatched
 * under the step execution id it already had, which is that handle already. The
 * two are tagged apart so no future dispatcher can make one path's id read as
 * the other's.
 */
export function deriveLogicalExecutionId(job: StepJobMessage): string {
  return job.workflowExecution === undefined
    ? `step:${job.stepExecutionId}`
    : `task:${job.workflowExecution.taskId}`;
}
