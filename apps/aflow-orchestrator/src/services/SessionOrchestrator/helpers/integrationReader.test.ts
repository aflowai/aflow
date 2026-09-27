import { describe, expect, it } from 'vitest';
import {
  buildResult,
  deriveMcpCredentialStatus,
  type ApiIntegrationRow,
  type IntegrationRow,
  type McpIntegrationRow,
  deriveApiCredentialStatus,
} from './integrationReader.js';
import { MCP_TOOLS_STALE_AFTER_MS, type ApiEndpoint } from '@aflow/schemas';

const endpoint = (id: string, method: 'GET' | 'POST' = 'GET'): ApiEndpoint =>
  ({
    endpointId: id,
    name: id,
    method,
    pathTemplate: `/${id}`,
    params: [],
    tags: [],
  }) as ApiEndpoint;

const apiRow = (overrides: Partial<ApiIntegrationRow> = {}): ApiIntegrationRow => ({
  sourceKind: 'api',
  apiId: 'alpaca',
  name: 'Alpaca',
  description: null,
  definitionEnabled: true,
  endpoints: [endpoint('get_bars'), endpoint('list_positions')],
  binding: {
    bindingId: 'alpaca-default',
    enabled: true,
    authJson: { type: 'none' },
    credentialStatus: 'ready',
    missingCredentialKeys: [],
  },
  bindingsForDefinition: 1,
  ...overrides,
});

const mcpRow = (overrides: Partial<McpIntegrationRow> = {}): McpIntegrationRow => ({
  sourceKind: 'mcp',
  serverId: 'kaggle',
  name: 'Kaggle',
  description: null,
  definitionEnabled: true,
  toolFilter: { include: ['search_competitions', 'get_competition'] },
  binding: {
    bindingId: 'kaggle-default',
    enabled: true,
    pinnedOrigin: 'https://mcp.kaggle.com',
    cachedTools: [
      { name: 'search_competitions', description: 'Find competitions' },
      { name: 'get_competition', description: 'Get one competition' },
      { name: 'submit_entry', description: 'Submit (excluded by filter)' },
    ],
    cachedToolsAt: new Date(),
    credentialStatus: 'ready',
    missingCredentialKeys: [],
  },
  bindingsForDefinition: 1,
  ...overrides,
});

describe('buildResult: API-only', () => {
  it('emits bound descriptor + endpoint tools when binding is ready', () => {
    const out = buildResult([apiRow()]);
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]).toMatchObject({
      sourceKind: 'api',
      integrationId: 'alpaca',
      bindingId: 'alpaca-default',
      status: 'bound',
      toolCount: 2,
      credentialStatus: 'ready',
    });
    expect(out.tools.map((t) => t.toolId)).toEqual([
      'api:alpaca-default/get_bars',
      'api:alpaca-default/list_positions',
    ]);
    expect(out.tools[0]?.callName).toBe('alpaca.get_bars');
    expect(out.definitionOnlyCount).toBe(0);
  });

  it('reports needs_credentials when API auth keys are missing', () => {
    const row = apiRow({
      binding: {
        bindingId: 'alpaca-default',
        enabled: true,
        authJson: { type: 'bearer', credentialKey: 'alpaca-key' },
        credentialStatus: 'missing',
        missingCredentialKeys: ['alpaca-key'],
      },
    });
    const out = buildResult([row]);
    expect(out.descriptors[0]).toMatchObject({
      status: 'needs_credentials',
      credentialStatus: 'missing',
      toolCount: 0,
    });
    expect(out.tools).toHaveLength(0);
  });

  it('reports disabled when the binding is disabled', () => {
    const row = apiRow({
      binding: {
        bindingId: 'alpaca-default',
        enabled: false,
        authJson: { type: 'none' },
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
    });
    const out = buildResult([row]);
    expect(out.descriptors[0]?.status).toBe('disabled');
    expect(out.tools).toHaveLength(0);
  });

  it('reports disabled when the definition is disabled', () => {
    const out = buildResult([apiRow({ definitionEnabled: false })]);
    expect(out.descriptors[0]?.status).toBe('disabled');
  });
});

