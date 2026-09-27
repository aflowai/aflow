import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';
import { createMemoryPayloadStore } from '@aflow/payload-store';

// ============================================================================
// Mocks (mirror prepareDesignSurface.test.ts)
// ============================================================================

const mockAddStepResult = vi.fn();

const mockTxApiDefinitionsRows: Array<Record<string, unknown>> = [];
const mockTxApiBindingsRows: Array<Record<string, unknown>> = [];
const mockTxMcpDefinitionsRows: Array<Record<string, unknown>> = [];
const mockTxMcpBindingsRows: Array<Record<string, unknown>> = [];

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  getSessionState: (...args: unknown[]) => mockGetSessionState(...(args as [])),
}));

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

vi.mock('@aflow/database', () => {
  const apiDefinitions = { __table: 'apiDefinitions', spaceId: 'spaceId' };
  const apiBindings = { __table: 'apiBindings', enabled: 'enabled' };
  const mcpServerDefinitions = { __table: 'mcpServerDefinitions', spaceId: 'spaceId' };
  const mcpServerBindings = { __table: 'mcpServerBindings', enabled: 'enabled' };

  function buildTx(): unknown {
    return {
      select: () => ({
        from: (table: { __table: string }) => ({
          where: () => {
            switch (table.__table) {
              case 'apiDefinitions':
                return Promise.resolve(mockTxApiDefinitionsRows);
              case 'apiBindings':
                return Promise.resolve(mockTxApiBindingsRows);
              case 'mcpServerDefinitions':
                return Promise.resolve(mockTxMcpDefinitionsRows);
              case 'mcpServerBindings':
                return Promise.resolve(mockTxMcpBindingsRows);
              default:
                return Promise.resolve([]);
            }
          },
        }),
      }),
      // Raw-SQL reads (store_installs) — no installs in these fixtures.
      execute: () => Promise.resolve([]),
    };
  }

  return {
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(buildTx()),
    ),
    getTenantStoreShelfPolicy: vi.fn(async () => ({
      defaultAvailability: 'available',
      overrides: new Map(),
    })),
    apiDefinitions,
    apiBindings,
    mcpServerDefinitions,
    mcpServerBindings,
  };
});

// ============================================================================
// Test helpers
// ============================================================================

const SPACE_ID = '41be431d-6011-495b-a4f2-6de539a6a0df';
const OTHER_SPACE_ID = '99999999-9999-9999-9999-999999999999';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function decodeOutput(ref: string): {
  status: string;
  matches: Array<Record<string, unknown>>;
  catalogCandidates?: Array<Record<string, unknown>>;
} {
  const decoded = Buffer.from(ref.slice('inline:'.length), 'base64').toString('utf8');
  return JSON.parse(decoded) as {
    status: string;
    matches: Array<Record<string, unknown>>;
    catalogCandidates?: Array<Record<string, unknown>>;
  };
}

