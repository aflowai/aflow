/**
 * The operator's plan routes (Plan 322 P3). GET /v1/spaces/:spaceId/plan reads
 * the space's plans as rows and GET …/plan/roots/:rootId one plan's board
 * (Plan 332 D7), as the plan engine reads them, for a caller who may read the
 * space named in the URL, and for no other. PATCH …/plan/nodes/:nodeId closes
 * a node through the engine's update — compare-and-set on the revision the
 * operator read, a stale one refused with the node's current revision — for a
 * person who may write the space, stamped with who they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { PlanBoardOutput, PlanNode, PlanOverviewOutput, PlanTreeNode } from '@aflow/schemas';

const mockReadPlanOverview = vi.fn();
const mockReadPlanBoard = vi.fn();
const mockUpdatePlanNode = vi.fn();
const mockReadPlanNodeDetail = vi.fn();
const mockPlacePlanNode = vi.fn();
const mockCreatePlanNodeStore = vi.fn((..._args: unknown[]) => ({ store: 'tenant-store' }));
const mockOpenPlanNode = vi.fn();
const mockRequestResidentWake = vi.fn((..._args: unknown[]) => Promise.resolve('started'));
const mockReadPlanLoopMeasure = vi.fn();
const SCHEDULES = { schedules: 'resident' };

vi.mock('@aflow/cybernetic-runtime', () => ({
  readPlanOverview: (...a: unknown[]) => mockReadPlanOverview(...a),
  readPlanBoard: (...a: unknown[]) => mockReadPlanBoard(...a),
  updatePlanNode: (...a: unknown[]) => mockUpdatePlanNode(...a),
  readPlanNodeDetail: (...a: unknown[]) => mockReadPlanNodeDetail(...a),
  openPlanNode: (...a: unknown[]) => mockOpenPlanNode(...a),
  placePlanNode: (...a: unknown[]) => mockPlacePlanNode(...a),
  createPlanNodeStore: (...a: unknown[]) => mockCreatePlanNodeStore(...a),
  createResidentScheduleStore: () => SCHEDULES,
  requestResidentWake: (...a: unknown[]) => mockRequestResidentWake(...a),
  readPlanLoopMeasure: (...a: unknown[]) => mockReadPlanLoopMeasure(...a),
}));

const { planRoutes } = await import('./plan.js');

const TENANT_ID = 'a0000000-0000-4000-8000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_SPACE_ID = '00000000-0000-4000-8000-000000000003';
const ROOT_ID = '00000000-0000-4000-8000-0000000000a1';
const CHILD_ID = '00000000-0000-4000-8000-0000000000a2';
const GRANDCHILD_ID = '00000000-0000-4000-8000-0000000000a3';
const RUN_ID = '00000000-0000-4000-8000-0000000000f1';
const PR = 'https://github.com/aflowai/aflow/pull/181';
const DB = { db: 'tenant-db' };

function treeNode(
  nodeId: string,
  parentId: string | null,
  extra: Partial<PlanTreeNode> = {},
): PlanTreeNode {
  return {
    nodeId,
    parentId,
    kind: 'execute',
    title: `node ${nodeId.slice(-2)}`,
    status: 'active',
    revision: 1,
    position: 0,
    updatedAt: '2026-10-05T08:00:00.000Z',
    createdAt: '2026-10-05T07:00:00.000Z',
    goalHead: 'Ship the board.',
    counts: { runs: 0, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 0 },
    rounds: 0,
    activity: 'idle',
    children: [],
    ...extra,
  };
}

const BOARD: PlanBoardOutput = {
  root: treeNode(ROOT_ID, null, {
    noteHead: 'next: the plan page',
    counts: { runs: 0, pullRequests: 0, findings: 0, documents: 0, inFlightRuns: 1 },
    progress: { done: 1, total: 1 },
    children: [
      treeNode(CHILD_ID, ROOT_ID, {
        status: 'done',
        closedAt: '2026-10-05T10:00:00.000Z',
        counts: { runs: 2, pullRequests: 1, findings: 3, documents: 0, inFlightRuns: 0 },
        rounds: 1,
        pullRequest: { url: PR, merged: true, mergeSha: 'abc1234' },
        progress: { done: 0, total: 0 },
        children: [treeNode(GRANDCHILD_ID, CHILD_ID, { status: 'dropped' })],
      }),
    ],
  }),
  tally: {
    rootId: ROOT_ID,
    state: 'finished',
    steps: 2,
    needsYou: 0,
    inFlight: 0,
    upNext: 0,
    done: 1,
    dropped: 1,
    doneByDay: [{ day: '2026-10-05', count: 1 }],
  },
};

const ROWS: PlanOverviewOutput = {
  roots: [
    {
      nodeId: ROOT_ID,
      title: 'Plan 332',
      status: 'active',
      position: 0,
      revision: 3,
      state: 'needs_you',
      counts: { steps: 4, needsYou: 1, inFlight: 1, upNext: 1, done: 1, dropped: 0 },
      lastWrittenAt: '2026-10-05T10:00:00.000Z',
    },
    {
      nodeId: CHILD_ID,
      title: 'Plan 322',
      status: 'done',
      position: 1,
      revision: 9,
      state: 'closed',
      counts: { steps: 2, needsYou: 0, inFlight: 0, upNext: 0, done: 2, dropped: 0 },
      lastWrittenAt: '2026-10-04T10:00:00.000Z',
    },
  ],
};

/** Who is asking, which spaces they may read and write, and whether they are an agent. */
const caller = {
  authenticated: true,
  readable: new Set<string>([SPACE_ID]),
  writable: new Set<string>([SPACE_ID]),
  servicePrincipal: false,
  /** How the credential authenticated; an API key is never a person signed in. */
  authMethod: 'session',
};
const OPERATOR_ID = 'u0000000-0000-4000-8000-0000000000e1';
const REDIS = { redis: 'shared' };
const appContext: { db: unknown; redis: unknown } = { db: DB, redis: REDIS };
const audit = { record: vi.fn() };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = appContext;
  app.decorate('audit', audit);
  app.decorate('authenticate', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!caller.authenticated) {
      await reply.status(401).send({ error: 'Unauthorized', message: 'Sign in.' });
    }
  });
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
    (request as unknown as { authUser: unknown }).authUser = caller.authenticated
      ? {
          userId: OPERATOR_ID,
          authMethod: caller.authMethod,
          isServicePrincipal: caller.servicePrincipal,
        }
      : undefined;
  });
  // The central authz preHandler, as it reads a route's declaration: the
  // resource and action, and the param naming the space it is checked on.
  app.addHook('preHandler', async (request, reply) => {
    const authz = request.routeOptions.config.authz;
    if (!authz) {
      await reply.status(500).send({ error: 'Unclassified', message: 'no authz declared' });
      return;
    }
    const params = request.params as Record<string, string>;
    const spaceId = params[authz.resourceIdParam ?? 'spaceId'];
    const granted = authz.action === 'write' ? caller.writable : caller.readable;
    const allowed =
      authz.resource === 'space' &&
      (authz.action === 'read' || authz.action === 'write') &&
      authz.resourceIdFrom === 'param' &&
      spaceId !== undefined &&
      granted.has(spaceId);
    if (!allowed) {
      await reply.status(403).send({ error: 'Forbidden', message: 'Permission denied' });
    }
  });
  await app.register(planRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  caller.authenticated = true;
  caller.readable = new Set([SPACE_ID]);
  caller.writable = new Set([SPACE_ID]);
  caller.servicePrincipal = false;
  caller.authMethod = 'session';
  appContext.redis = REDIS;
  mockReadPlanOverview.mockResolvedValue(ROWS);
  mockReadPlanBoard.mockResolvedValue({ ok: true, ...BOARD });
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/spaces/:spaceId/plan', () => {
  it('returns every plan as a row with its state and its steps’ counts, and no step', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(ROWS);
    expect(JSON.stringify(res.json())).not.toContain('children');
  });

  it('reads the space in the URL through the tenant’s plan store', async () => {
    await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(mockCreatePlanNodeStore).toHaveBeenCalledWith(DB, TENANT_ID);
    expect(mockReadPlanOverview).toHaveBeenCalledWith({
      store: { store: 'tenant-store' },
      spaceId: SPACE_ID,
    });
    expect(mockReadPlanBoard).not.toHaveBeenCalled();
  });

  it('takes no done window: the rows count every step', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/plan?closedSince=${encodeURIComponent('2026-10-22T00:00:00.000Z')}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mockReadPlanOverview).not.toHaveBeenCalled();
  });

  it('answers an empty plan with no rows', async () => {
    mockReadPlanOverview.mockResolvedValue({ roots: [] });

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ roots: [] });
  });

  it('names the bound that cut a large space short', async () => {
    mockReadPlanOverview.mockResolvedValue({ ...ROWS, truncated: { bound: 'nodes', value: 2000 } });

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.json()).toMatchObject({ truncated: { bound: 'nodes', value: 2000 } });
  });

  it('refuses a space the caller may not read, and reads nothing', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${OTHER_SPACE_ID}/plan` });

    expect(res.statusCode).toBe(403);
    expect(mockReadPlanOverview).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller, and reads nothing', async () => {
    caller.authenticated = false;

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(401);
    expect(mockReadPlanOverview).not.toHaveBeenCalled();
  });

  it('refuses a space id that is not a UUID', async () => {
    caller.readable.add('not-a-space');

    const res = await app.inject({ method: 'GET', url: '/v1/spaces/not-a-space/plan' });

    expect(res.statusCode).toBe(400);
    expect(mockReadPlanOverview).not.toHaveBeenCalled();
  });
});

describe('GET /v1/spaces/:spaceId/plan/roots/:rootId', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/roots/${ROOT_ID}`;

  it('returns one plan’s board: its tree nested with counts, rounds, pull request and progress, and its tally with its state', async () => {
    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(BOARD);
  });

  it('reads the root in the URL, in the space in the URL, through the tenant’s plan store', async () => {
    await app.inject({ method: 'GET', url });

    expect(mockCreatePlanNodeStore).toHaveBeenCalledWith(DB, TENANT_ID);
    expect(mockReadPlanBoard).toHaveBeenCalledWith(
      { store: { store: 'tenant-store' }, spaceId: SPACE_ID },
      ROOT_ID,
      {},
    );
    expect(mockReadPlanOverview).not.toHaveBeenCalled();
  });

  it('hands the done window and the reader’s time zone to the engine', async () => {
    const closedSince = '2026-10-22T00:00:00.000+02:00';

    const res = await app.inject({
      method: 'GET',
      url: `${url}?closedSince=${encodeURIComponent(closedSince)}&tz=Europe%2FParis`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockReadPlanBoard).toHaveBeenCalledWith(
      { store: { store: 'tenant-store' }, spaceId: SPACE_ID },
      ROOT_ID,
      { closedSince, tz: 'Europe/Paris' },
    );
  });

  it('refuses a done window that is not an instant, and a time zone that is not one', async () => {
    for (const query of ['closedSince=yesterday', 'tz=Mars%2FOlympus', 'links=all']) {
      const res = await app.inject({ method: 'GET', url: `${url}?${query}` });
      expect(res.statusCode).toBe(400);
    }
    expect(mockReadPlanBoard).not.toHaveBeenCalled();
  });

  it('answers a root the space does not hold, or a step’s id, with 404', async () => {
    mockReadPlanBoard.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'engine words',
    });

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'PLAN_NODE_NOT_FOUND',
      message: 'This plan is not in the space any more.',
    });
  });

  it('names the bound that cut a large plan short', async () => {
    mockReadPlanBoard.mockResolvedValue({
      ok: true,
      ...BOARD,
      truncated: { bound: 'depth', value: 64 },
    });

    const res = await app.inject({ method: 'GET', url });

    expect(res.json()).toMatchObject({ truncated: { bound: 'depth', value: 64 } });
  });

  it('refuses a space the caller may not read, and reads nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${OTHER_SPACE_ID}/plan/roots/${ROOT_ID}`,
    });

    expect(res.statusCode).toBe(403);
    expect(mockReadPlanBoard).not.toHaveBeenCalled();
  });

  it('refuses a root id that is not a UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/plan/roots/not-a-root`,
    });

    expect(res.statusCode).toBe(400);
    expect(mockReadPlanBoard).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}`;

  function closedNode(extra: Partial<PlanNode> = {}): PlanNode {
    return {
      nodeId: CHILD_ID,
      spaceId: SPACE_ID,
      parentId: ROOT_ID,
      kind: 'execute',
      title: 'P3.2 operator writes',
      goal: 'The operator acts on the plan.',
      criteria: 'A node marked done from the page.',
      status: 'done',
      outcome: 'Merged.',
      revision: 4,
      position: 0,
      createdAt: '2026-10-05T08:00:00.000Z',
      updatedAt: '2026-10-05T11:00:00.000Z',
      closedAt: '2026-10-05T11:00:00.000Z',
      ...extra,
    };
  }

  function patch(body: unknown) {
    return app.inject({ method: 'PATCH', url, payload: body as Record<string, unknown> });
  }

  it('marks a node done through the engine, against the revision the operator read, stamped with who they are', async () => {
    mockUpdatePlanNode.mockResolvedValue({ ok: true, node: closedNode() });

    const res = await patch({ expectedRevision: 3, status: 'done', outcome: 'Merged.' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ node: closedNode() });
    expect(mockCreatePlanNodeStore).toHaveBeenCalledWith(DB, TENANT_ID);
    expect(mockUpdatePlanNode).toHaveBeenCalledWith(
      {
        store: { store: 'tenant-store' },
        spaceId: SPACE_ID,
        redis: REDIS,
        tenantId: TENANT_ID,
        createdBy: OPERATOR_ID,
        actorKind: 'human',
      },
      { nodeId: CHILD_ID, expectedRevision: 3, status: 'done', outcome: 'Merged.' },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: OPERATOR_ID, kind: 'human' }),
        action: 'plan.node.close',
        target: expect.objectContaining({ resourceType: 'plan_node', resourceId: CHILD_ID }),
        details: { status: 'done', revision: 4 },
      }),
    );
  });

  it('drops a node, with or without a reason', async () => {
    mockUpdatePlanNode.mockResolvedValue({
      ok: true,
      node: closedNode({ status: 'dropped', outcome: undefined }),
    });

    const res = await patch({ expectedRevision: 3, status: 'dropped' });

    expect(res.statusCode).toBe(200);
    expect(mockUpdatePlanNode.mock.calls[0]?.[1]).toEqual({
      nodeId: CHILD_ID,
      expectedRevision: 3,
      status: 'dropped',
    });
  });

  it('refuses a stale revision with the node’s current one, and writes nothing more', async () => {
    const current = {
      nodeId: CHILD_ID,
      revision: 5,
      status: 'blocked',
      updatedAt: '2026-10-05T10:30:00.000Z',
      differingFields: ['status', 'outcome'],
    };
    mockUpdatePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'engine words for the Helmsman',
      details: current,
    });

    const res = await patch({ expectedRevision: 3, status: 'done', outcome: 'Merged.' });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ error: 'PLAN_NODE_STALE', current });
    expect(body.message).toContain('revision 5');
    expect(body.message).toContain('revision 3');
    expect(body.message).not.toContain('plan.node.get');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers a node not in the space with 404, and an unchanged write with 422', async () => {
    mockUpdatePlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'No plan node.',
      details: { nodeId: CHILD_ID },
    });
    expect((await patch({ expectedRevision: 3, status: 'dropped' })).statusCode).toBe(404);

    mockUpdatePlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message: 'Already so.',
      details: {
        nodeId: CHILD_ID,
        revision: 3,
        status: 'dropped',
        updatedAt: '2026-10-05T10:30:00.000Z',
        differingFields: [],
      },
    });
    const unchanged = await patch({ expectedRevision: 3, status: 'dropped' });
    expect(unchanged.statusCode).toBe(422);
    expect(unchanged.json()).toMatchObject({
      error: 'PLAN_NODE_UNCHANGED',
      current: { revision: 3 },
    });
  });

  it('refuses done without an outcome, and anything but done or dropped, before the engine', async () => {
    expect((await patch({ expectedRevision: 3, status: 'done' })).statusCode).toBe(400);
    expect((await patch({ expectedRevision: 3, status: 'active' })).statusCode).toBe(400);
    expect((await patch({ status: 'dropped' })).statusCode).toBe(400);
    expect(
      (await patch({ expectedRevision: 3, status: 'dropped', title: 'renamed' })).statusCode,
    ).toBe(400);
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses an agent’s credential, whatever its grants: the plan page is a person’s', async () => {
    caller.servicePrincipal = true;
    caller.authMethod = 'api_key';

    const res = await patch({ expectedRevision: 3, status: 'dropped' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'operator_only' });
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses a person’s own API key: an MCP server or a script is not the operator at the page', async () => {
    caller.authMethod = 'api_key';

    const res = await patch({ expectedRevision: 3, status: 'dropped' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'operator_only' });
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses a caller who may read the space but not write it', async () => {
    caller.writable = new Set();

    const res = await patch({ expectedRevision: 3, status: 'dropped' });

    expect(res.statusCode).toBe(403);
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('says so rather than writing where the server runs without Redis', async () => {
    appContext.redis = null;

    const res = await patch({ expectedRevision: 3, status: 'dropped' });

    expect(res.statusCode).toBe(503);
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId/open (Plan 332 D6, Plan 331 D5)', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}/open`;

  function openedNode(extra: Partial<PlanNode> = {}): PlanNode {
    return {
      nodeId: CHILD_ID,
      spaceId: SPACE_ID,
      parentId: ROOT_ID,
      kind: 'execute',
      title: 'P1 — the loop takes the next node',
      goal: 'The resident takes approved work.',
      criteria: 'Three nodes land over a weekend.',
      status: 'active',
      note: 'Approved: go.\nProposed from the merged plan document.',
      revision: 5,
      position: 0,
      createdAt: '2026-10-05T08:00:00.000Z',
      updatedAt: '2026-10-05T11:00:00.000Z',
      ...extra,
    };
  }

  function open(body: unknown) {
    return app.inject({ method: 'PATCH', url, payload: body as Record<string, unknown> });
  }

  it('accepts the person’s spend ceiling and passes it to the open write', async () => {
    mockOpenPlanNode.mockResolvedValue({
      ok: true,
      node: openedNode({ spendCents: 900 }),
      from: 'blocked',
    });
    const res = await open({ expectedRevision: 4, spendCents: 900 });
    expect(res.statusCode).toBe(200);
    expect(mockOpenPlanNode).toHaveBeenCalledWith(expect.anything(), {
      nodeId: CHILD_ID,
      expectedRevision: 4,
      spendCents: 900,
    });
  });

  it.each([0, -1, 1.5, 1_000_001])('refuses an invalid spend ceiling %s', async (spendCents) => {
    expect((await open({ expectedRevision: 4, spendCents })).statusCode).toBe(400);
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });

  it('resets the spend window through the authenticated production open path', async () => {
    const { openPlanNode } = await import('../../../cybernetic-runtime/src/plan/operations.js');
    const { InMemoryPlanNodeStore } =
      await import('../../../cybernetic-runtime/src/__tests__/planStoreFake.js');
    const { default: Redis } = await import('ioredis-mock');
    const store = new InMemoryPlanNodeStore();
    store.nodes.set(CHILD_ID, { ...openedNode(), status: 'blocked', revision: 4 });
    mockOpenPlanNode.mockImplementationOnce(
      (...[context, input]: Parameters<typeof openPlanNode>) =>
        openPlanNode({ ...context, store, redis: new Redis() }, input),
    );
    const response = await open({ expectedRevision: 4 });
    expect(response.statusCode).toBe(200);
    expect(response.json().node.status).toBe('active');
    expect(mockOpenPlanNode.mock.calls[0]![0]).toMatchObject({ actorKind: 'human' });
    expect(store.openedAt.get(CHILD_ID)).toBeInstanceOf(Date);
  });

  it('moves a blocked node to active through the open write, its own audit row naming what it left', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: true, node: openedNode(), from: 'blocked' });

    const res = await open({ expectedRevision: 4, why: 'go.' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ node: openedNode() });
    expect(mockOpenPlanNode).toHaveBeenCalledWith(
      {
        store: { store: 'tenant-store' },
        spaceId: SPACE_ID,
        redis: REDIS,
        tenantId: TENANT_ID,
        createdBy: OPERATOR_ID,
        actorKind: 'human',
      },
      { nodeId: CHILD_ID, expectedRevision: 4, why: 'go.' },
    );
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: OPERATOR_ID, kind: 'human' }),
        action: 'plan.node.open',
        target: expect.objectContaining({ resourceType: 'plan_node', resourceId: CHILD_ID }),
        details: { status: 'blocked', revision: 5 },
      }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'plan.node.close' }),
    );
  });

  it('takes a why of any length the note it lands in can hold', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: true, node: openedNode(), from: 'blocked' });
    const why = 'The review read the wrong base; the fix is on main now. '.repeat(40);

    const res = await open({ expectedRevision: 4, why });

    expect(res.statusCode).toBe(200);
    expect(mockOpenPlanNode).toHaveBeenCalledWith(expect.anything(), {
      nodeId: CHILD_ID,
      expectedRevision: 4,
      why: why.trim(),
    });
  });

  it('wakes the space’s resident after the write, as any person’s write to a node does', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: true, node: openedNode(), from: 'blocked' });

    await open({ expectedRevision: 4 });

    expect(mockRequestResidentWake).toHaveBeenCalledWith(
      { redis: REDIS, schedules: SCHEDULES },
      { tenantId: TENANT_ID, spaceId: SPACE_ID, cause: 'node_written' },
    );
  });

  it('is not the close: a body naming a status is refused, and the close route refuses active', async () => {
    expect((await open({ expectedRevision: 4, status: 'active' })).statusCode).toBe(400);
    expect((await open({ why: 'go' })).statusCode).toBe(400);
    expect((await open({ expectedRevision: 4, why: 'x'.repeat(64_001) })).statusCode).toBe(400);
    const close = await app.inject({
      method: 'PATCH',
      url: `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}`,
      payload: { expectedRevision: 4, status: 'active' },
    });
    expect(close.statusCode).toBe(400);
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
    expect(mockUpdatePlanNode).not.toHaveBeenCalled();
  });

  it('refuses a stale revision with the node as it stands, and an open node with 422', async () => {
    const current = {
      nodeId: CHILD_ID,
      revision: 6,
      status: 'blocked',
      updatedAt: '2026-10-05T10:30:00.000Z',
      differingFields: ['status'],
    };
    mockOpenPlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'engine words',
      details: current,
    });
    const stale = await open({ expectedRevision: 4 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'PLAN_NODE_STALE', current });

    mockOpenPlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message: 'engine words',
      details: { ...current, status: 'active', differingFields: [] },
    });
    const unchanged = await open({ expectedRevision: 6 });
    expect(unchanged.statusCode).toBe(422);
    expect(unchanged.json().message).toContain('nothing to approve');
    expect(audit.record).not.toHaveBeenCalled();
    expect(mockRequestResidentWake).not.toHaveBeenCalled();
  });

  it('is a person’s write only: an agent’s credential and a person’s own API key are refused operator_only', async () => {
    caller.servicePrincipal = true;
    caller.authMethod = 'api_key';
    const agent = await open({ expectedRevision: 4 });
    expect(agent.statusCode).toBe(403);
    expect(agent.json()).toMatchObject({ error: 'operator_only' });

    caller.servicePrincipal = false;
    const key = await open({ expectedRevision: 4 });
    expect(key.statusCode).toBe(403);
    expect(key.json()).toMatchObject({ error: 'operator_only' });
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });

  it('refuses a caller who may read the space but not write it', async () => {
    caller.writable = new Set();
    expect((await open({ expectedRevision: 4 })).statusCode).toBe(403);
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });
});