describe('buildResult: MCP-only', () => {
  it('emits bound descriptor + filtered tools when binding is ready', () => {
    const out = buildResult([mcpRow()]);
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]).toMatchObject({
      sourceKind: 'mcp',
      integrationId: 'kaggle',
      bindingId: 'kaggle-default',
      status: 'bound',
      toolCount: 2, // submit_entry excluded by toolFilter
    });
    expect(out.tools.map((t) => t.toolId).sort()).toEqual([
      'mcp:kaggle-default/get_competition',
      'mcp:kaggle-default/search_competitions',
    ]);
    expect(out.tools[0]?.callName.startsWith('mcp_kaggle.')).toBe(true);
  });

  it('marks tools as stale when cachedToolsAt is older than the staleness window', () => {
    const stale = new Date(Date.now() - MCP_TOOLS_STALE_AFTER_MS - 1000);
    const row = mcpRow();
    row.binding!.cachedToolsAt = stale;
    const out = buildResult([row]);
    expect(out.tools.every((t) => t.stale === true)).toBe(true);
  });

  it('flags opTaskOnly tools per the definition toolFilter', () => {
    const row = mcpRow({
      toolFilter: {
        include: ['search_competitions', 'get_competition'],
        opTaskOnly: ['get_competition'],
      },
    });
    const out = buildResult([row]);
    const opOnly = out.tools.find((t) => t.toolName === 'get_competition');
    const passthrough = out.tools.find((t) => t.toolName === 'search_competitions');
    expect(opOnly?.opTaskOnly).toBe(true);
    expect(passthrough?.opTaskOnly).toBeUndefined();
  });

  it('reports needs_credentials when MCP binding has no pinned origin', () => {
    const row = mcpRow();
    row.binding!.pinnedOrigin = null;
    row.binding!.credentialStatus = 'unpinned';
    const out = buildResult([row]);
    expect(out.descriptors[0]).toMatchObject({
      status: 'needs_credentials',
      credentialStatus: 'unpinned',
      toolCount: 0,
    });
    expect(out.tools).toHaveLength(0);
  });

  it('returns no tools when toolFilter has no include list (opt-in semantics)', () => {
    const row = mcpRow({ toolFilter: undefined });
    const out = buildResult([row]);
    expect(out.descriptors[0]?.toolCount).toBe(0);
    expect(out.tools).toHaveLength(0);
  });
});

describe('buildResult: mixed sources', () => {
  it('returns API and MCP descriptors side by side', () => {
    const out = buildResult([apiRow(), mcpRow()]);
    expect(out.descriptors.map((d) => d.sourceKind).sort()).toEqual(['api', 'mcp']);
    expect(out.tools.map((t) => t.sourceKind).sort()).toEqual(['api', 'api', 'mcp', 'mcp']);
  });
});

