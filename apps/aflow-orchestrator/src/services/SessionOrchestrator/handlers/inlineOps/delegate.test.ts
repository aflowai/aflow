/**
 * Plan 269 D7 and Plan 322 D3 — the delegation config offers a Runner tools
 * through three channels (runner_tools, the capability grant's direct
 * operations, and its promotable ceiling); the scan for the ruler and the plan
 * must see all of them or a grant simply rides the unscanned channel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from './types.js';

const redisCalls = vi.hoisted(() => ({
  addStepResult: vi.fn((_redis: unknown, _result: Record<string, unknown>) => Promise.resolve()),
  addControlMessage: vi.fn((_redis: unknown, _message: Record<string, unknown>) =>
    Promise.resolve(),
  ),
  setSessionState: vi.fn((_redis: unknown, _state: Record<string, unknown>) => Promise.resolve()),
}));

vi.mock('@aflow/redis', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  ...redisCalls,
  appendSessionEvent: vi.fn(() => Promise.resolve()),
  markSessionDirty: vi.fn(() => Promise.resolve()),
  addWaitingChild: vi.fn(() => Promise.resolve()),
  getSessionState: vi.fn(() => Promise.resolve(null)),
  scheduleShardTimer: vi.fn(() => Promise.resolve()),
}));
vi.mock('@aflow/database', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getDatabase: () => ({}),
}));
vi.mock('../../helpers/delegationState.js', () => ({
  enterChildWait: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../../lib/orchestratorLogger.js', () => ({
  getOrchestratorLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { collectRunnerExcludedGrants, handleDelegateInline } = await import('./delegate.js');

function delegation(runnerTools: string[]): InlineHandlerArgs {
  const input = {
    target: { kind: 'platform-role', systemRole: 'cybernetic-runner' },
    input: 'Carry out the round.',
    // A caller-supplied model keeps the space directives out of this test.
    config: { runner_model: 'glm-pro', runner_tools: runnerTools },
  };
  return {
    redis: {} as InlineHandlerArgs['redis'],
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve(input)),
    } as unknown as InlineHandlerArgs['payloadStore'],
    context: {
      tenantId: 'tenant-1',
      runId: 'helmsman-run-1',
      spaceId: 'space-1',
      traceId: 'trace-1',
    } as unknown as InlineHandlerArgs['context'],
    stepDef: {
      stepId: 'delegate-1',
      stepType: 'agent',
      operation: 'agent.control.delegate',
      config: {},
    } as unknown as InlineHandlerArgs['stepDef'],
    stepExecutionId: 'se-1' as InlineHandlerArgs['stepExecutionId'],
    idempotencyKey: 'idem-1' as InlineHandlerArgs['idempotencyKey'],
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function decodeInlineRef(ref: unknown): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(String(ref).slice('inline:'.length), 'base64').toString('utf8'),
  ) as Record<string, unknown>;
}

describe('agent.control.delegate — the plan never reaches a Runner', () => {
  beforeEach(() => {
    for (const call of Object.values(redisCalls)) call.mockClear();
  });

  it('starts a Runner with the tools it is granted', async () => {
    await handleDelegateInline(delegation(['memory.store.get']));

    expect(redisCalls.addControlMessage).toHaveBeenCalledTimes(1);
    const start = redisCalls.addControlMessage.mock.calls[0]?.[1];
    expect(decodeInlineRef(start?.['inputRef'])).toMatchObject({
      config: { runner_tools: ['memory.store.get'] },
    });
  });

  it('refuses a delegation naming plan.node.update in runner_tools, and starts no Runner', async () => {
    await handleDelegateInline(delegation(['memory.store.get', 'plan.node.update']));

    expect(redisCalls.setSessionState).not.toHaveBeenCalled();
    expect(redisCalls.addControlMessage).not.toHaveBeenCalled();
    const result = redisCalls.addStepResult.mock.calls[0]?.[1];
    expect(result).toMatchObject({ status: 'FAILED', operationId: 'agent.control.delegate' });
    expect(result?.['error']).toMatchObject({ retryable: false });
    expect(String((result?.['error'] as { message?: unknown }).message)).toContain(
      '[plan.node.update]',
    );
  });
});

describe('collectRunnerExcludedGrants', () => {
  it('finds plan ops on every channel', () => {
    expect(
      collectRunnerExcludedGrants({
        runner_tools: ['memory.store.get', 'plan.node.update'],
        runner_capability_grants: {
          operations: ['plan.node.create'],
          integrations: [],
          promotable: { operations: ['plan.node.list'] },
        },
      }),
    ).toEqual(['plan.node.update', 'plan.node.create', 'plan.node.list']);
  });

  it('finds eval ops on the runner_tools surface', () => {
    expect(
      collectRunnerExcludedGrants({ runner_tools: ['memory.store.get', 'eval.dataset.get'] }),
    ).toEqual(['eval.dataset.get']);
  });

  it('finds eval ops in the capability grant direct tier', () => {
    expect(
      collectRunnerExcludedGrants({
        runner_capability_grants: { operations: ['eval.case.promote'], integrations: [] },
      }),
    ).toEqual(['eval.case.promote']);
  });

  it('finds eval ops in the promotable ceiling — one catalog.tool.promote away from live', () => {
    expect(
      collectRunnerExcludedGrants({
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
      collectRunnerExcludedGrants({
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
      collectRunnerExcludedGrants({
        runner_tools: [42, null],
        runner_capability_grants: 'not-an-object',
      }),
    ).toEqual([]);
    expect(
      collectRunnerExcludedGrants({
        runner_capability_grants: { promotable: { operations: 'eval.dataset.get' } },
      }),
    ).toEqual([]);
  });
});
