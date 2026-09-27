import { eq } from 'drizzle-orm';
import {
  apiBindings,
  apiCredentials,
  apiDefinitions,
  createTenantContext,
  getDatabase,
  oauthTokens,
  mcpServerBindings,
  mcpServerDefinitions,
  withTenantSchema,
} from '@aflow/database';
import {
  applyToolFilter,
  buildIntegrationToolId,
  isSimulatedFulfillment,
  MCP_TOOLS_STALE_AFTER_MS,
  type ApiEndpoint,
  type BindingFulfillment,
  type IntegrationCredentialStatus,
  type IntegrationDescriptor,
  type IntegrationSourceKind,
  type IntegrationStatus,
  type IntegrationToolDescriptor,
  type McpCachedTool,
  extractCredentialKeys,
  type McpToolFilter,
  type TenantId,
  deriveEndpointToolSchema,
} from '@aflow/schemas';

/**
 * One row per (definition, binding). For definition-only definitions, `binding`
 * is null. The reader joins these into IntegrationDescriptor + tool descriptors.
 */
interface ApiIntegrationRow {
  sourceKind: 'api';
  apiId: string;
  name: string;
  description: string | null;
  definitionEnabled: boolean;
  endpoints: ApiEndpoint[];
  binding: {
    bindingId: string;
    enabled: boolean;
    authJson: Record<string, unknown>;
    credentialStatus: IntegrationCredentialStatus;
    missingCredentialKeys: string[];
  } | null;
  bindingsForDefinition: number;
}

interface McpIntegrationRow {
  sourceKind: 'mcp';
  serverId: string;
  name: string;
  description: string | null;
  definitionEnabled: boolean;
  toolFilter: McpToolFilter | undefined;
  binding: {
    bindingId: string;
    enabled: boolean;
    pinnedOrigin: string | null;
    cachedTools: McpCachedTool[];
    cachedToolsAt: Date | null;
    credentialStatus: IntegrationCredentialStatus;
    missingCredentialKeys: string[];
  } | null;
  bindingsForDefinition: number;
}

type IntegrationRow = ApiIntegrationRow | McpIntegrationRow;

export interface IntegrationScopeFilter {
  /** When provided, only include these source kinds. */
  sourceKinds?: IntegrationSourceKind[];
  /**
   * When provided, only include these (sourceKind, integrationId[, bindingId])
   * tuples. Used by runner/allowlist callers.
   */
  allowed?: Array<{
    sourceKind: IntegrationSourceKind;
    integrationId: string;
    bindingId?: string;
    toolNames?: string[];
  }>;
  /**
   * When true, include `definition-only` entries (no binding configured).
   * When false (default), drop them from descriptors — callers that want a
   * count can use `definitionOnlyCount` on the result.
   */
  includeDefinitionOnly?: boolean;
}

/**
 * Why a structurally-known tool is not promotable right now. Emitted for every
 * tool of a bound-but-not-ready integration so callers (catalog.tool.promote)
 * can reject with the actual cause instead of a catch-all.
 */
export interface IntegrationToolDiagnostic {
  toolId: string;
  cause:
    | 'definition_disabled'
    | 'binding_disabled'
    | 'credential_missing'
    | 'credential_expired'
    | 'unpinned';
  detail: string;
}

export interface IntegrationReadResult {
  descriptors: IntegrationDescriptor[];
  tools: IntegrationToolDescriptor[];
  toolDiagnostics: IntegrationToolDiagnostic[];
  /**
   * Number of `definition-only` integrations not surfaced as descriptors.
   * Non-zero only when `includeDefinitionOnly` is false (the default).
   */
  definitionOnlyCount: number;
}

/**
 * Read all integrations (and their callable tools) for a tenant + space.
 * Pure aggregation over existing tables — no caching layer is introduced
 * by this function; callers can wrap as needed.
 */
