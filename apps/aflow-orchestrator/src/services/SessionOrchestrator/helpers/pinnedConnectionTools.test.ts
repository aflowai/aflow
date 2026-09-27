/**
 * What an operator's always-on connections put on a turn's surface.
 *
 * The tests that matter are the ones about a connection the space can no longer
 * serve. This list is stored operator config, so a binding gets disabled, a
 * definition deleted, a tool cache cleared — all of them long after the switch
 * was flipped. The authored `coreMcpServers` path throws on each of those,
 * which here would mean every turn in the space fails from then on.
 */
import { describe, expect, it, vi } from 'vitest';

interface Rows {
  apiDefinitions?: unknown[];
  apiBindings?: unknown[];
  mcpServerDefinitions?: unknown[];
  mcpServerBindings?: unknown[];
}

const rowsRef: { current: Rows } = { current: {} };

const TABLES = {
  apiDefinitions: Symbol('apiDefinitions'),
  apiBindings: Symbol('apiBindings'),
  mcpServerDefinitions: Symbol('mcpServerDefinitions'),
  mcpServerBindings: Symbol('mcpServerBindings'),
};

vi.mock('@aflow/database', () => {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === TABLES.apiDefinitions) return rowsRef.current.apiDefinitions ?? [];
    if (table === TABLES.apiBindings) return rowsRef.current.apiBindings ?? [];
    if (table === TABLES.mcpServerDefinitions) return rowsRef.current.mcpServerDefinitions ?? [];
    if (table === TABLES.mcpServerBindings) return rowsRef.current.mcpServerBindings ?? [];
    return [];
  };
  const tx = {
    select: () => {
      let table: unknown;
      const chain = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        where: () => Promise.resolve(rowsFor(table)),
      };
      return chain;
    },
  };
  return {
    getDatabase: () => ({}),
    createTenantContext: (tenantId: string) => ({ tenantId }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, cb: (t: unknown) => Promise<unknown>) =>
      cb(tx),
    apiDefinitions: TABLES.apiDefinitions,
    apiBindings: TABLES.apiBindings,
    mcpServerDefinitions: TABLES.mcpServerDefinitions,
    mcpServerBindings: TABLES.mcpServerBindings,
  };
});

vi.mock('drizzle-orm', () => ({
  inArray: () => undefined,
  eq: () => undefined,
  and: () => undefined,
}));

const { resolvePinnedConnectionToolSpecs } = await import('./pinnedConnectionTools.js');

const TENANT_ID = 'a0000000-0000-0000-0000-000000000001';
const SPACE_ID = '00000000-0000-4000-8000-0000000000bb';

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

async function resolve(
  rows: Rows,
  connections: Array<{ sourceKind: 'api' | 'mcp'; integrationId: string; bindingId: string }>,
) {
  rowsRef.current = rows;
  return resolvePinnedConnectionToolSpecs({
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
    connections,
    runtimeState: { variables: {} },
  });
}

const ETORO = { sourceKind: 'api' as const, integrationId: 'etoro', bindingId: 'etoro-default' };
const KAGGLE = { sourceKind: 'mcp' as const, integrationId: 'kaggle', bindingId: 'kaggle-default' };

const ETORO_ROWS: Rows = {
  apiBindings: [
    { bindingId: 'etoro-default', apiId: 'etoro', spaceId: SPACE_ID, enabled: 1 },
    { bindingId: 'etoro-live', apiId: 'etoro', spaceId: SPACE_ID, enabled: 1 },
  ],
  apiDefinitions: [
    {
      apiId: 'etoro',
      name: 'eToro',
      definitionJson: { endpoints: [endpoint('quotes.get'), endpoint('orders.list')] },
    },
  ],
};

const KAGGLE_ROWS: Rows = {
  mcpServerBindings: [
    {
      bindingId: 'kaggle-default',
      serverId: 'kaggle',
      spaceId: SPACE_ID,
      enabled: 1,
      cachedTools: [
        { name: 'search_datasets', description: 'Find datasets', inputSchema: { type: 'object' } },
      ],
    },
  ],
  mcpServerDefinitions: [{ serverId: 'kaggle', name: 'Kaggle', definitionJson: {} }],
};

