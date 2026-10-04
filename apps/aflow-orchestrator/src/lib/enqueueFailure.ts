/**
 * What a failed enqueue means, in one place, for every dispatch path that funnels
 * through `addStepJob`.
 *
 * The distinction that matters is refusal versus outage. A lane breaker that is
 * open is a decision, and it has to reach the agent as one — `toAgentToolError`
 * turns a non-retryable `permission` error into `signal_blocked`. An executor
 * that is missing is an outage, and no dispatch path fails on one at once: the
 * work waits for its executor (`executorWait.ts`), and only a wait that spends
 * its looks reaches here as a failure.
 */
import { CodeLaneDisabledError, type AflowError, type ErrorClassification } from '@aflow/schemas';
import { NoExecutorAvailableError } from '@aflow/redis';

export interface StepResultErrorPayload {
  code: string;
  message: string;
  classification: ErrorClassification;
  retryable: boolean;
  timestamp: string;
}

export function describeEnqueueFailure(error: unknown): AflowError {
  if (error instanceof CodeLaneDisabledError) return error.toAflowError();
  if (error instanceof NoExecutorAvailableError) return error.toAflowError();
  return {
    code: 'ENQUEUE_FAILED',
    message: `Job enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
    classification: 'internal',
    retryable: false,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The `error` field of the synthetic FAILED result, its classification carried
 * through: `applyResult` reads an absent one as `internal`, which tells the
 * agent only that a system error happened. A missing executor is carried as
 * the transient, retryable failure it is, because it arrives here only after
 * its wait — so the retry it enters is one step's, not every step's behind an
 * executor that went away a moment ago.
 */
export function enqueueFailureResultError(failure: AflowError): StepResultErrorPayload {
  return {
    code: failure.code,
    message: failure.message,
    classification: failure.classification,
    retryable: failure.retryable,
    timestamp: failure.timestamp,
  };
}