export async function readIntegrations(
  tenantId: TenantId,
  spaceId: string,
  filter: IntegrationScopeFilter = {},
): Promise<IntegrationReadResult> {
  const rows = await loadIntegrationRows(tenantId, spaceId);
  return buildResult(rows, filter);
}

// ============================================================================
// Internals — pure (buildResult) and DB-bound (loadIntegrationRows)
// ============================================================================

async function loadIntegrationRows(tenantId: TenantId, spaceId: string): Promise<IntegrationRow[]> {
  const db = getDatabase();
  const tenantCtx = createTenantContext(tenantId);

  return withTenantSchema(db, tenantCtx, async (tx) => {
    // ── API side ──
    const apiDefRows = await tx
      .select({
        apiId: apiDefinitions.apiId,
        name: apiDefinitions.name,
        description: apiDefinitions.description,
        enabled: apiDefinitions.enabled,
        definitionJson: apiDefinitions.definitionJson,
      })
      .from(apiDefinitions)
      .where(eq(apiDefinitions.spaceId, spaceId));

    const apiBindingRows = await tx
      .select({
        bindingId: apiBindings.bindingId,
        apiId: apiBindings.apiId,
        scopeJson: apiBindings.scopeJson,
        authJson: apiBindings.authJson,
        enabled: apiBindings.enabled,
        fulfillmentMode: apiBindings.fulfillmentMode,
        simulationId: apiBindings.simulationId,
      })
      .from(apiBindings)
      .where(eq(apiBindings.spaceId, spaceId));

    let credentialKeys = new Set<string>();
    try {
      const credRows = await tx
        .select({ credentialKey: apiCredentials.credentialKey })
        .from(apiCredentials)
        .where(eq(apiCredentials.spaceId, spaceId));
      credentialKeys = new Set(credRows.map((c) => c.credentialKey));
    } catch {
      // credentials table may be missing in tests — leave empty.
    }

    // Group bindings by apiId, scope-filter to this space.
    const apiBindingsByDef = new Map<string, typeof apiBindingRows>();
    for (const b of apiBindingRows) {
      const scope = b.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      if (scopeSpaceId && scopeSpaceId !== spaceId) continue;
      const list = apiBindingsByDef.get(b.apiId) ?? [];
      list.push(b);
      apiBindingsByDef.set(b.apiId, list);
    }

    const rows: IntegrationRow[] = [];
    // OAuth tokens — keyed by the logical resource (resource_key = apiId for
    // API, serverId for MCP), since the unified token store is owner-scoped per
    // provider, not per binding. Used to mark credentialStatus for oauth2_*
    // auth types on BOTH sides: an OAuth authJson carries no credential keys,
    // so the static-key derivation would report it 'missing' forever even
    // after consent. We only need expiry; secret material stays encrypted.
    const oauthTokenByResource = {
      api: new Map<string, { expiresAt: Date; hasRefresh: boolean }>(),
      mcp: new Map<string, { expiresAt: Date; hasRefresh: boolean }>(),
    };
    try {
      const tokenRows = await tx
        .select({
          integrationKind: oauthTokens.integrationKind,
          resourceKey: oauthTokens.resourceKey,
          expiresAt: oauthTokens.expiresAt,
          refreshTokenEnc: oauthTokens.refreshTokenEnc,
        })
        .from(oauthTokens);
      for (const r of tokenRows) {
        const map =
          r.integrationKind === 'api' ? oauthTokenByResource.api : oauthTokenByResource.mcp;
        map.set(r.resourceKey, { expiresAt: r.expiresAt, hasRefresh: r.refreshTokenEnc !== null });
      }
    } catch {
      // Table may not exist in older test fixtures — treat as no tokens.
    }

    for (const def of apiDefRows) {
      const defJson = def.definitionJson as Record<string, unknown>;
      const endpoints = (defJson['endpoints'] ?? []) as ApiEndpoint[];
      const bindings = apiBindingsByDef.get(def.apiId) ?? [];

      if (bindings.length === 0) {
        rows.push({
          sourceKind: 'api',
          apiId: def.apiId,
          name: def.name,
          description: def.description ?? null,
          definitionEnabled: def.enabled === 1,
          endpoints,
          binding: null,
          bindingsForDefinition: 0,
        });
        continue;
      }

      for (const b of bindings) {
        const authJson = (b.authJson as Record<string, unknown> | undefined) ?? {};
        const authType = authJson['type'] as string | undefined;
        const simulated = b.fulfillmentMode === 'simulated';
        const credentialStatus = deriveApiCredentialStatus(
          authType,
          authJson,
          credentialKeys,
          oauthTokenByResource.api.get(def.apiId),
          simulated && b.simulationId !== null
            ? { mode: 'simulated', simulationId: b.simulationId }
            : { mode: 'live' },
        );
        rows.push({
          sourceKind: 'api',
          apiId: def.apiId,
          name: def.name,
          description: def.description ?? null,
          definitionEnabled: def.enabled === 1,
          endpoints,
          binding: {
            bindingId: b.bindingId,
            enabled: b.enabled === 1,
            authJson,
            credentialStatus,
            missingCredentialKeys: simulated
              ? []
              : extractCredentialKeys(authJson).filter((k) => !credentialKeys.has(k)),
          },
          bindingsForDefinition: bindings.length,
        });
      }
    }

    // ── MCP side ──
    const mcpDefRows = await tx
      .select({
        serverId: mcpServerDefinitions.serverId,
        name: mcpServerDefinitions.name,
        description: mcpServerDefinitions.description,
        enabled: mcpServerDefinitions.enabled,
        definitionJson: mcpServerDefinitions.definitionJson,
      })
      .from(mcpServerDefinitions)
      .where(eq(mcpServerDefinitions.spaceId, spaceId));

    const mcpBindingRows = await tx
      .select({
        bindingId: mcpServerBindings.bindingId,
        serverId: mcpServerBindings.serverId,
        scopeJson: mcpServerBindings.scopeJson,
        authJson: mcpServerBindings.authJson,
        pinnedOrigin: mcpServerBindings.pinnedOrigin,
        cachedTools: mcpServerBindings.cachedTools,
        cachedToolsAt: mcpServerBindings.cachedToolsAt,
        enabled: mcpServerBindings.enabled,
      })
      .from(mcpServerBindings)
      .where(eq(mcpServerBindings.spaceId, spaceId));

    const mcpBindingsByDef = new Map<string, typeof mcpBindingRows>();
    for (const b of mcpBindingRows) {
      const scope = b.scopeJson as Record<string, unknown> | null;
      const scopeSpaceId = scope?.['spaceId'] as string | undefined;
      if (scopeSpaceId && scopeSpaceId !== spaceId) continue;
      const list = mcpBindingsByDef.get(b.serverId) ?? [];
      list.push(b);
      mcpBindingsByDef.set(b.serverId, list);
    }

    for (const def of mcpDefRows) {
      const defJson = def.definitionJson as Record<string, unknown>;
      const toolFilter = defJson['toolFilter'] as McpToolFilter | undefined;
      const bindings = mcpBindingsByDef.get(def.serverId) ?? [];

      if (bindings.length === 0) {
        rows.push({
          sourceKind: 'mcp',
          serverId: def.serverId,
          name: def.name,
          description: def.description ?? null,
          definitionEnabled: def.enabled === 1,
          toolFilter,
          binding: null,
          bindingsForDefinition: 0,
        });
        continue;
      }

      for (const b of bindings) {
        const authJson = (b.authJson as Record<string, unknown> | undefined) ?? {};
        const authType = authJson['type'] as string | undefined;
        const credentialStatus = deriveMcpCredentialStatus(
          authType,
          authJson,
          b.pinnedOrigin,
          credentialKeys,
          oauthTokenByResource.mcp.get(b.serverId),
        );
        const cachedTools = (Array.isArray(b.cachedTools) ? b.cachedTools : []) as McpCachedTool[];
        rows.push({
          sourceKind: 'mcp',
          serverId: def.serverId,
          name: def.name,
          description: def.description ?? null,
          definitionEnabled: def.enabled === 1,
          toolFilter,
          binding: {
            bindingId: b.bindingId,
            enabled: b.enabled === 1,
            pinnedOrigin: b.pinnedOrigin,
            cachedTools,
            cachedToolsAt: b.cachedToolsAt,
            credentialStatus,
            missingCredentialKeys: extractCredentialKeys(authJson).filter(
              (k) => !credentialKeys.has(k),
            ),
          },
          bindingsForDefinition: bindings.length,
        });
      }
    }

    return rows;
  });
}

