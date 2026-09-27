/**
 * A film instance in memory — the write gateway's storage contract, nothing
 * more. Driving the real `applyAppletCommand` is what makes an action's input
 * schema binding: the platform is the one materializing the patch, so a
 * command that applies here is one the platform accepts.
 */
import { randomUUID } from 'node:crypto';
import { applyAppletCommand } from '@aflow/applet-runtime';
import type { AppletPersistence, AppletPersistenceTx } from '@aflow/applet-runtime';
import {
  appletStatePath,
  type AppletActor,
  type AppletCommand,
  type AppletInstance,
  type AppletJournalEntry,
  type AppletStatePatchOp,
  type AppletStateVersion,
} from '@aflow/schemas';
import { FILM_DEFINITION } from '../appletFixtures/film.js';

export interface Store {
  instance: AppletInstance;
  state: Record<string, unknown>;
  stateVersion: AppletStateVersion;
  journal: AppletJournalEntry[];
}

export const actor: AppletActor = { kind: 'user', userId: randomUUID() };

export function makeStore(): Store {
  const instanceId = randomUUID();
  return {
    instance: {
      instanceId,
      spaceId: randomUUID(),
      appletKey: 'film',
      definitionHash: `hash-${instanceId}`,
      artifactVersionId: randomUUID(),
      statePath: appletStatePath(instanceId),
      status: 'active',
      boundSessionId: null,
      createdBy: randomUUID(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    state: structuredClone(FILM_DEFINITION.initialState),
    stateVersion: 1,
    journal: [],
  };
}

/**
 * The lifecycle and outbox halves of the persistence contract, which applying
 * a command never reaches. Naming them here rather than widening the type
 * keeps the harness honest: a call means the test drifted off the write path.
 */
function unreached(member: string): never {
  throw new Error(`the film store harness implements no '${member}' — this is the write path only`);
}

export function persistence(store: Store): AppletPersistence {
  const tx: AppletPersistenceTx = {
    repinInstance: () => unreached('repinInstance'),
    resolveAppletArtifact: () => unreached('resolveAppletArtifact'),
    createInstance: () => unreached('createInstance'),
    listRecentReceipts: () => unreached('listRecentReceipts'),
    listInstances: () => unreached('listInstances'),
    getInstance: () => unreached('getInstance'),
    listPendingEffects: () => unreached('listPendingEffects'),
    markEffectDelivered: () => unreached('markEffectDelivered'),
    async loadInstanceForUpdate(instanceId) {
      if (instanceId !== store.instance.instanceId) return null;
      return {
        instance: structuredClone(store.instance),
        definition: FILM_DEFINITION,
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
      return store.stateVersion;
    },
    async appendJournalEntry(entry) {
      store.journal.push(structuredClone(entry));
    },
    async touchInstance(_instanceId, changes) {
      if (changes?.status !== undefined) store.instance.status = changes.status;
    },
    async listRoleBindings() {
      return [];
    },
  };
  return { transact: async (fn) => fn(tx) };
}

export async function act(
  store: Store,
  name: string,
  input: Record<string, unknown>,
  proposedPatch?: AppletStatePatchOp[],
) {
  const command: AppletCommand = {
    actionId: randomUUID(),
    baseVersion: store.stateVersion,
    name,
    input,
    ...(proposedPatch !== undefined ? { proposedPatch } : {}),
  };
  return applyAppletCommand({
    persistence: persistence(store),
    instanceId: store.instance.instanceId,
    actor,
    spaceRole: 'editor',
    command,
  });
}

/** Applies and fails loudly with the gateway's own words when it does not. */
export async function apply(
  store: Store,
  name: string,
  input: Record<string, unknown>,
  proposedPatch?: AppletStatePatchOp[],
) {
  const result = await act(store, name, input, proposedPatch);
  if (result.status !== 'applied') {
    throw new Error(
      `'${name}' did not apply: ${result.status}${
        result.status === 'rejected' ? ` — ${result.reason}: ${result.message}` : ''
      }`,
    );
  }
  return result;
}

export async function refusal(
  store: Store,
  name: string,
  input: Record<string, unknown>,
  proposedPatch?: AppletStatePatchOp[],
) {
  const result = await act(store, name, input, proposedPatch);
  if (result.status !== 'rejected') {
    throw new Error(`'${name}' was not refused — the gateway returned '${result.status}'`);
  }
  return result;
}
