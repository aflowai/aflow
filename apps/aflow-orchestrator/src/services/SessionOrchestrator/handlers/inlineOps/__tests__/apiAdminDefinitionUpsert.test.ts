import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  publishApiCatalogInvalidation: vi.fn(),
}));

let priorDefinitionRows: Array<{ definitionJson: Record<string, unknown> }> = [];

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(priorDefinitionRows), {
              limit: () => Promise.resolve(priorDefinitionRows),
            }),
        }),
      }),
      execute: () => Promise.resolve([]),
    }),
  ),
  apiDefinitions: { apiId: 'apiId', spaceId: 'spaceId', definitionJson: 'definitionJson' },
  apiBindings: { bindingId: 'bindingId', apiId: 'apiId', spaceId: 'spaceId' },
  apiCredentials: { credentialKey: 'credentialKey', spaceId: 'spaceId' },
  oauthTokens: {
    integrationKind: 'integrationKind',
    resourceKey: 'resourceKey',
    expiresAt: 'expiresAt',
    refreshTokenEnc: 'refreshTokenEnc',
  },
}));

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    enforceIntegrationHostPolicy: vi.fn(() => Promise.resolve()),
  };
});

const { handleApiAdminOpInline } = await import('../apiAdmin.js');
const { diffEndpointsById } = await import('../apiAdminOpenApiImport.js');
const { buildMergedDefinitionJson, PLANE_ONLY_ENDPOINT_FIELDS } =
  await import('../apiDefinitionMerge.js');

function buildArgs(input: Record<string, unknown>): InlineHandlerArgs {
  return {
    redis: {} as InlineHandlerArgs['redis'],
    payloadStore: {
      retrieve: vi.fn(() => Promise.resolve(input)),
      shouldStore: vi.fn(() => false),
      store: vi.fn(() => Promise.resolve('inline:e30=')),
    } as unknown as InlineHandlerArgs['payloadStore'],
    context: {
      tenantId: 'tenant-1',
      runId: 'run-1',
      spaceId: 'space-1',
      traceId: 'trace-1',
    } as unknown as InlineHandlerArgs['context'],
    stepDef: {
      stepId: 'step-1',
      stepType: 'platform',
      operation: 'api.definition.upsert',
    } as unknown as InlineHandlerArgs['stepDef'],
    stepExecutionId: 'se-1' as InlineHandlerArgs['stepExecutionId'],
    idempotencyKey: 'idem-1' as InlineHandlerArgs['idempotencyKey'],
    resolvedInputRef: 'inline:e30=',
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

function lastResult(): Record<string, unknown> {
  const call = mockAddStepResult.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1] as Record<string, unknown>;
}

function decodeOutput(result: Record<string, unknown>): Record<string, unknown> {
  const ref = result['outputRef'] as string;
  expect(ref.startsWith('inline:')).toBe(true);
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString()) as Record<
    string,
    unknown
  >;
}

// Stored endpoint as it comes back from the jsonb column — Postgres re-orders
// object keys (length, then bytewise), NOT zod shape order. The diff must still
// recognize an identical resend.
const canonicalEndpoint = (endpointId: string, pathTemplate: string) => ({
  name: endpointId,
  tags: [],
  method: 'GET',
  params: [],
  endpointId,
  pathTemplate,
});

const inputEndpoint = (endpointId: string, pathTemplate: string) => ({
  endpointId,
  name: endpointId,
  method: 'GET',
  pathTemplate,
});

const storedDefinition = () => ({
  definitionJson: {
    apiId: 'vercel',
    name: 'Vercel',
    baseUrl: 'https://api.vercel.com',
    version: '1',
    endpoints: [
      canonicalEndpoint('listProjects', '/v9/projects'),
      canonicalEndpoint('listDeployments', '/v6/deployments'),
    ],
    tags: [],
  },
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  apiId: 'vercel',
  name: 'Vercel',
  baseUrl: 'https://api.vercel.com',
  endpoints: [],
  ...overrides,
});