/**
 * Pure transformer — exposed for unit tests so we can drive deterministic
 * fixtures without standing up a database. `loadIntegrationRows` produces
 * `IntegrationRow[]` and this function is the only stage that needs coverage
 * for status/tool-count semantics.
 */
export function buildResult(
  rows: IntegrationRow[],
  filter: IntegrationScopeFilter = {},
): IntegrationReadResult {
  const includeDefinitionOnly = filter.includeDefinitionOnly === true;
  const sourceKindFilter = filter.sourceKinds ? new Set(filter.sourceKinds) : null;

  // Index allow entries by integration so we can apply the same
  // "binding-pinned supersedes broad" policy that `checkIntegrationScope` uses
  // in catalog.tool.promote — discovery must not surface what promotion would
  const allowIndex = filter.allowed ? indexAllowEntries(filter.allowed) : null;

  const descriptors: IntegrationDescriptor[] = [];
  const tools: IntegrationToolDescriptor[] = [];
  const toolDiagnostics: IntegrationToolDiagnostic[] = [];
  let definitionOnlyCount = 0;

  for (const row of rows) {
    if (sourceKindFilter && !sourceKindFilter.has(row.sourceKind)) continue;

    const integrationId = row.sourceKind === 'api' ? row.apiId : row.serverId;

    // Resolve the allow decision once per row. `toolFilter` is the per-tool
    // narrowing (null = no narrowing). When `allowIndex` is set and this row
    // is not permitted, `accepted` is false and we skip.
    const allow = allowIndex
      ? resolveAllowDecision(allowIndex, row.sourceKind, integrationId, row.binding?.bindingId)
      : { accepted: true, toolFilter: null as Set<string> | null };
    if (!allow.accepted) continue;

    const { status, credentialStatus } = deriveStatus(row);

    // For definition-only entries the caller may want a summary count only.
    if (status === 'definition-only') {
      definitionOnlyCount += 1;
      if (!includeDefinitionOnly) continue;
      descriptors.push({
        sourceKind: row.sourceKind,
        integrationId,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        status,
        toolCount: 0,
      });
      continue;
    }

    // Compute tool list once — descriptor needs `toolCount` and we may also
    // need to emit IntegrationToolDescriptors for the bound case.
    const toolNames = listToolNames(row);

    const useQualifiedName = row.bindingsForDefinition > 1;
    const allowedToolFilter = allow.toolFilter;

    const visibleToolNames =
      allowedToolFilter !== null ? toolNames.filter((n) => allowedToolFilter.has(n)) : toolNames;

    const descriptor: IntegrationDescriptor = {
      sourceKind: row.sourceKind,
      integrationId,
      ...(row.binding ? { bindingId: row.binding.bindingId } : {}),
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      status,
      toolCount: status === 'bound' ? visibleToolNames.length : 0,
      ...(credentialStatus ? { credentialStatus } : {}),
    };
    descriptors.push(descriptor);

    if (status !== 'bound' && row.binding) {
      const { cause, detail } = diagnoseNonBoundBinding(row, row.binding);
      for (const name of visibleToolNames) {
        toolDiagnostics.push({
          toolId: buildIntegrationToolId(row.sourceKind, row.binding.bindingId, name),
          cause,
          detail,
        });
      }
    }

    if (status !== 'bound' || !row.binding) continue;

    if (row.sourceKind === 'api') {
      for (const endpoint of row.endpoints) {
        if (allowedToolFilter && !allowedToolFilter.has(endpoint.endpointId)) continue;
        const namePrefix = useQualifiedName ? row.binding.bindingId : row.apiId;
        tools.push({
          sourceKind: 'api',
          integrationId: row.apiId,
          bindingId: row.binding.bindingId,
          toolName: endpoint.endpointId,
          callName: `${namePrefix}.${endpoint.endpointId}`,
          toolId: buildIntegrationToolId('api', row.binding.bindingId, endpoint.endpointId),
          name: endpoint.name || `${namePrefix}.${endpoint.endpointId}`,
          description:
            endpoint.description || `${endpoint.method} ${endpoint.pathTemplate} (${row.name})`,
          inputSchema: deriveEndpointToolSchema(endpoint),
        });
      }
    } else {
      const filtered = applyToolFilter(row.binding.cachedTools, row.toolFilter);
      const stale =
        row.binding.cachedToolsAt !== null &&
        Date.now() - row.binding.cachedToolsAt.getTime() > MCP_TOOLS_STALE_AFTER_MS;
      const opTaskOnlySet = new Set(row.toolFilter?.opTaskOnly ?? []);
      for (const t of filtered) {
        if (allowedToolFilter && !allowedToolFilter.has(t.name)) continue;
        const namePrefix = useQualifiedName ? row.binding.bindingId : row.serverId;
        const opTaskOnly = opTaskOnlySet.has(t.name);
        tools.push({
          sourceKind: 'mcp',
          integrationId: row.serverId,
          bindingId: row.binding.bindingId,
          toolName: t.name,
          callName: `mcp_${namePrefix}.${t.name}`,
          toolId: buildIntegrationToolId('mcp', row.binding.bindingId, t.name),
          name: t.name,
          description: t.description || `MCP tool from ${row.name}`,
          inputSchema: t.inputSchema ?? { type: 'object' },
          ...(opTaskOnly ? { opTaskOnly: true } : {}),
          ...(stale ? { stale: true } : {}),
        });
      }
    }
  }

  return { descriptors, tools, toolDiagnostics, definitionOnlyCount };
}