describe('GET /v1/spaces/:spaceId/plan/loop (Plan 331 D7)', () => {
  it('reads the window through the engine for a caller who may read the space', async () => {
    const measure = {
      window: { from: '2026-10-23T16:00:00.000Z', to: '2026-10-26T07:00:00.000Z' },
      operatorActions: {
        total: 0,
        helmsmanMessages: 0,
        actionCenter: { total: 0, byKind: {} },
        planWrites: { close: 0, open: 0 },
        scheduleWrites: 0,
      },
      mergedPullRequests: 3,
      actionsPerMergedPullRequest: 0,
      idle: [],
      cost: { nodes: [], wakes: { sessions: 12, cents: 240, centsPerMergedPullRequest: 80 } },
    };
    mockReadPlanLoopMeasure.mockResolvedValue(measure);
    const query = 'from=2026-10-23T16:00:00.000Z&to=2026-10-26T07:00:00.000Z';
    const res = await app.inject({
      method: 'GET',
      url: `/v1/spaces/${SPACE_ID}/plan/loop?${query}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(measure);
    expect(mockReadPlanLoopMeasure).toHaveBeenCalledWith(DB, TENANT_ID, SPACE_ID, {
      from: '2026-10-23T16:00:00.000Z',
      to: '2026-10-26T07:00:00.000Z',
    });

    caller.readable = new Set();
    expect(
      (await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan/loop` })).statusCode,
    ).toBe(403);
  });
});

