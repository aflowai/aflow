import { describe, expect, it, vi } from 'vitest';
import type { ExecutorContext } from '@aflow/executor-runtime';
import { reportRuntimePhases } from './runtimePhaseStatus.js';

function context() {
  const emitLiveDelta = vi.fn(async () => undefined);
  const reportProgress = vi.fn();
  const ctx = { emitLiveDelta, reportProgress, log: { warn: vi.fn() } };
  return { ctx: ctx as unknown as ExecutorContext, emitLiveDelta, reportProgress };
}

describe('a local model’s silent stretches', () => {
  it('are one line each on the status channel, naming the model that loads', () => {
    const { ctx, emitLiveDelta } = context();
    const report = reportRuntimePhases(ctx, 'Gemma 4 26B (this computer)');

    report({ phase: 'loading_model' });
    report({ phase: 'reading_prompt' });

    expect(emitLiveDelta.mock.calls).toEqual([
      ['status', 'Loading Gemma 4 26B (this computer) into memory…\n'],
      ['status', 'Reading the conversation…\n'],
    ]);
  });

  it('count as progress, so a long load is not cut as a stall', () => {
    const { ctx, reportProgress } = context();

    reportRuntimePhases(ctx, 'm')({ phase: 'loading_model' });

    expect(reportProgress).toHaveBeenCalledTimes(1);
  });
});