function diagnoseNonBoundBinding(
  row: IntegrationRow,
  binding: NonNullable<ApiIntegrationRow['binding'] | McpIntegrationRow['binding']>,
): Pick<IntegrationToolDiagnostic, 'cause' | 'detail'> {
  const integrationId = row.sourceKind === 'api' ? row.apiId : row.serverId;
  const label = `${row.sourceKind} binding "${binding.bindingId}" (${integrationId})`;
  if (!row.definitionEnabled) {
    return { cause: 'definition_disabled', detail: `${label}: the definition is disabled` };
  }
  if (!binding.enabled) {
    return { cause: 'binding_disabled', detail: `${label}: the binding is disabled` };
  }
  if (binding.credentialStatus === 'expired') {
    return {
      cause: 'credential_expired',
      detail: `${label}: the OAuth token expired and cannot refresh — re-consent required`,
    };
  }
  if (binding.credentialStatus === 'unpinned') {
    return {
      cause: 'unpinned',
      detail: `${label}: no pinned server origin — the operator pins it in the Integrations page`,
    };
  }
  const keys = binding.missingCredentialKeys;
  return {
    cause: 'credential_missing',
    detail:
      keys.length > 0
        ? `${label}: expects credential key(s) ${keys.map((k) => `"${k}"`).join(', ')} with no ` +
          'stored credential — the operator adds them in the Integrations page'
        : `${label}: requires OAuth consent that has not been granted`,
  };
}

