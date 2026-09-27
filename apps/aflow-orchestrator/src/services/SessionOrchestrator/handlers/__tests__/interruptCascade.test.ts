import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionHotState } from '@aflow/redis';

import { cascadeInterruptToChildren } from '../interruptCascade.js';
import type { InterruptCascadeDeps } from '../interruptCascade.js';

const mockRedis = {} as never;

function makeDeps(overrides?: Partial<InterruptCascadeDeps>): InterruptCascadeDeps {
  return {
    redis: mockRedis,
    logger: {
      info: vi.fn(),
      error: vi.fn(),
    },
    addControlMessage: vi.fn().mockResolvedValue(undefined),
    updateSessionState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeParentState(
  overrides?: Partial<
    Pick<
      SessionHotState,
      'traceId' | 'waitingForChildSessionIds' | 'delegationPauseSource' | 'pausedChildSessionId'
    >
  >,
): Pick<
  SessionHotState,
  'traceId' | 'waitingForChildSessionIds' | 'delegationPauseSource' | 'pausedChildSessionId'
> {
  return {
    traceId: 'trace-1' as never,
    ...overrides,
  };
}

describe('cascadeInterruptToChildren', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags and cancels each child in waitingForChildSessionIds', async () => {
    const deps = makeDeps();
    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        waitingForChildSessionIds: ['child-1', 'child-2'],
      }),
    });

    expect(result.cascadedTo).toEqual(['child-1', 'child-2']);
    expect(deps.updateSessionState).toHaveBeenCalledTimes(2);
    expect(deps.updateSessionState).toHaveBeenCalledWith(mockRedis, 'tenant-1', 'child-1', {
      interruptRequested: true,
    });
    expect(deps.updateSessionState).toHaveBeenCalledWith(mockRedis, 'tenant-1', 'child-2', {
      interruptRequested: true,
    });
    expect(deps.addControlMessage).toHaveBeenCalledTimes(2);
    const ctrl1 = (deps.addControlMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(ctrl1.type).toBe('cancel_run');
    expect(ctrl1.runId).toBe('child-1');
  });

  it('regression: incident shape — parent paused on child_input, child not in waitingForChildSessionIds', async () => {
    // The incident: parent was WAITING_ON_CHILD with pausedChildSessionId
    // pointing to a Driver session whose currentStep was PAUSED on
    // user.input.request. The cascade must reach the paused child even
    // when waitingForChildSessionIds doesn't list it (defensive parity).
    const deps = makeDeps();
    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        delegationPauseSource: 'child_input',
        pausedChildSessionId: 'paused-child' as never,
        waitingForChildSessionIds: [],
      }),
    });

    expect(result.cascadedTo).toEqual(['paused-child']);

    // Defense-in-depth: flag was set on the paused child.
    expect(deps.updateSessionState).toHaveBeenCalledWith(mockRedis, 'tenant-1', 'paused-child', {
      interruptRequested: true,
    });

    // Primary terminator: cancel_run was sent.
    expect(deps.addControlMessage).toHaveBeenCalledTimes(1);
    const ctrl = (deps.addControlMessage as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(ctrl.type).toBe('cancel_run');
    expect(ctrl.runId).toBe('paused-child');
    expect(ctrl.tenantId).toBe('tenant-1');
  });

  it('does not double-cascade when pausedChildSessionId is also in waitingForChildSessionIds', async () => {
    const deps = makeDeps();
    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        delegationPauseSource: 'child_input',
        pausedChildSessionId: 'child-1' as never,
        waitingForChildSessionIds: ['child-1'],
      }),
    });

    expect(result.cascadedTo).toEqual(['child-1']);
    expect(deps.updateSessionState).toHaveBeenCalledTimes(1);
    expect(deps.addControlMessage).toHaveBeenCalledTimes(1);
  });

  it('continues cascading siblings when one child-state write fails', async () => {
    const updateState = vi
      .fn<Parameters<typeof Promise.resolve>, ReturnType<typeof Promise.resolve>>()
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValue(undefined);
    const deps = makeDeps({ updateSessionState: updateState as never });

    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        waitingForChildSessionIds: ['child-1', 'child-2'],
      }),
    });

    expect(result.cascadedTo).toEqual(['child-1', 'child-2']);
    expect(deps.logger.error).toHaveBeenCalledOnce();
    // cancel_run still attempted for both children (best-effort)
    expect(deps.addControlMessage).toHaveBeenCalledTimes(2);
  });

  it('continues cascading siblings when one cancel_run send fails', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('stream unavailable'))
      .mockResolvedValue(undefined);
    const deps = makeDeps({ addControlMessage: send as never });

    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        waitingForChildSessionIds: ['child-1', 'child-2'],
      }),
    });

    expect(result.cascadedTo).toEqual(['child-1', 'child-2']);
    expect(deps.logger.error).toHaveBeenCalledOnce();
    // Flag was still written for both children (defense-in-depth)
    expect(deps.updateSessionState).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when there are no children to cascade to', async () => {
    const deps = makeDeps();
    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({}),
    });

    expect(result.cascadedTo).toEqual([]);
    expect(deps.updateSessionState).not.toHaveBeenCalled();
    expect(deps.addControlMessage).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalled();
  });

  it('does not include pausedChildSessionId when delegationPauseSource is not child_input', async () => {
    // pausedChildSessionId is only meaningful when paired with the
    // child_input source. Other pause sources (e.g. waitForInput) point
    // at a different concept and must not trigger child cascade.
    const deps = makeDeps();
    const result = await cascadeInterruptToChildren(deps, {
      tenantId: 'tenant-1' as never,
      parentRunId: 'parent-1' as never,
      parentState: makeParentState({
        pausedChildSessionId: 'orphan-child' as never,
        // delegationPauseSource is undefined / something other than child_input
      }),
    });

    expect(result.cascadedTo).toEqual([]);
  });
});
