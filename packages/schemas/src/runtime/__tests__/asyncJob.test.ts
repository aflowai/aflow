import { describe, it, expect } from 'vitest';
import {
  AsyncJobRecordSchema,
  AsyncJobStateSchema,
  isAsyncJobTerminal,
  resolveAsyncJobRecovery,
  type AsyncReplayGuarantee,
} from '../asyncJob.js';

const DEDUPED: AsyncReplayGuarantee = { kind: 'idempotency_key', field: 'X-Idempotency-Key' };
const NO_DEDUPE: AsyncReplayGuarantee = { kind: 'unknown_terminal' };

describe('resolveAsyncJobRecovery', () => {
  it('submits work that was only ever reserved', () => {
    expect(resolveAsyncJobRecovery('reserved', DEDUPED)).toBe('submit');
    expect(resolveAsyncJobRecovery('reserved', NO_DEDUPE)).toBe('submit');
  });

  // The crash window: `submitting` means a provider call may have been accepted
  // with nothing recorded. These two lines are the whole point of the contract.
  it('re-submits through a dedupe key rather than paying twice', () => {
    expect(resolveAsyncJobRecovery('submitting', DEDUPED)).toBe('resubmit_deduped');
  });

  it('strands an ambiguous submit instead of resubmitting when nothing dedupes it', () => {
    expect(resolveAsyncJobRecovery('submitting', NO_DEDUPE)).toBe('mark_unknown');
  });

  it('never returns submit for a state that may already have reached the provider', () => {
    for (const state of AsyncJobStateSchema.options) {
      for (const guarantee of [DEDUPED, NO_DEDUPE]) {
        const action = resolveAsyncJobRecovery(state, guarantee);
        if (state !== 'reserved') expect(action).not.toBe('submit');
      }
    }
  });

  it('polls anything the provider has accepted', () => {
    expect(resolveAsyncJobRecovery('submitted', NO_DEDUPE)).toBe('poll');
    expect(resolveAsyncJobRecovery('polling', NO_DEDUPE)).toBe('poll');
  });

  it('treats every terminal state as complete', () => {
    for (const state of ['succeeded', 'failed', 'unknown'] as const) {
      expect(isAsyncJobTerminal(state)).toBe(true);
      expect(resolveAsyncJobRecovery(state, DEDUPED)).toBe('complete');
    }
  });

  it('does not treat in-flight states as terminal', () => {
    for (const state of ['reserved', 'submitting', 'submitted', 'polling'] as const) {
      expect(isAsyncJobTerminal(state)).toBe(false);
    }
  });
});

describe('AsyncJobRecordSchema', () => {
  const valid = {
    jobKey: 'run1:step1:0:abc',
    runId: 'run1',
    logicalExecutionId: 'step1',
    attempt: 0,
    operationId: 'ai.media.video',
    provider: 'google',
    state: 'submitting',
    replayGuarantee: DEDUPED,
    clientRequestId: 'run1-step1-0-abc',
    inputHash: 'abc',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  };

  it('accepts a record mid-flight with no provider id yet', () => {
    const parsed = AsyncJobRecordSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.pollCount).toBe(0);
  });

  it('rejects a cost that is not integer micros with a currency', () => {
    expect(
      AsyncJobRecordSchema.safeParse({ ...valid, actualCost: { currency: 'USD', micros: 1.5 } })
        .success,
    ).toBe(false);
    expect(
      AsyncJobRecordSchema.safeParse({ ...valid, actualCost: { currency: 'US', micros: 1 } })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown state', () => {
    expect(AsyncJobRecordSchema.safeParse({ ...valid, state: 'in_progress' }).success).toBe(false);
  });
});
