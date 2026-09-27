/**
 * REST contract of the applet instance surfaces (real DB): instantiate
 * validates the pinned definition's initialState, every mutation runs through
 * the single gateway with a server-stamped actor and space role, reads carry
 * the viewer derivation, the list is space-scoped, and an instance the caller
 * cannot read is indistinguishable from one that does not exist.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  appletActionEvents,
  appletInstances,
  appletRoleBindings,
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
  type AppletActionReceipt,
  type AppletDefinition,
  type TenantId,
} from '@aflow/schemas';
import { appletsRoutes } from './applets.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const baseDefinition = {
  appletKey: 'work-board',
  version: 1,
  name: 'Work Board',
  description: 'A shared work item',
  semanticDescription: 'A board people and the agent operate together',
  roles: [{ id: 'driver', description: 'Keeps the board moving' }],
  stateSchema: {
    type: 'object',
    properties: {
      budget: { type: 'number' },
      notes: { type: 'object', additionalProperties: { type: 'string' } },
      closed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  initialState: { budget: 0, notes: {}, closed: false },
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
        template: [{ op: 'replace' as const, path: '/state/budget', valueFrom: '/input/amount' }],
      },
    },
    {
      name: 'edit_notes',
      description: 'Edit notes freely',
      inputSchema: { type: 'object' },
      patch: 'actor_supplied' as const,
    },
    {
      name: 'close_board',
      description: 'Close the board',
      inputSchema: { type: 'object', additionalProperties: false },
      patch: { template: [{ op: 'replace' as const, path: '/state/closed', value: true }] },
      ends: true,
    },
  ],
};

const definition: AppletDefinition = AppletDefinitionSchema.parse(baseDefinition);

/** Structurally valid definition whose initialState violates its own stateSchema. */
const invalidInitialStateDefinition: AppletDefinition = AppletDefinitionSchema.parse({
  ...baseDefinition,
  initialState: { budget: 'not-a-number', notes: {}, closed: false },
});

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

