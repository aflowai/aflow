/**
 * What a failed enqueue means, in one place, for every dispatch path that funnels
 * through `addStepJob`.
 *
 * The distinction that matters is refusal versus outage. An executor that is
 * merely absent is transient infrastructure. A lane breaker that is open is a
 * decision, and it has to reach the agent as one — `toAgentToolError` turns a
 * non-retryable `permission` error into `signal_blocked`, while anything opaque
 * reads as a platform fault worth waiting out and retrying.
 */
import { CodeLaneDisabledError, type AflowError, type ErrorClassification } from '@aflow/schemas';
import { NoExecutorAvailableError } from '@aflow/redis';

export interface StepResultErrorPayload {
  code: string;
  message: string;
  classification?: ErrorClassification;
  retryable?: boolean;
  timestamp: string;
}

export function describeEnqueueFailure(error: unknown): AflowError {
  if (error instanceof CodeLaneDisabledError) return error.toAflowError();

  const noExecutor = error instanceof NoExecutorAvailableError;

  // The host lane is the one whose executor is not ours to keep running. It
  // lives on the operator's own machine, outside the appliance, and is off
  // whenever they have not started it — an ordinary state, not an outage, and
  // one no amount of retrying resolves. Read as transient it becomes "temporary
  // issue, may resolve if retried", which is advice to wait for something that
  // will not happen; `configuration` keeps the message and stops the retry.
  if (noExecutor && error.stepType === 'host') {
    return {
      code: 'HOST_EXECUTOR_NOT_CONNECTED',
      message:
        'No host executor is connected. This lane runs on the operator machine rather than in ' +
        'the appliance, so folders are reachable only while they have it running — ' +
        '`yarn workspace @aflow/aflow-executor-host start` on that machine. Nothing was ' +
        'attempted, and retrying will not help until it is up.',
      classification: 'configuration',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }

  // The browser is served by the same executor on the operator's machine, so
  // its absence is the same ordinary state and gets the same reading.
  if (noExecutor && error.stepType === 'browser') {
    return {
      code: 'BROWSER_EXECUTOR_NOT_CONNECTED',
      message:
        'No browser is connected. The browser runs on the operator machine through its host ' +
        'executor rather than in the appliance, so pages open only while they have it running — ' +
        '`yarn workspace @aflow/aflow-executor-host start` on that machine. Nothing was ' +
        'attempted, and retrying will not help until it is up.',
      classification: 'configuration',
      retryable: false,
      timestamp: new Date().toISOString(),
    };
  }

  return {
    code: noExecutor ? 'EXECUTOR_UNAVAILABLE' : 'ENQUEUE_FAILED',
    message: `Job enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
    classification: noExecutor ? 'transient' : 'internal',
    retryable: noExecutor,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The `error` field of the synthetic FAILED result. A failure nobody should
 * retry carries its classification through; `applyResult` defaults an absent one
 * to `internal`, which is the right reading for an outage and the wrong one for
 * a refusal.
 */
export function enqueueFailureResultError(failure: AflowError): StepResultErrorPayload {
  if (failure.retryable) {
    // Dropped deliberately, and it costs something real: `applyResult` reads an
    // absent classification as `internal`, so the agent is told only that a
    // system error happened. The alternative costs more. `shouldRetry` fires on
    // `retryable === true` AND a classification in its retryable set, so
    // carrying both would enter every step whose executor is missing into the
    // retry budget at once — one outage becoming a retry herd across every run
    // in flight. A lane that wants to say more says it before this point, by
    // not being retryable; that is what the host branch above does.
    return { code: failure.code, message: failure.message, timestamp: failure.timestamp };
  }
  return {
    code: failure.code,
    message: failure.message,
    classification: failure.classification,
    retryable: failure.retryable,
    timestamp: failure.timestamp,
  };
}
