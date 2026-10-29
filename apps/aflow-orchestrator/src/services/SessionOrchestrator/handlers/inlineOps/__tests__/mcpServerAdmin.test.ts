import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureLogging } from '@aflow/observability';
import type { InlineHandlerArgs } from '../types.js';

beforeAll(() => {
  configureLogging({ service: 'test', level: 'silent' });
});

const mockAddStepResult = vi.fn();
const mockPublishMcpCatalogInvalidation = vi.fn();

vi.mock('@aflow/redis', () => ({
  addStepResult: (...args: unknown[]) => mockAddStepResult(...args),
  publishMcpCatalogInvalidation: (...args: unknown[]) => mockPublishMcpCatalogInvalidation(...args),
}));

// Rows the next `select` answers with, and the SQL and bound values every `execute` was given.
let selectRows: unknown[] = [];
let executeRows: unknown[] = [];
const executed: string[] = [];
const executedParams: unknown[][] = [];

function textOf(chunk: unknown): string | null {
  const value =
    chunk !== null && typeof chunk === 'object' ? (chunk as { value?: unknown }).value : null;
  return Array.isArray(value) ? value.join('') : null;
}

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => textOf(chunk) ?? '?').join('');
}

function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((chunk) => textOf(chunk) === null);
}

const tx = {
  select: () => ({
    from: () => ({
      where: () =>
        Object.assign(Promise.resolve(selectRows), {
          limit: () => Promise.resolve(selectRows),
        }),
    }),
  }),
  execute: (query: unknown) => {
    executed.push(sqlText(query));
    executedParams.push(sqlParams(query));
    return Promise.resolve(executeRows);
  },
};

vi.mock('@aflow/database', async () => {
  const actual = await vi.importActual<typeof import('@aflow/database')>('@aflow/database');
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})),
    createTenantContext: vi.fn(() => ({})),
    withTenantSchema: vi.fn(async (_db: unknown, _ctx: unknown, fn: (t: unknown) => unknown) =>
      fn(tx),
    ),
    getTenantIntegrationPolicy: vi.fn(() => Promise.resolve({ mode: 'open', allowlist: [] })),
  };
});

const { handleMcpServerAdminInline } = await import('../mcpServerAdmin.js');
const database = await import('@aflow/database');

const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '22222222-2222-4222-8222-222222222222';

function buildArgs(operation: string, input: Record<string, unknown>): InlineHandlerArgs {
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
      spaceId: SPACE,
      traceId: 'trace-1',
    } as unknown as InlineHandlerArgs['context'],
    stepDef: {
      stepId: 'step-1',
      stepType: 'mcp',
      operation,
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
  expect(result['status']).toBe('SUCCEEDED');
  const ref = result['outputRef'] as string;
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString()) as Record<
    string,
    unknown
  >;
}

function lastError(): { code: string; message: string; classification: string } {
  const result = lastResult();
  expect(result['status']).toBe('FAILED');
  return result['error'] as { code: string; message: string; classification: string };
}

const storedDefinitionRow = {
  serverId: 'docs-mcp',
  name: 'Docs MCP',
  description: null,
  serverUrl: 'https://mcp.example.com/mcp',
  transport: 'streamable_http',
  definitionJson: {
    serverId: 'docs-mcp',
    toolFilter: { include: ['search'] },
  },
  tags: [],
  source: 'custom',
  enabled: 1,
  spaceId: SPACE,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
};

beforeEach(() => {
  mockAddStepResult.mockClear();
  mockPublishMcpCatalogInvalidation.mockClear();
  selectRows = [];
  executeRows = [];
  executed.length = 0;
  executedParams.length = 0;
  vi.mocked(database.getTenantIntegrationPolicy).mockResolvedValue({
    mode: 'open',
    allowlist: [],
  } as Awaited<ReturnType<typeof database.getTenantIntegrationPolicy>>);
});

