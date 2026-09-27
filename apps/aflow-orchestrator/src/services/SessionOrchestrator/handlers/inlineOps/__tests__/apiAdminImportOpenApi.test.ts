import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineHandlerArgs } from '../types.js';

const mockAddStepResult = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  publishApiCatalogInvalidation: vi.fn(),
}));

vi.mock('@aflow/database', () => ({
  getDatabase: vi.fn(() => ({})),
  createTenantContext: vi.fn(() => ({})),
  withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }),
      execute: () => Promise.resolve([]),
    }),
  ),
  apiDefinitions: { apiId: 'apiId', spaceId: 'spaceId' },
  apiBindings: { bindingId: 'bindingId', apiId: 'apiId', spaceId: 'spaceId' },
  apiCredentials: { credentialKey: 'credentialKey', spaceId: 'spaceId' },
  oauthTokens: {
    integrationKind: 'integrationKind',
    resourceKey: 'resourceKey',
    expiresAt: 'expiresAt',
    refreshTokenEnc: 'refreshTokenEnc',
  },
}));

const mockEnforceIntegrationHostPolicy = vi.fn<(opts: { hosts: readonly string[] }) => unknown>(
  () => Promise.resolve(),
);

vi.mock('@aflow/cybernetic-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aflow/cybernetic-runtime')>(
    '@aflow/cybernetic-runtime',
  );
  return {
    ...actual,
    enforceIntegrationHostPolicy: (opts: { hosts: readonly string[] }) =>
      mockEnforceIntegrationHostPolicy(opts),
  };
});

const { handleApiAdminOpInline } = await import('../apiAdmin.js');
const { IntegrationHostPolicyError, integrationHostDenialMessage } =
  await import('@aflow/cybernetic-runtime');

const SPEC_JSON = {
  info: { title: 'Example API' },
  servers: [{ url: 'https://api.example.com' }],
  paths: {
    '/items': {
      get: { operationId: 'listItems', summary: 'List items' },
      post: {
        operationId: 'createItem',
        summary: 'Create item',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      },
    },
  },
};

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
      operation: 'api.definition.import_openapi',
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

describe('api.definition.import_openapi specUrl fetch guard', () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(SPEC_JSON),
    }),
  );

  beforeEach(() => {
    mockAddStepResult.mockClear();
    mockEnforceIntegrationHostPolicy.mockClear();
    mockEnforceIntegrationHostPolicy.mockImplementation(() => Promise.resolve());
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a metadata-IP specUrl before any fetch', async () => {
    await handleApiAdminOpInline(
      buildArgs({ apiId: 'ex', specUrl: 'https://169.254.169.254/spec.json', dryRun: true }),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as { code: string }).code).toBe('API_SSRF_BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a loopback-IP specUrl before any fetch', async () => {
    await handleApiAdminOpInline(
      buildArgs({ apiId: 'ex', specUrl: 'http://127.0.0.1:8080/spec.json', dryRun: true }),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    expect((result['error'] as { code: string }).code).toBe('API_SSRF_BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies an uncovered spec host through the shared host policy before fetching', async () => {
    mockEnforceIntegrationHostPolicy.mockImplementation((opts) => {
      throw new IntegrationHostPolicyError({
        code: 'INTEGRATION_HOST_NOT_ALLOWED',
        kind: 'api',
        deniedHosts: [...opts.hosts],
        message: integrationHostDenialMessage(opts.hosts),
      });
    });
    await handleApiAdminOpInline(
      buildArgs({ apiId: 'ex', specUrl: 'https://8.8.8.8/spec.json', dryRun: true }),
    );
    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    const error = result['error'] as { code: string; details?: { deniedHosts: string[] } };
    expect(error.code).toBe('INTEGRATION_HOST_NOT_ALLOWED');
    expect(error.details?.deniedHosts).toEqual(['8.8.8.8']);
    expect(mockEnforceIntegrationHostPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ hosts: ['8.8.8.8'] }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches with redirects refused when the policy permits the spec host', async () => {
    await handleApiAdminOpInline(
      buildArgs({ apiId: 'ex', specUrl: 'https://8.8.8.8/spec.json', dryRun: true }),
    );
    const result = lastResult();
    expect(result['status']).toBe('SUCCEEDED');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://8.8.8.8/spec.json',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
