/**
 * The op-task half of the D5 read-only posture: operation tasks bypass step
 * gating, so a live-tier frozen run must refuse mutating op tasks at
 * dispatch — while production runs and seeded (fixture-isolated) trials
 * dispatch untouched.
 */
import { describe, it, expect } from 'vitest';
import { decideFrozenOpTaskDispatch, extractEvalFixtureTier } from '../frozenRunGate.js';

const MUTATING_OP = 'memory.store.put';
const READ_OP = 'memory.store.query';

function frozenRun(tier?: string): { evalBatchId: string | null; metadata: unknown } {
  return {
    evalBatchId: 'batch-1',
    metadata: tier !== undefined ? { evalFixtureTier: tier } : {},
  };
}

describe('decideFrozenOpTaskDispatch', () => {
  it('never touches a production run, mutating or not', () => {
    const run = { evalBatchId: null, metadata: {} };
    expect(decideFrozenOpTaskDispatch(run, MUTATING_OP)).toBeNull();
    expect(decideFrozenOpTaskDispatch(run, READ_OP)).toBeNull();
  });

  it('refuses a mutating op task on a live-tier frozen run', () => {
    const denial = decideFrozenOpTaskDispatch(frozenRun('live'), MUTATING_OP);
    expect(denial).toMatch(/^EVAL_FROZEN_WRITE_DENIED/);
    expect(denial).toContain(MUTATING_OP);
  });

  it('lets a read op task through on a live-tier frozen run', () => {
    expect(decideFrozenOpTaskDispatch(frozenRun('live'), READ_OP)).toBeNull();
  });

  it('lets a sealed trial dispatch its writes — its world reaches no service at all', () => {
    expect(decideFrozenOpTaskDispatch(frozenRun('sealed'), MUTATING_OP)).toBeNull();
  });

  it('lets a seeded trial dispatch its writes — the fixture space is the isolation boundary', () => {
    expect(decideFrozenOpTaskDispatch(frozenRun('seeded'), MUTATING_OP)).toBeNull();
  });

  it('a frozen run with no tier stamp fails closed as live', () => {
    expect(decideFrozenOpTaskDispatch(frozenRun(), MUTATING_OP)).toMatch(
      /^EVAL_FROZEN_WRITE_DENIED/,
    );
  });

  it('an operation unknown to the registry fails closed as mutating', () => {
    expect(decideFrozenOpTaskDispatch(frozenRun('live'), 'no.such.operation')).toMatch(
      /^EVAL_FROZEN_WRITE_DENIED/,
    );
  });
});

describe('extractEvalFixtureTier', () => {
  it('narrows every launchable tier', () => {
    expect(extractEvalFixtureTier({ evalFixtureTier: 'live' })).toBe('live');
    expect(extractEvalFixtureTier({ evalFixtureTier: 'seeded' })).toBe('seeded');
    expect(extractEvalFixtureTier({ evalFixtureTier: 'sealed' })).toBe('sealed');
    expect(extractEvalFixtureTier({})).toBeUndefined();
    expect(extractEvalFixtureTier(null)).toBeUndefined();
    expect(extractEvalFixtureTier({ evalFixtureTier: 'invented' })).toBeUndefined();
  });
});