describe('buildResult: multi-binding qualification', () => {
  it('qualifies API callName with bindingId when multiple bindings exist', () => {
    const paper = apiRow({
      binding: {
        bindingId: 'alpaca-paper',
        enabled: true,
        authJson: { type: 'none' },
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      bindingsForDefinition: 2,
    });
    const live = apiRow({
      binding: {
        bindingId: 'alpaca-live',
        enabled: true,
        authJson: { type: 'none' },
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      bindingsForDefinition: 2,
    });
    const out = buildResult([paper, live]);
    const callNames = out.tools.map((t) => t.callName);
    expect(callNames).toContain('alpaca-paper.get_bars');
    expect(callNames).toContain('alpaca-live.get_bars');
    // No duplicate plain `alpaca.get_bars` once qualified.
    expect(callNames).not.toContain('alpaca.get_bars');
  });

  it('qualifies MCP callName with bindingId when multiple bindings exist', () => {
    const dev = mcpRow({
      binding: {
        bindingId: 'kaggle-dev',
        enabled: true,
        pinnedOrigin: 'https://mcp.kaggle.com',
        cachedTools: [{ name: 'search_competitions' }],
        cachedToolsAt: new Date(),
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      bindingsForDefinition: 2,
    });
    const prod = mcpRow({
      binding: {
        bindingId: 'kaggle-prod',
        enabled: true,
        pinnedOrigin: 'https://mcp.kaggle.com',
        cachedTools: [{ name: 'search_competitions' }],
        cachedToolsAt: new Date(),
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      bindingsForDefinition: 2,
    });
    const out = buildResult([dev, prod]);
    const callNames = out.tools.map((t) => t.callName).sort();
    expect(callNames).toEqual([
      'mcp_kaggle-dev.search_competitions',
      'mcp_kaggle-prod.search_competitions',
    ]);
  });
});

describe('buildResult: definition-only handling', () => {
  it('hides definition-only entries by default but counts them', () => {
    const defOnly = apiRow({ binding: null, bindingsForDefinition: 0 });
    const bound = mcpRow();
    const out = buildResult([defOnly, bound]);
    expect(out.descriptors.map((d) => d.integrationId)).toEqual(['kaggle']);
    expect(out.definitionOnlyCount).toBe(1);
  });

  it('surfaces definition-only entries when includeDefinitionOnly is true', () => {
    const defOnly = apiRow({ binding: null, bindingsForDefinition: 0 });
    const out = buildResult([defOnly], { includeDefinitionOnly: true });
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]?.status).toBe('definition-only');
    expect(out.descriptors[0]?.bindingId).toBeUndefined();
    expect(out.definitionOnlyCount).toBe(1);
  });
});

describe('buildResult: scope filtering', () => {
  it('respects sourceKinds filter', () => {
    const out = buildResult([apiRow(), mcpRow()], { sourceKinds: ['mcp'] });
    expect(out.descriptors.map((d) => d.sourceKind)).toEqual(['mcp']);
    expect(out.tools.every((t) => t.sourceKind === 'mcp')).toBe(true);
  });

  it('respects allowlist with bindingId precision', () => {
    const out = buildResult([apiRow(), mcpRow()], {
      allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' }],
    });
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]?.sourceKind).toBe('mcp');
  });

  it('narrows tools to the allowed toolNames per binding', () => {
    const out = buildResult([mcpRow()], {
      allowed: [
        {
          sourceKind: 'mcp',
          integrationId: 'kaggle',
          bindingId: 'kaggle-default',
          toolNames: ['search_competitions'],
        },
      ],
    });
    expect(out.tools.map((t) => t.toolName)).toEqual(['search_competitions']);
    expect(out.descriptors[0]?.toolCount).toBe(1);
  });

  it('keeps full toolCount when allowed entry has no toolNames pin', () => {
    const out = buildResult([mcpRow()], {
      allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' }],
    });
    expect(out.tools).toHaveLength(2);
    expect(out.descriptors[0]?.toolCount).toBe(2);
  });
});

describe('buildResult: rows order is preserved as input order', () => {
  it('does not reorder rows on the way out', () => {
    const rows: IntegrationRow[] = [mcpRow(), apiRow()];
    const out = buildResult(rows);
    expect(out.descriptors.map((d) => d.sourceKind)).toEqual(['mcp', 'api']);
  });
});

describe('buildResult: allowlist semantics align with promoter (reviewer round 2 P1)', () => {
  // Two bindings of the same MCP server — pretend they're 'kaggle-default' and
  // 'kaggle-prod'. The grant pins 'kaggle-default' only. The reader must drop
  // the sibling 'kaggle-prod' row so discovery doesn't surface what promotion
  // would reject.
  const defaultBinding = (): McpIntegrationRow =>
    mcpRow({
      binding: {
        bindingId: 'kaggle-default',
        enabled: true,
        pinnedOrigin: 'https://mcp.kaggle.com',
        cachedTools: [{ name: 'search_competitions' }, { name: 'submit_entry' }],
        cachedToolsAt: new Date(),
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      toolFilter: { include: ['search_competitions', 'submit_entry'] },
      bindingsForDefinition: 2,
    });
  const prodBinding = (): McpIntegrationRow =>
    mcpRow({
      binding: {
        bindingId: 'kaggle-prod',
        enabled: true,
        pinnedOrigin: 'https://mcp.kaggle.com',
        cachedTools: [{ name: 'search_competitions' }, { name: 'submit_entry' }],
        cachedToolsAt: new Date(),
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
      toolFilter: { include: ['search_competitions', 'submit_entry'] },
      bindingsForDefinition: 2,
    });

  it('drops sibling bindings when allow entry pins one bindingId', () => {
    const out = buildResult([defaultBinding(), prodBinding()], {
      allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle', bindingId: 'kaggle-default' }],
    });
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]?.bindingId).toBe('kaggle-default');
    expect(out.tools.every((t) => t.bindingId === 'kaggle-default')).toBe(true);
  });

  it('binding-pinned entries supersede a broad entry for the same integration', () => {
    // Both broad and pinned in the allow list. The pinned binding wins —
    // the broad entry must NOT widen access to the sibling binding.
    const out = buildResult([defaultBinding(), prodBinding()], {
      allowed: [
        { sourceKind: 'mcp', integrationId: 'kaggle' },
        {
          sourceKind: 'mcp',
          integrationId: 'kaggle',
          bindingId: 'kaggle-default',
          toolNames: ['search_competitions'],
        },
      ],
    });
    // Only kaggle-default surfaces; only its allowlisted tool surfaces.
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]?.bindingId).toBe('kaggle-default');
    expect(out.descriptors[0]?.toolCount).toBe(1);
    expect(out.tools.map((t) => t.toolName)).toEqual(['search_competitions']);
  });

  it('broad allow with no toolNames exposes all bindings/tools', () => {
    const out = buildResult([defaultBinding(), prodBinding()], {
      allowed: [{ sourceKind: 'mcp', integrationId: 'kaggle' }],
    });
    expect(out.descriptors).toHaveLength(2);
    expect(out.descriptors.every((d) => d.toolCount === 2)).toBe(true);
  });
});

