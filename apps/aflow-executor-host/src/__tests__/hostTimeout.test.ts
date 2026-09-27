/**
 * Contract: a streaming host job is reaped for silence, never for taking the
 * time its own ceiling allows. Everything else keeps the executor's flat clock.
 */
import type { ExecutorContext } from '@aflow/executor-runtime';
import { describe, expect, it } from 'vitest';

import {
  HOST_OUTER_TIMEOUT_MARGIN_MS,
  HOST_STREAM_IDLE_MS,
  resolveHostTimeout,
} from '../handlers/hostTimeout.js';

function ctxFor(
  operationId: string,
  input: Record<string, unknown>,
  stepTimeoutMs?: number,
): ExecutorContext {
  return {
    operationId,
    job: { inputRef: 'inline:x' },
    readPayload: async () => input,
    ...(stepTimeoutMs === undefined
      ? {}
      : { stepDefinition: { timeout: { executionTimeoutMs: stepTimeoutMs } } }),
  } as unknown as ExecutorContext;
}

describe('resolveHostTimeout', () => {
  it('gives a harness run an idle deadline under its own ceiling', async () => {
    const spec = await resolveHostTimeout(
      ctxFor('host.harness.run', { bindingId: 'b', task: 't', timeoutMs: 1_800_000 }),
    );
    expect(spec).toEqual({
      idleMs: HOST_STREAM_IDLE_MS,
      maxMs: 1_800_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
  });

  it('never lets the idle deadline outlive the ceiling', async () => {
    const spec = await resolveHostTimeout(
      ctxFor('host.harness.run', { bindingId: 'b', task: 't', timeoutMs: 60_000 }),
    );
    expect(spec).toEqual({
      idleMs: 60_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
      maxMs: 60_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
  });

  it('treats a foreground command the same way, and a detached one as instant', async () => {
    const running = await resolveHostTimeout(
      ctxFor('host.process.exec', {
        bindingId: 'b',
        command: ['yarn', 'test'],
        timeoutMs: 600_000,
      }),
    );
    expect(running).toEqual({
      idleMs: Math.min(HOST_STREAM_IDLE_MS, 600_000 + HOST_OUTER_TIMEOUT_MARGIN_MS),
      maxMs: 600_000 + HOST_OUTER_TIMEOUT_MARGIN_MS,
    });
    const detached = await resolveHostTimeout(
      ctxFor('host.process.exec', { bindingId: 'b', command: ['yarn', 'dev'], detach: true }),
    );
    expect(detached).toBeUndefined();
  });

  it('leaves the flat clock to a file read, an unreadable input, and an operator-set step timeout', async () => {
    expect(
      await resolveHostTimeout(ctxFor('host.file.get', { bindingId: 'b', path: 'x' })),
    ).toBeUndefined();
    expect(
      await resolveHostTimeout(ctxFor('host.harness.run', { nonsense: true })),
    ).toBeUndefined();
    expect(
      await resolveHostTimeout(ctxFor('host.harness.run', { bindingId: 'b', task: 't' }, 120_000)),
    ).toBeUndefined();
  });
});