describe('GET /v1/spaces/:spaceId/plan/nodes/:nodeId', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}`;
  const node: PlanNode = {
    nodeId: CHILD_ID,
    spaceId: SPACE_ID,
    parentId: ROOT_ID,
    kind: 'decide',
    title: 'Where the decide answer is recorded',
    goal: 'In the outcome, or as a link?',
    criteria: 'One is chosen.',
    status: 'active',
    revision: 6,
    position: 0,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T11:00:00.000Z',
  };
  const read = {
    node,
    children: [],
    childrenTotal: 0,
    links: [],
    linksTotal: 0,
    runs: [],
    runsTotal: 0,
  };

  it('reads one node in full through the engine, the newest 50 links by default', async () => {
    mockReadPlanNodeDetail.mockResolvedValue({ ok: true, ...read });

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(read);
    expect(mockReadPlanNodeDetail).toHaveBeenCalledWith(
      { store: { store: 'tenant-store' }, spaceId: SPACE_ID },
      CHILD_ID,
      { limit: 50 },
    );
  });

  it('pages the links by kind, cursor and limit, and hands on the next cursor', async () => {
    const page = {
      ...read,
      links: [
        {
          nodeId: CHILD_ID,
          kind: 'run',
          ref: RUN_ID,
          label: 'commission-change completed',
          createdAt: '2026-10-05T10:00:00.000Z',
        },
      ],
      linksTotal: 7,
      nextCursor: 'next-page',
    };
    mockReadPlanNodeDetail.mockResolvedValue({ ok: true, ...page });

    const res = await app.inject({
      method: 'GET',
      url: `${url}?linkKind=run&cursor=this-page&limit=1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(page);
    expect(mockReadPlanNodeDetail).toHaveBeenCalledWith(expect.anything(), CHILD_ID, {
      linkKind: 'run',
      cursor: 'this-page',
      limit: 1,
    });
  });

  it('refuses a link kind it does not know and a limit past the ceiling, before the engine', async () => {
    for (const query of ['linkKind=email', 'limit=0', 'limit=201', 'page=2']) {
      const res = await app.inject({ method: 'GET', url: `${url}?${query}` });
      expect(res.statusCode).toBe(400);
    }
    expect(mockReadPlanNodeDetail).not.toHaveBeenCalled();
  });

  it('answers a cursor the engine did not issue with 400', async () => {
    mockReadPlanNodeDetail.mockResolvedValue({
      ok: false,
      code: 'PLAN_LINK_CURSOR_INVALID',
      message: 'This cursor was not issued by this read.',
    });

    const res = await app.inject({ method: 'GET', url: `${url}?cursor=forged` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'PLAN_LINK_CURSOR_INVALID' });
  });

  it('answers a node not in the space with 404', async () => {
    mockReadPlanNodeDetail.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOT_FOUND',
      message: 'No plan node.',
    });

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'PLAN_NODE_NOT_FOUND' });
  });

  it('refuses a space the caller may not read, and reads nothing', async () => {
    caller.readable = new Set();

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(403);
    expect(mockReadPlanNodeDetail).not.toHaveBeenCalled();
  });
});

