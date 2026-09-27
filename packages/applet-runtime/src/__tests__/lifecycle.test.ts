import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AppletDefinitionSchema,
  appletStatePath,
  type AppletDefinition,
  type AppletInstance,
  type AppletJournalEntry,
  type AppletStateVersion,
} from '@aflow/schemas';
import type {
  AppletArtifactResolution,
  AppletPersistence,
  AppletPersistenceTx,
} from '../persistence.js';
import { applyAppletCommand } from '../applyAppletCommand.js';
import { applyAppletUpgrade, archiveAppletInstance } from '../lifecycle.js';

function makeDefinition(overrides: {
  version: number;
  stateSchema: Record<string, unknown>;
}): AppletDefinition {
  return AppletDefinitionSchema.parse({
    appletKey: 'work-board',
    version: overrides.version,
    name: 'Work Board',
    description: 'A shared work item',
    semanticDescription: 'A board people and the agent operate together',
    stateSchema: overrides.stateSchema,
    initialState: { budget: 0 },
    actions: [
      {
        name: 'set_budget',
        description: 'Set the budget',
        inputSchema: {
          type: 'object',
          properties: { amount: { type: 'number' } },
          required: ['amount'],
          additionalProperties: false,
        },
        patch: {
          template: [{ op: 'replace', path: '/state/budget', valueFrom: '/input/amount' }],
        },
      },
    ],
  });
}

const looseSchema = {
  type: 'object',
  properties: { budget: { type: 'number' } },
  additionalProperties: false,
};
const strictSchema = {
  type: 'object',
  properties: { budget: { type: 'number' }, owner: { type: 'string' } },
  required: ['owner'],
  additionalProperties: false,
};

const ARTIFACT_ID = randomUUID();
const OTHER_ARTIFACT_ID = randomUUID();
const V1 = randomUUID();
const V2 = randomUUID();
const V_STRICT = randomUUID();
const V_OTHER = randomUUID();

interface VersionRow {
  artifactId: string;
  definition: AppletDefinition;
  definitionHash: string;
}

interface FakeStore {
  instance: AppletInstance;
  state: Record<string, unknown>;
  stateVersion: number;
  journal: AppletJournalEntry[];
  versions: Map<string, VersionRow>;
  snapshotWrites: number;
}

