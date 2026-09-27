/**
 * Space-boundary invariant: spaceId is system-carried
 * from the originating session via the step job message into ExecutorContext —
 * never caller-supplied through operation input.
 */
import { describe, expect, it } from 'vitest';
import type { StepJobMessage } from '@aflow/schemas';
import { buildExecutionContext } from '../executor/buildContext.js';
import type { ExecutorDependencies, ExecutorLogger } from '../types.js';

const log: ExecutorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeDeps(): ExecutorDependencies {
  return {
    payloadStore: {
      retrieve: async () => ({}),
      store: async () => 'inline:e30=' as never,
      buildRef: () => 'inline:e30=' as never,
      exists: async () => false,
    } as never,
    redis: {} as never,
  } as never;
}

function makeJob(overrides: Partial<StepJobMessage>): StepJobMessage {
  return {
    messageVersion: 1,
    tenantId: 'a0000000-0000-0000-0000-000000000001',
    sessionId: 'b0000000-0000-0000-0000-000000000002',
    stepExecutionId: 'c0000000-0000-0000-0000-000000000003',
    stepId: 'render-card',
    stepType: 'ui',
    operationId: 'ui.artifact.render',
    attempt: 1,
    idempotencyKey: 'idem-1',
    inputRef: 'inline:e30=',
    traceId: 'trace-1',
    scheduledAtMs: 1,
    ...overrides,
  } as StepJobMessage;
}

describe('space-boundary invariant', () => {
  it('exposes the job-stamped spaceId on ExecutorContext', async () => {
    const spaceId = 'd0000000-0000-0000-0000-000000000004';
    const ctx = await buildExecutionContext(makeDeps(), makeJob({ spaceId }), log);
    expect(ctx.spaceId).toBe(spaceId);
  });

  it('omits spaceId (not undefined-valued) when the job lacks it — handlers fail loud', async () => {
    const ctx = await buildExecutionContext(makeDeps(), makeJob({}), log);
    expect(ctx.spaceId).toBeUndefined();
    expect('spaceId' in ctx).toBe(false);
  });
});