function makeArgs(identifier: string): InlineHandlerArgs {
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
      stepId: 'lookup',
      stepType: 'capability',
      operation: 'integration.registry.lookup',
      config: {},
      tags: [],
      role: 'helmsman-preflight',
      onSuccess: { next: [] },
      onFailure: { next: [] },
    } as never,
    stepExecutionId: 'step-exec-1' as never,
    idempotencyKey: 'idem-1' as never,
    resolvedInputRef: inlineRef({ identifier }),
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function setRegistry(opts: {
  apiDefs?: Array<{ apiId: string; name?: string; enabled?: number }>;
  apiBindings?: Array<{
    bindingId: string;
    apiId: string;
    scopeSpaceId?: string;
    authJson?: Record<string, unknown>;
    /** Defaults to 1 (enabled). Set 0 to exercise the disabled rollup. */
    enabled?: number;
  }>;
  mcpDefs?: Array<{
    serverId: string;
    name?: string;
    enabled?: number;
    toolFilter?: { include?: string[]; opTaskOnly?: string[] };
  }>;
  mcpBindings?: Array<{
    bindingId: string;
    serverId: string;
    scopeSpaceId?: string;
    pinnedOrigin?: string;
    authJson?: Record<string, unknown>;
    cachedTools?: Array<{ name: string; description?: string }>;
  }>;
}): void {
  mockTxApiDefinitionsRows.length = 0;
  mockTxApiBindingsRows.length = 0;
  mockTxMcpDefinitionsRows.length = 0;
  mockTxMcpBindingsRows.length = 0;

  for (const def of opts.apiDefs ?? []) {
    mockTxApiDefinitionsRows.push({
      apiId: def.apiId,
      name: def.name ?? def.apiId,
      description: null,
      definitionJson: def.name ? { name: def.name, endpoints: [] } : { endpoints: [] },
      enabled: def.enabled ?? 1,
    });
  }
  for (const b of opts.apiBindings ?? []) {
    mockTxApiBindingsRows.push({
      bindingId: b.bindingId,
      apiId: b.apiId,
      scopeJson: { spaceId: b.scopeSpaceId ?? SPACE_ID },
      authJson: b.authJson ?? { type: 'none' },
      enabled: b.enabled ?? 1,
    });
  }
  for (const def of opts.mcpDefs ?? []) {
    mockTxMcpDefinitionsRows.push({
      serverId: def.serverId,
      name: def.name ?? def.serverId,
      description: null,
      definitionJson: {
        ...(def.name ? { name: def.name } : {}),
        ...(def.toolFilter ? { toolFilter: def.toolFilter } : {}),
      },
      enabled: def.enabled ?? 1,
    });
  }
  for (const b of opts.mcpBindings ?? []) {
    mockTxMcpBindingsRows.push({
      bindingId: b.bindingId,
      serverId: b.serverId,
      scopeJson: { spaceId: b.scopeSpaceId ?? SPACE_ID },
      authJson: b.authJson ?? { type: 'none' },
      pinnedOrigin: b.pinnedOrigin ?? null,
      cachedTools: b.cachedTools ?? [],
      cachedToolsAt: b.cachedTools ? new Date() : null,
      enabled: 1,
    });
  }
}

async function runLookup(identifier: string): Promise<{
  status: string;
  matches: Array<Record<string, unknown>>;
  catalogCandidates?: Array<Record<string, unknown>>;
}> {
  const { handleIntegrationRegistryLookupInline } = await import('../integrationRegistryLookup.js');
  await handleIntegrationRegistryLookupInline(makeArgs(identifier));
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeTruthy();
  const msg = call?.[1] as {
    status: string;
    outputRef?: string;
    error?: Record<string, unknown>;
  };
  if (msg.status !== 'SUCCEEDED') {
    throw new Error(`Expected SUCCEEDED but got ${msg.status}: ${JSON.stringify(msg.error)}`);
  }
  return decodeOutput(msg.outputRef!);
}

// ============================================================================
// Tests
// ============================================================================

