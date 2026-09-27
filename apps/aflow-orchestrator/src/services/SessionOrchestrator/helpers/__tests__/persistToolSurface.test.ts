import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSessionState = vi.fn();
const mockUpdateSessionState = vi.fn();

vi.mock('@aflow/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aflow/redis')>();
  return {
    ...actual,
    getSessionState: (...args: unknown[]) => mockGetSessionState(...args),
    updateSessionState: (...args: unknown[]) => mockUpdateSessionState(...args),
  };
});

const { persistAgentTurnToolSurface } = await import('../persistToolSurface.js');
const { TOOL_SURFACE_VAR } = await import('../agentTurn.js');

const redis = {} as never;
const TENANT = 'tenant-1';
const RUN = 'run-1';
const STEP = 'agent';
const surfaceKey = `${TOOL_SURFACE_VAR}.${STEP}`;

function surfaceVar(ids: string[]) {
  return { ref: { kind: 'inline' as const, value: ids } };
}

function runtimeStateWith(vars: Record<string, unknown>) {
  return { variables: vars, version: 1, updatedAtMs: 0 } as never;
}

describe('persistAgentTurnToolSurface — Plan 233 surface-durability invariant', () => {
  beforeEach(() => {
    mockGetSessionState.mockReset();
    mockUpdateSessionState.mockReset();
  });

  it('persists the just-computed surface, merged onto authoritative latest state with version+1', async () => {
    // The failing scenario: a tool promoted on the prior turn is admitted to
    // THIS turn's surface. It must reach durable state so the gate sees it.
    const newSurface = surfaceVar(['catalog.tool.promote', 'compute.sandbox.exec']);
    // `latest` (Redis) still carries the PRIOR turn's surface (no compute) plus
    // an unrelated var that must be preserved by the merge.
    mockGetSessionState.mockResolvedValue({
      runtimeState: {
        variables: {
          [surfaceKey]: surfaceVar(['catalog.tool.promote']),
          'ai.agent._virtualTools': { ref: { kind: 'inline', value: { x: 1 } } },
        },
        version: 7,
        updatedAtMs: 100,
      },
    });

    await persistAgentTurnToolSurface(
      redis,
      TENANT,
      RUN,
      STEP,
      runtimeStateWith({ [surfaceKey]: newSurface }),
    );

    expect(mockUpdateSessionState).toHaveBeenCalledTimes(1);
    const written = mockUpdateSessionState.mock.calls[0]?.[3] as {
      runtimeState: { variables: Record<string, unknown>; version: number };
    };
    // The freshly-computed surface (with compute) is written.
    expect(written.runtimeState.variables[surfaceKey]).toEqual(newSurface);
    // Unrelated latest-state vars survive the field-merge.
    expect(written.runtimeState.variables['ai.agent._virtualTools']).toEqual({
      ref: { kind: 'inline', value: { x: 1 } },
    });
    // Version is bumped off LATEST (7 -> 8), not off the passed-in runtimeState.
    expect(written.runtimeState.version).toBe(8);
  });

  it('no-ops when the turn produced no surface var (nothing to persist)', async () => {
    await persistAgentTurnToolSurface(redis, TENANT, RUN, STEP, runtimeStateWith({}));
    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('no-ops when runtimeState is undefined', async () => {
    await persistAgentTurnToolSurface(redis, TENANT, RUN, STEP, undefined);
    expect(mockGetSessionState).not.toHaveBeenCalled();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('no-ops when the session state has vanished (never resurrects a dead run)', async () => {
    mockGetSessionState.mockResolvedValue(undefined);
    await persistAgentTurnToolSurface(
      redis,
      TENANT,
      RUN,
      STEP,
      runtimeStateWith({ [surfaceKey]: surfaceVar(['compute.sandbox.exec']) }),
    );
    expect(mockGetSessionState).toHaveBeenCalledTimes(1);
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('carries the applet spec cache in the same write — dispatch admits only specs persisted this turn', async () => {
    mockGetSessionState.mockResolvedValue({
      runtimeState: { variables: {}, version: 3, updatedAtMs: 1 },
    });
    const specs = {
      ref: {
        kind: 'inline',
        value: [
          {
            toolId: 'chess.move',
            operationId: 'ui.applet.act',
            appletMeta: {
              instanceId: 'i1',
              actionName: 'move',
              patchMode: 'actor_supplied',
              baseVersion: 4,
            },
          },
        ],
      },
    };
    await persistAgentTurnToolSurface(
      redis,
      TENANT,
      RUN,
      STEP,
      runtimeStateWith({ 'ai.agent._appletToolSpecs': specs }),
    );
    expect(mockUpdateSessionState).toHaveBeenCalledTimes(1);
    const written = mockUpdateSessionState.mock.calls[0]![3] as {
      runtimeState: { variables: Record<string, unknown> };
    };
    expect(written.runtimeState.variables['ai.agent._appletToolSpecs']).toEqual(specs);
  });

  it('an empty applet spec cache still persists — a stale prior-turn spec must be cleared', async () => {
    mockGetSessionState.mockResolvedValue({
      runtimeState: {
        variables: {
          'ai.agent._appletToolSpecs': { ref: { kind: 'inline', value: [{ toolId: 'old.one' }] } },
        },
        version: 5,
        updatedAtMs: 1,
      },
    });
    const cleared = { ref: { kind: 'inline', value: [] } };
    await persistAgentTurnToolSurface(
      redis,
      TENANT,
      RUN,
      STEP,
      runtimeStateWith({ 'ai.agent._appletToolSpecs': cleared }),
    );
    const written = mockUpdateSessionState.mock.calls[0]![3] as {
      runtimeState: { variables: Record<string, unknown> };
    };
    expect(written.runtimeState.variables['ai.agent._appletToolSpecs']).toEqual(cleared);
  });
});