function deriveStatus(row: IntegrationRow): {
  status: IntegrationStatus;
  credentialStatus?: IntegrationCredentialStatus;
} {
  if (!row.definitionEnabled) return { status: 'disabled' };
  if (!row.binding) return { status: 'definition-only' };
  if (!row.binding.enabled) return { status: 'disabled' };

  if (row.sourceKind === 'api') {
    if (row.binding.credentialStatus !== 'ready') {
      return { status: 'needs_credentials', credentialStatus: row.binding.credentialStatus };
    }
    return { status: 'bound', credentialStatus: 'ready' };
  }

  // MCP — unpinned and missing are both flavors of needs_credentials.
  if (row.binding.credentialStatus !== 'ready') {
    return { status: 'needs_credentials', credentialStatus: row.binding.credentialStatus };
  }
  return { status: 'bound', credentialStatus: 'ready' };
}

function listToolNames(row: IntegrationRow): string[] {
  if (row.sourceKind === 'api') {
    return row.endpoints.map((e) => e.endpointId);
  }
  if (!row.binding) return [];
  return applyToolFilter(row.binding.cachedTools, row.toolFilter).map((t) => t.name);
}

/**
 * Index allow entries by `(sourceKind, integrationId)` so we can ask
 * "is this binding allowed?" and "which tools are allowed?" in O(1).
 *
 * Stores both pinned (with bindingId) and broad (without bindingId) entries.
 * `resolveAllowDecision` reads from this index with the
 * "binding-pinned supersedes broad" policy applied at lookup time so
 * `buildResult` stays simple.
 */