function makeStore(overrides?: { status?: AppletInstance['status'] }): FakeStore {
  const instanceId = randomUUID();
  const versions = new Map<string, VersionRow>([
    [
      V1,
      {
        artifactId: ARTIFACT_ID,
        definition: makeDefinition({ version: 1, stateSchema: looseSchema }),
        definitionHash: 'hash-v1',
      },
    ],
    [
      V2,
      {
        artifactId: ARTIFACT_ID,
        definition: makeDefinition({ version: 2, stateSchema: looseSchema }),
        definitionHash: 'hash-v2',
      },
    ],
    [
      V_STRICT,
      {
        artifactId: ARTIFACT_ID,
        definition: makeDefinition({ version: 3, stateSchema: strictSchema }),
        definitionHash: 'hash-strict',
      },
    ],
    [
      V_OTHER,
      {
        artifactId: OTHER_ARTIFACT_ID,
        definition: makeDefinition({ version: 1, stateSchema: looseSchema }),
        definitionHash: 'hash-other',
      },
    ],
  ]);
  return {
    instance: {
      instanceId,
      spaceId: randomUUID(),
      appletKey: 'work-board',
      definitionHash: 'hash-v1',
      artifactVersionId: V1,
      statePath: appletStatePath(instanceId),
      status: overrides?.status ?? 'active',
      boundSessionId: null,
      createdBy: randomUUID(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    state: { budget: 10 },
    stateVersion: 1,
    journal: [],
    versions,
    snapshotWrites: 0,
  };
}

function fakePersistence(store: FakeStore): AppletPersistence {
  const tx = {
    async loadInstanceForUpdate(instanceId: string) {
      if (instanceId !== store.instance.instanceId) return null;
      const definition = store.versions.get(store.instance.artifactVersionId)?.definition;
      if (definition === undefined) throw new Error('pinned version missing from fake store');
      return {
        instance: structuredClone(store.instance),
        definition,
        state: structuredClone(store.state),
        stateVersion: store.stateVersion as AppletStateVersion,
      };
    },
    async getJournalEntry(_instanceId: string, actionId: string) {
      return store.journal.find((entry) => entry.receipt.actionId === actionId) ?? null;
    },
    async nextSeq() {
      return store.journal.length + 1;
    },
    async writeSnapshot(_instance: AppletInstance, state: Record<string, unknown>) {
      store.state = structuredClone(state);
      store.stateVersion += 1;
      store.snapshotWrites += 1;
      return store.stateVersion as AppletStateVersion;
    },
    async appendJournalEntry(entry: AppletJournalEntry) {
      store.journal.push(structuredClone(entry));
    },
    async touchInstance(_instanceId: string, changes?: { status?: AppletInstance['status'] }) {
      if (changes?.status !== undefined) store.instance.status = changes.status;
      store.instance.updatedAt = new Date().toISOString();
    },
    async repinInstance(
      _instanceId: string,
      pin: {
        definitionHash: string;
        artifactVersionId: string;
        upgradedFromVersionId: string;
        upgradedAt: string;
      },
    ) {
      store.instance = {
        ...store.instance,
        definitionHash: pin.definitionHash,
        artifactVersionId: pin.artifactVersionId,
        upgradedFromVersionId: pin.upgradedFromVersionId,
        upgradedAt: pin.upgradedAt,
        updatedAt: pin.upgradedAt,
      };
    },
    async listRoleBindings() {
      return [];
    },
    async resolveAppletArtifact(ref: {
      spaceId: string;
      artifactId?: string;
      versionId?: string;
    }): Promise<AppletArtifactResolution> {
      if (ref.versionId === undefined) return { outcome: 'not_found' };
      const version = store.versions.get(ref.versionId);
      if (!version || ref.spaceId !== store.instance.spaceId) return { outcome: 'not_found' };
      return {
        outcome: 'resolved',
        artifactId: version.artifactId,
        artifactVersionId: ref.versionId,
        definition: version.definition,
        definitionHash: version.definitionHash,
      };
    },
  } as AppletPersistenceTx;
  return { transact: async (fn) => fn(tx) };
}

function upgrade(store: FakeStore, toVersionId: string) {
  return applyAppletUpgrade({
    persistence: fakePersistence(store),
    instanceId: store.instance.instanceId,
    toVersionId,
  });
}

describe('applyAppletUpgrade', () => {
  it('repins to a compatible version, records provenance, and bumps the state version', async () => {
    const store = makeStore();
    const result = await upgrade(store, V2);
    expect(result.status).toBe('upgraded');
    if (result.status !== 'upgraded') return;
    expect(result.fromVersionId).toBe(V1);
    expect(result.instance.artifactVersionId).toBe(V2);
    expect(result.instance.definitionHash).toBe('hash-v2');
    expect(result.instance.upgradedFromVersionId).toBe(V1);
    expect(result.instance.upgradedAt).toBeDefined();
    expect(result.stateVersion).toBe(2);
    expect(store.instance.artifactVersionId).toBe(V2);
    expect(store.state).toEqual({ budget: 10 });
    expect(store.snapshotWrites).toBe(1);
  });

  it('refuses when the current state does not validate against the target stateSchema', async () => {
    const store = makeStore();
    const result = await upgrade(store, V_STRICT);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('state_incompatible');
    expect(result.validation).toBeDefined();
    expect(result.validation!.length).toBeGreaterThan(0);
    expect(store.instance.artifactVersionId).toBe(V1);
    expect(store.instance.definitionHash).toBe('hash-v1');
    expect(store.snapshotWrites).toBe(0);
  });

  it('refuses a version from a different artifact lineage', async () => {
    const store = makeStore();
    const result = await upgrade(store, V_OTHER);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('different_lineage');
    expect(store.instance.artifactVersionId).toBe(V1);
  });

  it('is an idempotent no-op when already pinned to the target', async () => {
    const store = makeStore();
    const result = await upgrade(store, V1);
    expect(result.status).toBe('unchanged');
    expect(store.snapshotWrites).toBe(0);
  });

  it('refuses on a non-active instance', async () => {
    const store = makeStore({ status: 'ended' });
    const result = await upgrade(store, V2);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('instance_not_active');
  });

  it('refuses an unknown target version', async () => {
    const store = makeStore();
    const result = await upgrade(store, randomUUID());
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('version_not_found');
  });

  it('rolls back: upgrading to the recorded prior version restores the pin', async () => {
    const store = makeStore();
    const up = await upgrade(store, V2);
    expect(up.status).toBe('upgraded');
    const rollbackTarget = store.instance.upgradedFromVersionId;
    expect(rollbackTarget).toBe(V1);

    const back = await upgrade(store, rollbackTarget!);
    expect(back.status).toBe('upgraded');
    if (back.status !== 'upgraded') return;
    expect(back.instance.artifactVersionId).toBe(V1);
    expect(back.instance.definitionHash).toBe('hash-v1');
    expect(back.instance.upgradedFromVersionId).toBe(V2);
    expect(store.state).toEqual({ budget: 10 });
    expect(store.stateVersion).toBe(3);
  });
});

describe('archiveAppletInstance', () => {
  it('archives an active instance, after which the gateway refuses actions', async () => {
    const store = makeStore();
    const result = await archiveAppletInstance({
      persistence: fakePersistence(store),
      instanceId: store.instance.instanceId,
    });
    expect(result.status).toBe('archived');
    expect(store.instance.status).toBe('archived');

    const action = await applyAppletCommand({
      persistence: fakePersistence(store),
      instanceId: store.instance.instanceId,
      actor: { kind: 'user', userId: randomUUID() },
      spaceRole: 'editor',
      command: { actionId: randomUUID(), baseVersion: 1, name: 'set_budget', input: { amount: 1 } },
    });
    expect(action.status).toBe('rejected');
    if (action.status !== 'rejected') return;
    expect(action.reason).toBe('instance_not_active');
  });

  it('is an idempotent no-op on an already archived instance', async () => {
    const store = makeStore({ status: 'archived' });
    const result = await archiveAppletInstance({
      persistence: fakePersistence(store),
      instanceId: store.instance.instanceId,
    });
    expect(result.status).toBe('unchanged');
  });

  it('refuses to archive an ended instance', async () => {
    const store = makeStore({ status: 'ended' });
    const result = await archiveAppletInstance({
      persistence: fakePersistence(store),
      instanceId: store.instance.instanceId,
    });
    expect(result.status).toBe('refused');
  });

  it('refuses to upgrade an archived instance', async () => {
    const store = makeStore({ status: 'archived' });
    const result = await upgrade(store, V2);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('instance_not_active');
  });
});
