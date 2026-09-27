import {
  AppletDefinitionSchema,
  RAW_PATCH_ACTION,
  RAW_PATCH_ACTION_NAME,
  resolveAppletLimits,
  type AppletCommand,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { availableActionNames, resolveAppletAction, resolveCommandPatch } from '../command.js';
import { AppletCommandError, AppletPatchBoundsError } from '../errors.js';

const definition = AppletDefinitionSchema.parse({
  appletKey: 'chess',
  version: 1,
  name: 'Chess',
  description: 'A chess board',
  semanticDescription: 'A shared chess game',
  stateSchema: { type: 'object' },
  initialState: {},
  actions: [
    {
      name: 'set_budget',
      description: 'Set the budget',
      inputSchema: { type: 'object' },
      patch: { template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }] },
    },
    {
      name: 'move',
      description: 'Make a move',
      inputSchema: { type: 'object' },
      patch: 'actor_supplied',
    },
  ],
});

function command(overrides: Partial<AppletCommand>): AppletCommand {
  return {
    actionId: '22222222-2222-4222-8222-222222222222',
    baseVersion: 4,
    name: 'set_budget',
    input: {},
    ...overrides,
  };
}

describe('resolveAppletAction', () => {
  it('resolves a declared action', () => {
    expect(resolveAppletAction(definition, 'move').patch).toBe('actor_supplied');
  });

  it('resolves the built-in raw_patch', () => {
    expect(resolveAppletAction(definition, RAW_PATCH_ACTION_NAME)).toBe(RAW_PATCH_ACTION);
  });

  it('refuses an unknown action, carrying the declared surface', () => {
    try {
      resolveAppletAction(definition, 'castle');
      expect.fail('expected AppletCommandError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletCommandError);
      expect((err as AppletCommandError).code).toBe('unknown_action');
      expect((err as AppletCommandError).availableActions).toEqual([
        'set_budget',
        'move',
        RAW_PATCH_ACTION_NAME,
      ]);
    }
  });
});

describe('availableActionNames', () => {
  it('lists declared actions plus raw_patch', () => {
    expect(availableActionNames(definition)).toEqual(['set_budget', 'move', RAW_PATCH_ACTION_NAME]);
  });
});

describe('resolveCommandPatch', () => {
  const templateAction = resolveAppletAction(definition, 'set_budget');
  const actorAction = resolveAppletAction(definition, 'move');

  it('materializes and bounds a template action patch', () => {
    const patch = resolveCommandPatch(templateAction, command({ input: { amount: 40000 } }));
    expect(patch).toEqual([{ op: 'replace', path: '/state/budget', value: 40000 }]);
  });

  it('refuses proposedPatch on a template action', () => {
    try {
      resolveCommandPatch(
        templateAction,
        command({
          input: { amount: 1 },
          proposedPatch: [{ op: 'replace', path: '/state/budget', value: 1 }],
        }),
      );
      expect.fail('expected AppletCommandError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletCommandError);
      expect((err as AppletCommandError).code).toBe('patch_forbidden');
    }
  });

  it('requires proposedPatch on an actor-supplied action', () => {
    try {
      resolveCommandPatch(actorAction, command({ name: 'move' }));
      expect.fail('expected AppletCommandError');
    } catch (err) {
      expect(err).toBeInstanceOf(AppletCommandError);
      expect((err as AppletCommandError).code).toBe('patch_required');
    }
  });

  it('bounds and returns an actor-supplied patch', () => {
    const proposedPatch = [
      { op: 'replace' as const, path: '/state/board/e4', value: 'P' },
      { op: 'remove' as const, path: '/state/board/e2' },
    ];
    expect(resolveCommandPatch(actorAction, command({ name: 'move', proposedPatch }))).toEqual(
      proposedPatch,
    );
  });

  it('propagates bounds violations from an actor-supplied patch', () => {
    expect(() =>
      resolveCommandPatch(
        actorAction,
        command({
          name: 'move',
          proposedPatch: [{ op: 'replace', path: '/state/a', value: 1 }],
        }),
        { ...resolveAppletLimits(), maxPatchOps: 0 },
      ),
    ).toThrowError(AppletPatchBoundsError);
  });
});
