import { describe, it, expect } from 'vitest';
import {
  AppletDefinitionSchema,
  UiAppletActInputSchema,
  type AppletDefinition,
  type AppletFocus,
  type AppletInstance,
} from '@aflow/schemas';
import type { SessionHotState } from '@aflow/redis';
import {
  APPLET_TOOL_SPECS_VAR,
  buildAppletActInput,
  findCachedAppletToolSpec,
  mapAppletActionsToToolSpecs,
  resolveCurrentAppletInstance,
  type AppletFocusResolutionDeps,
  type ResolvedAppletInstance,
} from './appletToolMapper.js';

const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-01-01T00:00:00.000Z';

const MOVE_INPUT_SCHEMA = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' } },
  required: ['from', 'to'],
};

function makeDefinition(): AppletDefinition {
  return AppletDefinitionSchema.parse({
    appletKey: 'chess',
    version: 1,
    name: 'Chess',
    description: 'A chess board',
    semanticDescription: 'A shared chess game between two players',
    stateSchema: { type: 'object' },
    initialState: {},
    actions: [
      {
        name: 'move',
        description: 'Make a move',
        whenToUse: ['When it is your turn'],
        pitfalls: ['Compute the patch against the version you just read'],
        inputSchema: MOVE_INPUT_SCHEMA,
        patch: 'actor_supplied',
        audience: 'both',
      },
      {
        name: 'set_title',
        description: 'Rename the game',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        patch: { template: [{ op: 'replace', path: '/state/title', valueFrom: '/input/title' }] },
        audience: 'agent',
      },
      {
        name: 'poke',
        description: 'Nudge the other player',
        inputSchema: { type: 'object' },
        patch: 'actor_supplied',
        audience: 'human',
      },
    ],
  });
}

function makeInstance(overrides: Partial<AppletInstance> = {}): AppletInstance {
  return {
    instanceId: INSTANCE_ID,
    spaceId: SPACE,
    appletKey: 'chess',
    definitionHash: 'hash',
    artifactVersionId: '33333333-3333-4333-8333-333333333333',
    statePath: `/applets/${INSTANCE_ID}.json`,
    status: 'active',
    boundSessionId: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeResolved(overrides: Partial<AppletInstance> = {}): ResolvedAppletInstance {
  return { instance: makeInstance(overrides), definition: makeDefinition(), stateVersion: 4 };
}

// ============================================================================
// mapAppletActionsToToolSpecs
// ============================================================================

describe('mapAppletActionsToToolSpecs', () => {
  const specs = mapAppletActionsToToolSpecs(makeResolved());
  const byId = new Map(specs.map((s) => [s.toolId, s]));

  it('names every tool <appletKey>.<action> and never leaks the instance id', () => {
    expect([...byId.keys()].sort()).toEqual(['chess.move', 'chess.raw_patch', 'chess.set_title']);
    for (const spec of specs) {
      expect(spec.toolId).not.toContain(INSTANCE_ID);
      expect(spec.callName).toBe(spec.toolId);
    }
  });

  it('lowers onto ui.applet.act as run_step — a meta block, not a new execution path', () => {
    for (const spec of specs) {
      expect(spec.operationId).toBe('ui.applet.act');
      expect(spec.lowering).toBe('run_step');
      expect(spec.source).toBe('applet');
      expect(spec.stepType).toBe('ui');
      expect(spec.kind).toBe('virtual');
    }
  });

  it('excludes human-audience actions and includes the built-in raw_patch', () => {
    expect(byId.has('chess.poke')).toBe(false);
    expect(byId.get('chess.raw_patch')?.appletMeta?.patchMode).toBe('actor_supplied');
  });

  it('template actions expose the action inputSchema plus the outcome slot', () => {
    const setTitle = byId.get('chess.set_title');
    expect(setTitle?.inputSchema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        outcome: {
          type: 'string',
          maxLength: 1000,
          description: 'Human-readable result of the action, in your words',
        },
      },
    });
    expect(setTitle?.appletMeta?.patchMode).toBe('template');
  });

  it('actor_supplied actions expose the { input, proposedPatch, outcome? } wrapper', () => {
    const move = byId.get('chess.move');
    const schema = move?.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(schema.required).toEqual(['input', 'proposedPatch']);
    expect(schema.properties['input']).toEqual(MOVE_INPUT_SCHEMA);
    expect(schema.properties['proposedPatch']?.['type']).toBe('array');
    expect(schema.properties['outcome']?.['type']).toBe('string');
    expect(move?.appletMeta?.patchMode).toBe('actor_supplied');
  });

  it('never puts instanceId/actionId/baseVersion in any tool schema', () => {
    for (const spec of specs) {
      const rendered = JSON.stringify(spec.inputSchema);
      expect(rendered).not.toContain('instanceId');
      expect(rendered).not.toContain('actionId');
      expect(rendered).not.toContain('baseVersion');
    }
  });

  it('stamps appletMeta with the instance and the assembly-time version', () => {
    for (const spec of specs) {
      expect(spec.appletMeta?.instanceId).toBe(INSTANCE_ID);
      expect(spec.appletMeta?.baseVersion).toBe(4);
    }
    expect(byId.get('chess.move')?.appletMeta?.actionName).toBe('move');
  });

  it('composes description from description + whenToUse + pitfalls', () => {
    const description = byId.get('chess.move')?.description ?? '';
    expect(description).toContain('Make a move');
    expect(description).toContain('When to use: When it is your turn');
    expect(description).toContain('Pitfalls: Compute the patch');
  });
});

