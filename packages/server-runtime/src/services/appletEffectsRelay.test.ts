/**
 * Post-commit effects relay over the real gateway + real DB outbox: notable
 * actions narrate into the bound room exactly once (idempotent on actionId),
 * agent actors are never forged into room messages, waking actions land one
 * boundary wake with waking_action focus, and pending effects survive a crash
 * to be re-driven by the next action or a replay.
 */
import { APPLET_EFFECT_MAX_ATTEMPTS } from '@aflow/schemas';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
  eventLog,
  idempotencyKeys,
  memoryDocs,
  memoryDirs,
  sessions,
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
import { getAppletFocus, setSessionState, setStepState } from '@aflow/redis';
import {
  AppletDefinitionSchema,
  StreamKeys,
  type AppletActionReceipt,
  type AppletDefinition,
  type AppletEffectDelivery,
  type SystemRole,
  type TenantId,
} from '@aflow/schemas';
import { appletsRoutes } from '../routes/applets.js';
import {
  appletRoomMessageEventId,
  createAppletEffectsRelay,
  type AppletEffectsRelayDeps,
} from './appletEffectsRelay.js';
import {
  createSessionService,
  postRoomMessageDirect,
  type DirectRoomMessageInput,
  type ResumeSessionRequest,
} from './sessions.js';
import type { AppContext } from './context.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const TENANT_SCHEMA = `t_${TENANT_ID.replace(/-/g, '')}`;

const describeDb = DATABASE_URL ? describe : describe.skip;

const definition: AppletDefinition = AppletDefinitionSchema.parse({
  appletKey: 'relay-board',
  version: 1,
  name: 'Relay Board',
  description: 'Board exercising post-commit effects',
  semanticDescription: 'A shared object whose actions narrate and wake',
  stateSchema: {
    type: 'object',
    properties: { budget: { type: 'number' }, note: { type: 'string' } },
    additionalProperties: false,
  },
  initialState: { budget: 0, note: '' },
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
      name: 'flag_blocker',
      description: 'Flag a blocker',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      patch: {
        template: [{ op: 'replace' as const, path: '/state/note', valueFrom: '/input/text' }],
      },
      notable: true,
    },
    {
      name: 'call_agent',
      description: 'Ask the agent to look at the board',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      patch: {
        template: [{ op: 'replace' as const, path: '/state/note', valueFrom: '/input/text' }],
      },
      wakes: true,
    },
  ],
});

interface FakeStreamEntry {
  id: string;
  fields: string[];
}