describeDb('applet instance routes (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const rawSql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  const spaceA = randomUUID();
  const spaceB = randomUUID();
  const ownerA = randomUUID();
  const editorA = randomUUID();
  const viewerA = randomUUID();
  const ownerB = randomUUID();
  const testUserIds = [ownerA, editorA, viewerA, ownerB];

  const artifactA = randomUUID();
  const versionA = randomUUID();
  const artifactBad = randomUUID();
  const versionBad = randomUUID();
  const artifactPlain = randomUUID();
  const versionPlain = randomUUID();
  const artifactB = randomUUID();
  const versionB = randomUUID();
  const hashA = `sha256:${randomUUID()}`;
  const hashBad = `sha256:${randomUUID()}`;
  const hashB = `sha256:${randomUUID()}`;

  let schemaReady = false;
  let app: FastifyInstance;

  async function loadSpaceAttributes(
    spaceId: string,
  ): Promise<{ ownerId: string | null; memberCount: number } | null> {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
    );
    const row = rows[0];
    if (row === undefined) return null;
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.tenantId, TENANT_ID), eq(spaceMemberships.spaceId, spaceId)));
    return { ownerId: row.ownerId, memberCount: countRows[0]?.count ?? 0 };
  }

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

    // Mirrors the authz plugin's requirePermission: real checkPermission over
    // real membership rows, 403 on deny.
    instance.decorate(
      'requirePermission',
      (opts: {
        resource: AuthzResourceType;
        action: AuthzAction;
        getResourceId?: (request: FastifyRequest) => string | undefined;
        getSpaceId?: (request: FastifyRequest) => string | undefined;
      }) =>
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
          const { userId } = (request as unknown as { authUser: { userId: string } }).authUser;
          const spaceId = opts.getSpaceId?.(request);
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
              loadSpaceAttributes,
            },
            {
              resource: opts.resource,
              action: opts.action,
              ...(spaceId !== undefined ? { spaceId } : {}),
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
      (request as unknown as { requireSpace: () => Promise<{ spaceId: string }> }).requireSpace =
        async () => {
          const spaceId = request.headers['x-space-id'];
          if (typeof spaceId !== 'string' || spaceId.length === 0) {
            throw new Error('test request missing x-space-id header');
          }
          return { spaceId };
        };
    });

    await instance.register(appletsRoutes, { prefix: '/v1/applets' });
    await instance.ready();
    return instance;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      const instanceRows = await tx
        .select({ id: appletInstances.id })
        .from(appletInstances)
        .where(inArray(appletInstances.spaceId, [spaceA, spaceB]));
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
        .where(inArray(uiArtifactVersions.id, [versionA, versionBad, versionPlain, versionB]));
      await tx
        .delete(uiArtifacts)
        .where(inArray(uiArtifacts.id, [artifactA, artifactBad, artifactPlain, artifactB]));
      await tx.delete(memoryDocs).where(inArray(memoryDocs.spaceId, [spaceA, spaceB]));
      await tx.delete(memoryDirs).where(inArray(memoryDirs.spaceId, [spaceA, spaceB]));
      await tx.delete(spaces).where(inArray(spaces.id, [spaceA, spaceB]));
    });
    await db.delete(spaceMemberships).where(inArray(spaceMemberships.spaceId, [spaceA, spaceB]));
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
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = ${TENANT_SCHEMA} AND table_name = 'applet_instances'
      ) AS ok`;
    schemaReady = rows[0]?.ok === true;
    if (!schemaReady) return;

    await db.insert(users).values([
      { id: ownerA, displayName: 'Applet Owner A' },
      { id: editorA, displayName: 'Applet Editor A' },
      { id: viewerA, displayName: 'Applet Viewer A' },
      { id: ownerB, displayName: 'Applet Owner B' },
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
      { tenantId: TENANT_ID, spaceId: spaceA, userId: ownerA, role: 'admin' },
      { tenantId: TENANT_ID, spaceId: spaceA, userId: editorA, role: 'editor' },
      { tenantId: TENANT_ID, spaceId: spaceA, userId: viewerA, role: 'viewer' },
      { tenantId: TENANT_ID, spaceId: spaceB, userId: ownerB, role: 'admin' },
    ]);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceA,
          name: 'Applet Routes A',
          slug: `applet-routes-a-${randomUUID().slice(0, 8)}`,
          ownerId: ownerA,
        },
        {
          id: spaceB,
          name: 'Applet Routes B',
          slug: `applet-routes-b-${randomUUID().slice(0, 8)}`,
          ownerId: ownerB,
        },
      ]);
      await tx.insert(uiArtifacts).values(
        [
          { id: artifactA, spaceId: spaceA, kind: 'applet' },
          { id: artifactBad, spaceId: spaceA, kind: 'applet' },
          { id: artifactPlain, spaceId: spaceA, kind: 'react_tsx' },
          { id: artifactB, spaceId: spaceB, kind: 'applet' },
        ].map(({ id, spaceId, kind }) => ({
          id,
          name: 'Work Board',
          kind,
          spaceId,
          currentVersion: 1,
          catalogId: 'test',
          catalogVersion: '1',
          catalogHash: 'test',
        })),
      );
      const versionSeeds: Array<{
        id: string;
        artifactId: string;
        def: AppletDefinition | null;
        hash: string | null;
      }> = [
        { id: versionA, artifactId: artifactA, def: definition, hash: hashA },
        {
          id: versionBad,
          artifactId: artifactBad,
          def: invalidInitialStateDefinition,
          hash: hashBad,
        },
        { id: versionPlain, artifactId: artifactPlain, def: null, hash: null },
        { id: versionB, artifactId: artifactB, def: definition, hash: hashB },
      ];
      await tx.insert(uiArtifactVersions).values(
        versionSeeds.map(({ id, artifactId, def, hash }) => ({
          id,
          artifactId,
          version: 1,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          ...(def !== null ? { appletDefinition: def } : {}),
          ...(hash !== null ? { definitionHash: hash } : {}),
        })),
      );
    });
    app = await buildApp();
  });

  afterAll(async () => {
    if (app) await app.close();
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

  function instantiate(userId: string, spaceId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/applets',
      headers: { 'x-test-user': userId, 'x-space-id': spaceId },
      payload,
    });
  }

  async function createInstance(opts?: {
    userId?: string;
    spaceId?: string;
    versionId?: string;
    roles?: Array<{ userId: string; role: string }>;
  }): Promise<string> {
    const res = await instantiate(opts?.userId ?? ownerA, opts?.spaceId ?? spaceA, {
      artifactVersionId: opts?.versionId ?? versionA,
      ...(opts?.roles !== undefined ? { roles: opts.roles } : {}),
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { instance: { instanceId: string } }).instance.instanceId;
  }

  function act(userId: string, instanceId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/v1/applets/${instanceId}/actions`,
      headers: { 'x-test-user': userId },
      payload,
    });
  }

  function getInstance(userId: string, instanceId: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/applets/${instanceId}`,
      headers: { 'x-test-user': userId },
    });
  }

  function setBudget(amount: number, overrides?: Record<string, unknown>) {
    return {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount },
      ...overrides,
    };
  }

  it('instantiates from a published artifact version: instance row, initial state, version 1', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await instantiate(ownerA, spaceA, { artifactVersionId: versionA });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      instance: Record<string, unknown>;
      state: unknown;
      stateVersion: number;
    };
    expect(body.instance).toMatchObject({
      spaceId: spaceA,
      appletKey: 'work-board',
      definitionHash: hashA,
      artifactVersionId: versionA,
      status: 'active',
      createdBy: ownerA,
    });
    expect(body.state).toEqual({ budget: 0, notes: {}, closed: false });
    expect(body.stateVersion).toBe(1);

    const got = await getInstance(ownerA, body.instance['instanceId'] as string);
    expect(got.statusCode).toBe(200);
    const gotBody = got.json() as { state: unknown; stateVersion: number; recentReceipts: unknown };
    expect(gotBody.state).toEqual({ budget: 0, notes: {}, closed: false });
    expect(gotBody.stateVersion).toBe(1);
    expect(gotBody.recentReceipts).toEqual([]);
  });

  it('rejects a pinned definition whose initialState violates its own stateSchema', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await instantiate(ownerA, spaceA, { artifactVersionId: versionBad });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'InvalidInitialState' });
  });

  it('refuses an unknown artifact version and a version from another space with the same 404', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const missing = await instantiate(ownerA, spaceA, { artifactVersionId: randomUUID() });
    expect(missing.statusCode).toBe(404);
    const crossSpace = await instantiate(ownerA, spaceA, { artifactVersionId: versionB });
    expect(crossSpace.statusCode).toBe(404);
    expect(crossSpace.body).toBe(missing.body);
  });

  it('rejects role bindings the definition does not declare', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await instantiate(ownerA, spaceA, {
      artifactVersionId: versionA,
      roles: [{ userId: editorA, role: 'navigator' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'UnknownRole' });
  });

  it('applies an editor action through the gateway and returns the receipt', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const res = await act(editorA, instanceId, setBudget(40000));
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      receipt: AppletActionReceipt;
      stateVersion: number;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.stateVersion).toBe(2);
    expect(body.receipt).toMatchObject({
      seq: 1,
      name: 'set_budget',
      actor: { kind: 'user', userId: editorA },
      beforeVersion: 1,
      afterVersion: 2,
    });

    const got = await getInstance(editorA, instanceId);
    expect((got.json() as { state: unknown }).state).toEqual({
      budget: 40000,
      notes: {},
      closed: false,
    });
  });

  it('gives a space viewer 403 on actions but 200 on reads', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const denied = await act(viewerA, instanceId, setBudget(5));
    expect(denied.statusCode).toBe(403);

    const got = await getInstance(viewerA, instanceId);
    expect(got.statusCode).toBe(200);
    const body = got.json() as { viewer: unknown; stateVersion: number };
    expect(body.viewer).toEqual({ userId: viewerA, spaceRole: 'viewer', appletRoles: [] });
    expect(body.stateVersion).toBe(1);
  });

  it('derives the viewer stamp per caller: space role and applet role bindings', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance({ roles: [{ userId: editorA, role: 'driver' }] });
    const asEditor = await getInstance(editorA, instanceId);
    expect(asEditor.statusCode).toBe(200);
    expect((asEditor.json() as { viewer: unknown }).viewer).toEqual({
      userId: editorA,
      spaceRole: 'editor',
      appletRoles: ['driver'],
    });

    const asOwner = await getInstance(ownerA, instanceId);
    expect((asOwner.json() as { viewer: unknown }).viewer).toEqual({
      userId: ownerA,
      spaceRole: 'admin',
      appletRoles: [],
    });
  });

  it('conflicts a stale actor-supplied baseVersion with 409 and the current version', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const advanced = await act(editorA, instanceId, setBudget(10));
    expect(advanced.statusCode).toBe(200);

    const stale = await act(editorA, instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'edit_notes',
      input: {},
      proposedPatch: [{ op: 'add', path: '/state/notes/x', value: 'stale' }],
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ currentVersion: 2 });
  });

  it('rejects an unknown action with 422 carrying the declared surface', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const res = await act(editorA, instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'burn_it',
      input: {},
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { reason: string; availableActions: string[] };
    expect(body.reason).toBe('unknown_action');
    expect(body.availableActions).toEqual(['set_budget', 'edit_notes', 'close_board', 'raw_patch']);
  });

  it('replays an identical actionId idempotently with the original receipt', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const command = setBudget(7);
    const first = await act(editorA, instanceId, command);
    const replay = await act(editorA, instanceId, command);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    const firstBody = first.json() as { receipt: unknown; stateVersion: number; replayed: boolean };
    const replayBody = replay.json() as {
      receipt: unknown;
      stateVersion: number;
      replayed: boolean;
    };
    expect(firstBody.replayed).toBe(false);
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.receipt).toEqual(firstBody.receipt);
    expect(replayBody.stateVersion).toBe(firstBody.stateVersion);
  });

  it('refuses actions on an ended instance', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const closed = await act(editorA, instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'close_board',
      input: {},
    });
    expect(closed.statusCode).toBe(200);

    const refused = await act(editorA, instanceId, setBudget(1, { baseVersion: 2 }));
    expect(refused.statusCode).toBe(422);
    expect((refused.json() as { reason: string }).reason).toBe('instance_not_active');
  });

  it('lists only the presented space — an instance in another space is invisible', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const aId = await createInstance();
    const bId = await createInstance({ userId: ownerB, spaceId: spaceB, versionId: versionB });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/applets',
      headers: { 'x-test-user': ownerA, 'x-space-id': spaceA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { applets: Array<{ instanceId: string }>; total: number };
    const ids = body.applets.map((item) => item.instanceId);
    expect(ids).toContain(aId);
    expect(ids).not.toContain(bId);
    expect(body.total).toBe(ids.length);
  });

  it('instantiates from artifactId by resolving the current published version server-side', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const res = await instantiate(ownerA, spaceA, { artifactId: artifactA });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { instance: Record<string, unknown> };
    expect(body.instance).toMatchObject({
      appletKey: 'work-board',
      artifactVersionId: versionA,
      definitionHash: hashA,
    });
  });

  it('rejects a body carrying both or neither of artifactId and artifactVersionId', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const both = await instantiate(ownerA, spaceA, {
      artifactId: artifactA,
      artifactVersionId: versionA,
    });
    expect(both.statusCode).toBe(400);
    const neither = await instantiate(ownerA, spaceA, {});
    expect(neither.statusCode).toBe(400);
  });

  it('lists installed applet definitions with live counts behind ?include=installed', async (ctx) => {
    if (!requireSchema(ctx)) return;
    await createInstance();

    const withoutInclude = await app.inject({
      method: 'GET',
      url: '/v1/applets',
      headers: { 'x-test-user': ownerA, 'x-space-id': spaceA },
    });
    expect(withoutInclude.statusCode).toBe(200);
    expect(withoutInclude.json()).not.toHaveProperty('installed');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/applets?include=installed',
      headers: { 'x-test-user': ownerA, 'x-space-id': spaceA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      installed?: Array<{
        artifactId: string;
        appletKey: string;
        name: string;
        description?: string;
        liveInstances: number;
      }>;
    };
    const installed = body.installed ?? [];
    const ids = installed.map((item) => item.artifactId);
    expect(ids).toContain(artifactA);
    // Carries a definition (instantiation later fails on initialState) — still installed.
    expect(ids).toContain(artifactBad);
    // No applet definition on the current version — never appears.
    expect(ids).not.toContain(artifactPlain);
    // Other space's artifact is invisible.
    expect(ids).not.toContain(artifactB);

    const entryA = installed.find((item) => item.artifactId === artifactA)!;
    expect(entryA).toMatchObject({ appletKey: 'work-board', name: 'Work Board' });
    expect(entryA.description).toBe('A board people and the agent operate together');
    // Every active instance in this space pins a version of artifactA, so the
    // live count equals the active-instance total the same response reports.
    expect(entryA.liveInstances).toBe(body.total);
    expect(entryA.liveInstances).toBeGreaterThanOrEqual(1);

    const entryBad = installed.find((item) => item.artifactId === artifactBad)!;
    expect(entryBad.liveInstances).toBe(0);
  });

  it('masks a cross-space instance as 404 — byte-identical to a missing one', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const bId = await createInstance({ userId: ownerB, spaceId: spaceB, versionId: versionB });

    const got = await getInstance(editorA, bId);
    expect(got.statusCode).toBe(404);
    const acted = await act(editorA, bId, setBudget(1));
    expect(acted.statusCode).toBe(404);

    const missing = await getInstance(editorA, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(got.body).toBe(missing.body);
    expect(acted.body).toBe(missing.body);

    const ownRead = await getInstance(ownerB, bId);
    expect(ownRead.statusCode).toBe(200);
  });
});