// ============================================================================
// resolveCurrentAppletInstance
// ============================================================================

function deps(overrides: Partial<AppletFocusResolutionDeps>): AppletFocusResolutionDeps {
  return {
    getFocus: () => Promise.resolve(null),
    loadInstance: () => Promise.resolve(null),
    listActiveInstances: () => Promise.resolve({ items: [], total: 0 }),
    ...overrides,
  };
}

function focusOn(instanceId: string, source: AppletFocus['source']): AppletFocus {
  return { sessionId: 'session-1', instanceId, source, version: 4 };
}

describe('resolveCurrentAppletInstance', () => {
  it('honors an explicit focus whose instance is active in this space', async () => {
    const focused = makeResolved();
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        getFocus: () => Promise.resolve(focusOn(INSTANCE_ID, 'explicit_agent_focus')),
        loadInstance: (id) => Promise.resolve(id === INSTANCE_ID ? focused : null),
        listActiveInstances: () =>
          Promise.resolve({
            items: [makeResolved({ instanceId: OTHER_INSTANCE_ID }), makeResolved()],
            total: 2,
          }),
      }),
    );
    expect(resolved?.instance.instanceId).toBe(INSTANCE_ID);
  });

  it('resolves a waking_action focus through the same slot (Phase 4 seam)', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        getFocus: () => Promise.resolve(focusOn(INSTANCE_ID, 'waking_action')),
        loadInstance: () => Promise.resolve(makeResolved()),
      }),
    );
    expect(resolved?.instance.instanceId).toBe(INSTANCE_ID);
  });

  it('ignores a focus pointing at another space and falls back to the sole active instance', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        getFocus: () => Promise.resolve(focusOn(INSTANCE_ID, 'explicit_agent_focus')),
        loadInstance: () => Promise.resolve(makeResolved({ spaceId: OTHER_SPACE })),
        listActiveInstances: () =>
          Promise.resolve({ items: [makeResolved({ instanceId: OTHER_INSTANCE_ID })], total: 1 }),
      }),
    );
    expect(resolved?.instance.instanceId).toBe(OTHER_INSTANCE_ID);
  });

  it('ignores a focus whose instance has ended', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        getFocus: () => Promise.resolve(focusOn(INSTANCE_ID, 'explicit_agent_focus')),
        loadInstance: () => Promise.resolve(makeResolved({ status: 'ended' })),
      }),
    );
    expect(resolved).toBeNull();
  });

  it('ignores a focus whose instance no longer exists', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        getFocus: () => Promise.resolve(focusOn(INSTANCE_ID, 'explicit_agent_focus')),
        listActiveInstances: () => Promise.resolve({ items: [makeResolved()], total: 1 }),
      }),
    );
    expect(resolved?.instance.instanceId).toBe(INSTANCE_ID);
  });

  it('falls back to the sole active instance when no focus is set', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({ listActiveInstances: () => Promise.resolve({ items: [makeResolved()], total: 1 }) }),
    );
    expect(resolved?.instance.instanceId).toBe(INSTANCE_ID);
  });

  it('declines with two live instances and no focus — guessing is worse', async () => {
    const resolved = await resolveCurrentAppletInstance(
      SPACE,
      deps({
        listActiveInstances: () =>
          Promise.resolve({
            items: [makeResolved(), makeResolved({ instanceId: OTHER_INSTANCE_ID })],
            total: 2,
          }),
      }),
    );
    expect(resolved).toBeNull();
  });

  it('resolves to none when the space has no active instances', async () => {
    expect(await resolveCurrentAppletInstance(SPACE, deps({}))).toBeNull();
  });
});

// ============================================================================
// buildAppletActInput — the model never supplies identity or version
// ============================================================================