interface AllowIndex {
  broadToolNames: Map<string, Set<string> | null>; // key = `${sk}:${id}`. Value `null` = broad allow, no toolNames pin.
  byBinding: Map<string, Map<string, Set<string> | null>>; // key = `${sk}:${id}` → bindingId → toolNames or null.
}

function indexAllowEntries(
  allowed: ReadonlyArray<{
    sourceKind: IntegrationSourceKind;
    integrationId: string;
    bindingId?: string;
    toolNames?: string[];
  }>,
): AllowIndex {
  const broadToolNames = new Map<string, Set<string> | null>();
  const byBinding = new Map<string, Map<string, Set<string> | null>>();
  for (const a of allowed) {
    const integKey = `${a.sourceKind}:${a.integrationId}`;
    const toolNames = a.toolNames && a.toolNames.length > 0 ? new Set(a.toolNames) : null;
    if (a.bindingId) {
      const bindings = byBinding.get(integKey) ?? new Map<string, Set<string> | null>();
      // Merge tool sets when the same binding appears twice. `null` (no pin)
      // is the union identity — once any entry permits all tools, the binding
      // has no per-tool narrowing.
      const existing = bindings.get(a.bindingId);
      if (existing === undefined) {
        bindings.set(a.bindingId, toolNames);
      } else if (existing !== null && toolNames !== null) {
        for (const t of toolNames) existing.add(t);
      } else {
        bindings.set(a.bindingId, null);
      }
      byBinding.set(integKey, bindings);
    } else {
      const existing = broadToolNames.get(integKey);
      if (existing === undefined) {
        broadToolNames.set(integKey, toolNames);
      } else if (existing !== null && toolNames !== null) {
        for (const t of toolNames) existing.add(t);
      } else {
        broadToolNames.set(integKey, null);
      }
    }
  }
  return { broadToolNames, byBinding };
}

