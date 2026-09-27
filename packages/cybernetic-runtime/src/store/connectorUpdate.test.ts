/**
 * Connector update cores — definition replace + credential-preserving binding
 * merge, exercised for real against an in-memory SQL dispatcher: a compatible
 * auth shape keeps the operator's filled auth_json verbatim, an incompatible
 * one placeholder-resets it and the setup checklist reappears, a moved MCP
 * server drops the origin pin, and the overwritten definition row hashes
 * identically to the registry stamp (the divergence "pristine" invariant).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getCatalogEntry } from '@aflow/platform-artifacts';
import type { SpaceId, TenantId } from '@aflow/schemas';

interface ApiDefinitionRow {
  api_id: string;
  definition_json: Record<string, unknown>;
}

interface ApiBindingRow {
  binding_id: string;
  auth_json: Record<string, unknown>;
  egress_policy_json: Record<string, unknown> | null;
  variable_values_json: Record<string, string> | null;
}

interface McpDefinitionRow {
  server_id: string;
  definition_json: Record<string, unknown>;
}

interface McpBindingRow {
  binding_id: string;
  auth_json: Record<string, unknown>;
  pinned_origin: string | null;
  enabled: number;
}

const store = vi.hoisted(() => ({
  apiDefinitions: [] as ApiDefinitionRow[],
  apiBindings: [] as ApiBindingRow[],
  mcpDefinitions: [] as McpDefinitionRow[],
  mcpBindings: [] as McpBindingRow[],
  credentialKeys: new Set<string>(),
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('INSERT INTO api_definitions')) {
    const [apiId, , , , , definitionJson] = params as [
      string,
      string,
      string | null,
      string | null,
      string,
      string,
    ];
    const parsed = JSON.parse(definitionJson) as Record<string, unknown>;
    const existing = store.apiDefinitions.find((row) => row.api_id === apiId);
    if (existing) {
      if (text.includes('DO UPDATE')) existing.definition_json = parsed;
      return existing || text.includes('DO UPDATE') ? [] : [{ api_id: apiId }];
    }
    store.apiDefinitions.push({ api_id: apiId, definition_json: parsed });
    return [{ api_id: apiId }];
  }
  if (
    text.includes('SELECT auth_json, egress_policy_json, variable_values_json FROM api_bindings')
  ) {
    const [bindingId] = params as [string];
    return store.apiBindings.filter((row) => row.binding_id === bindingId);
  }
  if (text.includes('UPDATE api_bindings SET')) {
    const [authJson, egressJson, bindingId] = params as [string, string, string];
    const row = store.apiBindings.find((binding) => binding.binding_id === bindingId);
    if (row) {
      row.auth_json = JSON.parse(authJson) as Record<string, unknown>;
      row.egress_policy_json = JSON.parse(egressJson) as Record<string, unknown>;
    }
    return [];
  }
  if (text.includes('INSERT INTO api_bindings')) {
    const [bindingId, , , , , authJson, egressJson] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
    ];
    if (store.apiBindings.some((row) => row.binding_id === bindingId)) return [];
    store.apiBindings.push({
      binding_id: bindingId,
      auth_json: JSON.parse(authJson) as Record<string, unknown>,
      egress_policy_json: JSON.parse(egressJson) as Record<string, unknown>,
      variable_values_json: null,
    });
    return [{ binding_id: bindingId }];
  }
  if (text.includes('SELECT credential_key FROM api_credentials')) {
    return [...store.credentialKeys].map((key) => ({ credential_key: key }));
  }
  if (text.includes('INSERT INTO mcp_server_definitions')) {
    const [serverId, , , , , definitionJson] = params as [
      string,
      string,
      string | null,
      string,
      string,
      string,
    ];
    const parsed = JSON.parse(definitionJson) as Record<string, unknown>;
    const existing = store.mcpDefinitions.find((row) => row.server_id === serverId);
    if (existing) {
      if (text.includes('DO UPDATE')) existing.definition_json = parsed;
      return [];
    }
    store.mcpDefinitions.push({ server_id: serverId, definition_json: parsed });
    return [{ server_id: serverId }];
  }
  if (text.includes('SELECT auth_json, pinned_origin, enabled FROM mcp_server_bindings')) {
    const [bindingId] = params as [string];
    return store.mcpBindings.filter((row) => row.binding_id === bindingId);
  }
  if (text.includes('UPDATE mcp_server_bindings SET')) {
    const [authJson, pinnedOrigin, enabled, bindingId] = params as [
      string,
      string | null,
      number,
      string,
    ];
    const row = store.mcpBindings.find((binding) => binding.binding_id === bindingId);
    if (row) {
      row.auth_json = JSON.parse(authJson) as Record<string, unknown>;
      row.pinned_origin = pinnedOrigin;
      row.enabled = enabled;
    }
    return [];
  }
  if (text.includes('INSERT INTO mcp_server_bindings')) {
    const [bindingId, , , , , , authJson] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
    ];
    if (store.mcpBindings.some((row) => row.binding_id === bindingId)) return [];
    store.mcpBindings.push({
      binding_id: bindingId,
      auth_json: JSON.parse(authJson) as Record<string, unknown>,
      pinned_origin: null,
      enabled: 0,
    });
    return [{ binding_id: bindingId }];
  }
  throw new Error(`connectorUpdate.test: unhandled SQL: ${text}`);
}

const fakeTx = { execute: async (query: SQL) => applyExecute(query) };

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId, schemaName: `tenant_${tenantId}` }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx),
  };
});

const { updateApiConnectorEntry, updateMcpConnectorEntry } = await import('./connectorUpdate.js');
const { jsonContentHash } = await import('./artifactContent.js');

const SPACE_ID = '00000000-0000-0000-0000-000000000001' as SpaceId;
const TENANT_ID = 'tenant-1' as TenantId;

const context = { db: {} as never, redis: null, tenantId: TENANT_ID, spaceId: SPACE_ID };

function githubPayload(): { definition: { apiId: string } } {
  const entry = getCatalogEntry('github');
  if (entry?.kind !== 'connector' || entry.sourceKind !== 'api') {
    throw new Error('github connector missing');
  }
  return entry.payload as unknown as { definition: { apiId: string } };
}

const MCP_ENTRY = {
  catalogId: 'test-mcp',
  version: 1,
  name: 'Test MCP',
  tagline: 'Test MCP connector.',
  description: 'Synthetic MCP connector for update tests.',
  honestyLabel: 'curated',
  authKind: 'bearer',
  definition: {
    serverId: 'test-mcp',
    name: 'Test MCP',
    serverUrl: 'https://mcp.example.com/mcp',
  },
};

beforeEach(() => {
  store.apiDefinitions = [];
  store.apiBindings = [];
  store.mcpDefinitions = [];
  store.mcpBindings = [];
  store.credentialKeys = new Set();
  vi.clearAllMocks();
});

describe('updateApiConnectorEntry', () => {
  it('overwrites the definition; the stored row hashes identically to the registry stamp', async () => {
    store.apiDefinitions.push({
      api_id: 'github',
      definition_json: { apiId: 'github', name: 'Old', baseUrl: 'https://api.github.com' },
    });
    store.apiBindings.push({
      binding_id: 'github-default',
      auth_json: { type: 'bearer', credentialKey: 'github-default-token' },
      egress_policy_json: { allowedHosts: ['api.github.com'] },
      variable_values_json: null,
    });

    const result = await updateApiConnectorEntry({ entry: githubPayload(), context });
    expect(result.outcome).toBe('updated');
    const row = store.apiDefinitions.find((definition) => definition.api_id === 'github');
    expect(jsonContentHash(row?.definition_json)).toBe(jsonContentHash(githubPayload().definition));
  });

  it('preserves filled auth on a compatible shape — no reset, empty checklist', async () => {
    store.credentialKeys.add('github-default-token');
    const filledAuth = {
      type: 'bearer',
      credentialKey: 'github-default-token',
    };
    store.apiBindings.push({
      binding_id: 'github-default',
      auth_json: filledAuth,
      egress_policy_json: { allowedHosts: ['custom.example.com'] },
      variable_values_json: null,
    });

    const result = await updateApiConnectorEntry({ entry: githubPayload(), context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    expect(result.credentialsReset).toBe(false);
    expect(result.missingCredentialKeys).toEqual([]);
    expect(result.status).toBe('definition-only');
    expect(result.setupChecklist).toEqual([]);

    const binding = store.apiBindings[0];
    expect(binding?.auth_json).toEqual(filledAuth);
    expect(binding?.egress_policy_json?.['allowedHosts']).toEqual(
      expect.arrayContaining(['custom.example.com', 'api.github.com']),
    );
  });

  it('placeholder-resets an incompatible shape and the setup checklist reappears', async () => {
    store.apiBindings.push({
      binding_id: 'github-default',
      auth_json: {
        type: 'basic',
        usernameCredentialKey: 'github-default-username',
        passwordCredentialKey: 'github-default-secret',
      },
      egress_policy_json: { allowedHosts: ['api.github.com'] },
      variable_values_json: null,
    });

    const result = await updateApiConnectorEntry({ entry: githubPayload(), context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    expect(result.credentialsReset).toBe(true);
    expect(result.missingCredentialKeys).toEqual(['github-default-token']);
    expect(result.status).toBe('needs_credentials');
    expect(result.setupChecklist).toMatchObject([
      { kind: 'fill_credentials', bindingId: 'github-default' },
    ]);
    expect(store.apiBindings[0]?.auth_json).toMatchObject({
      type: 'bearer',
      credentialKey: 'github-default-token',
    });
  });

  it('recreates a deleted default binding as a placeholder', async () => {
    const result = await updateApiConnectorEntry({ entry: githubPayload(), context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    expect(result.credentialsReset).toBe(true);
    expect(store.apiBindings).toHaveLength(1);
    expect(store.apiBindings[0]?.auth_json).toMatchObject({ type: 'bearer' });
  });
});

describe('updateMcpConnectorEntry', () => {
  it('preserves compatible auth and an unmoved origin pin', async () => {
    store.credentialKeys.add('test-mcp-default-token');
    store.mcpBindings.push({
      binding_id: 'test-mcp-default',
      auth_json: { type: 'bearer', credentialKey: 'test-mcp-default-token' },
      pinned_origin: 'https://mcp.example.com',
      enabled: 1,
    });

    const result = await updateMcpConnectorEntry({ entry: MCP_ENTRY, context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    expect(result.credentialsReset).toBe(false);
    expect(result.missingCredentialKeys).toEqual([]);
    const binding = store.mcpBindings[0];
    expect(binding?.pinned_origin).toBe('https://mcp.example.com');
    expect(binding?.enabled).toBe(1);
  });

  it('drops the origin pin and disables the binding when the server moved', async () => {
    store.credentialKeys.add('test-mcp-default-token');
    store.mcpBindings.push({
      binding_id: 'test-mcp-default',
      auth_json: { type: 'bearer', credentialKey: 'test-mcp-default-token' },
      pinned_origin: 'https://old-mcp.example.com',
      enabled: 1,
    });

    const result = await updateMcpConnectorEntry({ entry: MCP_ENTRY, context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    const binding = store.mcpBindings[0];
    expect(binding?.pinned_origin).toBeNull();
    expect(binding?.enabled).toBe(0);
    expect(result.setupChecklist).toMatchObject([{ kind: 'run_mcp_binding_test' }]);

    const definition = store.mcpDefinitions.find((row) => row.server_id === 'test-mcp');
    expect(definition?.definition_json['serverUrl']).toBe('https://mcp.example.com/mcp');
  });

  it('placeholder-resets an incompatible MCP auth shape', async () => {
    store.mcpBindings.push({
      binding_id: 'test-mcp-default',
      auth_json: { type: 'header', headerName: 'X-Key', credentialKey: 'legacy-key' },
      pinned_origin: 'https://mcp.example.com',
      enabled: 1,
    });

    const result = await updateMcpConnectorEntry({ entry: MCP_ENTRY, context });
    if (result.outcome !== 'updated') throw new Error('expected updated');
    expect(result.credentialsReset).toBe(true);
    expect(store.mcpBindings[0]?.auth_json).toEqual({
      type: 'bearer',
      credentialKey: 'test-mcp-default-token',
    });
    expect(result.missingCredentialKeys).toEqual(['test-mcp-default-token']);
  });

  it('an entry that fails re-validation returns invalid_entry without touching the space', async () => {
    const result = await updateMcpConnectorEntry({
      entry: { ...MCP_ENTRY, definition: { serverId: 'test-mcp' } },
      context,
    });
    expect(result.outcome).toBe('invalid_entry');
    if (result.outcome !== 'invalid_entry') throw new Error('expected invalid_entry');
    expect(result.error).toContain('re-validation');
    expect(store.mcpDefinitions).toHaveLength(0);
    expect(store.mcpBindings).toHaveLength(0);
  });
});