describe('api.definition.upsert — endpoint merge semantics', () => {
  beforeEach(() => {
    mockAddStepResult.mockClear();
    priorDefinitionRows = [];
  });

  it('creates a new definition and reports status created with all endpoints added', async () => {
    await handleApiAdminOpInline(
      buildArgs(baseInput({ endpoints: [inputEndpoint('listProjects', '/v9/projects')] })),
    );
    const result = lastResult();
    expect(result['status']).toBe('SUCCEEDED');
    expect(decodeOutput(result)).toMatchObject({
      apiId: 'vercel',
      status: 'created',
      endpoints: { added: ['listProjects'], updated: [], removed: [], unchanged: 0 },
    });
  });

  it('adding one endpoint keeps the stored ones (merge, not replace)', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(
        baseInput({ endpoints: [inputEndpoint('getAnalytics', '/v1/query/web-analytics')] }),
      ),
    );
    const output = decodeOutput(lastResult());
    expect(output).toMatchObject({
      status: 'updated',
      endpoints: { added: ['getAnalytics'], updated: [], removed: [], unchanged: 2 },
    });
  });

  it('sending one changed endpoint updates only that endpoint', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(baseInput({ endpoints: [inputEndpoint('listDeployments', '/v13/deployments')] })),
    );
    const output = decodeOutput(lastResult());
    expect(output).toMatchObject({
      status: 'updated',
      endpoints: { added: [], updated: ['listDeployments'], removed: [], unchanged: 1 },
    });
  });

  it('an identical resend reports all-unchanged', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(
        baseInput({
          endpoints: [
            inputEndpoint('listProjects', '/v9/projects'),
            inputEndpoint('listDeployments', '/v6/deployments'),
          ],
        }),
      ),
    );
    const output = decodeOutput(lastResult());
    expect(output).toMatchObject({
      status: 'updated',
      endpoints: { added: [], updated: [], removed: [], unchanged: 2 },
    });
  });

  it('removes endpoints only via removeEndpointIds', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(baseInput({ endpoints: [], removeEndpointIds: ['listDeployments'] })),
    );
    const output = decodeOutput(lastResult());
    expect(output).toMatchObject({
      status: 'updated',
      endpoints: { added: [], updated: [], removed: ['listDeployments'], unchanged: 1 },
    });
  });

  it('fails loud when removeEndpointIds names an unknown endpoint', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(baseInput({ endpoints: [], removeEndpointIds: ['getAnalytics'] })),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    expect(String((result['error'] as { message: string }).message)).toContain('getAnalytics');
  });

  it('fails loud when an endpoint is both provided and removed', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(
        baseInput({
          endpoints: [inputEndpoint('listProjects', '/v9/projects')],
          removeEndpointIds: ['listProjects'],
        }),
      ),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    expect(String((result['error'] as { message: string }).message)).toContain('listProjects');
  });
});

