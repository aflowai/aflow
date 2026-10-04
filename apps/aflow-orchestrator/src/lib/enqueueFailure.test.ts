/**
 * What an agent is told when a step cannot be enqueued.
 *
 * A dogfood run produced the worst version of this: every host call, legitimate
 * or not, came back as "operation failed due to a system error". The agent could
 * not tell a refusal from an outage, reported the lane as broken, and the actual
 * cause — an executor nobody had started — was in the orchestrator log alone.
 *
 * A missing executor now waits for its executor first (Plan 315 D21), so what
 * reaches here is an outage that outlasted the wait — and it says so whole.
 */
import { describe, expect, it } from 'vitest';

import { NoExecutorAvailableError } from '@aflow/redis';
import { errorContextFromUnknown, toAgentToolError, type StepType } from '@aflow/schemas';

import { describeEnqueueFailure, enqueueFailureResultError } from './enqueueFailure.js';

describe('no executor for the host lane', () => {
  const failure = describeEnqueueFailure(new NoExecutorAvailableError('host' as StepType));

  it('says what is wrong and what fixes it', () => {
    expect(failure.message).toContain('host executor');
    expect(failure.message).toMatch(/start/i);
  });

  it('reaches the agent as an outage to retry, never as a system error', () => {
    // Transient errors reach the agent compact, so the message above is the
    // run's and the operator's; the agent is told only that it may resolve.
    const shown = toAgentToolError(failure);
    expect(shown.message).not.toContain('system error');
    expect(shown.retry).toBe(true);
  });

  it('is the same transient outage as any lane, since a sleeping machine is one that returns', () => {
    expect(failure.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(failure.classification).toBe('transient');
    expect(failure.retryable).toBe(true);
  });
});

describe('no executor for the browser lane', () => {
  const failure = describeEnqueueFailure(new NoExecutorAvailableError('browser' as StepType));

  it('names the machine the browser runs on and how to start it', () => {
    expect(failure.message).toContain('host executor');
    expect(failure.message).toMatch(/browser/i);
    expect(failure.classification).toBe('transient');
    expect(toAgentToolError(failure).message).not.toContain('system error');
  });
});

describe('every other lane', () => {
  it('reads a missing executor as an outage worth retrying', () => {
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('ai' as StepType));
    expect(failure.classification).toBe('transient');
    expect(toAgentToolError(failure).retry).toBe(true);
  });
});

describe('the error itself', () => {
  it('is an AflowError, so a log tags it by its own code rather than as an unknown exception', () => {
    const logged = errorContextFromUnknown(new NoExecutorAvailableError('host' as StepType));
    expect(logged['errorCode']).toBe('EXECUTOR_UNAVAILABLE');
    expect(logged['errorClassification']).toBe('transient');
    expect(logged['errorRetryable']).toBe(true);
  });
});

describe('what the result payload carries', () => {
  it('keeps the classification of a missing executor, so the agent hears an outage, not a system error', () => {
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('ai' as StepType));
    const payload = enqueueFailureResultError(failure);
    expect(payload.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(payload.classification).toBe('transient');
    expect(payload.retryable).toBe(true);
  });
});
