import { randomUUID } from 'node:crypto';
import {
  AppletDefinitionSchema,
  appletStatePath,
  type AppletActor,
  type AppletCommand,
  type AppletDefinition,
  type AppletInstance,
  type AppletJournalEntry,
  type AppletStateVersion,
} from '@aflow/schemas';
import { describe, expect, it } from 'vitest';
import { applyAppletCommand } from '../applyAppletCommand.js';
import { AppletPersistenceError } from '../errors.js';
import type { AppletPersistence, AppletPersistenceTx } from '../persistence.js';

const definition = AppletDefinitionSchema.parse({
  appletKey: 'work-board',
  version: 1,
  name: 'Work Board',
  description: 'A shared work item',
  semanticDescription: 'A board people and the agent operate together',
  stateSchema: {
    type: 'object',
    properties: {
      budget: { type: 'number', minimum: 0 },
      notes: { type: 'object' },
      done: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  initialState: { budget: 0, notes: {}, done: false },
  actions: [
    {
      name: 'set_budget',
      description: 'Set the budget',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number', minimum: 0 } },
        required: ['amount'],
        additionalProperties: false,
      },
      patch: { template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }] },
    },
    {
      name: 'edit_notes',
      description: 'Edit the notes freely',
      inputSchema: { type: 'object' },
      patch: 'actor_supplied',
      notable: true,
    },
    {
      name: 'close_item',
      description: 'Close the item',
      inputSchema: { type: 'object', additionalProperties: false },
      patch: { template: [{ op: 'replace', path: '/state/done', value: true }] },
      ends: true,
      wakes: true,
    },
  ],
});

interface FakeStore {
  instance: AppletInstance;
  definition: AppletDefinition;
  state: Record<string, unknown>;
  stateVersion: AppletStateVersion;
  journal: AppletJournalEntry[];
  snapshotWrites: number;
}

