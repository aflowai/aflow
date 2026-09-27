/**
 * MCP connector install — writes go through the shared cybernetic-runtime
 * write authority (`writeMcpServerDefinition` / `writePlaceholderMcpBinding`),
 * exercised for real against an in-memory SQL dispatcher so the tests pin the
 * persisted rows (source, disabled binding, ownership scopes, slot-name-only
 * auth) alongside the response contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SpaceId, TenantId } from '@aflow/schemas';

interface McpDefinitionRow {
  serverId: string;
  name: string;
  serverUrl: string;
  definitionJson: Record<string, unknown>;
  source: string;
}

interface McpBindingRow {
  bindingId: string;
  serverId: string;
  name: string;
  description: string | null;
  scopeJson: Record<string, unknown>;
  authJson: Record<string, unknown>;
  subscribeListChanged: number;
  samplingPolicy: string;
  ownerScope: string;
  clientScope: string;
  enabled: number;
  pinnedOrigin: string | null;
}

const store = vi.hoisted(() => ({
  mcpDefinitions: [] as McpDefinitionRow[],
  mcpBindings: [] as McpBindingRow[],
  credentialKeys: new Set<string>(),
  tenantPolicyRows: [] as Array<{ ownerScope: string | null; clientScope: string | null }>,
  oauthClientRows: [{ id: 'oauth-client-1' }] as Array<{ id: string }>,
}));

const dialect = new PgDialect();

function applyExecute(query: SQL): unknown[] {
  const { sql: text, params } = dialect.sqlToQuery(query);
  if (text.includes('SELECT server_id FROM mcp_server_definitions')) {
    const serverId = params[0] as string;
    return store.mcpDefinitions
      .filter((d) => d.serverId === serverId)
      .map((d) => ({ server_id: d.serverId }));
  }
  if (text.includes('INSERT INTO mcp_server_definitions')) {
    const [serverId, name, , serverUrl, , definitionJson, , source] = params as [
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      string,
      ...unknown[],
    ];
    if (store.mcpDefinitions.some((d) => d.serverId === serverId)) return [];
    store.mcpDefinitions.push({
      serverId,
      name,
      serverUrl,
      definitionJson: JSON.parse(definitionJson) as Record<string, unknown>,
      source,
    });
    return [{ server_id: serverId }];
  }
  if (text.includes('INSERT INTO mcp_server_bindings')) {
    const [
      bindingId,
      serverId,
      name,
      description,
      ,
      scopeJson,
      authJson,
      ,
      subscribeListChanged,
      samplingPolicy,
      ownerScope,
      clientScope,
    ] = params as [
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      number,
      string,
      string,
      string,
      ...unknown[],
    ];
    if (store.mcpBindings.some((b) => b.bindingId === bindingId)) return [];
    store.mcpBindings.push({
      bindingId,
      serverId,
      name,
      description,
      scopeJson: JSON.parse(scopeJson) as Record<string, unknown>,
      authJson: JSON.parse(authJson) as Record<string, unknown>,
      subscribeListChanged,
      samplingPolicy,
      ownerScope,
      clientScope,
      enabled: 0,
      pinnedOrigin: null,
    });
    return [{ binding_id: bindingId }];
  }
  if (text.includes('SELECT auth_json, pinned_origin, enabled FROM mcp_server_bindings')) {
    const bindingId = params[0] as string;
    return store.mcpBindings
      .filter((b) => b.bindingId === bindingId)
      .map((b) => ({ auth_json: b.authJson, pinned_origin: b.pinnedOrigin, enabled: b.enabled }));
  }
  if (text.includes('SELECT credential_key FROM api_credentials')) {
    return [...store.credentialKeys].map((credentialKey) => ({ credential_key: credentialKey }));
  }
  throw new Error(`connectorInstall.test: unhandled SQL: ${text}`);
}

const fakeTx = {
  execute: async (query: SQL) => applyExecute(query),
  // Drizzle chain used by checkOAuthClientRegistered's oauth_clients lookup.
  select: () => ({
    from: () => ({
      where: () => ({ limit: async () => store.oauthClientRows }),
    }),
  }),
};

vi.mock('@aflow/database', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    createTenantContext: (tenantId: string) => ({ tenantId }),
    withTenantSchema: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx),
  };
});

const publishMcpCatalogInvalidation = vi.hoisted(() => vi.fn());
vi.mock('@aflow/redis', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, publishMcpCatalogInvalidation };
});

const { installMcpConnectorEntry, buildPlaceholderMcpAuth, buildApiConnectorPlaceholderAuth } =
  await import('./connectorInstall.js');

const TENANT_ID = '11111111-1111-1111-1111-111111111111' as TenantId;
const SPACE_ID = '00000000-0000-4000-8000-000000000002' as SpaceId;

const fakeDb = {
  select: (_shape?: unknown) => ({
    from: (_table: unknown) => ({
      where: (_pred: unknown) => ({
        limit: (_n: number) => Promise.resolve(store.tenantPolicyRows),
      }),
    }),
  }),
} as unknown as PostgresJsDatabase;

function context(redis: unknown = null) {
  return {
    db: fakeDb,
    redis: redis as never,
    tenantId: TENANT_ID,
    spaceId: SPACE_ID,
  };
}

function mcpEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalogId: 'kagglemcp',
    version: 1,
    name: 'Kaggle MCP',
    tagline: 'Kaggle over MCP.',
    description: 'A vetted Kaggle MCP connector.',
    honestyLabel: 'curated',
    authKind: 'bearer',
    credentialPrompts: [{ authField: 'credentialKey', label: 'Kaggle API token' }],
    definition: {
      serverId: 'kaggle',
      name: 'Kaggle MCP',
      serverUrl: 'https://mcp.kaggle.com/mcp',
    },
    ...over,
  };
}

beforeEach(() => {
  store.mcpDefinitions = [];
  store.mcpBindings = [];
  store.credentialKeys = new Set();
  store.tenantPolicyRows = [];
  publishMcpCatalogInvalidation.mockClear();
});

describe('installMcpConnectorEntry — bearer', () => {
  it('writes a platform-source definition + a disabled slot-name-only binding', async () => {
    const result = await installMcpConnectorEntry({ entry: mcpEntry(), context: context() });

    expect(result).toEqual({
      outcome: 'installed',
      serverId: 'kaggle',
      bindingId: 'kaggle-default',
      status: 'needs_credentials',
      missingCredentialKeys: ['kaggle-default-token'],
      setupChecklist: [
        {
          kind: 'fill_mcp_credentials',
          bindingId: 'kaggle-default',
          serverId: 'kaggle',
          slots: [
            {
              authField: 'credentialKey',
              credentialKey: 'kaggle-default-token',
              role: 'token',
              label: 'Kaggle API token',
            },
          ],
          description: 'Add credentials for the Kaggle MCP integration.',
          required: true,
        },
      ],
    });

    expect(store.mcpDefinitions).toHaveLength(1);
    const def = store.mcpDefinitions[0]!;
    expect(def.source).toBe('platform');
    expect(def.definitionJson['source']).toBe('platform');
    expect(def.definitionJson['serverId']).toBe('kaggle');
    expect(def.serverUrl).toBe('https://mcp.kaggle.com/mcp');

    expect(store.mcpBindings).toHaveLength(1);
    const binding = store.mcpBindings[0]!;
    expect(binding.enabled).toBe(0);
    expect(binding.authJson).toEqual({ type: 'bearer', credentialKey: 'kaggle-default-token' });
    expect(binding.ownerScope).toBe('space');
    // MCP keeps the platform (CIMD) client default — SEP-991 is MCP-only; the
    // space-BYO default applies to API connector bindings.
    expect(binding.clientScope).toBe('platform');
    expect(binding.scopeJson).toEqual({ tenantId: TENANT_ID, spaceId: SPACE_ID });
    expect(JSON.stringify(binding.authJson)).not.toMatch(/secret|password/i);
  });

  it('regenerates the checklist from state: a filled credential advances to run_mcp_binding_test', async () => {
    store.credentialKeys = new Set(['kaggle-default-token']);
    const result = await installMcpConnectorEntry({ entry: mcpEntry(), context: context() });
    if (result.outcome !== 'installed') throw new Error('expected installed');
    expect(result.setupChecklist).toEqual([
      {
        kind: 'run_mcp_binding_test',
        bindingId: 'kaggle-default',
        serverId: 'kaggle',
        description: 'Open the Kaggle MCP integration and save to verify the connection.',
        required: true,
      },
    ]);
  });

  it('publishes definition + binding catalog invalidations when redis is present', async () => {
    const redis = { publish: vi.fn() };
    await installMcpConnectorEntry({ entry: mcpEntry(), context: context(redis) });
    expect(publishMcpCatalogInvalidation).toHaveBeenCalledTimes(2);
    expect(publishMcpCatalogInvalidation).toHaveBeenCalledWith(redis, TENANT_ID, SPACE_ID, {
      kind: 'definition',
      serverId: 'kaggle',
    });
    expect(publishMcpCatalogInvalidation).toHaveBeenCalledWith(redis, TENANT_ID, SPACE_ID, {
      kind: 'binding',
      serverId: 'kaggle',
      bindingId: 'kaggle-default',
    });
  });
});

describe('installMcpConnectorEntry — public server (auth none)', () => {
  it('installs definition-only with a save-to-enable task', async () => {
    const result = await installMcpConnectorEntry({
      entry: mcpEntry({ authKind: 'none', credentialPrompts: undefined }),
      context: context(),
    });
    if (result.outcome !== 'installed') throw new Error('expected installed');
    expect(result.status).toBe('definition-only');
    expect(result.missingCredentialKeys).toEqual([]);
    expect(result.consentPath).toBeUndefined();
    expect(result.setupChecklist).toEqual([
      {
        kind: 'run_mcp_binding_test',
        bindingId: 'kaggle-default',
        serverId: 'kaggle',
        description: 'Open the Kaggle MCP integration and save to connect and enable.',
        required: true,
      },
    ]);
    expect(store.mcpBindings[0]!.authJson).toEqual({ type: 'none' });
  });
});

describe('installMcpConnectorEntry — consent-based OAuth', () => {
  it('oauth2_pkce stamps the tenant policy ownership defaults and routes to consent', async () => {
    store.tenantPolicyRows = [{ ownerScope: 'user', clientScope: 'platform' }];
    const result = await installMcpConnectorEntry({
      entry: mcpEntry({ authKind: 'oauth2_pkce', credentialPrompts: undefined }),
      context: context(),
    });
    if (result.outcome !== 'installed') throw new Error('expected installed');
    expect(result.status).toBe('needs_oauth_consent');
    expect(result.missingCredentialKeys).toEqual([]);
    expect(result.consentPath).toBe('/integrations/mcp/bindings/kaggle-default/consent');
    // Consent first, then Save & connect pins the origin before enable.
    expect(result.setupChecklist.map((t) => t.kind)).toEqual(['run_mcp_binding_test']);

    const binding = store.mcpBindings[0]!;
    expect(binding.authJson).toEqual({ type: 'oauth2_pkce' });
    expect(binding.ownerScope).toBe('user');
    expect(binding.clientScope).toBe('space');
  });

  it('oauth2_cimd carries the platform CIMD document URL', async () => {
    const result = await installMcpConnectorEntry({
      entry: mcpEntry({ authKind: 'oauth2_cimd', credentialPrompts: undefined }),
      context: context(),
    });
    if (result.outcome !== 'installed') throw new Error('expected installed');
    expect(result.status).toBe('needs_oauth_consent');
    const auth = store.mcpBindings[0]!.authJson;
    expect(auth['type']).toBe('oauth2_cimd');
    expect(auth['clientIdMetadataUrl']).toMatch(/\/\.well-known\/cimd$/);
  });
});

describe('installMcpConnectorEntry — failure modes', () => {
  it('returns a conflict when the server definition already exists in the space', async () => {
    store.mcpDefinitions.push({
      serverId: 'kaggle',
      name: 'Kaggle MCP',
      serverUrl: 'https://mcp.kaggle.com/mcp',
      definitionJson: {},
      source: 'custom',
    });
    const result = await installMcpConnectorEntry({ entry: mcpEntry(), context: context() });
    expect(result).toEqual({
      outcome: 'conflict',
      conflictingServerId: 'kaggle',
      error: "An MCP server definition 'kaggle' already exists in this space.",
    });
    expect(store.mcpBindings).toHaveLength(0);
    expect(publishMcpCatalogInvalidation).not.toHaveBeenCalled();
  });

  it('throws on an entry that fails re-validation', async () => {
    await expect(
      installMcpConnectorEntry({
        entry: mcpEntry({ definition: { serverId: 'kaggle', name: 'Kaggle MCP' } }),
        context: context(),
      }),
    ).rejects.toThrow(/failed re-validation/);
    expect(store.mcpDefinitions).toHaveLength(0);
  });

  it('rejects auth kinds whose structural fields a listing cannot carry', async () => {
    for (const authKind of ['header', 'oauth2_client_credentials']) {
      await expect(
        installMcpConnectorEntry({
          entry: mcpEntry({ authKind }),
          context: context(),
        }),
      ).rejects.toThrow(/failed re-validation/);
    }
    expect(store.mcpDefinitions).toHaveLength(0);
  });
});

describe('buildPlaceholderMcpAuth', () => {
  it('never emits a credential VALUE field, only slot names', () => {
    const { authJson, slots } = buildPlaceholderMcpAuth('bearer', 'x-default', undefined);
    expect(authJson).toEqual({ type: 'bearer', credentialKey: 'x-default-token' });
    expect(slots[0]!.label).toBe('x-default-token');
  });
});

describe('buildApiConnectorPlaceholderAuth', () => {
  it('threads apiKeyHeaderName into the placeholder auth_json', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: { catalogId: 'linear', authKind: 'api_key', apiKeyHeaderName: 'Authorization' },
      bindingId: 'linear-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: false,
      authJson: {
        type: 'api_key',
        credentialKey: 'linear-default-key',
        headerName: 'Authorization',
      },
    });
  });

  it('omits headerName when the entry does not pin one', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: { catalogId: 'acme', authKind: 'api_key' },
      bindingId: 'acme-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: false,
      authJson: { type: 'api_key', credentialKey: 'acme-default-key' },
    });
  });

  it('threads apiKeyQueryParamName into query-placement auth_json', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: { catalogId: 'fred', authKind: 'api_key', apiKeyQueryParamName: 'api_key' },
      bindingId: 'fred-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: false,
      authJson: {
        type: 'api_key',
        credentialKey: 'fred-default-key',
        placement: 'query',
        queryParamName: 'api_key',
      },
    });
  });

  it('prefers per-listing oauthScopes over the issuer defaults', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: {
        catalogId: 'slack',
        authKind: 'oauth2_authorization_code',
        oauthIssuerKey: 'slack',
        oauthScopes: ['channels:read', 'chat:write'],
      },
      bindingId: 'slack-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: true,
      authJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'slack',
        ownerScope: 'space',
        clientScope: 'space',
        scopes: ['channels:read', 'chat:write'],
      },
    });
  });

  it('falls back to the issuer defaultScopes when the listing omits oauthScopes', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: {
        catalogId: 'gcal',
        authKind: 'oauth2_authorization_code',
        oauthIssuerKey: 'google',
      },
      bindingId: 'gcal-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: true,
      authJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'google',
        ownerScope: 'space',
        clientScope: 'space',
        scopes: ['openid', 'email', 'profile'],
      },
    });
  });

  it('omits scopes when neither the listing nor the issuer declares any', async () => {
    const placeholder = await buildApiConnectorPlaceholderAuth({
      db: fakeDb,
      tenantId: TENANT_ID,
      spaceId: SPACE_ID,
      entry: {
        catalogId: 'slack',
        authKind: 'oauth2_authorization_code',
        oauthIssuerKey: 'slack',
      },
      bindingId: 'slack-default',
      enforceOAuthClientRegistered: true,
    });
    expect(placeholder).toEqual({
      ok: true,
      isOAuth: true,
      authJson: {
        type: 'oauth2_authorization_code',
        issuerKey: 'slack',
        ownerScope: 'space',
        clientScope: 'space',
      },
    });
  });
});