describe('resolvePinnedConnectionToolSpecs', () => {
  it('pins a connection to the binding the operator named, not to its integration', async () => {
    const specs = await resolve(ETORO_ROWS, [ETORO]);
    expect(specs.map((s) => s.toolId)).toEqual([
      'api:etoro-default/quotes.get',
      'api:etoro-default/orders.list',
    ]);
    // Without this the executor scope-resolves the account, and `etoro-live`
    // wins as readily as the binding the operator listed.
    for (const spec of specs) expect(spec.apiMeta?.bindingId).toBe('etoro-default');
  });

  it('pins only the named endpoints when the operator chose a subset', async () => {
    const specs = await resolve(ETORO_ROWS, [{ ...ETORO, toolNames: ['quotes.get'] }]);
    expect(specs.map((s) => s.toolId)).toEqual(['api:etoro-default/quotes.get']);
  });

  it('pins every endpoint when no subset is named', async () => {
    const specs = await resolve(ETORO_ROWS, [{ ...ETORO, toolNames: undefined }]);
    expect(specs).toHaveLength(2);
  });

  it('applies the subset to MCP tools too', async () => {
    const specs = await resolve(KAGGLE_ROWS, [{ ...KAGGLE, toolNames: ['nothing_matches'] }]);
    expect(specs).toHaveLength(0);
  });

  it('ignores a name the connection does not have rather than inventing a tool', async () => {
    const specs = await resolve(ETORO_ROWS, [
      { ...ETORO, toolNames: ['quotes.get', 'endpoint.that.left'] },
    ]);
    expect(specs.map((s) => s.toolId)).toEqual(['api:etoro-default/quotes.get']);
  });

  it('drops a disabled binding instead of taking the turn with it', async () => {
    const specs = await resolve(
      {
        ...ETORO_ROWS,
        apiBindings: [
          { bindingId: 'etoro-default', apiId: 'etoro', spaceId: SPACE_ID, enabled: 0 },
        ],
      },
      [ETORO],
    );
    expect(specs).toEqual([]);
  });

  it('drops an MCP binding whose tool cache was cleared instead of throwing', async () => {
    const specs = await resolve(
      {
        ...KAGGLE_ROWS,
        mcpServerBindings: [
          {
            bindingId: 'kaggle-default',
            serverId: 'kaggle',
            spaceId: SPACE_ID,
            enabled: 1,
            cachedTools: [],
          },
        ],
      },
      [KAGGLE],
    );
    expect(specs).toEqual([]);
  });

  it('drops a connection whose definition is gone instead of throwing', async () => {
    const specs = await resolve({ ...KAGGLE_ROWS, mcpServerDefinitions: [] }, [KAGGLE]);
    expect(specs).toEqual([]);
  });

  it('keeps the connections that still work when a sibling is broken', async () => {
    const specs = await resolve({ ...ETORO_ROWS, ...KAGGLE_ROWS, mcpServerDefinitions: [] }, [
      ETORO,
      KAGGLE,
    ]);
    expect(specs.map((s) => s.toolId)).toEqual([
      'api:etoro-default/quotes.get',
      'api:etoro-default/orders.list',
    ]);
  });

  it('qualifies call names when two bindings of one integration are pinned', async () => {
    const specs = await resolve(ETORO_ROWS, [
      ETORO,
      { sourceKind: 'api', integrationId: 'etoro', bindingId: 'etoro-live' },
    ]);
    expect(specs.map((s) => s.callName)).toEqual([
      'etoro-default.quotes.get',
      'etoro-default.orders.list',
      'etoro-live.quotes.get',
      'etoro-live.orders.list',
    ]);
  });

  it('pins nothing without a space rather than failing the turn', async () => {
    rowsRef.current = ETORO_ROWS;
    expect(
      await resolvePinnedConnectionToolSpecs({
        tenantId: TENANT_ID,
        spaceId: undefined,
        connections: [ETORO],
        runtimeState: { variables: {} },
      }),
    ).toEqual([]);
  });
});
