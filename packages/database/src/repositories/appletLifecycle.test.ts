/**
 * Phase 5 lifecycle acceptance, against the real schema: an instance pins its
 * definition hash; upgrade migrates or refuses, never silently reinterprets;
 * rollback restores the prior pin and state shape; archived instances are
 * read-only and excluded from the active surfaces; an artifact with live
 * instances cannot be hard-removed — the removal path archives them first,
 * and the version FK blocks deletion underneath.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { TenantId } from '@aflow/schemas';
import {
  AppletDefinitionSchema,
  appletStatePath,
  type AppletDefinition,
  type AppletInstance,
} from '@aflow/schemas';
import {
  applyAppletCommand,
  applyAppletUpgrade,
  archiveAppletInstance,
} from '@aflow/applet-runtime';
import { createDatabase } from '../connection.js';
import { createTenantContext } from '../tenant/context.js';
import { withTenantSchema } from '../tenant/queries.js';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
  memoryDocs,
  memoryDirs,
  spaces,
  uiArtifacts,
  uiArtifactVersions,
} from '../schema/tenant.js';
import { createAppletPersistence } from './appletInstances.js';
import {
  archiveActiveAppletInstancesForArtifact,
  countActiveAppletInstancesForArtifact,
} from './appletLifecycle.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

function makeDefinition(version: number, stateSchema: Record<string, unknown>): AppletDefinition {
  return AppletDefinitionSchema.parse({
    appletKey: 'work-board',
    version,
    name: 'Work Board',
    description: 'A shared work item',
    semanticDescription: 'A board people and the agent operate together',
    stateSchema,
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

describeDb('applet lifecycle (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const rawSql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const persistence = createAppletPersistence(db, tenantCtx);

  const spaceId = randomUUID();
  const artifactA = randomUUID();
  const artifactB = randomUUID();
  const v1 = randomUUID();
  const v2 = randomUUID();
  const vStrict = randomUUID();
  const vOther = randomUUID();
  const hashV1 = `sha256:${randomUUID()}`;
  const hashV2 = `sha256:${randomUUID()}`;
  const hashStrict = `sha256:${randomUUID()}`;
  const hashOther = `sha256:${randomUUID()}`;
  const actorUserId = randomUUID();

  let schemaReady = false;

  async function instantiate(versionId: string): Promise<AppletInstance> {
    return persistence.transact(async (tx) => {
      const resolution = await tx.resolveAppletArtifact({ spaceId, versionId });
      if (resolution.outcome !== 'resolved') {
        throw new Error(`fixture version did not resolve: ${resolution.outcome}`);
      }
      const instanceId = randomUUID();
      const now = new Date().toISOString();
      const instance: AppletInstance = {
        instanceId,
        spaceId,
        appletKey: resolution.definition.appletKey,
        definitionHash: resolution.definitionHash,
        artifactVersionId: resolution.artifactVersionId,
        statePath: appletStatePath(instanceId),
        status: 'active',
        boundSessionId: null,
        createdBy: actorUserId,
        createdAt: now,
        updatedAt: now,
      };
      await tx.createInstance({
        instance,
        initialState: resolution.definition.initialState,
        roleBindings: [],
      });
      return instance;
    });
  }

  function upgrade(instanceId: string, toVersionId: string) {
    return applyAppletUpgrade({ persistence, instanceId, toVersionId });
  }

  function act(instanceId: string, amount: number, baseVersion: number) {
    return applyAppletCommand({
      persistence,
      instanceId,
      actor: { kind: 'user', userId: actorUserId },
      spaceRole: 'editor',
      command: {
        actionId: randomUUID(),
        baseVersion,
        name: 'set_budget',
        input: { amount },
      },
    });
  }

  async function reload(instanceId: string) {
    const record = await persistence.transact((tx) => tx.loadInstanceForUpdate(instanceId));
    expect(record).not.toBeNull();
    return record!;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      const instanceRows = await tx
        .select({ id: appletInstances.id })
        .from(appletInstances)
        .where(eq(appletInstances.spaceId, spaceId));
      const instanceIds = instanceRows.map((row) => row.id);
      if (instanceIds.length > 0) {
        await tx
          .delete(appletActionEvents)
          .where(inArray(appletActionEvents.instanceId, instanceIds));
        await tx
          .delete(appletRoleBindings)
          .where(inArray(appletRoleBindings.instanceId, instanceIds));
        await tx.delete(appletInstances).where(inArray(appletInstances.id, instanceIds));
      }
      await tx
        .delete(uiArtifactVersions)
        .where(inArray(uiArtifactVersions.id, [v1, v2, vStrict, vOther]));
      await tx.delete(uiArtifacts).where(inArray(uiArtifacts.id, [artifactA, artifactB]));
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceId));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceId));
      await tx.delete(spaces).where(eq(spaces.id, spaceId));
    });
  }

  beforeAll(async () => {
    const rows = await rawSql<{ ok: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'applet_instances'
          AND column_name = 'upgraded_from_version_id'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values({
        id: spaceId,
        name: 'Applet Lifecycle Space',
        slug: `applet-lc-${randomUUID().slice(0, 8)}`,
      });
      await tx.insert(uiArtifacts).values([
        {
          id: artifactA,
          name: 'Work Board',
          kind: 'applet',
          spaceId,
          currentVersion: 1,
          catalogId: 'test',
          catalogVersion: '1',
          catalogHash: 'test',
        },
        {
          id: artifactB,
          name: 'Other Board',
          kind: 'applet',
          spaceId,
          currentVersion: 1,
          catalogId: 'test',
          catalogVersion: '1',
          catalogHash: 'test',
        },
      ]);
      await tx.insert(uiArtifactVersions).values([
        {
          id: v1,
          artifactId: artifactA,
          version: 1,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(1, looseSchema),
          definitionHash: hashV1,
        },
        {
          id: v2,
          artifactId: artifactA,
          version: 2,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(2, looseSchema),
          definitionHash: hashV2,
        },
        {
          id: vStrict,
          artifactId: artifactA,
          version: 3,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(3, strictSchema),
          definitionHash: hashStrict,
        },
        {
          id: vOther,
          artifactId: artifactB,
          version: 1,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(1, looseSchema),
          definitionHash: hashOther,
        },
      ]);
    });
  });

  afterAll(async () => {
    if (schemaReady) await cleanup();
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('an instance pins the version definition hash at instantiation', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    expect(instance.definitionHash).toBe(hashV1);
    expect(instance.artifactVersionId).toBe(v1);

    const record = await reload(instance.instanceId);
    expect(record.instance.definitionHash).toBe(hashV1);
    expect(record.definition.version).toBe(1);
    expect(record.instance.upgradedFromVersionId).toBeUndefined();
  });

  it('upgrade repins, records provenance, keeps the state, and bumps its version', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    const applied = await act(instance.instanceId, 40000, 1);
    expect(applied.status).toBe('applied');

    const result = await upgrade(instance.instanceId, v2);
    expect(result.status).toBe('upgraded');
    if (result.status !== 'upgraded') return;
    expect(result.fromVersionId).toBe(v1);
    expect(result.stateVersion).toBe(3);

    const record = await reload(instance.instanceId);
    expect(record.instance.artifactVersionId).toBe(v2);
    expect(record.instance.definitionHash).toBe(hashV2);
    expect(record.instance.upgradedFromVersionId).toBe(v1);
    expect(record.instance.upgradedAt).toBeDefined();
    expect(record.definition.version).toBe(2);
    expect(record.state).toEqual({ budget: 40000 });
    expect(record.stateVersion).toBe(3);
  });

  it('upgrade refuses when the state does not fit the target schema — pin untouched', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);

    const result = await upgrade(instance.instanceId, vStrict);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('state_incompatible');
    expect(result.validation).toBeDefined();

    const record = await reload(instance.instanceId);
    expect(record.instance.artifactVersionId).toBe(v1);
    expect(record.instance.definitionHash).toBe(hashV1);
    expect(record.instance.upgradedFromVersionId).toBeUndefined();
    expect(record.stateVersion).toBe(1);
  });

  it('upgrade refuses a version from another artifact lineage', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    const result = await upgrade(instance.instanceId, vOther);
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.reason).toBe('different_lineage');
  });

  it('rollback — upgrading to the recorded prior version — restores pin and state shape', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    const up = await upgrade(instance.instanceId, v2);
    expect(up.status).toBe('upgraded');

    const midway = await reload(instance.instanceId);
    const rollbackTarget = midway.instance.upgradedFromVersionId;
    expect(rollbackTarget).toBe(v1);

    const back = await upgrade(instance.instanceId, rollbackTarget!);
    expect(back.status).toBe('upgraded');

    const record = await reload(instance.instanceId);
    expect(record.instance.artifactVersionId).toBe(v1);
    expect(record.instance.definitionHash).toBe(hashV1);
    expect(record.instance.upgradedFromVersionId).toBe(v2);
    expect(record.definition.version).toBe(1);

    const applied = await act(instance.instanceId, 7, record.stateVersion);
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    expect(applied.state).toEqual({ budget: 7 });
  });

  it('archived instances are read-only and excluded from the active listing', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);

    const archived = await archiveAppletInstance({ persistence, instanceId: instance.instanceId });
    expect(archived.status).toBe('archived');

    const rejectedAction = await act(instance.instanceId, 1, 1);
    expect(rejectedAction.status).toBe('rejected');
    if (rejectedAction.status !== 'rejected') return;
    expect(rejectedAction.reason).toBe('instance_not_active');

    const rejectedUpgrade = await upgrade(instance.instanceId, v2);
    expect(rejectedUpgrade.status).toBe('refused');
    if (rejectedUpgrade.status !== 'refused') return;
    expect(rejectedUpgrade.reason).toBe('instance_not_active');

    const active = await persistence.transact((tx) =>
      tx.listInstances({ spaceId, status: 'active', limit: 100, offset: 0 }),
    );
    expect(active.items.map((item) => item.instance.instanceId)).not.toContain(instance.instanceId);
    const archivedList = await persistence.transact((tx) =>
      tx.listInstances({ spaceId, status: 'archived', limit: 100, offset: 0 }),
    );
    expect(archivedList.items.map((item) => item.instance.instanceId)).toContain(
      instance.instanceId,
    );
  });

  it('removal protection: live instances are counted, archived in bulk, ended left alone', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const before = await withTenantSchema(db, tenantCtx, (tx) =>
      countActiveAppletInstancesForArtifact(tx, artifactB),
    );
    expect(before).toBe(0);

    const liveA = await instantiate(vOther);
    const liveB = await instantiate(vOther);
    const endedInstance = await instantiate(vOther);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx
        .update(appletInstances)
        .set({ status: 'ended' })
        .where(eq(appletInstances.id, endedInstance.instanceId));
    });

    const count = await withTenantSchema(db, tenantCtx, (tx) =>
      countActiveAppletInstancesForArtifact(tx, artifactB),
    );
    expect(count).toBe(2);

    const refs = await withTenantSchema(db, tenantCtx, (tx) =>
      archiveActiveAppletInstancesForArtifact(tx, artifactB),
    );
    expect(refs.map((ref) => ref.instanceId).sort()).toEqual(
      [liveA.instanceId, liveB.instanceId].sort(),
    );
    expect(refs.every((ref) => ref.spaceId === spaceId)).toBe(true);

    const after = await withTenantSchema(db, tenantCtx, (tx) =>
      countActiveAppletInstancesForArtifact(tx, artifactB),
    );
    expect(after).toBe(0);

    const statuses = await withTenantSchema(db, tenantCtx, (tx) =>
      tx
        .select({ id: appletInstances.id, status: appletInstances.status })
        .from(appletInstances)
        .where(
          inArray(appletInstances.id, [
            liveA.instanceId,
            liveB.instanceId,
            endedInstance.instanceId,
          ]),
        ),
    );
    const byId = new Map(statuses.map((row) => [row.id, row.status]));
    expect(byId.get(liveA.instanceId)).toBe('archived');
    expect(byId.get(liveB.instanceId)).toBe('archived');
    expect(byId.get(endedInstance.instanceId)).toBe('ended');
  });

  it('a version any instance pins cannot be hard-deleted out from under it', async (ctx) => {
    if (!requireSchema(ctx)) return;
    await instantiate(v1);
    const error = await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.delete(uiArtifactVersions).where(eq(uiArtifactVersions.id, v1));
    }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: { code?: string } }).cause;
    // 23503 = foreign_key_violation: applet_instances.artifact_version_id.
    expect(cause?.code).toBe('23503');
  });
});
