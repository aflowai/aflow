import { describe, expect, it } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { AiHandler } from './ai/AiHandler.js';

const handler = new AiHandler({ payloadStore: {} as never });

function ctx(
  operationId: string,
  executionTimeoutMs?: number,
  input: Record<string, unknown> = {},
): ExecutorContext {
  return {
    operationId,
    job: {
      stepExecutionId: `step-${operationId}-${String(input['model'])}`,
      attempt: 1,
      inputRef: 'inline:e30=',
    },
    readPayload: () => Promise.resolve(input),
    stepDefinition:
      executionTimeoutMs !== undefined ? { timeout: { executionTimeoutMs } } : undefined,
  } as unknown as ExecutorContext;
}

describe('AiHandler.resolveTimeoutMs', () => {
  it('agent turns get a progress-aware spec — a live stream is never reaped on elapsed time', async () => {
    const spec = await handler.resolveTimeoutMs(ctx('ai.agent.turn'));
    expect(spec).toBeDefined();
    expect(typeof spec).not.toBe('number');
    const { idleMs, maxMs } = spec as { idleMs: number; maxMs: number };
    // The stall window is the liveness signal; the ceiling only bounds runaway
    // generation, so it must be a large multiple of the idle window.
    expect(idleMs).toBeGreaterThan(0);
    expect(maxMs).toBeGreaterThan(idleMs * 2);
  });

  it('an explicit step-definition timeout stays a flat wall clock', async () => {
    // An operator who set a number meant a number.
    expect(await handler.resolveTimeoutMs(ctx('ai.agent.turn', 45_000))).toBeUndefined();
  });

  it('non-agent operations keep the executor default', async () => {
    expect(await handler.resolveTimeoutMs(ctx('ai.text.generate'))).toBeUndefined();
  });

  it('a model on this computer may read its prompt for minutes before its first token', async () => {
    const cloud = (await handler.resolveTimeoutMs(
      ctx('ai.agent.turn', undefined, { model: 'glm-pro' }),
    )) as {
      idleMs: number;
    };
    const local = (await handler.resolveTimeoutMs(
      ctx('ai.text.generate', undefined, { model: 'gemma-local' }),
    )) as { idleMs: number; maxMs: number };
    expect(local.idleMs).toBeGreaterThan(cloud.idleMs);
    expect(local.maxMs).toBeGreaterThan(local.idleMs);
  });
});

describe('AiHandler.admit', () => {
  it('asks nothing of a step whose model is served elsewhere', async () => {
    const withRedis = new AiHandler({ payloadStore: {} as never, redis: {} as never });
    const waiting = {
      signal: new AbortController().signal,
      waiting: () => undefined,
      stillWaiting: () => undefined,
    };
    expect(
      await withRedis.admit(ctx('ai.agent.turn', undefined, { model: 'glm-pro' }), waiting),
    ).toBeUndefined();
  });
});
