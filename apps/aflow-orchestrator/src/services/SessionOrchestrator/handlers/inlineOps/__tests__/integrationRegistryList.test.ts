import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

const mockAddStepResult = vi.fn();
// Registry ops follow the uniform discovery-scope contract (absent scope
// fails closed) — the default fixture models the Helmsman bound-mode scope
// these operator-facing ops actually run under.
const mockGetSessionState = vi.fn<() => Promise<unknown>>(() =>
  Promise.resolve({
    runtimeState: {
      variables: {
        'ai.agent._discoveryScope': {
          ref: {
            kind: 'inline',
            value: {
              allowedStepTypes: ['api', 'mcp'],
              integrations: { mode: 'bound', sourceKinds: ['api', 'mcp'] },
            },
          },
        },
      },
    },
  }),
);

const mockApiDefs: Array<Record<string, unknown>> = [];
const mockApiBindings: Array<Record<string, unknown>> = [];
const mockMcpDefs: Array<Record<string, unknown>> = [];
const mockMcpBindings: Array<Record<string, unknown>> = [];

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...(args as [])),
}));

vi.mock('@aflow/database', () => {
  const apiDefinitions = { __table: 'apiDefinitions', spaceId: 'spaceId' };
  const apiBindings = { __table: 'apiBindings', spaceId: 'spaceId' };
  const apiCredentials = { __table: 'apiCredentials' };
  const mcpServerDefinitions = { __table: 'mcpServerDefinitions', spaceId: 'spaceId' };
  const mcpServerBindings = { __table: 'mcpServerBindings', spaceId: 'spaceId' };
  const oauthTokens = { __table: 'oauthTokens', integrationKind: 'integrationKind' };

  function buildTx(): unknown {
    return {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => {
            switch (table.__table) {
              case 'apiDefinitions':
                return Promise.resolve(mockApiDefs);
              case 'apiBindings':
                return Promise.resolve(mockApiBindings);
              case 'apiCredentials':
                return Promise.resolve([]);
              case 'mcpServerDefinitions':
                return Promise.resolve(mockMcpDefs);
              case 'mcpServerBindings':
                return Promise.resolve(mockMcpBindings);
              case 'oauthTokens':
                return Promise.resolve([]);
              default:
                return Promise.resolve([]);
            }
          },
        }),
      }),
    };
  }

  return {
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(buildTx()),
    ),
    apiDefinitions,
    apiBindings,
    apiCredentials,
    mcpServerDefinitions,
    mcpServerBindings,
    oauthTokens,
  };
});

