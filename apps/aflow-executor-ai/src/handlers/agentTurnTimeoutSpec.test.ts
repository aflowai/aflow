import { describe, expect, it } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { AiHandler } from './ai/AiHandler.js';

const handler = new AiHandler({ payloadStore: {} as never });

function ctx(operationId: string, executionTimeoutMs?: number): ExecutorContext {
  return {
    operationId,
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
});