describe('buildMergedDefinitionJson — whole-definition preserve-on-omit', () => {
  const prior = {
    apiId: 'vercel',
    name: 'Vercel',
    description: 'Deploy platform',
    baseUrl: 'https://api.vercel.com',
    version: '3',
    endpoints: [canonicalEndpoint('listProjects', '/v9/projects')],
    defaultHeaders: { 'X-Client': 'phoenix' },
    suggestedEgressPolicy: { allowCrossHostRedirects: true },
    tags: ['deploy'],
  };

  it('an endpoint-only input keeps every stored non-endpoint field', () => {
    const merged = buildMergedDefinitionJson(
      'vercel',
      { apiId: 'vercel', name: 'Vercel', endpoints: [inputEndpoint('getAnalytics', '/v1/q')] },
      prior,
    );
    expect(merged).toMatchObject({
      description: 'Deploy platform',
      baseUrl: 'https://api.vercel.com',
      version: '3',
      defaultHeaders: { 'X-Client': 'phoenix' },
      suggestedEgressPolicy: { allowCrossHostRedirects: true },
      tags: ['deploy'],
    });
    expect((merged['endpoints'] as unknown[]).length).toBe(2);
  });

  it('explicit input fields win over stored ones', () => {
    const merged = buildMergedDefinitionJson(
      'vercel',
      { apiId: 'vercel', name: 'Vercel v2', description: 'New', tags: [], endpoints: [] },
      prior,
    );
    expect(merged['name']).toBe('Vercel v2');
    expect(merged['description']).toBe('New');
    expect(merged['tags']).toEqual([]);
  });

  it('providing a base form takes the input group exclusively; omitting inherits it', () => {
    const templatePrior = {
      ...prior,
      baseUrl: undefined,
      baseUrlTemplate: 'https://{domain}.example.com',
      variables: [{ name: 'domain', description: 'sub' }],
    };
    const inherited = buildMergedDefinitionJson(
      'vercel',
      { apiId: 'vercel', name: 'Vercel', endpoints: [] },
      templatePrior,
    );
    expect(inherited['baseUrlTemplate']).toBe('https://{domain}.example.com');
    expect(inherited['variables']).toEqual([{ name: 'domain', description: 'sub' }]);
    expect(inherited['baseUrl']).toBeUndefined();

    const switched = buildMergedDefinitionJson(
      'vercel',
      { apiId: 'vercel', name: 'Vercel', baseUrl: 'https://api.vercel.com', endpoints: [] },
      templatePrior,
    );
    expect(switched['baseUrl']).toBe('https://api.vercel.com');
    expect(switched['baseUrlTemplate']).toBeUndefined();
    expect(switched['variables']).toBeUndefined();
  });

  it('preserves plane-only endpoint fields on a re-send and strips them from input', () => {
    expect(PLANE_ONLY_ENDPOINT_FIELDS).toContain('writeRiskTier');
    const tieredPrior = {
      ...prior,
      endpoints: [
        { ...canonicalEndpoint('createDeployment', '/v13/deployments'), writeRiskTier: 'high' },
      ],
    };
    const merged = buildMergedDefinitionJson(
      'vercel',
      {
        apiId: 'vercel',
        name: 'Vercel',
        endpoints: [
          {
            ...inputEndpoint('createDeployment', '/v13/deployments-v2'),
            writeRiskTier: 'low',
          },
        ],
      },
      tieredPrior,
    );
    const endpoints = merged['endpoints'] as Array<Record<string, unknown>>;
    expect(endpoints[0]?.['pathTemplate']).toBe('/v13/deployments-v2');
    expect(endpoints[0]?.['writeRiskTier']).toBe('high');
  });

  it('carries an authored responseSchemas through while writeRiskTier stays protected', () => {
    // The plane-only set is derived by subtracting the upsert input schema from
    // the endpoint schema, so making a field agent-writable removes it from the
    // set silently. This pins both halves of that subtraction at once: the
    // newly writable field must land, the plane-only one must not.
    expect(PLANE_ONLY_ENDPOINT_FIELDS).not.toContain('responseSchemas');
    expect(PLANE_ONLY_ENDPOINT_FIELDS).toContain('writeRiskTier');

    const authored = {
      '2xx': { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      '4xx': { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    };
    const tieredPrior = {
      ...prior,
      endpoints: [
        { ...canonicalEndpoint('createDeployment', '/v13/deployments'), writeRiskTier: 'high' },
      ],
    };
    const merged = buildMergedDefinitionJson(
      'vercel',
      {
        apiId: 'vercel',
        name: 'Vercel',
        endpoints: [
          {
            ...inputEndpoint('createDeployment', '/v13/deployments'),
            responseSchemas: authored,
            writeRiskTier: 'low',
          },
        ],
      },
      tieredPrior,
    );

    const endpoints = merged['endpoints'] as Array<Record<string, unknown>>;
    expect(endpoints[0]?.['responseSchemas']).toEqual(authored);
    expect(endpoints[0]?.['writeRiskTier']).toBe('high');
  });
});

describe('diffEndpointsById', () => {
  it('classifies added, updated, removed, unchanged by endpointId', () => {
    const existing = [
      canonicalEndpoint('a', '/a'),
      canonicalEndpoint('b', '/b'),
      canonicalEndpoint('c', '/c'),
    ];
    const next = [
      canonicalEndpoint('a', '/a'),
      canonicalEndpoint('b', '/b2'),
      canonicalEndpoint('d', '/d'),
    ];
    expect(diffEndpointsById(existing, next)).toEqual({
      added: ['d'],
      updated: ['b'],
      removed: ['c'],
      unchanged: 1,
    });
  });
});

describe('api.definition.upsert — duplicate input endpointIds', () => {
  it('fails loud when the same endpointId appears twice in the input, even if stored', async () => {
    priorDefinitionRows = [storedDefinition()];
    await handleApiAdminOpInline(
      buildArgs(
        baseInput({
          endpoints: [
            inputEndpoint('listProjects', '/v9/projects'),
            inputEndpoint('listProjects', '/v10/projects'),
          ],
        }),
      ),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    expect(String((result['error'] as { message: string }).message)).toContain(
      'Duplicate endpointId',
    );
  });
});
