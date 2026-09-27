/**
 * What an agent is told when a step cannot be enqueued.
 *
 * A dogfood run produced the worst version of this: every host call, legitimate
 * or not, came back as "operation failed due to a system error". The agent could
 * not tell a refusal from an outage, reported the lane as broken, and the actual
 * cause — an executor nobody had started — was in the orchestrator log alone.
 */
import { describe, expect, it } from 'vitest';

import { NoExecutorAvailableError } from '@aflow/redis';
import { toAgentToolError, type StepType } from '@aflow/schemas';

import { describeEnqueueFailure, enqueueFailureResultError } from './enqueueFailure.js';

describe('no executor for the host lane', () => {
  const failure = describeEnqueueFailure(new NoExecutorAvailableError('host' as StepType));

  it('says what is wrong and what fixes it', () => {
    const shown = toAgentToolError(failure);
    expect(shown.message).toContain('host executor');
    expect(shown.message).toMatch(/start/i);
    // The words the agent must not be given instead.
    expect(shown.message).not.toContain('system error');
  });

  it('does not invite a retry that cannot succeed', () => {
    // The executor is on the operator's machine. Nothing the agent does brings
    // it up, so "may resolve if retried" is advice to wait for something that
    // will not happen on its own.
    expect(toAgentToolError(failure).retry).toBe(false);
    expect(failure.retryable).toBe(false);
  });

  it('reports nothing was attempted, since dispatch never happened', () => {
    expect(failure.message).toMatch(/nothing was attempted/i);
  });
});

describe('every other lane', () => {
  it('still reads a missing executor as an outage worth retrying', () => {
    // Those executors are the appliance's own, so their absence is
    // infrastructure and the agent waiting is the right response.
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('ai' as StepType));
    expect(failure.classification).toBe('transient');
    expect(toAgentToolError(failure).retry).toBe(true);
  });
});

describe('what the result payload carries', () => {
  it('still says nothing on a retryable outage, which keeps it out of the retry budget', () => {
    // Tempting to carry the classification here so the agent hears "temporary,
    // may resolve" instead of "system error". It would also make it true that
    // `shouldRetry` fires — that check wants `retryable === true` and a
    // classification in its retryable set — so one executor going down would
    // enter every step behind it into the retry budget at once.
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('ai' as StepType));
    const payload = enqueueFailureResultError(failure);
    expect(payload.classification).toBeUndefined();
    expect(payload.retryable).toBeUndefined();
  });

  it('carries both on a non-retryable one, which is how the host case speaks', () => {
    // A lane with something to say says it by not being retryable, which is the
    // branch that keeps its classification and therefore its message.
    const failure = describeEnqueueFailure(new NoExecutorAvailableError('host' as StepType));
    const payload = enqueueFailureResultError(failure);
    expect(payload.classification).toBe('configuration');
    expect(payload.retryable).toBe(false);
  });
});