describe('mcp.server.upsert', () => {
  const input = {
    serverId: 'docs-mcp',
    name: 'Docs MCP',
    serverUrl: 'https://mcp.example.com/mcp',
    spaceId: SPACE,
  };

  it('creates the definition in the run space from a URL alone and invalidates the catalog', async () => {
    executeRows = [{ created: true }];
    await handleMcpServerAdminInline(buildArgs('mcp.server.upsert', input));

    expect(decodeOutput(lastResult())).toEqual({
      serverId: 'docs-mcp',
      spaceId: SPACE,
      created: true,
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('INSERT INTO mcp_server_definitions');
    expect(mockPublishMcpCatalogInvalidation).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      SPACE,
      { kind: 'definition', serverId: 'docs-mcp' },
    );
  });

  it('reports an update as created: false', async () => {
    executeRows = [{ created: false }];
    await handleMcpServerAdminInline(buildArgs('mcp.server.upsert', input));
    expect(decodeOutput(lastResult())['created']).toBe(false);
  });

  it('refuses a spaceId naming another space and writes nothing', async () => {
    await handleMcpServerAdminInline(
      buildArgs('mcp.server.upsert', { ...input, spaceId: OTHER_SPACE }),
    );
    const error = lastError();
    expect(error.code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain(OTHER_SPACE);
    expect(executed).toHaveLength(0);
  });

  it('refuses an input without a serverUrl as a validation error', async () => {
    const { serverUrl: _omitted, ...withoutUrl } = input;
    await handleMcpServerAdminInline(buildArgs('mcp.server.upsert', withoutUrl));
    const error = lastError();
    expect(error.code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(error.message).toContain('serverUrl');
  });

  it("keeps the operator's egress decision: an allowlist denial fails the step and writes nothing", async () => {
    vi.mocked(database.getTenantIntegrationPolicy).mockResolvedValue({
      mode: 'allowlist',
      allowlist: [],
    } as unknown as Awaited<ReturnType<typeof database.getTenantIntegrationPolicy>>);
    vi.spyOn(database, 'getCatalogHostGrants').mockResolvedValue([]);

    await handleMcpServerAdminInline(buildArgs('mcp.server.upsert', input));

    const result = lastResult();
    expect(result['status']).toBe('FAILED');
    const error = result['error'] as { code: string; details?: { deniedHosts: string[] } };
    expect(error.code).toBe('INTEGRATION_HOST_NOT_ALLOWED');
    expect(error.details?.deniedHosts).toContain('mcp.example.com');
    expect(executed).toHaveLength(0);
  });
});

describe('mcp.server.get / list', () => {
  it('returns the stored definition in the public shape', async () => {
    selectRows = [storedDefinitionRow];
    await handleMcpServerAdminInline(
      buildArgs('mcp.server.get', { serverId: 'docs-mcp', spaceId: SPACE }),
    );
    expect(decodeOutput(lastResult())).toEqual({
      definition: {
        serverId: 'docs-mcp',
        name: 'Docs MCP',
        serverUrl: 'https://mcp.example.com/mcp',
        transport: 'streamable_http',
        toolFilter: { include: ['search'] },
        tags: [],
        source: 'custom',
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      },
    });
  });

  it('answers definition: null for an unknown server', async () => {
    await handleMcpServerAdminInline(
      buildArgs('mcp.server.get', { serverId: 'missing', spaceId: SPACE }),
    );
    expect(decodeOutput(lastResult())).toEqual({ definition: null });
  });

  it("lists the run space's definitions", async () => {
    selectRows = [storedDefinitionRow];
    await handleMcpServerAdminInline(buildArgs('mcp.server.list', {}));
    const output = decodeOutput(lastResult()) as { definitions: Array<{ serverId: string }> };
    expect(output.definitions.map((d) => d.serverId)).toEqual(['docs-mcp']);
  });
});

describe('mcp.server.delete', () => {
  it('deletes the definition with its bindings and reports whether it existed', async () => {
    selectRows = [{ serverId: 'docs-mcp' }];
    await handleMcpServerAdminInline(
      buildArgs('mcp.server.delete', { serverId: 'docs-mcp', spaceId: SPACE }),
    );
    expect(decodeOutput(lastResult())).toEqual({ deleted: true });
    expect(executed.some((q) => q.includes('DELETE FROM mcp_server_bindings'))).toBe(true);
    expect(executed.some((q) => q.includes('DELETE FROM mcp_server_definitions'))).toBe(true);
  });

  it('reports deleted: false for a server that is not there', async () => {
    await handleMcpServerAdminInline(
      buildArgs('mcp.server.delete', { serverId: 'missing', spaceId: SPACE }),
    );
    expect(decodeOutput(lastResult())).toEqual({ deleted: false });
  });
});

describe('mcp.binding.upsert', () => {
  const binding = {
    bindingId: 'docs-default',
    serverId: 'docs-mcp',
    name: 'Docs default',
    scope: { tenantId: 'whatever-the-agent-guessed' },
    auth: { type: 'none' },
  };

  const runScope = { tenantId: 'tenant-1', spaceId: SPACE };

  /** The COALESCE operand an update writes as scope_json; null keeps the stored scope. */
  function scopeOnUpdateParam(): unknown {
    return executedParams[0]?.at(-1);
  }

  it('writes an unauthenticated binding enabled, stamped with the run tenant and space', async () => {
    executeRows = [{ created: true, scope: runScope }];
    await handleMcpServerAdminInline(buildArgs('mcp.binding.upsert', binding));

    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: true,
      scope: runScope,
    });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('INSERT INTO mcp_server_bindings');
    const storedScope = JSON.stringify({ tenantId: 'tenant-1', spaceId: SPACE });
    expect(executedParams[0]).toContain(storedScope);
    expect(executedParams[0]).not.toContain(JSON.stringify(binding.scope));
    expect(mockPublishMcpCatalogInvalidation).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      SPACE,
      { kind: 'binding', serverId: 'docs-mcp', bindingId: 'docs-default' },
    );
  });

  it('refuses to enable a credentialed binding with no pinned origin', async () => {
    selectRows = [];
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', {
        ...binding,
        auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
        enabled: true,
      }),
    );
    const error = lastError();
    expect(error.code).toBe('MCP_BINDING_ORIGIN_NOT_PINNED');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain('mcp.binding.test');
    expect(executed).toHaveLength(0);
  });

  it('writes a credentialed binding disabled, ready for mcp.binding.test', async () => {
    executeRows = [{ created: true, scope: runScope }];
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', {
        ...binding,
        auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
        enabled: false,
      }),
    );
    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: true,
      scope: runScope,
    });
  });

  it('keeps the stored flow narrowing on an update that omits flowId, and reports it', async () => {
    executeRows = [{ created: false, scope: { ...runScope, flowId: 'flow-7' } }];
    await handleMcpServerAdminInline(buildArgs('mcp.binding.upsert', binding));

    expect(scopeOnUpdateParam()).toBeNull();
    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: false,
      scope: { ...runScope, flowId: 'flow-7' },
    });
  });

  it('narrows to a stated flowId on create and on update', async () => {
    executeRows = [{ created: true, scope: { ...runScope, flowId: 'flow-9' } }];
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', { ...binding, scope: { tenantId: 'x', flowId: 'flow-9' } }),
    );
    const stated = JSON.stringify({ flowId: 'flow-9', ...runScope });
    expect(executedParams[0]).toContain(stated);
    expect(scopeOnUpdateParam()).toBe(stated);
  });

  it('widens to space-wide only when flowId is stated as null', async () => {
    executeRows = [{ created: false, scope: runScope }];
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', { ...binding, scope: { tenantId: 'x', flowId: null } }),
    );
    expect(scopeOnUpdateParam()).toBe(JSON.stringify(runScope));
    expect(decodeOutput(lastResult())['scope']).toEqual(runScope);
  });

  it('refuses an empty flowId rather than reading it as space-wide', async () => {
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', { ...binding, scope: { tenantId: 'x', flowId: '' } }),
    );
    expect(lastError().code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(executed).toHaveLength(0);
  });

  it('refuses a scope naming another space', async () => {
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.upsert', {
        ...binding,
        scope: { tenantId: 'tenant-1', spaceId: OTHER_SPACE },
      }),
    );
    expect(lastError().code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(executed).toHaveLength(0);
  });
});

describe('mcp.binding.delete', () => {
  it('deletes a binding in this space and invalidates by its server', async () => {
    selectRows = [{ serverId: 'docs-mcp' }];
    await handleMcpServerAdminInline(
      buildArgs('mcp.binding.delete', { bindingId: 'docs-default' }),
    );
    expect(decodeOutput(lastResult())).toEqual({ deleted: true });
    expect(executed[0]).toContain('DELETE FROM mcp_server_bindings');
    expect(mockPublishMcpCatalogInvalidation).toHaveBeenCalledWith(
      expect.anything(),
      'tenant-1',
      SPACE,
      { kind: 'binding', serverId: 'docs-mcp', bindingId: 'docs-default' },
    );
  });

  it('reports deleted: false and deletes nothing for an unknown binding', async () => {
    await handleMcpServerAdminInline(buildArgs('mcp.binding.delete', { bindingId: 'missing' }));
    expect(decodeOutput(lastResult())).toEqual({ deleted: false });
    expect(executed).toHaveLength(0);
    expect(mockPublishMcpCatalogInvalidation).not.toHaveBeenCalled();
  });
});