function makeStore(overrides?: {
  status?: AppletInstance['status'];
  state?: Record<string, unknown>;
  stateVersion?: number;
}): FakeStore {
  const instanceId = randomUUID();
  return {
    instance: {
      instanceId,
      spaceId: randomUUID(),
      appletKey: 'work-board',
      definitionHash: `hash-${instanceId}`,
      artifactVersionId: randomUUID(),
      statePath: appletStatePath(instanceId),
      status: overrides?.status ?? 'active',
      boundSessionId: null,
      createdBy: randomUUID(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    definition,
    state: overrides?.state ?? { budget: 0, notes: {}, done: false },
    stateVersion: overrides?.stateVersion ?? 1,
    journal: [],
    snapshotWrites: 0,
  };
}

function fakePersistence(store: FakeStore): AppletPersistence {
  const tx: AppletPersistenceTx = {
    async loadInstanceForUpdate(instanceId) {
      if (instanceId !== store.instance.instanceId) return null;
      return {
        instance: structuredClone(store.instance),
        definition: store.definition,
        state: structuredClone(store.state),
        stateVersion: store.stateVersion,
      };
    },
    async getJournalEntry(_instanceId, actionId) {
      return store.journal.find((entry) => entry.receipt.actionId === actionId) ?? null;
    },
    async nextSeq() {
      return store.journal.length + 1;
    },
    async writeSnapshot(_instance, state) {
      store.state = structuredClone(state);
      store.stateVersion += 1;
      store.snapshotWrites += 1;
      return store.stateVersion;
    },
    async appendJournalEntry(entry) {
      store.journal.push(structuredClone(entry));
    },
    async touchInstance(_instanceId, changes) {
      if (changes?.status !== undefined) store.instance.status = changes.status;
      store.instance.updatedAt = new Date().toISOString();
    },
    async listRoleBindings() {
      return [];
    },
  };
  return { transact: async (fn) => fn(tx) };
}

const user: AppletActor = { kind: 'user', userId: randomUUID() };
const agent: AppletActor = { kind: 'agent', agentRole: 'helmsman' };

function command(overrides: Partial<AppletCommand>): AppletCommand {
  return {
    actionId: randomUUID(),
    baseVersion: 1,
    name: 'set_budget',
    input: { amount: 100 },
    ...overrides,
  };
}

function run(
  store: FakeStore,
  cmd: AppletCommand,
  opts?: { actor?: AppletActor; role?: 'admin' | 'editor' | 'viewer' },
) {
  return applyAppletCommand({
    persistence: fakePersistence(store),
    instanceId: store.instance.instanceId,
    actor: opts?.actor ?? user,
    spaceRole: opts?.role ?? 'editor',
    command: cmd,
  });
}

describe('applyAppletCommand — apply', () => {
  it('applies a template action: snapshot, journal, receipt, server-stamped actor', async () => {
    const store = makeStore();
    const cmd = command({ input: { amount: 40000 }, outcome: 'budget set to 40k' });
    const result = await run(store, cmd);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.replayed).toBe(false);
    expect(result.state['budget']).toBe(40000);
    expect(result.stateVersion).toBe(2);
    expect(result.receipt).toMatchObject({
      actionId: cmd.actionId,
      seq: 1,
      actor: user,
      name: 'set_budget',
      beforeVersion: 1,
      afterVersion: 2,
      outcome: 'budget set to 40k',
      effects: { notable: false, waking: false, ending: false },
    });
    expect(result.receipt.patch).toEqual([{ op: 'replace', path: '/state/budget', value: 40000 }]);
    expect(store.journal).toHaveLength(1);
    expect(store.journal[0]!.effectDeliveries).toEqual([]);
  });

  it('applies an actor-supplied action and records pending deliveries for its effects', async () => {
    const store = makeStore();
    const proposedPatch = [{ op: 'add' as const, path: '/state/notes/n1', value: 'hello' }];
    const result = await run(store, command({ name: 'edit_notes', input: {}, proposedPatch }), {
      actor: agent,
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.receipt.actor).toEqual(agent);
    expect((store.state['notes'] as Record<string, unknown>)['n1']).toBe('hello');
    expect(store.journal[0]!.effectDeliveries).toEqual([{ effect: 'notable', status: 'pending' }]);
  });

  it('raw_patch works through the gateway as an actor-supplied action', async () => {
    const store = makeStore();
    const result = await run(
      store,
      command({
        name: 'raw_patch',
        input: { summary: 'tweak the budget' },
        proposedPatch: [{ op: 'replace', path: '/state/budget', value: 7 }],
      }),
    );
    expect(result.status).toBe('applied');
    expect(store.state['budget']).toBe(7);
  });

  it('an ending action flips instance status without the platform knowing why', async () => {
    const store = makeStore();
    const result = await run(store, command({ name: 'close_item', input: {} }));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.receipt.effects).toEqual({ notable: false, waking: true, ending: true });
    expect(store.instance.status).toBe('ended');
    expect(store.journal[0]!.effectDeliveries).toEqual([{ effect: 'waking', status: 'pending' }]);
  });

  it('throws instance_not_found for an unknown instance', async () => {
    const store = makeStore();
    await expect(
      applyAppletCommand({
        persistence: fakePersistence(store),
        instanceId: randomUUID(),
        actor: user,
        spaceRole: 'editor',
        command: command({}),
      }),
    ).rejects.toBeInstanceOf(AppletPersistenceError);
  });
});

describe('applyAppletCommand — idempotency', () => {
  it('replays a known actionId with the same payload: original receipt, no second write', async () => {
    const store = makeStore();
    const cmd = command({ input: { amount: 5 } });
    const first = await run(store, cmd);
    expect(first.status).toBe('applied');
    const replay = await run(store, cmd);
    expect(replay.status).toBe('applied');
    if (first.status !== 'applied' || replay.status !== 'applied') return;
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(first.receipt);
    expect(store.journal).toHaveLength(1);
    expect(store.snapshotWrites).toBe(1);
  });

  it('replays an actor-supplied action when the proposedPatch matches verbatim', async () => {
    const store = makeStore();
    const cmd = command({
      name: 'edit_notes',
      input: {},
      proposedPatch: [{ op: 'add' as const, path: '/state/notes/x', value: 1 }],
    });
    await run(store, cmd);
    const replay = await run(store, cmd);
    expect(replay.status).toBe('applied');
    if (replay.status !== 'applied') return;
    expect(replay.replayed).toBe(true);
  });

  it('refuses a known actionId with a different payload', async () => {
    const store = makeStore();
    const cmd = command({ input: { amount: 5 } });
    await run(store, cmd);
    const result = await run(store, { ...cmd, input: { amount: 6 } });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('idempotency_mismatch');
    expect(store.journal).toHaveLength(1);
  });
});

describe('applyAppletCommand — authorization and lifecycle', () => {
  it('rejects a viewer write — appletRoles are never consulted', async () => {
    const store = makeStore();
    const result = await run(store, command({}), { role: 'viewer' });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('forbidden');
    expect(store.snapshotWrites).toBe(0);
  });

  it('rejects a new action on an ended instance but still replays its journal', async () => {
    const store = makeStore();
    const endCmd = command({ name: 'close_item', input: {} });
    await run(store, endCmd);
    const rejectedResult = await run(store, command({ input: { amount: 1 } }));
    expect(rejectedResult.status).toBe('rejected');
    if (rejectedResult.status !== 'rejected') return;
    expect(rejectedResult.reason).toBe('instance_not_active');
    const replay = await run(store, endCmd);
    expect(replay.status).toBe('applied');
    if (replay.status !== 'applied') return;
    expect(replay.replayed).toBe(true);
  });
});

describe('applyAppletCommand — validation', () => {
  it('rejects an unknown action with the declared surface', async () => {
    const store = makeStore();
    const result = await run(store, command({ name: 'castle', input: {} }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('unknown_action');
    expect(result.availableActions).toEqual([
      'set_budget',
      'edit_notes',
      'close_item',
      'raw_patch',
    ]);
  });

  it('rejects schema-invalid input with the validation failures', async () => {
    const store = makeStore();
    const result = await run(store, command({ input: { amount: -1 } }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_input');
    expect(result.validation?.join(' ')).toContain('amount');
  });

  it('rejects an over-long outcome against the definition-tightened cap', async () => {
    const tightened = AppletDefinitionSchema.parse({
      ...AppletDefinitionSchema.parse(definition),
      limits: { maxOutcomeLength: 5 },
    });
    const store = makeStore();
    store.definition = tightened;
    const result = await run(store, command({ outcome: 'far too long' }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_input');
  });

  it('rejects a proposedPatch on a template action', async () => {
    const store = makeStore();
    const result = await run(
      store,
      command({ proposedPatch: [{ op: 'replace', path: '/state/budget', value: 1 }] }),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_patch');
  });

  it('rejects an actor-supplied command without a proposedPatch', async () => {
    const store = makeStore();
    const result = await run(store, command({ name: 'edit_notes', input: {} }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_patch');
  });

  it('rejects when the resulting state fails the stateSchema, persisting nothing', async () => {
    const store = makeStore();
    const result = await run(
      store,
      command({
        name: 'edit_notes',
        input: {},
        proposedPatch: [{ op: 'add' as const, path: '/state/rogue', value: true }],
      }),
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_state');
    expect(store.snapshotWrites).toBe(0);
    expect(store.journal).toHaveLength(0);
  });

  it('rejects a command whose action declares an unsafe inputSchema', async () => {
    const unsafe = AppletDefinitionSchema.parse({
      ...AppletDefinitionSchema.parse(definition),
      actions: [
        {
          name: 'bad_action',
          description: 'Schema smuggles a remote ref',
          inputSchema: { $ref: 'https://evil.example/schema.json' },
          patch: { template: [{ op: 'replace', path: '/state/budget', value: 0 }] },
        },
      ],
    });
    const store = makeStore();
    store.definition = unsafe;
    const result = await run(store, command({ name: 'bad_action', input: {} }));
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.reason).toBe('invalid_schema');
  });
});

describe('applyAppletCommand — versioning and conflict', () => {
  it('conflicts an actor-supplied command on a stale baseVersion, carrying the current version', async () => {
    const store = makeStore({ stateVersion: 4 });
    const result = await run(
      store,
      command({
        name: 'edit_notes',
        input: {},
        baseVersion: 3,
        proposedPatch: [{ op: 'add' as const, path: '/state/notes/x', value: 1 }],
      }),
    );
    expect(result).toEqual({ status: 'conflict', currentVersion: 4 });
    expect(store.snapshotWrites).toBe(0);
  });

  it('rematerializes a template command against the current version on a stale baseVersion', async () => {
    const store = makeStore({ stateVersion: 4 });
    const result = await run(store, command({ baseVersion: 2, input: { amount: 9 } }));
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.receipt.beforeVersion).toBe(4);
    expect(result.receipt.afterVersion).toBe(5);
    expect(store.state['budget']).toBe(9);
  });
});
