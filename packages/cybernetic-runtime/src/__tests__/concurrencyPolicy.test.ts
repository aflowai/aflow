import { describe, it, expect } from 'vitest';
import { SkillConcurrencyPolicySchema } from '@aflow/schemas';
import {
  defaultConcurrencyPolicy,
  resolveEffectiveConcurrencyPolicy,
  readPinnedConcurrencyPolicy,
} from '../scheduling/concurrencyPolicy.js';

describe('resolveEffectiveConcurrencyPolicy', () => {
  it('fills every field from the schema defaults when the manifest declares nothing', () => {
    expect(resolveEffectiveConcurrencyPolicy(undefined)).toEqual(
      SkillConcurrencyPolicySchema.parse({}),
    );
  });

  it('keeps declared fields and defaults the rest', () => {
    const resolved = resolveEffectiveConcurrencyPolicy({ maxParallelTasksPerRun: 9 });
    expect(resolved.maxParallelTasksPerRun).toBe(9);
    expect(resolved.maxConcurrentRuns).toBe(
      SkillConcurrencyPolicySchema.parse({}).maxConcurrentRuns,
    );
    expect(resolved.failureMode).toBe('isolate');
    expect(resolved.perUserSerial).toBe(false);
  });

  it('resolves every declared field verbatim', () => {
    expect(
      resolveEffectiveConcurrencyPolicy({
        maxParallelTasksPerRun: 1,
        maxConcurrentRuns: 'unlimited',
        failureMode: 'cancel_siblings',
        perUserSerial: true,
      }),
    ).toEqual({
      maxParallelTasksPerRun: 1,
      maxConcurrentRuns: 'unlimited',
      failureMode: 'cancel_siblings',
      perUserSerial: true,
    });
  });

  it('rejects a limit above the hard upper bound rather than silently clamping', () => {
    expect(() => resolveEffectiveConcurrencyPolicy({ maxParallelTasksPerRun: 21 })).toThrow();
  });
});

describe('readPinnedConcurrencyPolicy', () => {
  it('returns the pinned policy verbatim', () => {
    const pinned = resolveEffectiveConcurrencyPolicy({
      maxParallelTasksPerRun: 7,
      perUserSerial: true,
    });
    expect(readPinnedConcurrencyPolicy({ effectiveConcurrencyPolicy: pinned })).toEqual(pinned);
  });

  it('falls back to the schema defaults when the column is NULL', () => {
    expect(readPinnedConcurrencyPolicy({ effectiveConcurrencyPolicy: null })).toEqual(
      defaultConcurrencyPolicy(),
    );
  });

  it('never leaves a limit undefined for a row holding a partial policy', () => {
    const partial = { maxParallelTasksPerRun: 2 } as unknown as ReturnType<
      typeof defaultConcurrencyPolicy
    >;
    const read = readPinnedConcurrencyPolicy({ effectiveConcurrencyPolicy: partial });
    expect(read.maxParallelTasksPerRun).toBe(2);
    expect(read.maxConcurrentRuns).toBe(defaultConcurrencyPolicy().maxConcurrentRuns);
    expect(read.failureMode).toBe(defaultConcurrencyPolicy().failureMode);
  });

  it('falls back to the defaults when the stored value is not a policy at all', () => {
    const corrupt = { maxParallelTasksPerRun: 0 } as unknown as ReturnType<
      typeof defaultConcurrencyPolicy
    >;
    expect(readPinnedConcurrencyPolicy({ effectiveConcurrencyPolicy: corrupt })).toEqual(
      defaultConcurrencyPolicy(),
    );
  });
});