/** The handful of commands the room/wake machinery touches, in memory. */
function createFakeRedis() {
  const kv = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const streams = new Map<string, FakeStreamEntry[]>();
  const sets = new Map<string, Set<string>>();
  let streamSeq = 0;

  function hashFor(key: string): Map<string, string> {
    let h = hashes.get(key);
    if (!h) {
      h = new Map();
      hashes.set(key, h);
    }
    return h;
  }
  function applyHset(key: string, args: unknown[]): number {
    const h = hashFor(key);
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      for (const [field, value] of Object.entries(args[0] as Record<string, unknown>)) {
        h.set(field, String(value));
      }
    } else {
      for (let i = 0; i + 1 < args.length; i += 2) {
        h.set(String(args[i]), String(args[i + 1]));
      }
    }
    return h.size;
  }
  function removeKey(key: string): boolean {
    const had = kv.has(key) || hashes.has(key) || streams.has(key);
    kv.delete(key);
    hashes.delete(key);
    streams.delete(key);
    return had;
  }

  const fake = {
    async get(key: string) {
      return kv.get(key) ?? null;
    },
    async set(key: string, value: string) {
      kv.set(key, value);
      return 'OK';
    },
    async del(...keys: string[]) {
      return keys.filter(removeKey).length;
    },
    async exists(...keys: string[]) {
      return keys.filter((key) => kv.has(key) || hashes.has(key) || streams.has(key)).length;
    },
    async expire() {
      return 1;
    },
    async hgetall(key: string) {
      return Object.fromEntries(hashes.get(key) ?? new Map<string, string>());
    },
    async hget(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async hset(key: string, ...args: unknown[]) {
      return applyHset(key, args);
    },
    async hincrby(key: string, field: string, by: number) {
      const h = hashFor(key);
      const next = (Number.parseInt(h.get(field) ?? '0', 10) || 0) + by;
      h.set(field, String(next));
      return next;
    },
    async incr(key: string) {
      const next = (Number.parseInt(kv.get(key) ?? '0', 10) || 0) + 1;
      kv.set(key, String(next));
      return next;
    },
    // Lua no-op: nothing here asserts what a script wrote.
    async eval(
      _script: string,
      _numKeys: number,
      dirtySet: string,
      stateKey: string,
      member: string,
    ) {
      const set = sets.get(dirtySet) ?? new Set<string>();
      set.add(member);
      sets.set(dirtySet, set);
      const h = hashes.get(stateKey);
      if (h) h.set('flushedToDb', 'false');
      return 1;
    },
    async xadd(key: string, ...args: unknown[]) {
      const starIdx = args.indexOf('*');
      const fields = args.slice(starIdx + 1).map(String);
      const entries = streams.get(key) ?? [];
      streamSeq += 1;
      const id = `${streamSeq}-0`;
      entries.push({ id, fields });
      streams.set(key, entries);
      return id;
    },
    async publish() {
      return 0;
    },
    pipeline() {
      // Per-command results, because appendSessionEvent reads its XADD id out
      // of exec()'s reply — a fake returning [] makes every append look failed.
      const ops: Array<() => Promise<unknown> | unknown> = [];
      const chain = {
        del(key: string) {
          ops.push(() => void removeKey(key));
          return chain;
        },
        hset(key: string, ...args: unknown[]) {
          ops.push(() => void applyHset(key, args));
          return chain;
        },
        xadd(key: string, ...args: unknown[]) {
          ops.push(() => fake.xadd(key, ...args));
          return chain;
        },
        expire() {
          ops.push(() => undefined);
          return chain;
        },
        // Candidate-index arming rides every session write; these tests assert
        // none of it, so the members can vanish.
        zadd() {
          ops.push(() => undefined);
          return chain;
        },
        zrem() {
          ops.push(() => undefined);
          return chain;
        },
        zincrby() {
          ops.push(() => undefined);
          return chain;
        },
        sadd() {
          ops.push(() => undefined);
          return chain;
        },
        async exec() {
          const results: Array<[null, unknown]> = [];
          for (const op of ops) results.push([null, await op()]);
          return results;
        },
      };
      return chain;
    },
    // The session-state rewrite is DEL-then-HSET and must be atomic against
    // readers; a serial fake has no concurrent readers, so the pipeline shape
    // is equivalent here.
    multi() {
      return fake.pipeline();
    },
  };
  return { redis: fake as unknown as Redis, kv, hashes, streams };
}

function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) obj[key] = value;
  }
  return obj;
}

function authzFakeRedis(): Redis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    },
  } as unknown as Redis;
}

