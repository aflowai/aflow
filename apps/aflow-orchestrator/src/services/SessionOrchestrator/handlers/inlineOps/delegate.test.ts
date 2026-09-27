/**
 * Plan 269 D7 — the delegation config offers a Runner tools through three
 * channels (runner_tools, the capability grant's direct operations, and its
 * promotable ceiling); the eval-plane scan must see all of them or a grant
 * simply rides the unscanned channel.
 */
import { describe, expect, it } from 'vitest';
import { collectEvalPlaneGrants } from './delegate.js';

describe('collectEvalPlaneGrants', () => {
  it('finds eval ops on the runner_tools surface', () => {
    expect(
      collectEvalPlaneGrants({ runner_tools: ['memory.store.get', 'eval.dataset.get'] }),
    ).toEqual(['eval.dataset.get']);
  });

  it('finds eval ops in the capability grant direct tier', () => {
    expect(
      collectEvalPlaneGrants({
        runner_capability_grants: { operations: ['eval.case.promote'], integrations: [] },
      }),
    ).toEqual(['eval.case.promote']);
  });

  it('finds eval ops in the promotable ceiling — one catalog.tool.promote away from live', () => {
    expect(
      collectEvalPlaneGrants({
        runner_capability_grants: {
          operations: ['memory.store.get'],
          integrations: [],
          promotable: { operations: ['eval.dataset.list'] },
        },
      }),
    ).toEqual(['eval.dataset.list']);
  });

  it('passes a config with no eval-plane reach', () => {
    expect(
      collectEvalPlaneGrants({
        runner_tools: ['memory.store.get'],
        runner_capability_grants: {
          operations: ['workflow.ledger.get'],
          integrations: [],
          promotable: { operations: ['compute.sandbox.exec'] },
        },
      }),
    ).toEqual([]);
  });

  it('tolerates malformed caller-supplied shapes without widening', () => {
    expect(
      collectEvalPlaneGrants({
        runner_tools: [42, null],
        runner_capability_grants: 'not-an-object',
      }),
    ).toEqual([]);
    expect(
      collectEvalPlaneGrants({
        runner_capability_grants: { promotable: { operations: 'eval.dataset.get' } },
      }),
    ).toEqual([]);
  });
});