/** A node as an open or place write answers with it. */
function writtenNode(extra: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: CHILD_ID,
    spaceId: SPACE_ID,
    parentId: ROOT_ID,
    kind: 'execute',
    title: 'P1 — the loop takes the next node',
    goal: 'The loop takes approved work.',
    criteria: 'It is taken.',
    status: 'active',
    note: 'Approved: go ahead\nProposed from the plan document',
    revision: 4,
    position: 0,
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T11:00:00.000Z',
    ...extra,
  };
}

const ENGINE_CTX = {
  store: { store: 'tenant-store' },
  spaceId: SPACE_ID,
  redis: REDIS,
  tenantId: TENANT_ID,
  createdBy: OPERATOR_ID,
  actorKind: 'human',
};

const STALE_CURRENT = {
  nodeId: CHILD_ID,
  revision: 5,
  status: 'blocked',
  updatedAt: '2026-10-05T10:30:00.000Z',
  differingFields: ['status'],
};

describe('PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId/open', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}/open`;
  const open = (body: unknown) =>
    app.inject({ method: 'PATCH', url, payload: body as Record<string, unknown> });

  it('approves through the engine against the revision read, stamped from the session, with the status it left', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: true, node: writtenNode(), from: 'blocked' });

    const res = await open({ expectedRevision: 3, why: 'go ahead' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ node: writtenNode() });
    expect(mockOpenPlanNode).toHaveBeenCalledWith(ENGINE_CTX, {
      nodeId: CHILD_ID,
      expectedRevision: 3,
      why: 'go ahead',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({
          userId: OPERATOR_ID,
          kind: 'human',
          authMethod: 'session',
        }),
        action: 'plan.node.open',
        target: expect.objectContaining({
          resourceType: 'plan_node',
          resourceId: CHILD_ID,
          spaceId: SPACE_ID,
        }),
        details: { status: 'blocked', revision: 4 },
      }),
    );
  });

  it('reopens without a reason, and records that it left done', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: true, node: writtenNode(), from: 'done' });

    const res = await open({ expectedRevision: 3 });

    expect(res.statusCode).toBe(200);
    expect(mockOpenPlanNode.mock.calls[0]?.[1]).toEqual({ nodeId: CHILD_ID, expectedRevision: 3 });
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      details: { status: 'done', revision: 4 },
    });
  });

  it('refuses a reason past the note ceiling, a missing revision and a status, before the engine', async () => {
    expect((await open({ expectedRevision: 3, why: 'x'.repeat(64001) })).statusCode).toBe(400);
    expect((await open({ why: 'go' })).statusCode).toBe(400);
    expect((await open({ expectedRevision: 3, status: 'active' })).statusCode).toBe(400);
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });

  it('refuses a stale revision with the node’s current one, and writes no audit row', async () => {
    mockOpenPlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'engine words',
      details: STALE_CURRENT,
    });

    const res = await open({ expectedRevision: 3 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PLAN_NODE_STALE', current: STALE_CURRENT });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers an active or waiting node with 422 and the node as it stands', async () => {
    for (const status of ['active', 'waiting'] as const) {
      mockOpenPlanNode.mockResolvedValueOnce({
        ok: false,
        code: 'PLAN_NODE_UNCHANGED',
        message: 'engine words',
        details: { ...STALE_CURRENT, revision: 3, status, differingFields: [] },
      });

      const res = await open({ expectedRevision: 3 });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'PLAN_NODE_UNCHANGED', current: { status } });
      expect(res.json().message).toContain(`This step is ${status}`);
    }
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers an overlong note with the operator’s remedy, not the engine’s', async () => {
    mockOpenPlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_NOTE_TOO_LONG',
      message: 'Pass a shorter `note` in this update, or "" to keep only that line.',
      details: { nodeId: CHILD_ID, status: 'blocked', noteLength: 64_012, noteMaxChars: 64_000 },
    });

    const res = await open({ expectedRevision: 3, why: 'go ahead' });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'PLAN_NODE_NOTE_TOO_LONG',
      message:
        'This would leave the step’s note at 64012 characters, past the 64000 a note holds, so nothing ' +
        'was written. Shorten the reason, or clear it and approve again without one.',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers an overlong note on a reopen with the outcome as the cause, not the reason', async () => {
    const refusal = (status: string) => ({
      ok: false,
      code: 'PLAN_NODE_NOTE_TOO_LONG',
      message: 'engine words',
      details: { nodeId: CHILD_ID, status, noteLength: 64_012, noteMaxChars: 64_000 },
    });
    mockOpenPlanNode.mockResolvedValueOnce(refusal('blocked'));
    mockOpenPlanNode.mockResolvedValueOnce(refusal('done'));

    const approve = (await open({ expectedRevision: 3, why: 'go ahead' })).json();
    const reopen = await open({ expectedRevision: 3 });

    expect(reopen.statusCode).toBe(422);
    expect(reopen.json()).toEqual({
      error: 'PLAN_NODE_NOTE_TOO_LONG',
      message:
        'Reopening heads this step’s note with the outcome it was closed with, which would leave the note at ' +
        '64012 characters, past the 64000 a note holds, so nothing was written. A shorter reason, or none, ' +
        'does not bring it under: the recorded outcome has to be shortened first, and the plan page cannot ' +
        'write it. Ask the Helmsman to shorten the outcome while the step is still done, then reopen it.',
    });
    expect(reopen.json().message).not.toBe(approve.message);
    expect(reopen.json().message).not.toContain('approve again');
  });

  it('answers a node not in the space with 404', async () => {
    mockOpenPlanNode.mockResolvedValue({ ok: false, code: 'PLAN_NODE_NOT_FOUND', message: 'gone' });

    expect((await open({ expectedRevision: 3 })).statusCode).toBe(404);
  });

  it('refuses an API key and a service principal: the write is a person’s', async () => {
    for (const [authMethod, servicePrincipal] of [
      ['api_key', false],
      ['api_key', true],
      ['session', true],
    ] as const) {
      caller.authMethod = authMethod;
      caller.servicePrincipal = servicePrincipal;

      const res = await open({ expectedRevision: 3 });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'operator_only' });
    }
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });

  it('says so rather than writing where the server runs without Redis', async () => {
    appContext.redis = null;

    expect((await open({ expectedRevision: 3 })).statusCode).toBe(503);
    expect(mockOpenPlanNode).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/spaces/:spaceId/plan/nodes/:nodeId/place', () => {
  const url = `/v1/spaces/${SPACE_ID}/plan/nodes/${CHILD_ID}/place`;
  const place = (body: unknown) =>
    app.inject({ method: 'PATCH', url, payload: body as Record<string, unknown> });

  it('places before a sibling through the engine, stamped from the session, with an audit row', async () => {
    mockPlacePlanNode.mockResolvedValue({ ok: true, node: writtenNode({ position: 512 }) });

    const res = await place({ expectedRevision: 3, before: GRANDCHILD_ID });

    expect(res.statusCode).toBe(200);
    expect(mockRequestResidentWake).toHaveBeenCalledWith(
      { redis: REDIS, schedules: SCHEDULES },
      { tenantId: TENANT_ID, spaceId: SPACE_ID, cause: 'node_written' },
    );
    expect(mockPlacePlanNode).toHaveBeenCalledWith(ENGINE_CTX, {
      nodeId: CHILD_ID,
      expectedRevision: 3,
      before: GRANDCHILD_ID,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: OPERATOR_ID, kind: 'human' }),
        action: 'plan.node.place',
        target: expect.objectContaining({ resourceType: 'plan_node', resourceId: CHILD_ID }),
        details: { before: GRANDCHILD_ID, revision: 4 },
      }),
    );
  });

  it('places after a sibling, and records after', async () => {
    mockPlacePlanNode.mockResolvedValue({ ok: true, node: writtenNode() });

    await place({ expectedRevision: 3, after: GRANDCHILD_ID });

    expect(mockPlacePlanNode.mock.calls[0]?.[1]).toEqual({
      nodeId: CHILD_ID,
      expectedRevision: 3,
      after: GRANDCHILD_ID,
    });
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      details: { after: GRANDCHILD_ID, revision: 4 },
    });
  });

  it('refuses both anchors, neither, a position and a non-uuid, before the engine', async () => {
    for (const body of [
      { expectedRevision: 3, before: GRANDCHILD_ID, after: ROOT_ID },
      { expectedRevision: 3 },
      { expectedRevision: 3, position: 0 },
      { expectedRevision: 3, before: 'P6.a' },
    ]) {
      expect((await place(body)).statusCode).toBe(400);
    }
    expect(mockPlacePlanNode).not.toHaveBeenCalled();
  });

  it('refuses a sibling that moved away with 409 and the siblings’ order as it stands', async () => {
    const siblings = [
      { nodeId: ROOT_ID, title: 'P6.a', status: 'active', position: 0 },
      { nodeId: CHILD_ID, title: 'P6.b', status: 'blocked', position: 1024 },
    ];
    mockPlacePlanNode.mockResolvedValue({
      ok: false,
      code: 'PLAN_NODE_PLACE_STALE',
      message: 'engine words',
      details: { nodeId: CHILD_ID, siblings },
    });

    const res = await place({ expectedRevision: 3, before: GRANDCHILD_ID });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'PLAN_NODE_PLACE_STALE', siblings });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a stale revision with the current one, and a place that changes nothing with 422', async () => {
    mockPlacePlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_STALE',
      message: 'engine words',
      details: STALE_CURRENT,
    });
    const stale = await place({ expectedRevision: 3, before: GRANDCHILD_ID });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'PLAN_NODE_STALE', current: STALE_CURRENT });

    mockPlacePlanNode.mockResolvedValueOnce({
      ok: false,
      code: 'PLAN_NODE_UNCHANGED',
      message: 'engine words',
      details: { ...STALE_CURRENT, revision: 3, differingFields: [] },
    });
    expect((await place({ expectedRevision: 3, after: GRANDCHILD_ID })).statusCode).toBe(422);
  });

  it('refuses an API key and a service principal: the write is a person’s', async () => {
    for (const [authMethod, servicePrincipal] of [
      ['api_key', false],
      ['session', true],
    ] as const) {
      caller.authMethod = authMethod;
      caller.servicePrincipal = servicePrincipal;

      const res = await place({ expectedRevision: 3, before: GRANDCHILD_ID });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'operator_only' });
    }
    expect(mockPlacePlanNode).not.toHaveBeenCalled();
  });
});