const SPACE_ID = '41be431d-6011-495b-a4f2-6de539a6a0df';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function makeArgs(input: Record<string, unknown>): InlineHandlerArgs {
  return {
    redis: {} as never,
    payloadStore: { ...createMemoryPayloadStore(), shouldStore: () => false } as never,
    context: {
      tenantId: 'a0000000-0000-0000-0000-000000000001',
      runId: 'session-1',
      traceId: 'trace-1',
      actorContext: {},
      agentDefinition: { steps: [] },
      spaceId: SPACE_ID,
    } as never,
    stepDef: {
      stepId: 'list',
      stepType: 'integration',
      operation: 'integration.registry.list',
      config: {},
      tags: [],
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inlineRef(input),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

async function runList(input: Record<string, unknown> = {}): Promise<{
  items: Array<Record<string, unknown>>;
  total: number;
  definitionOnlyCount: number;
}> {
  const { handleIntegrationRegistryListInline } = await import('../integrationRegistryList.js');
  await handleIntegrationRegistryListInline(makeArgs(input));
  const call = mockAddStepResult.mock.calls.at(-1);
  const msg = call?.[1] as { status: string; outputRef?: string; error?: unknown };
  if (msg.status !== 'SUCCEEDED') {
    throw new Error(`Expected SUCCEEDED but got ${msg.status}: ${JSON.stringify(msg.error)}`);
  }
  const decoded = Buffer.from(msg.outputRef!.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(decoded) as {
    items: Array<Record<string, unknown>>;
    total: number;
    definitionOnlyCount: number;
  };
}

function setRegistry(opts: {
  apiDefs?: Array<{ apiId: string; name?: string }>;
  apiBindings?: Array<{ bindingId: string; apiId: string; authJson?: Record<string, unknown> }>;
  mcpDefs?: Array<{ serverId: string; name?: string }>;
  mcpBindings?: Array<{
    bindingId: string;
    serverId: string;
    pinnedOrigin?: string;
    cachedTools?: Array<{ name: string }>;
  }>;
}): void {
  mockApiDefs.length = 0;
  mockApiBindings.length = 0;
  mockMcpDefs.length = 0;
  mockMcpBindings.length = 0;
  for (const d of opts.apiDefs ?? []) {
    mockApiDefs.push({
      apiId: d.apiId,
      name: d.name ?? d.apiId,
      description: null,
      enabled: 1,
      definitionJson: { endpoints: [] },
    });
  }
  for (const b of opts.apiBindings ?? []) {
    mockApiBindings.push({
      bindingId: b.bindingId,
      apiId: b.apiId,
      scopeJson: { spaceId: SPACE_ID },
      authJson: b.authJson ?? { type: 'none' },
      enabled: 1,
    });
  }
  for (const d of opts.mcpDefs ?? []) {
    mockMcpDefs.push({
      serverId: d.serverId,
      name: d.name ?? d.serverId,
      description: null,
      enabled: 1,
      definitionJson: {},
    });
  }
  for (const b of opts.mcpBindings ?? []) {
    mockMcpBindings.push({
      bindingId: b.bindingId,
      serverId: b.serverId,
      scopeJson: { spaceId: SPACE_ID },
      authJson: { type: 'none' },
      pinnedOrigin: b.pinnedOrigin ?? null,
      cachedTools: b.cachedTools ?? [],
      cachedToolsAt: b.cachedTools ? new Date() : null,
      enabled: 1,
    });
  }
}

describe('handleIntegrationRegistryListInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefs.length = 0;
    mockApiBindings.length = 0;
    mockMcpDefs.length = 0;
    mockMcpBindings.length = 0;
  });

  it('returns empty inventory when nothing is configured', async () => {
    const out = await runList();
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.definitionOnlyCount).toBe(0);
  });

  it('lists bound and needs_credentials items but hides definition-only by default', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'alpaca', name: 'Alpaca' }, { apiId: 'unused-api' }],
      apiBindings: [{ bindingId: 'alpaca-default', apiId: 'alpaca' }],
      mcpDefs: [{ serverId: 'kaggle', name: 'Kaggle' }],
      mcpBindings: [
        // Unpinned → needs_credentials
        { bindingId: 'kaggle-default', serverId: 'kaggle' },
      ],
    });
    const out = await runList();
    // 1 bound API + 1 needs_credentials MCP. The definition-only API is hidden.
    expect(out.items.map((i) => i['integrationId']).sort()).toEqual(['alpaca', 'kaggle']);
    expect(out.definitionOnlyCount).toBe(1);
    expect(out.items.find((i) => i['integrationId'] === 'alpaca')).toMatchObject({
      sourceKind: 'api',
      status: 'bound',
    });
    expect(out.items.find((i) => i['integrationId'] === 'kaggle')).toMatchObject({
      sourceKind: 'mcp',
      status: 'needs_credentials',
      credentialStatus: 'unpinned',
    });
  });

  it('includes definition-only entries when includeDefinitionOnly=true', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'unused-api', name: 'Unused' }],
    });
    const out = await runList({ includeDefinitionOnly: true });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      sourceKind: 'api',
      integrationId: 'unused-api',
      status: 'definition-only',
    });
    expect(out.items[0]?.['bindingId']).toBeUndefined();
  });

  it('filters by sourceKinds', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'alpaca' }],
      apiBindings: [{ bindingId: 'alpaca-default', apiId: 'alpaca' }],
      mcpDefs: [{ serverId: 'kaggle' }],
      mcpBindings: [
        {
          bindingId: 'kaggle-default',
          serverId: 'kaggle',
          pinnedOrigin: 'https://mcp.kaggle.com',
        },
      ],
    });
    const apiOnly = await runList({ sourceKinds: ['api'] });
    expect(apiOnly.items.every((i) => i['sourceKind'] === 'api')).toBe(true);
    const mcpOnly = await runList({ sourceKinds: ['mcp'] });
    expect(mcpOnly.items.every((i) => i['sourceKind'] === 'mcp')).toBe(true);
  });

  it('reports toolCount = endpoints.length for bound APIs', async () => {
    mockApiDefs.push({
      apiId: 'alpaca',
      name: 'Alpaca',
      description: null,
      enabled: 1,
      definitionJson: {
        endpoints: [
          { endpointId: 'get_bars', method: 'GET', pathTemplate: '/bars', params: [] },
          {
            endpointId: 'list_positions',
            method: 'GET',
            pathTemplate: '/positions',
            params: [],
          },
        ],
      },
    });
    mockApiBindings.push({
      bindingId: 'alpaca-default',
      apiId: 'alpaca',
      scopeJson: { spaceId: SPACE_ID },
      authJson: { type: 'none' },
      enabled: 1,
    });
    const out = await runList();
    expect(out.items[0]).toMatchObject({
      sourceKind: 'api',
      status: 'bound',
      toolCount: 2,
    });
  });

  it("clamps the inventory to the agent's allowlist discovery scope", async () => {
    // Two bound integrations, but the active turn's DiscoveryScope only allows
    // kaggle. integration.registry.list must hide alpaca — otherwise a narrow
    // runner can probe identifiers outside its grant.
    setRegistry({
      apiDefs: [{ apiId: 'alpaca' }, { apiId: 'kaggle' }],
      apiBindings: [
        { bindingId: 'alpaca-default', apiId: 'alpaca' },
        { bindingId: 'kaggle-default', apiId: 'kaggle' },
      ],
    });
    mockGetSessionState.mockResolvedValueOnce({
      runtimeState: {
        variables: {
          'ai.agent._discoveryScope': {
            ref: {
              kind: 'inline',
              value: {
                allowedStepTypes: ['api'],
                allowedAgents: false,
                allowedMcpServerIds: [],
                integrations: {
                  mode: 'allowlist',
                  allowed: [{ sourceKind: 'api', integrationId: 'kaggle' }],
                },
              },
            },
          },
        },
      },
    });
    const out = await runList();
    expect(out.items.map((i) => i['integrationId'])).toEqual(['kaggle']);
  });
});