describe('deriveMcpCredentialStatus: per-auth-type matrix (reviewer round 2 P2)', () => {
  const pinned = 'https://mcp.example.com';

  it('unpinned origin always wins regardless of auth type', () => {
    expect(
      deriveMcpCredentialStatus(
        'bearer',
        { type: 'bearer', credentialKey: 'k' },
        null,
        new Set(['k']),
        undefined,
      ),
    ).toBe('unpinned');
  });

  it('returns ready for none auth', () => {
    expect(deriveMcpCredentialStatus('none', { type: 'none' }, pinned, new Set(), undefined)).toBe(
      'ready',
    );
  });

  it('treats oauth2_client_credentials like bearer (static credential keys)', () => {
    // client-credentials does NOT use oauth_tokens at bind time. Static keys →
    // executor fetches/caches tokens at call time.
    const auth = {
      type: 'oauth2_client_credentials',
      clientIdCredentialKey: 'id',
      clientSecretCredentialKey: 'secret',
    };
    expect(
      deriveMcpCredentialStatus(
        'oauth2_client_credentials',
        auth,
        pinned,
        new Set(['id', 'secret']),
        undefined,
      ),
    ).toBe('ready');
    expect(
      deriveMcpCredentialStatus(
        'oauth2_client_credentials',
        auth,
        pinned,
        new Set(['id']),
        undefined,
      ),
    ).toBe('missing');
  });

  it('PKCE valid access token is ready', () => {
    const future = new Date(Date.now() + 60_000);
    expect(
      deriveMcpCredentialStatus('oauth2_pkce', { type: 'oauth2_pkce' }, pinned, new Set(), {
        expiresAt: future,
        hasRefresh: false,
      }),
    ).toBe('ready');
  });

  it('PKCE expired token WITH refresh token stays ready (executor auto-refreshes)', () => {
    // Reviewer P2: getValidAccessToken() refreshes proactively when a refresh
    // token is present. Marking this `expired` would over-report unavailable.
    const past = new Date(Date.now() - 60_000);
    expect(
      deriveMcpCredentialStatus('oauth2_pkce', { type: 'oauth2_pkce' }, pinned, new Set(), {
        expiresAt: past,
        hasRefresh: true,
      }),
    ).toBe('ready');
  });

  it('PKCE expired token WITHOUT refresh is expired', () => {
    const past = new Date(Date.now() - 60_000);
    expect(
      deriveMcpCredentialStatus('oauth2_pkce', { type: 'oauth2_pkce' }, pinned, new Set(), {
        expiresAt: past,
        hasRefresh: false,
      }),
    ).toBe('expired');
  });

  it('PKCE with no token row at all is missing', () => {
    expect(
      deriveMcpCredentialStatus(
        'oauth2_pkce',
        { type: 'oauth2_pkce' },
        pinned,
        new Set(),
        undefined,
      ),
    ).toBe('missing');
  });

  it('CIMD follows the same PKCE policy', () => {
    const past = new Date(Date.now() - 60_000);
    expect(
      deriveMcpCredentialStatus('oauth2_cimd', { type: 'oauth2_cimd' }, pinned, new Set(), {
        expiresAt: past,
        hasRefresh: true,
      }),
    ).toBe('ready');
  });

  it('unknown auth type is conservatively missing', () => {
    expect(
      deriveMcpCredentialStatus(
        'something_new',
        { type: 'something_new' },
        pinned,
        new Set(),
        undefined,
      ),
    ).toBe('missing');
  });
});

