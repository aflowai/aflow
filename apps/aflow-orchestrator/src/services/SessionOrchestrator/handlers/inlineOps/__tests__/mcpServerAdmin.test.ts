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

function chunksOf(chunk: unknown): unknown[] | null {
  const chunks =
    chunk !== null && typeof chunk === 'object'
      ? (chunk as { queryChunks?: unknown }).queryChunks
      : undefined;
  return Array.isArray(chunks) ? chunks : null;
}

function sqlText(query: unknown): string {
  return (chunksOf(query) ?? [])
    .map((chunk) => (chunksOf(chunk) ? sqlText(chunk) : (textOf(chunk) ?? '?')))
    .join('');
}

function sqlParams(query: unknown): unknown[] {
  return (chunksOf(query) ?? []).flatMap((chunk) =>
    chunksOf(chunk) ? sqlParams(chunk) : textOf(chunk) === null ? [chunk] : [],
  );
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
const { resolveStepInput } = await import('../../../helpers/stepInputResolution.js');
const database = await import('@aflow/database');

const SPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_SPACE = '22222222-2222-4222-8222-222222222222';

function inlineRef(value: unknown): string {
  return `inline:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
}

function readInlineRef(ref: string): unknown {
  return JSON.parse(Buffer.from(ref.slice('inline:'.length), 'base64').toString());
}

const inlineStore = {
  retrieve: vi.fn((ref: string) => Promise.resolve(readInlineRef(ref))),
  shouldStore: vi.fn(() => false),
  store: vi.fn((value: { data: unknown }) => Promise.resolve(inlineRef(value.data))),
} as unknown as InlineHandlerArgs['payloadStore'];

/**
 * The input ref the handler receives for an agent's call: the arguments the
 * agent sent, through the step input resolution and schema validation every
 * scheduled step goes through.
 */
async function resolvedInputRefFor(
  operation: string,
  agentInput: Record<string, unknown>,
): Promise<string> {
  return resolveStepInput(
    inlineStore,
    { stepId: 'step-1', stepType: 'mcp', operation, config: {} } as unknown as Parameters<
      typeof resolveStepInput
    >[1],
    inlineRef(agentInput),
    undefined,
    undefined,
    'tenant-1',
    'run-1',
    undefined,
    SPACE,
  );
}

/** Handler args carrying `resolvedInputRef` as it is, for input production refuses before the handler. */
function argsWithRef(operation: string, resolvedInputRef: string): InlineHandlerArgs {
  return {
    redis: {} as InlineHandlerArgs['redis'],
    payloadStore: inlineStore,
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
    resolvedInputRef,
    attempt: 1,
    scheduledAtMs: Date.now(),
  };
}

/** The handler args production builds for an agent calling `operation` with `agentInput`. */
async function buildArgs(
  operation: string,
  agentInput: Record<string, unknown>,
): Promise<InlineHandlerArgs> {
  return argsWithRef(operation, await resolvedInputRefFor(operation, agentInput));
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
  };

  it('accepts the run space stated explicitly', async () => {
    executeRows = [{ created: true }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, spaceId: SPACE }),
    );
    expect(decodeOutput(lastResult())['created']).toBe(true);
  });

  it('updates only the fields the agent sent, keeping tags, source and the stored JSON', async () => {
    executeRows = [{ created: false }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, toolFilter: { include: ['search'] } }),
    );
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('name = EXCLUDED.name');
    expect(update).toContain('server_url = EXCLUDED.server_url');
    for (const kept of ['tags =', 'source =', 'transport =', 'description =']) {
      expect(update).not.toContain(kept);
    }
    expect(update).toContain('definition_json = COALESCE(');
    expect(executedParams[0]?.at(-1)).toBe(
      JSON.stringify({ ...input, toolFilter: { include: ['search'] } }),
    );
  });

  it('writes no schema default over a stored value on an update that states one field', async () => {
    executeRows = [{ created: false }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, description: 'Docs search' }),
    );
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('description = EXCLUDED.description');
    for (const kept of ['tags =', 'source =', 'transport =']) {
      expect(update).not.toContain(kept);
    }
    const mergedJson = JSON.parse(executedParams[0]!.at(-1) as string) as Record<string, unknown>;
    expect(Object.keys(mergedJson).sort()).toEqual(
      ['description', 'name', 'serverId', 'serverUrl'].sort(),
    );
  });

  it('clears the optional fields an update names in clear and keeps the ones it leaves out', async () => {
    selectRows = [
      {
        ...storedDefinitionRow,
        description: 'Docs search',
        definitionJson: {
          ...storedDefinitionRow.definitionJson,
          icon: { kind: 'phosphor', name: 'Books' },
        },
      },
    ];
    executeRows = [{ created: false, tool_filter: null }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', {
        ...input,
        clear: ['description', 'toolFilter', 'icon'],
      }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({
      created: false,
      cleared: ['description', 'toolFilter', 'icon'],
      toolFilter: null,
      exposedTools: [],
    });
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('description = EXCLUDED.description');
    expect(update.match(/ - \?::text\)/g)).toHaveLength(3);
    const params = executedParams[0]!;
    expect(params).toEqual(expect.arrayContaining(['description', 'toolFilter', 'icon']));
    expect(params).not.toContain('protectedResourceMetadataPath');
    // The insert's description is null, which is what EXCLUDED.description writes.
    expect(params[2]).toBeNull();
    const mergedJson = JSON.parse(params.at(-1) as string) as Record<string, unknown>;
    expect(Object.keys(mergedJson).sort()).toEqual(['name', 'serverId', 'serverUrl'].sort());
  });

  it('names only the fields that held a value as cleared, leaving out ones stored empty', async () => {
    selectRows = [storedDefinitionRow];
    executeRows = [{ created: false, tool_filter: null }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, clear: ['description', 'toolFilter'] }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, cleared: ['toolFilter'] });
  });

  it('names nothing as cleared on a create, which had nothing stored to remove', async () => {
    executeRows = [{ created: true, tool_filter: null }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, clear: ['description', 'toolFilter'] }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: true, cleared: [] });
  });

  it('echoes the stored toolFilter and the tools it exposes after the write', async () => {
    executeRows = [
      {
        created: false,
        tool_filter: { include: ['search', 'fetch', 'delete'], exclude: ['delete'] },
      },
    ];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, description: 'Docs search' }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({
      toolFilter: { include: ['search', 'fetch', 'delete'], exclude: ['delete'] },
      exposedTools: ['search', 'fetch'],
    });
  });

  it('keeps every stored field an agent sends as a habitual null', async () => {
    executeRows = [{ created: false }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', {
        ...input,
        description: null,
        toolFilter: null,
        icon: null,
        protectedResourceMetadataPath: null,
      }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, cleared: [] });
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).not.toContain('description =');
    expect(update).not.toContain('::text)');
    const mergedJson = JSON.parse(executedParams[0]!.at(-1) as string) as Record<string, unknown>;
    expect(Object.keys(mergedJson).sort()).toEqual(['name', 'serverId', 'serverUrl'].sort());
  });

  it('refuses a field both given a value and named in clear, and writes nothing', async () => {
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', {
        ...input,
        toolFilter: { include: ['search'] },
        clear: ['toolFilter'],
      }),
    );
    const error = lastError();
    expect(error.code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(error.message).toContain('toolFilter');
    expect(executed).toHaveLength(0);
  });

  it('hands the handler the input as the agent sent it, with no schema default filled in', async () => {
    const ref = await resolvedInputRefFor('mcp.server.upsert', input);
    expect(readInlineRef(ref)).toEqual(input);
  });

  it('creates the definition in the run space from a URL alone and invalidates the catalog', async () => {
    executeRows = [{ created: true }];
    await handleMcpServerAdminInline(await buildArgs('mcp.server.upsert', input));

    expect(decodeOutput(lastResult())).toEqual({
      serverId: 'docs-mcp',
      spaceId: SPACE,
      created: true,
      cleared: [],
      toolFilter: null,
      exposedTools: [],
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
    await handleMcpServerAdminInline(await buildArgs('mcp.server.upsert', input));
    expect(decodeOutput(lastResult())['created']).toBe(false);
  });

  it('refuses a spaceId naming another space and writes nothing', async () => {
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.upsert', { ...input, spaceId: OTHER_SPACE }),
    );
    const error = lastError();
    expect(error.code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain(OTHER_SPACE);
    expect(executed).toHaveLength(0);
  });

  it('refuses an input without a serverUrl as a validation error', async () => {
    const { serverUrl: _omitted, ...withoutUrl } = input;
    await expect(resolvedInputRefFor('mcp.server.upsert', withoutUrl)).rejects.toThrow(/serverUrl/);
    await handleMcpServerAdminInline(argsWithRef('mcp.server.upsert', inlineRef(withoutUrl)));
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

    await handleMcpServerAdminInline(await buildArgs('mcp.server.upsert', input));

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
    await handleMcpServerAdminInline(await buildArgs('mcp.server.get', { serverId: 'docs-mcp' }));
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
    await handleMcpServerAdminInline(await buildArgs('mcp.server.get', { serverId: 'missing' }));
    expect(decodeOutput(lastResult())).toEqual({ definition: null });
  });

  it("lists the run space's definitions", async () => {
    selectRows = [storedDefinitionRow];
    await handleMcpServerAdminInline(await buildArgs('mcp.server.list', {}));
    const output = decodeOutput(lastResult()) as { definitions: Array<{ serverId: string }> };
    expect(output.definitions.map((d) => d.serverId)).toEqual(['docs-mcp']);
  });
});

describe('mcp.server.delete', () => {
  it('deletes the definition with its bindings', async () => {
    selectRows = [storedDefinitionRow];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.server.delete', { serverId: 'docs-mcp' }),
    );
    expect(decodeOutput(lastResult())).toEqual({ deleted: true });
    expect(executed.some((q) => q.includes('DELETE FROM mcp_server_bindings'))).toBe(true);
    expect(executed.some((q) => q.includes('DELETE FROM mcp_server_definitions'))).toBe(true);
  });

  it('fails a delete of a server that is not there, naming it, and deletes nothing', async () => {
    await handleMcpServerAdminInline(await buildArgs('mcp.server.delete', { serverId: 'missing' }));
    const error = lastError();
    expect(error.code).toBe('MCP_SERVER_NOT_FOUND');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain('"missing"');
    expect(executed).toHaveLength(0);
    expect(mockPublishMcpCatalogInvalidation).not.toHaveBeenCalled();
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
    executeRows = [{ created: true, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(await buildArgs('mcp.binding.upsert', binding));

    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: true,
      scope: runScope,
      enabled: true,
      cleared: [],
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
      await buildArgs('mcp.binding.upsert', {
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
    executeRows = [{ created: true, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', {
        ...binding,
        auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
        enabled: false,
      }),
    );
    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: true,
      scope: runScope,
      enabled: false,
      cleared: [],
    });
  });

  it('writes every field on create, defaults included', async () => {
    executeRows = [{ created: true, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(await buildArgs('mcp.binding.upsert', binding));
    expect(executedParams[0]).toEqual(expect.arrayContaining(['space', 'platform', 'off', 1]));
  });

  it('updates only the fields the agent sent, keeping enabled, ownerScope and the rest', async () => {
    selectRows = [{ pinnedOrigin: null, enabled: 0, authJson: { type: 'none' } }];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, samplingPolicy: 'no_tools' }),
    );

    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('sampling_policy = EXCLUDED.sampling_policy');
    expect(update).toContain('name = EXCLUDED.name');
    expect(update).toContain('auth_json = EXCLUDED.auth_json');
    for (const kept of [
      'enabled =',
      'owner_scope =',
      'client_scope =',
      'subscribe_list_changed =',
      'connection_policy_json =',
      'description =',
    ]) {
      expect(update).not.toContain(kept);
    }
    expect(decodeOutput(lastResult())['enabled']).toBe(false);
  });

  it('writes no schema default over a stored value on an update that states one field', async () => {
    selectRows = [{ pinnedOrigin: null, enabled: 0, authJson: { type: 'none' } }];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, name: 'Renamed' }),
    );

    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('name = EXCLUDED.name');
    for (const kept of [
      'enabled =',
      'owner_scope =',
      'client_scope =',
      'subscribe_list_changed =',
      'sampling_policy =',
      'connection_policy_json =',
      'description =',
    ]) {
      expect(update).not.toContain(kept);
    }
    expect(scopeOnUpdateParam()).toBeNull();
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, enabled: false });
  });

  it('keeps a stored description on an update that sends description: null', async () => {
    selectRows = [{ pinnedOrigin: null, enabled: 0, authJson: { type: 'none' } }];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, description: null }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, cleared: [] });
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).not.toContain('description =');
  });

  it("clears a stored description on an update that sends clear: ['description']", async () => {
    selectRows = [
      { pinnedOrigin: null, enabled: 0, authJson: { type: 'none' }, description: 'Docs search' },
    ];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, clear: ['description'] }),
    );

    expect(decodeOutput(lastResult())).toMatchObject({
      created: false,
      cleared: ['description'],
    });
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('description = EXCLUDED.description');
    for (const kept of ['enabled =', 'owner_scope =', 'sampling_policy =']) {
      expect(update).not.toContain(kept);
    }
    // The insert's description is null, which is what EXCLUDED.description writes.
    expect(executedParams[0]![3]).toBeNull();
  });

  it('names nothing as cleared when the description it was told to clear held no value', async () => {
    selectRows = [
      { pinnedOrigin: null, enabled: 0, authJson: { type: 'none' }, description: null },
    ];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, clear: ['description'] }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, cleared: [] });
  });

  it('names nothing as cleared on a create, which had nothing stored to remove', async () => {
    executeRows = [{ created: true, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, clear: ['description'] }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: true, cleared: [] });
  });

  it('hands the handler the binding input as the agent sent it, with no schema default filled in', async () => {
    const ref = await resolvedInputRefFor('mcp.binding.upsert', binding);
    expect(readInlineRef(ref)).toEqual(binding);
  });

  it('writes enabled and ownerScope on an update that states them', async () => {
    selectRows = [{ pinnedOrigin: null, enabled: 1, authJson: { type: 'none' } }];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, enabled: false, ownerScope: 'user' }),
    );
    const update = executed[0]!.slice(executed[0]!.indexOf('DO UPDATE SET'));
    expect(update).toContain('enabled = EXCLUDED.enabled');
    expect(update).toContain('owner_scope = EXCLUDED.owner_scope');
  });

  it('merges only the connectionPolicy keys given over the stored policy', async () => {
    selectRows = [{ pinnedOrigin: null, enabled: 1, authJson: { type: 'none' } }];
    executeRows = [{ created: false, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, connectionPolicy: { timeoutMs: 5000 } }),
    );
    expect(executed[0]).toContain('connection_policy_json = COALESCE(');
    expect(executedParams[0]?.at(-1)).toBe(JSON.stringify({ timeoutMs: 5000 }));
  });

  it('does not re-enable a disabled credentialed binding on an update that omits enabled', async () => {
    selectRows = [
      { pinnedOrigin: null, enabled: 0, authJson: { type: 'bearer', credentialKey: 'K' } },
    ];
    executeRows = [{ created: false, scope: runScope, enabled: 0 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', {
        ...binding,
        auth: { type: 'bearer', credentialKey: 'DOCS_TOKEN' },
        name: 'Renamed',
      }),
    );
    expect(decodeOutput(lastResult())).toMatchObject({ created: false, enabled: false });
  });

  it('needs no scope at all and ignores a tenantId the agent made up', async () => {
    const { scope: _scope, ...withoutScope } = binding;
    executeRows = [{ created: true, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(await buildArgs('mcp.binding.upsert', withoutScope));
    expect(decodeOutput(lastResult())['scope']).toEqual(runScope);
    expect(executedParams[0]).toContain(JSON.stringify(runScope));
  });

  it('keeps the stored flow narrowing on an update that omits flowId, and reports it', async () => {
    executeRows = [{ created: false, scope: { ...runScope, flowId: 'flow-7' }, enabled: 1 }];
    await handleMcpServerAdminInline(await buildArgs('mcp.binding.upsert', binding));

    expect(scopeOnUpdateParam()).toBeNull();
    expect(decodeOutput(lastResult())).toEqual({
      bindingId: 'docs-default',
      created: false,
      scope: { ...runScope, flowId: 'flow-7' },
      enabled: true,
      cleared: [],
    });
  });

  it('narrows to a stated flowId on create and on update', async () => {
    executeRows = [{ created: true, scope: { ...runScope, flowId: 'flow-9' }, enabled: 1 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, scope: { flowId: 'flow-9' } }),
    );
    const stated = JSON.stringify({ flowId: 'flow-9', ...runScope });
    expect(executedParams[0]).toContain(stated);
    expect(scopeOnUpdateParam()).toBe(stated);
  });

  it('widens to space-wide only when flowId is stated as null', async () => {
    executeRows = [{ created: false, scope: runScope, enabled: 1 }];
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', { ...binding, scope: { flowId: null } }),
    );
    expect(scopeOnUpdateParam()).toBe(JSON.stringify(runScope));
    expect(decodeOutput(lastResult())['scope']).toEqual(runScope);
  });

  it('refuses an empty flowId rather than reading it as space-wide', async () => {
    const emptyFlow = { ...binding, scope: { flowId: '' } };
    await expect(resolvedInputRefFor('mcp.binding.upsert', emptyFlow)).rejects.toThrow(/flowId/);
    await handleMcpServerAdminInline(argsWithRef('mcp.binding.upsert', inlineRef(emptyFlow)));
    expect(lastError().code).toBe('MCP_ADMIN_INVALID_INPUT');
    expect(executed).toHaveLength(0);
  });

  it('refuses a scope naming another space', async () => {
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.upsert', {
        ...binding,
        scope: { spaceId: OTHER_SPACE },
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
      await buildArgs('mcp.binding.delete', { bindingId: 'docs-default' }),
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

  it('fails a delete of an unknown binding, naming it, and deletes nothing', async () => {
    await handleMcpServerAdminInline(
      await buildArgs('mcp.binding.delete', { bindingId: 'missing' }),
    );
    const error = lastError();
    expect(error.code).toBe('MCP_BINDING_NOT_FOUND');
    expect(error.classification).toBe('validation');
    expect(error.message).toContain('"missing"');
    expect(executed).toHaveLength(0);
    expect(mockPublishMcpCatalogInvalidation).not.toHaveBeenCalled();
  });
});
