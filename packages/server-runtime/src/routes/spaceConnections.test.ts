/**
 * The connection surface an operator pins from: what `GET /v1/spaces/:spaceId/
 * connections` reports per binding, and the tool-cap refusal that keeps an
 * always-on list from silently degrading at run time.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import {
  apiBindings,
  apiDefinitions,
  mcpServerBindings,
  mcpServerDefinitions,
  spaceMemberships,
  spaces,
} from '@aflow/database';

vi.mock('../services/entityBootstrap.js', () => ({
  bootstrapCyberneticEntity: vi.fn(async () => ({
    created: [],
    resolvedAgents: { helmsman: 'agent-1', runner: 'agent-2', coach: 'agent-3' },
    durationMs: 1,
    firstActivation: false,
    emittedEvent: 'entity.directives.updated',
    entityEventId: null,
  })),
}));

const { spaceConnectionsRoutes } = await import('./spaceConnections.js');
const { spaceCrudRoutes } = await import('./spaceCrudRoutes.js');
const { spacePolicyRoutes } = await import('./spacePolicyRoutes.js');
const { spaceLifecycleRoutes } = await import('./spaceLifecycleRoutes.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

interface Rows {
  apiBindings?: unknown[];
  apiDefinitions?: unknown[];
  mcpServerBindings?: unknown[];
  mcpServerDefinitions?: unknown[];
}

const SPACE_ROW = {
  id: SPACE_ID,
  name: 'Trading',
  slug: 'trading',
  description: null,
  ownerId: USER_ID,
  createdBy: USER_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  archivedAt: null,
  directives: null,
  rules: [],
};

function makeFakeDb(rows: Rows): unknown {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === apiBindings) return rows.apiBindings ?? [];
    if (table === apiDefinitions) return rows.apiDefinitions ?? [];
    if (table === mcpServerBindings) return rows.mcpServerBindings ?? [];
    if (table === mcpServerDefinitions) return rows.mcpServerDefinitions ?? [];
    if (table === spaces) return [SPACE_ROW];
    if (table === spaceMemberships) return [{ count: 1 }];
    return [];
  };
  const select = () => {
    let table: unknown;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where: () => ({
        limit: () => Promise.resolve(rowsFor(table)),
        then: (resolve: (r: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve(rowsFor(table)).then(resolve, reject),
      }),
      then: (resolve: (r: unknown[]) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(resolve, reject),
    };
    return chain;
  };
  const update = (table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: () => ({
        returning: () =>
          Promise.resolve(rowsFor(table).map((r) => ({ ...(r as object), ...values }))),
      }),
    }),
  });
  const tx = { execute: async () => undefined, select, update };
  return {
    select,
    update,
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  };
}

async function buildApp(db: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  (app as unknown as { appContext: unknown }).appContext = { db };
  app.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    (request as unknown as { authUser: unknown }).authUser = { userId: USER_ID };
  });
  app.addHook('onRequest', async (request) => {
    const req = request as unknown as {
      requireTenant: () => Promise<unknown>;
      requireSpace: () => Promise<unknown>;
    };
    req.requireTenant = async () => ({ tenantId: TENANT_ID, tenantRole: 'admin', isAdmin: true });
    req.requireSpace = async () => ({ spaceId: SPACE_ID });
  });
  await app.register(spaceConnectionsRoutes, { prefix: '/v1/spaces' });
  await app.register(spaceCrudRoutes, { prefix: '/v1/spaces' });
  await app.register(spacePolicyRoutes, { prefix: '/v1/spaces' });
  await app.register(spaceLifecycleRoutes, { prefix: '/v1/spaces' });
  await app.ready();
  return app;
}

function endpoint(endpointId: string) {
  return {
    endpointId,
    name: `eToro ${endpointId}`,
    description: `Call ${endpointId}`,
    method: 'GET',
    pathTemplate: `/v1/${endpointId}`,
    params: [{ name: 'symbol', location: 'query', required: true, schema: { type: 'string' } }],
  };
}

interface ConnectionRow {
  sourceKind: 'api' | 'mcp';
  integrationId: string;
  bindingId: string;
  label: string;
  toolCount: number;
  alwaysOnTokens: number;
  pinnable: boolean;
  blockedReason?: string;
}

async function listConnections(rows: Rows): Promise<ConnectionRow[]> {
  const app = await buildApp(makeFakeDb(rows));
  const res = await app.inject({ method: 'GET', url: `/v1/spaces/${SPACE_ID}/connections` });
  await app.close();
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { connections: ConnectionRow[] }).connections;
}

describe('GET /v1/spaces/:spaceId/connections', () => {
  it('reports the tools and per-turn cost an API connection pins', async () => {
    const connections = await listConnections({
      apiBindings: [{ bindingId: 'etoro-default', apiId: 'etoro', name: 'eToro', enabled: 1 }],
      apiDefinitions: [
        {
          apiId: 'etoro',
          name: 'eToro Trading',
          enabled: 1,
          definitionJson: { endpoints: [endpoint('quotes.get'), endpoint('orders.list')] },
        },
      ],
    });

    expect(connections).toHaveLength(1);
    const etoro = connections[0]!;
    expect(etoro).toMatchObject({
      sourceKind: 'api',
      integrationId: 'etoro',
      bindingId: 'etoro-default',
      label: 'eToro Trading',
      toolCount: 2,
      pinnable: true,
    });
    expect(etoro.blockedReason).toBeUndefined();
    expect(etoro.alwaysOnTokens).toBeGreaterThan(0);
  });

  it('costs each endpoint, so a bigger connection quotes a bigger figure', async () => {
    const [small] = await listConnections({
      apiBindings: [{ bindingId: 'b', apiId: 'etoro', name: 'eToro', enabled: 1 }],
      apiDefinitions: [
        {
          apiId: 'etoro',
          name: 'eToro',
          enabled: 1,
          definitionJson: { endpoints: [endpoint('quotes.get')] },
        },
      ],
    });
    const [large] = await listConnections({
      apiBindings: [{ bindingId: 'b', apiId: 'etoro', name: 'eToro', enabled: 1 }],
      apiDefinitions: [
        {
          apiId: 'etoro',
          name: 'eToro',
          enabled: 1,
          definitionJson: {
            endpoints: [endpoint('quotes.get'), endpoint('orders.list'), endpoint('orders.create')],
          },
        },
      ],
    });
    expect(large!.alwaysOnTokens).toBeGreaterThan(small!.alwaysOnTokens);
  });

  it('refuses to offer an MCP binding whose tool cache is empty', async () => {
    const connections = await listConnections({
      mcpServerBindings: [
        {
          bindingId: 'kaggle-b',
          serverId: 'kaggle',
          name: 'Kaggle',
          cachedTools: null,
          enabled: 1,
        },
      ],
      mcpServerDefinitions: [
        {
          serverId: 'kaggle',
          name: 'Kaggle',
          enabled: 1,
          definitionJson: { toolFilter: { include: ['search_datasets'] } },
        },
      ],
    });

    expect(connections[0]).toMatchObject({
      sourceKind: 'mcp',
      integrationId: 'kaggle',
      toolCount: 0,
      alwaysOnTokens: 0,
      pinnable: false,
    });
    expect(connections[0]!.blockedReason).toMatch(/cached tools/i);
  });

  it('applies the definition tool filter to an MCP connection', async () => {
    const connections = await listConnections({
      mcpServerBindings: [
        {
          bindingId: 'kaggle-b',
          serverId: 'kaggle',
          name: 'Kaggle',
          enabled: 1,
          cachedTools: [
            {
              name: 'search_datasets',
              description: 'Find datasets',
              inputSchema: { type: 'object' },
            },
            {
              name: 'delete_dataset',
              description: 'Remove a dataset',
              inputSchema: { type: 'object' },
            },
          ],
        },
      ],
      mcpServerDefinitions: [
        {
          serverId: 'kaggle',
          name: 'Kaggle',
          enabled: 1,
          definitionJson: { toolFilter: { include: ['search_datasets'] } },
        },
      ],
    });

    expect(connections[0]).toMatchObject({ toolCount: 1, pinnable: true });
    expect(connections[0]!.alwaysOnTokens).toBeGreaterThan(0);
  });

  it('lists a binding whose definition is gone, unpinnable with the reason', async () => {
    const connections = await listConnections({
      apiBindings: [{ bindingId: 'orphan', apiId: 'gone', name: 'Orphan', enabled: 1 }],
    });
    expect(connections[0]).toMatchObject({
      integrationId: 'gone',
      label: 'Orphan',
      toolCount: 0,
      pinnable: false,
    });
    expect(connections[0]!.blockedReason).toMatch(/No API definition/);
  });

  it('refuses to offer a disabled binding', async () => {
    const connections = await listConnections({
      apiBindings: [{ bindingId: 'etoro-default', apiId: 'etoro', name: 'eToro', enabled: 0 }],
      apiDefinitions: [
        {
          apiId: 'etoro',
          name: 'eToro',
          enabled: 1,
          definitionJson: { endpoints: [endpoint('quotes.get')] },
        },
      ],
    });
    expect(connections[0]).toMatchObject({ pinnable: false, toolCount: 1 });
    expect(connections[0]!.blockedReason).toMatch(/binding is disabled/i);
  });
});

describe('PATCH /v1/spaces/:spaceId — always-on connections against the tool cap', () => {
  const directives = (connections: unknown[]) => ({
    version: 1,
    responsibility: 'Trade research',
    priorities: [],
    resourceBudget: {},
    modelDefaults: {},
    reasoningDefaults: {},
    learningPolicy: {},
    capabilityDiscovery: { connections },
  });

  async function patch(
    connections: unknown[],
    rows: Rows = {},
  ): Promise<{ status: number; body: string }> {
    const app = await buildApp(makeFakeDb(rows));
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/spaces/${SPACE_ID}`,
      payload: { directives: directives(connections) },
    });
    await app.close();
    return { status: res.statusCode, body: res.body };
  }

  /**
   * What the Helmsman's own always-on capabilities leave for connections, taken
   * the way the route takes it. Hard-coding the figure would make the tests
   * below pass on a stale number rather than on the behaviour they name.
   */
  async function connectionBudget(): Promise<number> {
    const { CYBERNETIC_AGENTS } = await import('@aflow/platform-artifacts');
    const { validateBundlePlacements, MAX_PINNED_TOOLS } = await import('@aflow/schemas');
    const catalog = (
      CYBERNETIC_AGENTS.find((a) => a.flowId === 'cybernetic-helmsman')?.steps.find(
        (s) => s['operation'] === 'ai.agent.turn',
      )?.['config'] as
        | {
            catalog?: { coreOperations?: string[]; discovery?: { allowedOperationIds?: string[] } };
          }
        | undefined
    )?.catalog;
    const verdict = validateBundlePlacements(
      catalog?.coreOperations ?? [],
      catalog?.discovery?.allowedOperationIds ?? [],
      undefined,
    );
    return MAX_PINNED_TOOLS - verdict.pinnedCount;
  }

  function etoroRows(endpointCount: number, bindingIds: string[]): Rows {
    return {
      apiBindings: bindingIds.map((bindingId) => ({
        bindingId,
        apiId: 'etoro',
        name: 'eToro',
        enabled: 1,
      })),
      apiDefinitions: [
        {
          apiId: 'etoro',
          name: 'eToro',
          enabled: 1,
          definitionJson: {
            endpoints: Array.from({ length: endpointCount }, (_, i) => endpoint(`ep${String(i)}`)),
          },
        },
      ],
    };
  }

  const pin = (bindingId: string) => ({
    sourceKind: 'api' as const,
    integrationId: 'etoro',
    bindingId,
    placement: 'always_on' as const,
  });

  it('accepts a connection whose endpoints fit the room left', async () => {
    const budget = await connectionBudget();
    const { status } = await patch([pin('b1')], etoroRows(budget, ['b1']));
    expect(status).toBe(200);
  });

  it('counts endpoints, not connections — one connection can breach the cap alone', async () => {
    const budget = await connectionBudget();
    const { status, body } = await patch([pin('b1')], etoroRows(budget + 1, ['b1']));
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: 'PLACEMENT_OVER_TOOL_CAP' });
  });

  it('counts only the pinned subset — a selection that fits is not refused', async () => {
    // The edit an over-cap operator is told to make. Charging the connection
    // its whole surface would 400 the very selection the composer had just
    // shown as fitting.
    const budget = await connectionBudget();
    const { status } = await patch(
      [{ ...pin('b1'), pinnedToolNames: ['ep0'] }],
      etoroRows(budget + 20, ['b1']),
    );
    expect(status).toBe(200);
  });

  it('still refuses when the subset itself is over the cap', async () => {
    const budget = await connectionBudget();
    const names = Array.from({ length: budget + 1 }, (_, i) => `ep${String(i)}`);
    const { status, body } = await patch(
      [{ ...pin('b1'), pinnedToolNames: names }],
      etoroRows(budget + 20, ['b1']),
    );
    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({ error: 'PLACEMENT_OVER_TOOL_CAP' });
  });

  it('charges nothing for an empty subset — cleared pins none, not all', async () => {
    const budget = await connectionBudget();
    const { status } = await patch(
      [{ ...pin('b1'), pinnedToolNames: [] }],
      etoroRows(budget + 20, ['b1']),
    );
    expect(status).toBe(200);
  });

  it('counts each binding of one integration — they pin separate tool sets', async () => {
    const budget = await connectionBudget();
    const { status } = await patch([pin('b1'), pin('b2')], etoroRows(budget, ['b1', 'b2']));
    expect(status).toBe(400);
  });

  it('leaves an on-demand list out of the pinned count', async () => {
    const budget = await connectionBudget();
    const rows = etoroRows(budget, ['b1', 'b2']);
    const { status } = await patch(
      [
        { ...pin('b1'), placement: 'on_demand' as const },
        { ...pin('b2'), placement: 'on_demand' as const },
      ],
      rows,
    );
    expect(status).toBe(200);
  });

  it('costs a pinned binding the space does not have at nothing', async () => {
    const { status } = await patch([pin('never-bound')]);
    expect(status).toBe(200);
  });
});