describe('deriveApiCredentialStatus — OAuth bindings carry no credential keys', () => {
  const oauthAuth = { type: 'oauth2_authorization_code', issuerKey: 'google', ownerScope: 'space' };
  const future = { expiresAt: new Date(Date.now() + 3_600_000), hasRefresh: false };
  const expiredNoRefresh = { expiresAt: new Date(Date.now() - 1), hasRefresh: false };
  const expiredWithRefresh = { expiresAt: new Date(Date.now() - 1), hasRefresh: true };

  it('is missing before consent (no token), never key-derived', () => {
    expect(
      deriveApiCredentialStatus('oauth2_authorization_code', oauthAuth, new Set(), undefined),
    ).toBe('missing');
  });

  it('is ready once a live token exists', () => {
    expect(
      deriveApiCredentialStatus('oauth2_authorization_code', oauthAuth, new Set(), future),
    ).toBe('ready');
  });

  it('is ready when expired but refreshable, expired when not', () => {
    expect(
      deriveApiCredentialStatus(
        'oauth2_authorization_code',
        oauthAuth,
        new Set(),
        expiredWithRefresh,
      ),
    ).toBe('ready');
    expect(
      deriveApiCredentialStatus(
        'oauth2_authorization_code',
        oauthAuth,
        new Set(),
        expiredNoRefresh,
      ),
    ).toBe('expired');
  });

  it('static kinds still resolve from stored keys', () => {
    const bearer = { type: 'bearer', credentialKey: 'gh-token' };
    expect(deriveApiCredentialStatus('bearer', bearer, new Set(['gh-token']), undefined)).toBe(
      'ready',
    );
    expect(deriveApiCredentialStatus('bearer', bearer, new Set(), undefined)).toBe('missing');
    expect(deriveApiCredentialStatus('none', {}, new Set(), undefined)).toBe('ready');
  });
});

describe('buildResult: tool diagnostics for non-ready bindings', () => {
  it('emits credential_missing diagnostics naming the missing keys', () => {
    const row = apiRow({
      binding: {
        bindingId: 'alpaca-default',
        enabled: true,
        authJson: { type: 'bearer', credentialKey: 'alpaca-key' },
        credentialStatus: 'missing',
        missingCredentialKeys: ['alpaca-key'],
      },
    });
    const out = buildResult([row]);
    expect(out.tools).toHaveLength(0);
    expect(out.toolDiagnostics.map((d) => d.toolId)).toEqual([
      'api:alpaca-default/get_bars',
      'api:alpaca-default/list_positions',
    ]);
    expect(out.toolDiagnostics[0]?.cause).toBe('credential_missing');
    expect(out.toolDiagnostics[0]?.detail).toContain('"alpaca-key"');
  });

  it('distinguishes binding_disabled from definition_disabled', () => {
    const bindingDisabled = apiRow({
      binding: {
        bindingId: 'alpaca-default',
        enabled: false,
        authJson: { type: 'none' },
        credentialStatus: 'ready',
        missingCredentialKeys: [],
      },
    });
    const definitionDisabled = apiRow({ definitionEnabled: false });
    expect(buildResult([bindingDisabled]).toolDiagnostics[0]?.cause).toBe('binding_disabled');
    expect(buildResult([definitionDisabled]).toolDiagnostics[0]?.cause).toBe('definition_disabled');
  });

  it('emits unpinned for an MCP binding with no pinned origin', () => {
    const row = mcpRow();
    row.binding!.pinnedOrigin = null;
    row.binding!.credentialStatus = 'unpinned';
    const out = buildResult([row]);
    expect(out.toolDiagnostics.length).toBeGreaterThan(0);
    expect(out.toolDiagnostics[0]?.cause).toBe('unpinned');
  });

  it('emits no diagnostics for bound rows', () => {
    expect(buildResult([apiRow(), mcpRow()]).toolDiagnostics).toHaveLength(0);
  });
});
