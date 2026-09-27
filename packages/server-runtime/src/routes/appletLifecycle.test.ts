/**
 * REST contract of the lifecycle surfaces (real DB): upgrade repins within
 * the lineage and is refused — never silently reinterpreted — when the state
 * does not fit; rollback is an upgrade to the recorded prior version; archive
 * flips active→archived after which the action gateway refuses; viewers can
 * do neither.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
  createAppletPersistence,
  createDatabase,
  createTenantContext,
  memoryDocs,
  memoryDirs,
  spaceMemberships,
  spaces,
  tenantMemberships,
  uiArtifacts,
  uiArtifactVersions,
  users,
  withTenantSchema,
} from '@aflow/database';
import { checkPermission, resolveSpaceRole } from '@aflow/authz';
import type { AuthzAction, AuthzResourceType, SpaceRole } from '@aflow/authz';
import {
  AppletDefinitionSchema,
  appletStatePath,
  type AppletDefinition,
  type AppletInstance,
  type TenantId,
} from '@aflow/schemas';
import { appletsRoutes } from './applets.js';
import { appletLifecycleRoutes } from './appletLifecycle.js';

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

function fakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;
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

describeDb('applet lifecycle routes (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const rawSql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);
  const persistence = createAppletPersistence(db, tenantCtx);

  const spaceId = randomUUID();
  const editor = randomUUID();
  const viewer = randomUUID();
  const testUserIds = [editor, viewer];

  const artifactId = randomUUID();
  const v1 = randomUUID();
  const v2 = randomUUID();
  const vStrict = randomUUID();
  const hashV1 = `sha256:${randomUUID()}`;
  const hashV2 = `sha256:${randomUUID()}`;
  const hashStrict = `sha256:${randomUUID()}`;

  let schemaReady = false;
  let app: FastifyInstance;

  async function buildApp(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = { db, redis: null };

    instance.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
      const userId = request.headers['x-test-user'];
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('test request missing x-test-user header');
      }
      (request as unknown as { authUser: unknown }).authUser = {
        userId,
        roles: [],
        authMethod: 'test',
        isServicePrincipal: false,
      };
    });

    instance.decorate(
      'requirePermission',
      (opts: {
        resource: AuthzResourceType;
        action: AuthzAction;
        getSpaceId?: (request: FastifyRequest) => string | undefined;
      }) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const { userId } = (request as unknown as { authUser: { userId: string } }).authUser;
          const requestSpaceId = opts.getSpaceId?.(request);
          const decision = await checkPermission(
            {
              userId,
              tenantId: TENANT_ID,
              tenantRole: 'member',
              redis: fakeRedis(),
              config: { rbacCacheTtlSeconds: 60 },
              loadSpaceRole: async (uid, tid, sid) =>
                (await resolveSpaceRole(db, null, {
                  userId: uid,
                  tenantId: tid,
                  spaceId: sid,
                })) as SpaceRole | null,
              loadSpaceAttributes: async () => ({ ownerId: null, memberCount: 2 }),
            },
            {
              resource: opts.resource,
              action: opts.action,
              ...(requestSpaceId !== undefined ? { spaceId: requestSpaceId } : {}),
            },
          );
          if (!decision.allowed) {
            reply.status(403).send({
              error: 'Forbidden',
              message: `Permission denied: ${opts.resource}.${opts.action}`,
            });
          }
        },
    );

    instance.addHook('onRequest', async (request) => {
      (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant =
        async () => ({ tenantId: TENANT_ID, tenantRole: 'member', isAdmin: false });
    });

    await instance.register(appletsRoutes, { prefix: '/v1/applets' });
    await instance.register(appletLifecycleRoutes, { prefix: '/v1/applets' });
    await instance.ready();
    return instance;
  }

  async function instantiate(versionId: string): Promise<AppletInstance> {
    return persistence.transact(async (tx) => {
      const resolution = await tx.resolveAppletArtifact({ spaceId, versionId });
      if (resolution.outcome !== 'resolved') {
        throw new Error(`fixture version did not resolve: ${resolution.outcome}`);
      }
      const instanceId = randomUUID();
      const now = new Date().toISOString();
      const created: AppletInstance = {
        instanceId,
        spaceId,
        appletKey: resolution.definition.appletKey,
        definitionHash: resolution.definitionHash,
        artifactVersionId: resolution.artifactVersionId,
        statePath: appletStatePath(instanceId),
        status: 'active',
        boundSessionId: null,
        createdBy: editor,
        createdAt: now,
        updatedAt: now,
      };
      await tx.createInstance({
        instance: created,
        initialState: resolution.definition.initialState,
        roleBindings: [],
      });
      return created;
    });
  }

  function upgradeVia(user: string, instanceId: string, toVersionId: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/applets/${instanceId}/upgrade`,
      headers: { 'x-test-user': user },
      payload: { toVersionId },
    });
  }

  function archiveVia(user: string, instanceId: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/applets/${instanceId}/archive`,
      headers: { 'x-test-user': user },
    });
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
      await tx.delete(uiArtifactVersions).where(inArray(uiArtifactVersions.id, [v1, v2, vStrict]));
      await tx.delete(uiArtifacts).where(eq(uiArtifacts.id, artifactId));
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceId));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceId));
      await tx.delete(spaces).where(eq(spaces.id, spaceId));
    });
    await db.delete(spaceMemberships).where(eq(spaceMemberships.spaceId, spaceId));
    await db
      .delete(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenantId, TENANT_ID),
          inArray(tenantMemberships.userId, testUserIds),
        ),
      );
    await db.delete(users).where(inArray(users.id, testUserIds));
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

    await db.insert(users).values([
      { id: editor, displayName: 'Lifecycle Editor' },
      { id: viewer, displayName: 'Lifecycle Viewer' },
    ]);
    await db.insert(tenantMemberships).values(
      testUserIds.map((userId) => ({
        tenantId: TENANT_ID,
        userId,
        role: 'member',
        status: 'active',
      })),
    );
    await db.insert(spaceMemberships).values([
      { tenantId: TENANT_ID, spaceId, userId: editor, role: 'editor' },
      { tenantId: TENANT_ID, spaceId, userId: viewer, role: 'viewer' },
    ]);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values({
        id: spaceId,
        name: 'Applet Lifecycle Route Space',
        slug: `applet-lcr-${randomUUID().slice(0, 8)}`,
      });
      await tx.insert(uiArtifacts).values({
        id: artifactId,
        name: 'Work Board',
        kind: 'applet',
        spaceId,
        currentVersion: 1,
        catalogId: 'test',
        catalogVersion: '1',
        catalogHash: 'test',
      });
      await tx.insert(uiArtifactVersions).values([
        {
          id: v1,
          artifactId,
          version: 1,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(1, looseSchema),
          definitionHash: hashV1,
        },
        {
          id: v2,
          artifactId,
          version: 2,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(2, looseSchema),
          definitionHash: hashV2,
        },
        {
          id: vStrict,
          artifactId,
          version: 3,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: makeDefinition(3, strictSchema),
          definitionHash: hashStrict,
        },
      ]);
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (schemaReady) {
      await app.close();
      await cleanup();
    }
    await handle.close();
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  it('upgrades an instance and reports a repeat as a no-op', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);

    const response = await upgradeVia(editor, instance.instanceId, v2);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      instance: AppletInstance;
      stateVersion: number;
      upgraded: boolean;
    };
    expect(body.upgraded).toBe(true);
    expect(body.instance.artifactVersionId).toBe(v2);
    expect(body.instance.definitionHash).toBe(hashV2);
    expect(body.instance.upgradedFromVersionId).toBe(v1);
    expect(body.stateVersion).toBe(2);

    const repeat = await upgradeVia(editor, instance.instanceId, v2);
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { upgraded: boolean }).upgraded).toBe(false);
  });

  it('refuses an incompatible upgrade with the validation detail', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);

    const response = await upgradeVia(editor, instance.instanceId, vStrict);
    expect(response.statusCode).toBe(422);
    const body = response.json() as { reason: string; validation?: string[] };
    expect(body.reason).toBe('state_incompatible');
    expect(body.validation).toBeDefined();

    const record = await persistence.transact((tx) =>
      tx.loadInstanceForUpdate(instance.instanceId),
    );
    expect(record!.instance.artifactVersionId).toBe(v1);
  });

  it('rolls back through the recorded prior version', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    const up = await upgradeVia(editor, instance.instanceId, v2);
    const priorVersionId = (up.json() as { instance: AppletInstance }).instance
      .upgradedFromVersionId;
    expect(priorVersionId).toBe(v1);

    const back = await upgradeVia(editor, instance.instanceId, priorVersionId!);
    expect(back.statusCode).toBe(200);
    const body = back.json() as { instance: AppletInstance; upgraded: boolean };
    expect(body.upgraded).toBe(true);
    expect(body.instance.artifactVersionId).toBe(v1);
    expect(body.instance.definitionHash).toBe(hashV1);
  });

  it('viewers can neither upgrade nor archive', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);
    expect((await upgradeVia(viewer, instance.instanceId, v2)).statusCode).toBe(403);
    expect((await archiveVia(viewer, instance.instanceId)).statusCode).toBe(403);
  });

  it('archives an instance, after which actions are refused as not active', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instance = await instantiate(v1);

    const response = await archiveVia(editor, instance.instanceId);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { instance: AppletInstance; archived: boolean };
    expect(body.archived).toBe(true);
    expect(body.instance.status).toBe('archived');

    const action = await app.inject({
      method: 'POST',
      url: `/v1/applets/${instance.instanceId}/actions`,
      headers: { 'x-test-user': editor },
      payload: {
        actionId: randomUUID(),
        baseVersion: 1,
        name: 'set_budget',
        input: { amount: 1 },
      },
    });
    expect(action.statusCode).toBe(422);
    expect((action.json() as { reason: string }).reason).toBe('instance_not_active');

    const repeat = await archiveVia(editor, instance.instanceId);
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { archived: boolean }).archived).toBe(false);
  });

  it('404s on an unknown instance', async (ctx) => {
    if (!requireSchema(ctx)) return;
    expect((await upgradeVia(editor, randomUUID(), v2)).statusCode).toBe(404);
    expect((await archiveVia(editor, randomUUID())).statusCode).toBe(404);
  });
});
