import { describe, it, expect } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import type { PayloadRef } from '@aflow/schemas';

import { ComputeExecHandler } from '../computeExecHandler.js';

/**
 * The outer (executor-level) timeout for a sandbox step must exceed the
 * sandbox's OWN docker wall-clock, or processJob's withTimeout and the watchdog
 * reap the step before the container's graceful timeout returns. resolveTimeoutMs
 * derives that outer bound from the op's requested wall-clock (explicit limit or
 * preset) plus a fixed margin.
 */
const MARGIN_MS = 60_000;

function ctxFor(input: unknown): ExecutorContext {
  return {
    job: { inputRef: 'inline:input' as PayloadRef },
    readPayload: async (ref: PayloadRef) => (ref === 'inline:input' ? input : undefined),
  } as unknown as ExecutorContext;
}

describe('ComputeExecHandler.resolveTimeoutMs', () => {
  const handler = new ComputeExecHandler();

  it('uses the explicit limit + margin', async () => {
    const ms = await handler.resolveTimeoutMs(
      ctxFor({ runtime: 'python3-ml', code: 'x', limits: { timeoutSeconds: 900 } }),
    );
    expect(ms).toBe(900_000 + MARGIN_MS);
  });

  it('uses the runtime preset wall-clock when no explicit limit is set', async () => {
    const ms = await handler.resolveTimeoutMs(
      ctxFor({ runtime: 'python3-ml', code: 'x', runtimePreset: 'ml-training' }),
    );
    expect(ms).toBe(1_800_000 + MARGIN_MS);
  });

  it('an explicit limit overrides the preset', async () => {
    const ms = await handler.resolveTimeoutMs(
      ctxFor({
        runtime: 'python3-ml',
        code: 'x',
        runtimePreset: 'ml-training',
        limits: { timeoutSeconds: 600 },
      }),
    );
    expect(ms).toBe(600_000 + MARGIN_MS);
  });

  it('falls back to the schema default when neither preset nor limit is set', async () => {
    const ms = await handler.resolveTimeoutMs(ctxFor({ runtime: 'python3', code: 'x' }));
    expect(ms).toBe(180_000 + MARGIN_MS);
  });

  it('returns undefined for unparseable input (falls back to step/default timeout)', async () => {
    const ms = await handler.resolveTimeoutMs(ctxFor({ not: 'a valid compute input' }));
    expect(ms).toBeUndefined();
  });
});