describe('buildAppletActInput', () => {
  const templateMeta = {
    instanceId: INSTANCE_ID,
    actionName: 'set_title',
    patchMode: 'template' as const,
    baseVersion: 4,
  };
  const actorMeta = {
    instanceId: INSTANCE_ID,
    actionName: 'move',
    patchMode: 'actor_supplied' as const,
    baseVersion: 4,
  };

  it('template: model args become the action input, envelope fields come from meta', () => {
    const input = buildAppletActInput(templateMeta, { title: 'Endgame' });
    expect(input.instanceId).toBe(INSTANCE_ID);
    expect(input.baseVersion).toBe(4);
    expect(input.name).toBe('set_title');
    expect(input.input).toEqual({ title: 'Endgame' });
    expect(UiAppletActInputSchema.safeParse(input).success).toBe(true);
  });

  it('template: strips model-supplied instanceId/actionId/baseVersion/proposedPatch', () => {
    const forgedActionId = '99999999-9999-4999-8999-999999999999';
    const input = buildAppletActInput(templateMeta, {
      title: 'Endgame',
      instanceId: OTHER_INSTANCE_ID,
      actionId: forgedActionId,
      baseVersion: 999,
      proposedPatch: [{ op: 'replace', path: '/state/title', value: 'hacked' }],
    });
    expect(input.instanceId).toBe(INSTANCE_ID);
    expect(input.actionId).not.toBe(forgedActionId);
    expect(input.baseVersion).toBe(4);
    expect(input.proposedPatch).toBeUndefined();
    expect(input.input).toEqual({ title: 'Endgame' });
  });

  it('mints a fresh server-side actionId per call', () => {
    const first = buildAppletActInput(templateMeta, {});
    const second = buildAppletActInput(templateMeta, {});
    expect(first.actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.actionId).not.toBe(second.actionId);
  });

  it('actor_supplied: lifts input, proposedPatch and outcome from the wrapper', () => {
    const patch = [{ op: 'replace' as const, path: '/state/board', value: 'e4' }];
    const input = buildAppletActInput(actorMeta, {
      input: { from: 'e2', to: 'e4' },
      proposedPatch: patch,
      outcome: 'e4 — pawn advances',
    });
    expect(input.name).toBe('move');
    expect(input.input).toEqual({ from: 'e2', to: 'e4' });
    expect(input.proposedPatch).toEqual(patch);
    expect(input.outcome).toBe('e4 — pawn advances');
    expect(UiAppletActInputSchema.safeParse(input).success).toBe(true);
  });

  it('actor_supplied: ignores forged top-level identity and version fields', () => {
    const input = buildAppletActInput(actorMeta, {
      instanceId: OTHER_INSTANCE_ID,
      actionId: '99999999-9999-4999-8999-999999999999',
      baseVersion: 999,
      input: { from: 'e2', to: 'e4' },
      proposedPatch: [{ op: 'replace', path: '/state/board', value: 'e4' }],
    });
    expect(input.instanceId).toBe(INSTANCE_ID);
    expect(input.actionId).not.toBe('99999999-9999-4999-8999-999999999999');
    expect(input.baseVersion).toBe(4);
  });

  it('actor_supplied: malformed wrapper degrades to an empty command the gateway can reject', () => {
    const input = buildAppletActInput(actorMeta, { input: 'not-an-object', proposedPatch: 'nope' });
    expect(input.input).toEqual({});
    expect(input.proposedPatch).toBeUndefined();
  });
});

// ============================================================================
// findCachedAppletToolSpec
// ============================================================================

function runtimeStateWith(value: unknown): SessionHotState['runtimeState'] {
  return {
    version: 1,
    updatedAtMs: 0,
    variables: { [APPLET_TOOL_SPECS_VAR]: { ref: { kind: 'inline', value } } },
  } as unknown as SessionHotState['runtimeState'];
}

describe('findCachedAppletToolSpec', () => {
  const specs = mapAppletActionsToToolSpecs(makeResolved());

  it('finds this turn’s spec by toolId', () => {
    const spec = findCachedAppletToolSpec(runtimeStateWith(specs), 'chess.move');
    expect(spec?.appletMeta?.actionName).toBe('move');
  });

  it('returns undefined for a toolId that was never lowered', () => {
    expect(findCachedAppletToolSpec(runtimeStateWith(specs), 'chess.castle')).toBeUndefined();
  });

  it('returns undefined for cached specs without appletMeta', () => {
    const stripped = specs.map(({ appletMeta: _appletMeta, ...rest }) => rest);
    expect(findCachedAppletToolSpec(runtimeStateWith(stripped), 'chess.move')).toBeUndefined();
  });

  it('returns undefined when the variable is absent', () => {
    const empty = { version: 1, updatedAtMs: 0, variables: {} } as unknown as NonNullable<
      SessionHotState['runtimeState']
    >;
    expect(findCachedAppletToolSpec(empty, 'chess.move')).toBeUndefined();
    expect(findCachedAppletToolSpec(undefined, 'chess.move')).toBeUndefined();
  });
});
