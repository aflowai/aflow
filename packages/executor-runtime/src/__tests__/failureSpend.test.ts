/**
 * A failed step that spent money reports what it spent: the cost a handler
 * attaches to its failure rides the result message as `usage`, as a
 * success's does.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PayloadRef, StepJobMessage } from '@aflow/schemas';
import type { ExecutorContext, ExecutorDependencies } from '../types.js';

const { addStepResult } = vi.hoisted(() => ({
  addStepResult: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@aflow/redis', () => ({ addStepResult, ackStepJob: vi.fn() }));

import { emitResult } from '../executor/resultReporting.js';
import { failureWithError } from '../results.js';

const JOB = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  sessionId: '00000000-0000-0000-0000-0000000000b1',
  stepExecutionId: '00000000-0000-0000-0000-0000000000c1',
  stepType: 'ai',
  stepId: 'probe',
  attempt: 1,
  operationId: 'ai.model.probe_reasoning',
  idempotencyKey: 'idem-1',
  traceId: '0123456789abcdef0123456789abcdef',
  inputRef: 'inline:e30=',
} as unknown as StepJobMessage;

const spend = {
  provider: 'google',
  model: 'gemini-test',
  promptTokens: 80,
  completionTokens: 120,
  totalTokens: 200,
  promptCostUsd: 0.1,
  completionCostUsd: 0.15,
  totalCostUsd: 0.25,
};

const error = {
  code: 'REASONING_PROBE_NOTHING_MEASURED',
  message: 'nothing measured',
  classification: 'content_policy' as const,
  retryable: false,
  timestamp: new Date().toISOString(),
};

describe('failure spend', () => {
  it('emits the cost a failure carries as the result usage', async () => {
    const ctx = {
      writePayload: vi.fn().mockResolvedValue('inline:error' as PayloadRef),
    } as unknown as ExecutorContext;
    const result = await failureWithError(ctx, error, { costJson: spend });
    expect(result.costJson).toEqual(spend);

    const deps = {
      redis: {},
      payloadStore: { store: vi.fn().mockResolvedValue('inline:error') },
    } as unknown as ExecutorDependencies;
    await emitResult(deps, JOB, result, 5);

    expect(addStepResult).toHaveBeenCalledWith(
      deps.redis,
      expect.objectContaining({ status: 'FAILED', usage: expect.objectContaining(spend) }),
    );
  });

  it('carries no cost on a failure that spent nothing', async () => {
    const ctx = {
      writePayload: vi.fn().mockResolvedValue('inline:error' as PayloadRef),
    } as unknown as ExecutorContext;
    const result = await failureWithError(ctx, error);
    expect(result).not.toHaveProperty('costJson');
  });
});