describe('handleIntegrationRegistryLookupInline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTxApiDefinitionsRows.length = 0;
    mockTxApiBindingsRows.length = 0;
    mockTxMcpDefinitionsRows.length = 0;
    mockTxMcpBindingsRows.length = 0;
  });

  it('returns status="unknown" when nothing matches', async () => {
    setRegistry({});
    const out = await runLookup('kaggle');
    expect(out.status).toBe('unknown');
    expect(out.matches).toEqual([]);
  });

  it('returns status="definition-only" with per-match status when an API definition exists but is not bound', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'kaggle-api', name: 'Kaggle' }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('definition-only');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'api',
      status: 'definition-only',
      identifier: 'kaggle-api',
      apiId: 'kaggle-api',
      definitionName: 'Kaggle',
    });
    expect(out.matches[0]?.['bindingId']).toBeUndefined();
  });

  it('returns status="bound" with per-match status when an API has an enabled in-scope binding', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'kaggle-api', name: 'Kaggle' }],
      apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api' }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('bound');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'api',
      status: 'bound',
      identifier: 'kaggle-api',
      apiId: 'kaggle-api',
      bindingId: 'kaggle-prod',
    });
  });

  it('matches MCP servers as sourceKind="mcp"', async () => {
    setRegistry({
      mcpDefs: [{ serverId: 'kaggle-mcp', name: 'Kaggle MCP' }],
      mcpBindings: [
        {
          bindingId: 'kaggle-mcp-binding',
          serverId: 'kaggle-mcp',
          pinnedOrigin: 'https://mcp.kaggle.com',
        },
      ],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('bound');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'mcp',
      status: 'bound',
      identifier: 'kaggle-mcp',
      serverId: 'kaggle-mcp',
      bindingId: 'kaggle-mcp-binding',
    });
  });

  it('reports MCP without pinnedOrigin as needs_credentials (unpinned)', async () => {
    setRegistry({
      mcpDefs: [{ serverId: 'kaggle-mcp', name: 'Kaggle MCP' }],
      mcpBindings: [
        // No pinnedOrigin → operator hasn't run mcp.binding.test yet.
        { bindingId: 'kaggle-mcp-binding', serverId: 'kaggle-mcp' },
      ],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('needs_credentials');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'mcp',
      status: 'needs_credentials',
      credentialStatus: 'unpinned',
      bindingId: 'kaggle-mcp-binding',
    });
  });

  it('reports API binding with missing credential keys as needs_credentials', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'kaggle-api', name: 'Kaggle' }],
      apiBindings: [
        {
          bindingId: 'kaggle-prod',
          apiId: 'kaggle-api',
          // bearer auth with a credentialKey that won't be in api_credentials
          // (the in-memory mock has no api_credentials seeding).
          authJson: { type: 'bearer', credentialKey: 'kaggle-missing-key' },
        },
      ],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('needs_credentials');
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'api',
      status: 'needs_credentials',
      credentialStatus: 'missing',
    });
  });

  it('matches by bindingId substring even when the apiId/name does not match', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'generic-rest', name: 'Generic REST' }],
      apiBindings: [{ bindingId: 'kaggle-prod-binding', apiId: 'generic-rest' }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('bound');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({
      sourceKind: 'api',
      status: 'bound',
      apiId: 'generic-rest',
      bindingId: 'kaggle-prod-binding',
    });
  });

  it('suppresses bindingId-only matches when the referenced definition is not visible in this space', async () => {
    // Pass B used to add bindings whose `apiId` had no in-space definition,
    // reporting them as `'bound'`. The design surface (built from in-space
    // definitions) would then NOT list the binding — Helmsman would forward
    // a status: 'bound' that immediately fails the Layer 3 binding-stale
    // check on the next compose-skill turn. Drop the match here instead.
    setRegistry({
      // No definitions in scope.
      apiDefs: [],
      apiBindings: [{ bindingId: 'kaggle-prod-binding', apiId: 'kaggle-api' }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('unknown');
    expect(out.matches).toEqual([]);
  });

  it('filters out bindings scoped to a different space', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'kaggle-api', name: 'Kaggle' }],
      apiBindings: [
        { bindingId: 'kaggle-other', apiId: 'kaggle-api', scopeSpaceId: OTHER_SPACE_ID },
      ],
    });
    // Definition exists in this space; binding is scoped to a different space
    // so it should be ignored — result is definition-only, not bound.
    const out = await runLookup('kaggle');
    expect(out.status).toBe('definition-only');
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.['status']).toBe('definition-only');
  });

  it('keeps multiple matches per-vendor disambiguated when an identifier is ambiguous', async () => {
    // The classic "git" trap: substring-matches GitHub (bound) and GitLab
    // (definition-only). Top-level rolls up to bound, but per-match status
    // tells Helmsman which specific vendor still needs binding.
    setRegistry({
      apiDefs: [
        { apiId: 'github-api', name: 'GitHub' },
        { apiId: 'gitlab-api', name: 'GitLab' },
      ],
      apiBindings: [{ bindingId: 'gh-prod', apiId: 'github-api' }],
    });
    const out = await runLookup('git');
    expect(out.status).toBe('bound');
    expect(out.matches).toHaveLength(2);
    const github = out.matches.find((m) => m['apiId'] === 'github-api');
    const gitlab = out.matches.find((m) => m['apiId'] === 'gitlab-api');
    expect(github).toMatchObject({ status: 'bound', bindingId: 'gh-prod' });
    expect(gitlab).toMatchObject({ status: 'definition-only' });
    expect(gitlab?.['bindingId']).toBeUndefined();
  });

  it('matches case-insensitively', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'KAGGLE-API', name: 'Kaggle' }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('definition-only');
    expect(out.matches).toHaveLength(1);
  });

  it('emits FAILED on invalid input', async () => {
    setRegistry({});
    const { handleIntegrationRegistryLookupInline } =
      await import('../integrationRegistryLookup.js');
    await handleIntegrationRegistryLookupInline({
      ...makeArgs(''),
      // Empty identifier fails the schema's min(1).
      resolvedInputRef: inlineRef({ identifier: '' }),
    });
    const call = mockAddStepResult.mock.calls.at(-1);
    expect(call).toBeTruthy();
    const msg = call?.[1] as { status: string };
    expect(msg.status).toBe('FAILED');
  });

  it('rolls up to "disabled" when all matches are explicitly disabled (reviewer P2)', async () => {
    // Operator manually disabled the only binding. The next operator action
    // is "re-enable" — NOT "rebind" (which is what definition-only implies).
    // Pre-fix, the rollup fell through to definition-only and misdirected
    // callers.
    setRegistry({
      apiDefs: [{ apiId: 'kaggle-api', name: 'Kaggle' }],
      apiBindings: [{ bindingId: 'kaggle-prod', apiId: 'kaggle-api', enabled: 0 }],
    });
    const out = await runLookup('kaggle');
    expect(out.status).toBe('disabled');
    expect(out.matches.every((m) => m.status === 'disabled')).toBe(true);
  });

  it('surfaces store catalogCandidates when the vendor is unknown', async () => {
    setRegistry({});
    const out = await runLookup('jira');
    expect(out.status).toBe('unknown');
    const jira = out.catalogCandidates?.find((c) => c['catalogId'] === 'jira-cloud');
    expect(jira).toMatchObject({
      kind: 'connector',
      installedState: 'not_installed',
    });
    expect(typeof jira?.['version']).toBe('number');
  });

  it('surfaces store catalogCandidates when the vendor is definition-only', async () => {
    setRegistry({ apiDefs: [{ apiId: 'jira-api', name: 'Jira' }] });
    const out = await runLookup('jira');
    expect(out.status).toBe('definition-only');
    expect(out.catalogCandidates?.some((c) => c['catalogId'] === 'jira-cloud')).toBe(true);
  });

  it('omits catalogCandidates when a binding exists — the fix is on the binding, not an install', async () => {
    setRegistry({
      apiDefs: [{ apiId: 'jira-api', name: 'Jira' }],
      apiBindings: [{ bindingId: 'jira-prod', apiId: 'jira-api' }],
    });
    const out = await runLookup('jira');
    expect(out.status).toBe('bound');
    expect(out.catalogCandidates).toBeUndefined();
  });

  it("clamps lookup matches to the agent's allowlist discovery scope", async () => {
    // Both alpaca and kaggle have bound APIs, but the active turn only allows
    // kaggle. A lookup for "a" must NOT surface alpaca — narrow runners
    // should not be able to probe identifiers outside their grant.
    setRegistry({
      apiDefs: [
        { apiId: 'alpaca', name: 'Alpaca' },
        { apiId: 'kaggle', name: 'Kaggle' },
      ],
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
    const out = await runLookup('a');
    expect(out.matches.map((m) => m.identifier)).not.toContain('alpaca');
  });
});