describeDb('applet effects relay (real DB)', () => {
  const handle = createDatabase({ connectionString: DATABASE_URL ?? '' });
  const db = handle.db;
  const rawSql = handle.sql;
  const tenantCtx = createTenantContext(TENANT_ID as TenantId);

  const spaceA = randomUUID();
  const ownerA = randomUUID();
  const editorA = randomUUID();
  const testUserIds = [ownerA, editorA];

  const artifactA = randomUUID();
  const versionA = randomUUID();
  const hashA = `sha256:${randomUUID()}`;

  const fake = createFakeRedis();
  const createdSessionIds: string[] = [];

  const postCalls: DirectRoomMessageInput[] = [];
  const resumeCalls: ResumeSessionRequest[] = [];
  const focusAtResume: Array<string | null> = [];
  const relayLogs: Array<{ message: string; err?: unknown }> = [];
  let failNextPost = false;
  let failPostsRemaining = 0;

  let schemaReady = false;
  let app: FastifyInstance;
  let defaultRelayApp: FastifyInstance;

  async function loadSpaceAttributes(
    spaceId: string,
  ): Promise<{ ownerId: string | null; memberCount: number } | null> {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.select({ ownerId: spaces.ownerId }).from(spaces).where(eq(spaces.id, spaceId)).limit(1),
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { ownerId: row.ownerId, memberCount: 2 };
  }

  function buildRelayDeps(): AppletEffectsRelayDeps {
    const sessionService = createSessionService({
      db,
      sql: rawSql,
      redis: fake.redis,
      payloadStore: null,
      pubsubPublisher: null,
      pubsubSubscriber: null,
      redisUrl: null,
      isMock: false,
    } as AppContext);
    return {
      db,
      redis: fake.redis,
      persistenceFor: (tenantId) => createAppletPersistence(db, createTenantContext(tenantId)),
      postRoomMessage: async (input) => {
        if (failNextPost) {
          failNextPost = false;
          failPostsRemaining = 0;
          throw new Error('poster crashed');
        }
        if (failPostsRemaining > 0) {
          failPostsRemaining -= 1;
          throw new Error('poster crashed');
        }
        postCalls.push(input);
        return postRoomMessageDirect(fake.redis, db, input);
      },
      resumeSession: async (request) => {
        focusAtResume.push(
          fake.kv.get(StreamKeys.sessionAppletFocusKey(TENANT_ID, request.sessionId)) ?? null,
        );
        resumeCalls.push(request);
        return sessionService.resumeSession(request);
      },
      log: (message, err) => {
        relayLogs.push({ message, err });
      },
    };
  }

  async function buildApp(options: { injectRelay: boolean }): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    (instance as unknown as { appContext: unknown }).appContext = {
      db,
      redis: options.injectRelay ? fake.redis : null,
    };

    instance.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
      const userId = request.headers['x-test-user'];
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new Error('test request missing x-test-user header');
      }
      (request as unknown as { authUser: unknown }).authUser = {
        userId,
        roles: [],
        authMethod: 'dev_bypass',
        isServicePrincipal: false,
      };
    });

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
              redis: authzFakeRedis(),
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

    await instance.register(appletsRoutes, {
      prefix: '/v1/applets',
      ...(options.injectRelay ? { effectsRelay: createAppletEffectsRelay(buildRelayDeps()) } : {}),
    });
    await instance.ready();
    return instance;
  }

  async function cleanup(): Promise<void> {
    await withTenantSchema(db, tenantCtx, async (tx) => {
      const instanceRows = await tx
        .select({ id: appletInstances.id })
        .from(appletInstances)
        .where(eq(appletInstances.spaceId, spaceA));
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
      if (createdSessionIds.length > 0) {
        await tx.delete(eventLog).where(inArray(eventLog.sessionId, createdSessionIds));
        await tx
          .delete(idempotencyKeys)
          .where(inArray(idempotencyKeys.sessionId, createdSessionIds));
        await tx.delete(sessions).where(inArray(sessions.sessionId, createdSessionIds));
      }
      await tx.delete(uiArtifactVersions).where(eq(uiArtifactVersions.id, versionA));
      await tx.delete(uiArtifacts).where(eq(uiArtifacts.id, artifactA));
      await tx.delete(memoryDocs).where(eq(memoryDocs.spaceId, spaceA));
      await tx.delete(memoryDirs).where(eq(memoryDirs.spaceId, spaceA));
      await tx.delete(spaces).where(eq(spaces.id, spaceA));
    });
    await db.delete(spaceMemberships).where(eq(spaceMemberships.spaceId, spaceA));
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
      { id: ownerA, displayName: 'Relay Owner' },
      { id: editorA, displayName: 'Relay Editor' },
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
    ]);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(spaces).values([
        {
          id: spaceA,
          name: 'Effects Relay',
          slug: `effects-relay-${randomUUID().slice(0, 8)}`,
          ownerId: ownerA,
        },
      ]);
      await tx.insert(uiArtifacts).values([
        {
          id: artifactA,
          name: 'Relay Board',
          kind: 'applet',
          spaceId: spaceA,
          currentVersion: 1,
          catalogId: 'test',
          catalogVersion: '1',
          catalogHash: 'test',
        },
      ]);
      await tx.insert(uiArtifactVersions).values([
        {
          id: versionA,
          artifactId: artifactA,
          version: 1,
          sourceRef: 'inline:test',
          contentHash: 'test',
          prompt: 'test fixture',
          appletDefinition: definition,
          definitionHash: hashA,
        },
      ]);
    });
    app = await buildApp({ injectRelay: true });
    defaultRelayApp = await buildApp({ injectRelay: false });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (defaultRelayApp) await defaultRelayApp.close();
    if (schemaReady) await cleanup();
    await handle.close();
  });

  beforeEach(() => {
    postCalls.length = 0;
    resumeCalls.length = 0;
    focusAtResume.length = 0;
    relayLogs.length = 0;
    failNextPost = false;
  });

  function requireSchema(ctx: TestContext): boolean {
    if (!schemaReady) {
      ctx.skip(`tenant schema ${TENANT_SCHEMA} not migrated — run \`yarn db:migrate\``);
      return false;
    }
    return true;
  }

  async function createInstance(target: FastifyInstance = app): Promise<string> {
    const res = await target.inject({
      method: 'POST',
      url: '/v1/applets',
      headers: { 'x-test-user': ownerA, 'x-space-id': spaceA },
      payload: { artifactVersionId: versionA },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { instance: { instanceId: string } }).instance.instanceId;
  }

  function act(
    instanceId: string,
    payload: Record<string, unknown>,
    target: FastifyInstance = app,
  ) {
    return target.inject({
      method: 'POST',
      url: `/v1/applets/${instanceId}/actions`,
      headers: { 'x-test-user': editorA },
      payload,
    });
  }

  async function bindSession(
    instanceId: string,
    options?: { seedHotState?: boolean; pausedOperationId?: string },
  ): Promise<{ sessionId: string; stepExecutionId: string }> {
    const sessionId = randomUUID();
    const stepExecutionId = randomUUID();
    createdSessionIds.push(sessionId);
    await withTenantSchema(db, tenantCtx, async (tx) => {
      await tx.insert(sessions).values({
        sessionId,
        targetKind: 'platform-role',
        targetSystemRole: 'helmsman',
        agentVersion: '1',
        status: 'PAUSED',
        spaceId: spaceA,
      });
      await tx
        .update(appletInstances)
        .set({ boundSessionId: sessionId })
        .where(eq(appletInstances.id, instanceId));
    });
    if (options?.seedHotState !== false) {
      await setSessionState(fake.redis, {
        sessionId,
        tenantId: TENANT_ID,
        target: { kind: 'platform-role', systemRole: 'helmsman' as SystemRole },
        agentVersion: '1',
        status: 'PAUSED',
        currentStepExecutionId: stepExecutionId,
        createdAt: Date.now(),
        lastUpdatedAt: Date.now(),
        spaceId: spaceA,
      });
      await setStepState(fake.redis, {
        stepExecutionId,
        tenantId: TENANT_ID,
        sessionId,
        stepId: 'agent-turn',
        stepType: 'ai',
        operationId: options?.pausedOperationId ?? 'ai.agent.turn',
        attempt: 1,
        status: 'PAUSED',
        scheduledAt: Date.now(),
        inputRef: 'inline:e30=',
        idempotencyKey: randomUUID(),
      });
    }
    return { sessionId, stepExecutionId };
  }

  function roomMessages(sessionId: string): Array<Record<string, unknown>> {
    const entries = fake.streams.get(StreamKeys.sessionEventsStream(TENANT_ID, sessionId)) ?? [];
    return entries
      .map((entry) => fieldsToObject(entry.fields))
      .filter((event) => event['eventType'] === 'RoomMessage')
      .map((event) => JSON.parse(event['metadata'] ?? '{}') as Record<string, unknown>);
  }

  function controlResumes(sessionId: string): Array<Record<string, string>> {
    const resumes: Array<Record<string, string>> = [];
    for (const entries of fake.streams.values()) {
      for (const entry of entries) {
        const obj = fieldsToObject(entry.fields);
        if (obj['type'] === 'resume_run' && obj['runId'] === sessionId) resumes.push(obj);
      }
    }
    return resumes;
  }

  async function readDeliveries(
    instanceId: string,
    actionId: string,
  ): Promise<AppletEffectDelivery[]> {
    const rows = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ deliveredEffects: appletActionEvents.deliveredEffects })
        .from(appletActionEvents)
        .where(
          and(
            eq(appletActionEvents.instanceId, instanceId),
            eq(appletActionEvents.actionId, actionId),
          ),
        )
        .limit(1),
    );
    return rows[0]?.deliveredEffects ?? [];
  }

  async function resetToPending(
    instanceId: string,
    actionId: string,
    effect: 'notable' | 'waking',
  ) {
    await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .update(appletActionEvents)
        .set({ deliveredEffects: [{ effect, status: 'pending' }] })
        .where(
          and(
            eq(appletActionEvents.instanceId, instanceId),
            eq(appletActionEvents.actionId, actionId),
          ),
        ),
    );
  }

  it('narrates a notable action into the bound room as one attributed message', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'ship blocked' },
      outcome: 'moved "Ship it" to Done',
    });
    expect(res.statusCode).toBe(200);
    expect(relayLogs).toEqual([]);

    const messages = roomMessages(sessionId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      actorUserId: editorA,
      actorDisplayName: 'Relay Editor',
      body: 'flag_blocker — moved "Ship it" to Done',
      clientMessageId: `applet:${actionId}`,
      wakeHelmsman: false,
    });

    const durable = await withTenantSchema(db, tenantCtx, async (tx) =>
      tx
        .select({ eventId: eventLog.eventId })
        .from(eventLog)
        .where(eq(eventLog.eventId, appletRoomMessageEventId(instanceId, actionId)))
        .limit(1),
    );
    expect(durable).toHaveLength(1);

    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'posted' },
    ]);
  });

  it('re-drives a posted-but-unmarked notable without posting twice', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    const actionId = randomUUID();
    await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'first' },
    });
    expect(roomMessages(sessionId)).toHaveLength(1);
    expect(postCalls).toHaveLength(1);

    // Crash window: the post landed, the mark did not.
    await resetToPending(instanceId, actionId, 'notable');

    const followUp = await act(instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 5 },
    });
    expect(followUp.statusCode).toBe(200);

    expect(roomMessages(sessionId)).toHaveLength(1);
    expect(postCalls).toHaveLength(1);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'posted' },
    ]);
  });

  it('skips agent-actor effects: no forged room message, no self-wake', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    const agentActionId = randomUUID();
    await withTenantSchema(db, tenantCtx, async (tx) =>
      tx.insert(appletActionEvents).values({
        instanceId,
        seq: 1,
        actionId: agentActionId,
        actorUserId: null,
        actorAgentRole: 'helmsman',
        actionName: 'flag_blocker',
        input: {},
        patch: [],
        outcome: null,
        effects: { notable: true, waking: true, ending: false },
        beforeVersion: 1,
        afterVersion: 1,
        deliveredEffects: [
          { effect: 'notable', status: 'pending' },
          { effect: 'waking', status: 'pending' },
        ],
        createdAt: new Date(),
      }),
    );

    const res = await act(instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 1 },
    });
    expect(res.statusCode).toBe(200);

    expect(roomMessages(sessionId)).toHaveLength(0);
    expect(postCalls).toHaveLength(0);
    expect(resumeCalls).toHaveLength(0);
    expect(await readDeliveries(instanceId, agentActionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'skipped_agent_actor' },
      { effect: 'waking', status: 'delivered', outcome: 'skipped_agent_actor' },
    ]);
  });

  it('wakes a session paused at its agent turn once, focus stamped before the resume', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId, stepExecutionId } = await bindSession(instanceId);

    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'call_agent',
      input: { text: 'your move' },
    });
    expect(res.statusCode).toBe(200);
    const receipt = (res.json() as { receipt: AppletActionReceipt }).receipt;

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      sessionId,
      stepExecutionId,
      input: {},
      idempotencyKey: `appletwake:${actionId}`,
    });
    // The §4.9 landing rule: the turn the wake starts must already know which
    // instance nominated it.
    expect(focusAtResume[0]).not.toBeNull();

    const focus = await getAppletFocus(fake.redis, TENANT_ID, sessionId);
    expect(focus).toMatchObject({
      sessionId,
      instanceId,
      source: 'waking_action',
      version: receipt.afterVersion,
    });

    expect(controlResumes(sessionId)).toHaveLength(1);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'woke' },
    ]);
  });

  it('coalesces a burst of waking actions into one boundary wake', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    const wake1 = randomUUID();
    const wake2 = randomUUID();
    const wake3 = randomUUID();
    for (const actionId of [wake1, wake2, wake3]) {
      const res = await act(instanceId, {
        actionId,
        baseVersion: 1,
        name: 'call_agent',
        input: { text: `wake ${actionId.slice(0, 8)}` },
      });
      expect(res.statusCode).toBe(200);
    }

    expect(resumeCalls).toHaveLength(1);
    expect(controlResumes(sessionId)).toHaveLength(1);
    expect(await readDeliveries(instanceId, wake1)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'woke' },
    ]);
    expect(await readDeliveries(instanceId, wake2)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'coalesced' },
    ]);
    expect(await readDeliveries(instanceId, wake3)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'coalesced' },
    ]);
  });

  it('marks a waking action with no bound session attention_only', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();

    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'call_agent',
      input: { text: 'nobody home' },
    });
    expect(res.statusCode).toBe(200);

    expect(resumeCalls).toHaveLength(0);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'attention_only' },
    ]);
  });

  it('never resurrects a bound session whose hot state is gone', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    await bindSession(instanceId, { seedHotState: false });

    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'call_agent',
      input: { text: 'cold room' },
    });
    expect(res.statusCode).toBe(200);

    expect(resumeCalls).toHaveLength(0);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'attention_only' },
    ]);
  });

  it('coalesces a wake parked on a pause that is not the agent turn', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    await bindSession(instanceId, { pausedOperationId: 'user.input.request' });

    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'call_agent',
      input: { text: 'waiting on approval' },
    });
    expect(res.statusCode).toBe(200);

    expect(resumeCalls).toHaveLength(0);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'waking', status: 'delivered', outcome: 'coalesced' },
    ]);
  });

  it('leaves effects pending on relay failure and re-drives them on the next action', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    failNextPost = true;
    const actionId = randomUUID();
    const res = await act(instanceId, {
      actionId,
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'first try dies' },
    });
    // The action committed — the response never fails over fanout.
    expect(res.statusCode).toBe(200);
    expect(roomMessages(sessionId)).toHaveLength(0);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'notable', status: 'pending' },
    ]);

    const followUp = await act(instanceId, {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'set_budget',
      input: { amount: 9 },
    });
    expect(followUp.statusCode).toBe(200);

    expect(roomMessages(sessionId)).toHaveLength(1);
    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'posted' },
    ]);
  });

  it('abandons a poison effect as failed after max attempts, unblocking later effects', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    // Every post attempt for this drain and the next four dies — a
    // deterministic unclassified error, the queue-starving shape.
    failPostsRemaining = APPLET_EFFECT_MAX_ATTEMPTS;
    const poisonId = randomUUID();
    const first = await act(instanceId, {
      actionId: poisonId,
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'poison' },
    });
    expect(first.statusCode).toBe(200);

    // Drains 2..5: each later action retries the poison first and aborts.
    for (let round = 0; round < APPLET_EFFECT_MAX_ATTEMPTS - 1; round += 1) {
      const res = await act(instanceId, {
        actionId: randomUUID(),
        baseVersion: 1,
        name: 'set_budget',
        input: { amount: round + 1 },
      });
      expect(res.statusCode).toBe(200);
    }

    // The fifth attempt abandoned it — and the queue is unblocked: a fresh
    // notable behind it now posts.
    expect(await readDeliveries(instanceId, poisonId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'failed' },
    ]);
    const unblocked = randomUUID();
    const after = await act(instanceId, {
      actionId: unblocked,
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'flows again' },
    });
    expect(after.statusCode).toBe(200);
    expect(roomMessages(sessionId)).toHaveLength(1);
    expect(await readDeliveries(instanceId, unblocked)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'posted' },
    ]);
  });

  it('replaying a command re-drives only outstanding effects', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance();
    const { sessionId } = await bindSession(instanceId);

    const command = {
      actionId: randomUUID(),
      baseVersion: 1,
      name: 'flag_blocker',
      input: { text: 'replay me' },
    };
    const first = await act(instanceId, command);
    expect(first.statusCode).toBe(200);
    expect(postCalls).toHaveLength(1);

    const replay = await act(instanceId, command);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { replayed: boolean }).replayed).toBe(true);
    // Delivered means delivered — a replay does not re-drive it.
    expect(postCalls).toHaveLength(1);
    expect(roomMessages(sessionId)).toHaveLength(1);

    // But an outstanding effect (crash before the mark) is re-driven by replay.
    await resetToPending(instanceId, command.actionId, 'notable');
    const secondReplay = await act(instanceId, command);
    expect(secondReplay.statusCode).toBe(200);
    expect(roomMessages(sessionId)).toHaveLength(1);
    expect(await readDeliveries(instanceId, command.actionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'posted' },
    ]);
  });

  it('default route wiring marks an unbound notable attention_only', async (ctx) => {
    if (!requireSchema(ctx)) return;
    const instanceId = await createInstance(defaultRelayApp);

    const actionId = randomUUID();
    const res = await act(
      instanceId,
      { actionId, baseVersion: 1, name: 'flag_blocker', input: { text: 'no room' } },
      defaultRelayApp,
    );
    expect(res.statusCode).toBe(200);

    expect(await readDeliveries(instanceId, actionId)).toMatchObject([
      { effect: 'notable', status: 'delivered', outcome: 'attention_only' },
    ]);
  });
});
