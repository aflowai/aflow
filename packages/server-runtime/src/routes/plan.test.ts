/**
 * GET /v1/spaces/:spaceId/plan — the operator's read of the space's plan
 * (Plan 322 P3): whole trees as the plan engine reads them, for a caller who
 * may read the space named in the URL, and for no other.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { PlanTreeNode, PlanTreeOutput } from '@aflow/schemas';

const mockReadPlanTrees = vi.fn();
const mockCreatePlanNodeStore = vi.fn((..._args: unknown[]) => ({ store: 'tenant-store' }));

vi.mock('@aflow/cybernetic-runtime', () => ({
  readPlanTrees: (...a: unknown[]) => mockReadPlanTrees(...a),
  createPlanNodeStore: (...a: unknown[]) => mockCreatePlanNodeStore(...a),
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
    links: [],
    linksTotal: 0,
    runs: [],
    children: [],
    ...extra,
  };
}

const TREES: PlanTreeOutput = {
  roots: [
    treeNode(ROOT_ID, null, {
      noteHead: 'next: the plan page',
      runs: [
        {
          runId: RUN_ID,
          slug: 'commission-change',
          status: 'running',
          nodeId: ROOT_ID,
          startedAt: '2026-10-05T09:00:00.000Z',
        },
      ],
      children: [
        treeNode(CHILD_ID, ROOT_ID, {
          status: 'done',
          outcome: `Merged ${PR}.`,
          closedAt: '2026-10-05T10:00:00.000Z',
          links: [
            {
              nodeId: CHILD_ID,
              kind: 'pull_request',
              ref: PR,
              createdAt: '2026-10-05T10:00:00.000Z',
            },
          ],
          linksTotal: 3,
          children: [
            treeNode(GRANDCHILD_ID, CHILD_ID, { status: 'dropped', outcome: 'Superseded.' }),
          ],
        }),
      ],
    }),
  ],
  runsTotal: 1,
};

/** Who is asking, and which spaces they may read. */
const caller = { authenticated: true, readable: new Set<string>([SPACE_ID]) };

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db: DB };
  app.decorate('authenticate', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!caller.authenticated) {
      await reply.status(401).send({ error: 'Unauthorized', message: 'Sign in.' });
    }
  });
  app.addHook('onRequest', async (request) => {
    (request as unknown as { requireTenant: () => Promise<unknown> }).requireTenant = async () => ({
      tenantId: TENANT_ID,
    });
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
    const allowed =
      authz.resource === 'space' &&
      authz.action === 'read' &&
      authz.resourceIdFrom === 'param' &&
      spaceId !== undefined &&
      caller.readable.has(spaceId);
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
  mockReadPlanTrees.mockResolvedValue(TREES);
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('GET /v1/spaces/:spaceId/plan', () => {
  it('returns whole trees, every node nested with its status, position, outcome, links and runs', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TREES);
  });

  it('reads the space in the URL through the tenant’s plan store', async () => {
    await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(mockCreatePlanNodeStore).toHaveBeenCalledWith(DB, TENANT_ID);
    expect(mockReadPlanTrees).toHaveBeenCalledWith({
      store: { store: 'tenant-store' },
      spaceId: SPACE_ID,
    });
  });

  it('answers an empty plan with no roots', async () => {
    mockReadPlanTrees.mockResolvedValue({ roots: [], runsTotal: 0 });

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ roots: [], runsTotal: 0 });
  });

  it('names the bound that cut a large plan short', async () => {
    mockReadPlanTrees.mockResolvedValue({ ...TREES, truncated: { bound: 'nodes', value: 2000 } });

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.json()).toMatchObject({ truncated: { bound: 'nodes', value: 2000 } });
  });

  it('refuses a space the caller may not read, and reads nothing', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${OTHER_SPACE_ID}/plan` });

    expect(res.statusCode).toBe(403);
    expect(mockReadPlanTrees).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller, and reads nothing', async () => {
    caller.authenticated = false;

    const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/plan` });

    expect(res.statusCode).toBe(401);
    expect(mockReadPlanTrees).not.toHaveBeenCalled();
  });

  it('refuses a space id that is not a UUID', async () => {
    caller.readable.add('not-a-space');

    const res = await app.inject({ method: 'GET', url: '/v1/spaces/not-a-space/plan' });

    expect(res.statusCode).toBe(400);
    expect(mockReadPlanTrees).not.toHaveBeenCalled();
  });
});