function resolveAllowDecision(
  index: AllowIndex,
  sourceKind: IntegrationSourceKind,
  integrationId: string,
  bindingId: string | undefined,
): { accepted: boolean; toolFilter: Set<string> | null } {
  const integKey = `${sourceKind}:${integrationId}`;
  const bindings = index.byBinding.get(integKey);
  const broad = index.broadToolNames.get(integKey);

  // Pinned-supersedes-broad: when any bindingId is pinned for this integration,
  // the broad entry no longer applies to other bindings.
  if (bindings && bindings.size > 0) {
    if (!bindingId) return { accepted: false, toolFilter: null };
    const toolFilter = bindings.get(bindingId);
    if (toolFilter === undefined) return { accepted: false, toolFilter: null };
    return { accepted: true, toolFilter };
  }

  if (broad !== undefined) {
    return { accepted: true, toolFilter: broad };
  }

  return { accepted: false, toolFilter: null };
}

const STATIC_AUTH_TYPES = new Set([
  // OAuth client-credentials reads `clientId/Secret` from `api_credentials`;
  // tokens are fetched and cached by the executor at call time
  // (mcpHandler.ts → getClientCredentialsToken). No row in oauth_tokens at
  // bind time.
  'oauth2_client_credentials',
]);

const OAUTH_TOKEN_AUTH_TYPES = new Set(['oauth2_pkce', 'oauth2_cimd']);

/**
 * Credential readiness for an API binding. An `oauth2_authorization_code`
 * authJson carries no credential keys — readiness is whether a usable token
 * exists for the resource (missing until consent; expired only when
 * unrefreshable) — while every static kind resolves from stored keys.
 *
 * A simulated binding authenticates against nothing, so the key derivation
 * would report it uncredentialled forever and no tool would ever be
 * promotable — inert for exactly the case simulation exists for. Credentials
 * stay populated on such a binding so promotion is one toggle, which is why
 * the answer has to read fulfillment rather than infer from auth.
 */
export function deriveApiCredentialStatus(
  authType: string | undefined,
  authJson: Record<string, unknown>,
  credentialKeys: Set<string>,
  oauthToken: { expiresAt: Date; hasRefresh: boolean } | undefined,
  fulfillment?: BindingFulfillment,
): IntegrationCredentialStatus {
  if (isSimulatedFulfillment(fulfillment)) return 'ready';
  if (!authType || authType === 'none') return 'ready';
  if (authType === 'oauth2_authorization_code') {
    if (!oauthToken) return 'missing';
    const expired = oauthToken.expiresAt.getTime() <= Date.now();
    if (!expired) return 'ready';
    return oauthToken.hasRefresh ? 'ready' : 'expired';
  }
  const keys = extractCredentialKeys(authJson);
  if (keys.length === 0) return 'missing';
  if (keys.some((k) => !credentialKeys.has(k))) return 'missing';
  return 'ready';
}

export function deriveMcpCredentialStatus(
  authType: string | undefined,
  authJson: Record<string, unknown>,
  pinnedOrigin: string | null,
  credentialKeys: Set<string>,
  oauthToken: { expiresAt: Date; hasRefresh: boolean } | undefined,
): IntegrationCredentialStatus {
  if (!pinnedOrigin) return 'unpinned';
  if (!authType || authType === 'none') return 'ready';

  if (OAUTH_TOKEN_AUTH_TYPES.has(authType)) {
    if (!oauthToken) return 'missing';
    const expired = oauthToken.expiresAt.getTime() <= Date.now();
    if (!expired) return 'ready';
    return oauthToken.hasRefresh ? 'ready' : 'expired';
  }

  // bearer, header, oauth2_client_credentials — all resolve from static keys.
  if (authType === 'bearer' || authType === 'header' || STATIC_AUTH_TYPES.has(authType)) {
    const keys = extractCredentialKeys(authJson);
    if (keys.length === 0) return 'missing';
    if (keys.some((k) => !credentialKeys.has(k))) return 'missing';
    return 'ready';
  }

  // Unknown auth type — conservative.
  return 'missing';
}

// Internal types exported for tests.
export type { ApiIntegrationRow, McpIntegrationRow, IntegrationRow };
