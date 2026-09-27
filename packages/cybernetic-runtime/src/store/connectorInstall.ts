/**
 * Connector-catalog install cores — one per definition substrate, shared by
 * the store install execution and its ratification path.
 *
 * Both installs write ONLY a definition + a credential-LESS binding: the auth
 * JSON carries `*credentialKey` slot NAMES (never values). The operator fills
 * credentials afterward via the existing /integrations routes; readiness is
 * recompute-at-read. The entry is deep-cloned + re-parsed through the same Zod
 * schema that gates the registry at module load — one substrate, no fork.
 */
import { sql, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  createTenantContext,
  ensureSimulationBaselineIn,
  withTenantSchema,
  tenants,
} from '@aflow/database';
import {
  ConnectorCatalogEntrySchema,
  McpConnectorCatalogEntrySchema,
  deriveHostFromBaseUrlTemplate,
  getOAuthIssuer,
  SimulationSchema,
  type ApiDefinition,
  type ConnectorCredentialPrompt,
  type CredentialSlot,
  type EgressPolicy,
  type McpAuthType,
  type McpConnectorAuthKind,
  type OAuthClientScope,
  type OAuthConsentOwnerScope,
  type PostInstallTask,
  type SpaceId,
  type SuggestedEgressPolicyDraft,
  type TenantId,
} from '@aflow/schemas';
import {
  buildPlaceholderAuthJson,
  pinnedCredentialKeys,
  type CredentialKeyPinning,
  parseHostFromUrl,
  mergeSuggestedEgressIntoBaseline,
} from '../stagedChange/capabilityBindingApply.js';
import {
  writeApiDefinition,
  writePlaceholderBinding,
  BundleWriteConflictError,
  extractCredentialKeys,
  checkOAuthClientRegistered,
} from '../stagedChange/apiWriteHelpers.js';
import {
  writeMcpServerDefinition,
  writePlaceholderMcpBinding,
  McpBundleWriteConflictError,
  extractMcpCredentialKeys,
} from '../stagedChange/mcpWriteHelpers.js';
import {
  deriveMcpBindingSetupTask,
  fetchPresentCredentialKeys,
} from '../stagedChange/bundleInstallManifest.js';
import { resolveCimdDocumentUrl } from '@aflow/oauth';
import { publishApiCatalogInvalidation, publishMcpCatalogInvalidation } from '@aflow/redis';

export type ConnectorInstallStatus =
  'definition-only' | 'needs_credentials' | 'needs_oauth_consent';

export function connectorStatus(
  needsConsent: boolean,
  missingCredentialKeys: readonly string[],
): ConnectorInstallStatus {
  if (needsConsent) return 'needs_oauth_consent';
  return missingCredentialKeys.length > 0 ? 'needs_credentials' : 'definition-only';
}

export function connectorDefaultBindingId(integrationId: string): string {
  return `${integrationId}-default`;
}

// The consent-start paths mirror the api-oauth / mcp-oauth routes. The UI
// POSTs them to launch provider sign-in for the just-created binding.
export function apiConnectorConsentPath(bindingId: string): string {
  return `/integrations/api/bindings/${bindingId}/consent`;
}

export function mcpConnectorConsentPath(bindingId: string): string {
  return `/integrations/mcp/bindings/${bindingId}/consent`;
}

/**
 * Catalog-cache invalidations for an installed connector's artifacts. Fired
 * by the install helpers when they own the transaction; a caller that wraps
 * an install in an outer transaction passes `redis: null` and calls the
 * matching publisher itself post-commit.
 */
export function publishApiConnectorInstallInvalidations(
  redis: Redis,
  tenantId: TenantId,
  spaceId: SpaceId,
  apiId: string,
): void {
  publishApiCatalogInvalidation(redis, tenantId as string, spaceId, { kind: 'definition', apiId });
  publishApiCatalogInvalidation(redis, tenantId as string, spaceId, { kind: 'binding', apiId });
}

export function publishMcpConnectorInstallInvalidations(
  redis: Redis,
  tenantId: TenantId,
  spaceId: SpaceId,
  serverId: string,
  bindingId: string,
): void {
  publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
    kind: 'definition',
    serverId,
  });
  publishMcpCatalogInvalidation(redis, tenantId as string, spaceId, {
    kind: 'binding',
    serverId,
    bindingId,
  });
}

export interface ConnectorInstallContext {
  db: PostgresJsDatabase;
  redis: Redis | null;
  tenantId: TenantId;
  spaceId: SpaceId;
}

export type ApiConnectorInstallResult =
  | {
      outcome: 'installed';
      apiId: string;
      bindingId: string;
      status: ConnectorInstallStatus;
      missingVariables: string[];
      missingCredentialKeys: string[];
      consentPath?: string;
    }
  | { outcome: 'conflict'; conflictingApiId: string; error: string }
  | { outcome: 'invalid_entry'; error: string }
  | { outcome: 'oauth_client_unregistered'; error: string };

export type McpConnectorInstallResult =
  | {
      outcome: 'installed';
      serverId: string;
      bindingId: string;
      status: ConnectorInstallStatus;
      missingCredentialKeys: string[];
      setupChecklist: PostInstallTask[];
      consentPath?: string;
    }
  | { outcome: 'conflict'; conflictingServerId: string; error: string };

export async function readTenantOAuthDefaults(
  db: PostgresJsDatabase,
  tenantId: TenantId,
): Promise<{ ownerScope: OAuthConsentOwnerScope; clientScope: OAuthClientScope }> {
  const policyRows = await db
    .select({
      ownerScope: tenants.oauthDefaultOwnerScope,
      clientScope: tenants.oauthDefaultClientScope,
    })
    .from(tenants)
    .where(eq(tenants.tenantId, tenantId))
    .limit(1);
  // Coerce legacy stored values: 'tenant' is no longer an owner scope, and
  // the 'platform' client is CIMD (MCP-only) — an API issuer has no platform
  // client, so a connector binding defaulted to it dead-ends at consent with
  // the provider's invalid_client. Space-BYO is the working default.
  const rawOwner = policyRows[0]?.ownerScope;
  const rawClient = policyRows[0]?.clientScope;
  return {
    ownerScope: rawOwner === 'user' ? 'user' : 'space',
    clientScope: rawClient === 'tenant' ? 'tenant' : 'space',
  };
}

// ============================================================================
// API connector placeholder auth
// ============================================================================

export type ApiConnectorPlaceholderAuthResult =
  | { ok: true; authJson: Record<string, unknown>; isOAuth: boolean }
  | { ok: false; outcome: 'invalid_entry' | 'oauth_client_unregistered'; error: string };

/**
 * The auth profile a connector's default binding carries before the operator
 * fills anything: slot NAMES for static kinds, the issuer + tenant ownership
 * defaults for OAuth (the client secret never touches this path). Shared by
 * install and update so the two can never disagree about the placeholder
 * shape.
 */
export async function buildApiConnectorPlaceholderAuth(opts: {
  db: PostgresJsDatabase;
  tenantId: TenantId;
  spaceId: SpaceId;
  entry: {
    catalogId: string;
    authKind: string;
    apiKeyHeaderName?: string | undefined;
    apiKeyQueryParamName?: string | undefined;
    apiKeyPairHeaderNames?: { primary: string; secondary: string } | undefined;
    credentialPrompts?: CredentialKeyPinning | undefined;
    oauthIssuerKey?: string | undefined;
    oauthScopes?: readonly string[] | undefined;
  };
  bindingId: string;
  /** Install rejects an unregistered tenant/space OAuth client; update tolerates it (consent re-runs the guard). */
  enforceOAuthClientRegistered: boolean;
}): Promise<ApiConnectorPlaceholderAuthResult> {
  const { db, tenantId, spaceId, entry, bindingId } = opts;
  if (entry.authKind !== 'oauth2_authorization_code') {
    return {
      ok: true,
      authJson: buildPlaceholderAuthJson(
        entry.authKind as Parameters<typeof buildPlaceholderAuthJson>[0],
        bindingId,
        {
          apiKeyHeaderName: entry.apiKeyHeaderName,
          apiKeyQueryParamName: entry.apiKeyQueryParamName,
          apiKeyPairHeaderNames: entry.apiKeyPairHeaderNames,
          credentialKeys: pinnedCredentialKeys(entry.credentialPrompts),
        },
      ),
      isOAuth: false,
    };
  }

  const issuerKey = entry.oauthIssuerKey;
  if (!issuerKey) {
    // Belt-and-suspenders: the schema superRefine already requires this.
    return {
      ok: false,
      outcome: 'invalid_entry',
      error: `Connector '${entry.catalogId}' is OAuth but declares no oauthIssuerKey.`,
    };
  }
  const { ownerScope, clientScope } = await readTenantOAuthDefaults(db, tenantId);

  // A tenant/space client app must point at a registered oauth_clients row
  // or consent later has no client_id — the same guard the manual
  // /integrations/bindings route enforces (bindings.ts).
  if (opts.enforceOAuthClientRegistered && clientScope !== 'platform') {
    const guardError = await withTenantSchema(db, createTenantContext(tenantId), async (tx) =>
      checkOAuthClientRegistered(tx, clientScope, issuerKey, {
        tenantId: tenantId as string,
        spaceId: spaceId as string,
      }),
    );
    if (guardError) {
      return { ok: false, outcome: 'oauth_client_unregistered', error: guardError };
    }
  }

  const issuer = getOAuthIssuer(issuerKey);
  const scopes = entry.oauthScopes ?? issuer?.defaultScopes ?? [];
  return {
    ok: true,
    authJson: {
      type: 'oauth2_authorization_code',
      issuerKey,
      ownerScope,
      clientScope,
      ...(scopes.length > 0 ? { scopes: [...scopes] } : {}),
    },
    isOAuth: true,
  };
}

/** Egress baseline for a connector's default binding, derived from its definition. */
export function deriveApiConnectorInitialEgress(definition: ApiDefinition): EgressPolicy {
  const host = definition.baseUrl
    ? parseHostFromUrl(definition.baseUrl)
    : definition.baseUrlTemplate
      ? (deriveHostFromBaseUrlTemplate(definition.baseUrlTemplate) ?? null)
      : null;
  return mergeSuggestedEgressIntoBaseline(
    { allowedHosts: host ? [host] : [] },
    definition.suggestedEgressPolicy as SuggestedEgressPolicyDraft | undefined,
  ) as EgressPolicy;
}

// ============================================================================
// API connector install
// ============================================================================

/**
 * The simulation a simulated connector is bound to, minted per space.
 *
 * Deterministic in the api id so a reinstall finds what the first install
 * created rather than minting a second world beside the first.
 */
export function simulationIdForApi(apiId: string): string {
  return `sim-${apiId}`;
}

/**
 * The artifact a simulated connector starts from: the contract, and nothing
 * else. No collections, no personas, no rules.
 *
 * That is not a stub — `unmatched: 'generate'` means it answers from the first
 * call, against the endpoint's own `responseSchemas`, which is what makes an
 * integration usable before anyone has written a rule. Authoring collections,
 * effects and handlers afterwards is what walks it down the ladder from
 * generated to declared, and is the space's work rather than the catalog's.
 */
async function writeMintedSimulation(opts: {
  simulationId: string;
  definition: ApiDefinition;
  spaceId: string;
  tx: PostgresJsDatabase;
}): Promise<void> {
  const { simulationId, definition, spaceId, tx } = opts;
  const simulation = SimulationSchema.parse({
    simulationId,
    name: `${definition.name} (simulated)`,
    description: `Answers ${definition.name} from a declared world. Installed with no collections — every endpoint is answered by generation until one is authored.`,
    targets: { sourceKind: 'api', integrationId: definition.apiId },
    collections: [],
    personas: [],
    rules: [],
    handlers: {},
    effects: {},
    policy: { unmatched: 'generate' },
    revision: 1,
  });

  await tx.execute(sql`
    INSERT INTO simulations (
      simulation_id, space_id, name, description, revision, target_api_id, definition_json, enabled
    )
    VALUES (
      ${simulationId},
      ${spaceId}::uuid,
      ${simulation.name},
      ${simulation.description ?? null},
      1,
      ${definition.apiId},
      ${JSON.stringify(simulation)}::jsonb,
      1
    )
    ON CONFLICT (simulation_id, space_id) DO NOTHING
  `);
}

export async function installApiConnectorEntry(opts: {
  entry: unknown;
  installAsApiId?: string | undefined;
  context: ConnectorInstallContext;
}): Promise<ApiConnectorInstallResult> {
  const { entry, installAsApiId, context } = opts;
  const { db, redis, tenantId, spaceId } = context;

  const parsed = ConnectorCatalogEntrySchema.safeParse(JSON.parse(JSON.stringify(entry)));
  if (!parsed.success) {
    const catalogId = (entry as { catalogId?: string } | null)?.catalogId ?? '<unknown>';
    throw new Error(
      `Connector '${catalogId}' failed re-validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const definition: ApiDefinition = parsed.data.definition;
  const apiId = installAsApiId ?? definition.apiId;
  if (apiId !== definition.apiId) definition.apiId = apiId;

  const tenantContext = createTenantContext(tenantId);

  const conflictResult: ApiConnectorInstallResult = {
    outcome: 'conflict',
    conflictingApiId: apiId,
    error: `An API definition '${apiId}' already exists in this space. Pick a different installAsApiId.`,
  };
  const existing = await withTenantSchema(db, tenantContext, async (tx) =>
    tx.execute<{ api_id: string }>(sql`
      SELECT api_id FROM api_definitions
      WHERE api_id = ${apiId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `),
  );
  if (existing.length > 0) return conflictResult;

  const bindingId = connectorDefaultBindingId(apiId);

  // An OAuth connector installs a consent-based binding: the auth profile
  // carries the issuer + the tenant policy's ownership defaults; the client
  // secret never touches this path (it lives in oauth_clients). Install
  // routes to provider sign-in rather than paste-credentials.
  const placeholder = await buildApiConnectorPlaceholderAuth({
    db,
    tenantId,
    spaceId,
    entry: parsed.data,
    bindingId,
    enforceOAuthClientRegistered: true,
  });
  if (!placeholder.ok) {
    return { outcome: placeholder.outcome, error: placeholder.error };
  }
  const isSimulated = parsed.data.fulfillment === 'simulated';
  const isOAuthConnector = placeholder.isOAuth;
  const placeholderAuth = placeholder.authJson;
  const initialEgress = deriveApiConnectorInitialEgress(definition);

  // Minted, never carried on the listing. An id fixed by the entry would
  // collide the second time it is installed into one tenant, and the world it
  // names belongs to the space that installed it rather than to the catalog.
  const simulationId = isSimulated ? simulationIdForApi(apiId) : undefined;

  try {
    await withTenantSchema(db, tenantContext, async (tx) => {
      await writeApiDefinition({
        definition,
        spaceId: spaceId as string,
        conflictPolicy: 'fail',
        tx,
      });
      if (simulationId !== undefined) {
        await writeMintedSimulation({
          simulationId,
          definition,
          spaceId: spaceId as string,
          tx,
        });
        // The empty world is a real baseline version, not the absence of one —
        // a run pinning a never-seeded simulation must pin something that can
        // never later acquire rows.
        await ensureSimulationBaselineIn(tx, { spaceId: spaceId as string, simulationId });
      }
      await writePlaceholderBinding({
        bindingId,
        apiId,
        spaceId: spaceId as string,
        name: definition.name,
        description: isSimulated
          ? 'Simulated binding — answered by a declared world, with no host and no credential.'
          : 'Default binding (credentials + variables pending — add at /integrations).',
        scope: { tenantId: tenantId as string, spaceId: spaceId as string },
        authJson: placeholderAuth,
        egressPolicy: initialEgress,
        ...(simulationId !== undefined
          ? { fulfillment: { mode: 'simulated' as const, simulationId } }
          : {}),
        conflictPolicy: 'skip',
        tx,
      });
    });
  } catch (err) {
    // The pre-check above catches the common case; this maps the insert-time
    // conflict from a concurrent install/bind to a declared conflict instead
    // of a bare 500.
    if (err instanceof BundleWriteConflictError) return conflictResult;
    throw err;
  }

  if (redis) {
    publishApiConnectorInstallInvalidations(redis, tenantId, spaceId, apiId);
  }

  // A simulated binding needs nothing configured to work. Its variables
  // substitute into a base URL nothing calls, and it holds no credential, so
  // reporting either as missing would park a working integration in
  // needs-configuration and ask an operator for a secret it can never use.
  const missingVariables = isSimulated
    ? []
    : (definition.variables ?? []).filter((v) => v.required).map((v) => v.name);
  const missingCredentialKeys =
    isSimulated || isOAuthConnector ? [] : extractCredentialKeys(placeholderAuth);

  return {
    outcome: 'installed',
    apiId,
    bindingId,
    status: connectorStatus(isOAuthConnector, missingCredentialKeys),
    missingVariables,
    missingCredentialKeys,
    ...(isOAuthConnector ? { consentPath: apiConnectorConsentPath(bindingId) } : {}),
  };
}

// ============================================================================
// MCP connector install
// ============================================================================

export const CONSENT_AUTH_KINDS: ReadonlySet<McpAuthType> = new Set(['oauth2_pkce', 'oauth2_cimd']);

/**
 * Placeholder auth for an MCP connector's needs-config binding: the auth JSON
 * (slot NAMES only) plus the credential slots the operator must fill.
 * Consent-based kinds carry no slots — tokens arrive via provider sign-in.
 */
export function buildPlaceholderMcpAuth(
  authKind: McpConnectorAuthKind,
  bindingId: string,
  credentialPrompts: readonly ConnectorCredentialPrompt[] | undefined,
): { authJson: Record<string, unknown>; slots: CredentialSlot[] } {
  const labelFor = (authField: string, credentialKey: string): string =>
    credentialPrompts?.find((p) => p.authField === authField)?.label ?? credentialKey;
  switch (authKind) {
    case 'none':
      return { authJson: { type: 'none' }, slots: [] };
    case 'bearer': {
      const credentialKey = `${bindingId}-token`;
      return {
        authJson: { type: 'bearer', credentialKey },
        slots: [
          {
            authField: 'credentialKey',
            credentialKey,
            role: 'token',
            label: labelFor('credentialKey', credentialKey),
          },
        ],
      };
    }
    case 'oauth2_pkce':
      return { authJson: { type: 'oauth2_pkce' }, slots: [] };
    case 'oauth2_cimd':
      return {
        authJson: { type: 'oauth2_cimd', clientIdMetadataUrl: resolveCimdDocumentUrl() },
        slots: [],
      };
    default: {
      const _exhaustive: never = authKind;
      throw new Error(`buildPlaceholderMcpAuth: unhandled authKind '${String(_exhaustive)}'.`);
    }
  }
}

export interface McpConnectorSetupState {
  missingCredentialKeys: string[];
  setupChecklist: PostInstallTask[];
}

/**
 * Derived-from-state readiness for an MCP connector's default binding: read
 * the binding row, resolve which credential slots are actually filled, and
 * derive the outstanding setup task. Shared by the install tail and the
 * store's same-version reinstall no-op so both reflect what is still
 * outstanding, not what an install attempted.
 */
export async function deriveMcpConnectorSetupState(opts: {
  tx: PostgresJsDatabase;
  spaceId: string;
  bindingId: string;
  serverId: string;
  name: string;
  authKind: McpConnectorAuthKind;
  slots: readonly CredentialSlot[];
}): Promise<McpConnectorSetupState> {
  const { tx, spaceId, bindingId, serverId, name, authKind, slots } = opts;
  const bindingRows = await tx.execute<{
    auth_json: Record<string, unknown>;
    pinned_origin: string | null;
    enabled: number | boolean;
  }>(sql`
    SELECT auth_json, pinned_origin, enabled FROM mcp_server_bindings
    WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
    LIMIT 1
  `);
  const row = bindingRows[0];
  const isConsent = CONSENT_AUTH_KINDS.has(authKind);
  const credentialKeys = isConsent
    ? []
    : row
      ? extractMcpCredentialKeys(row.auth_json)
      : slots.map((slot) => slot.credentialKey);
  const presentCredentialKeys = await fetchPresentCredentialKeys(
    tx,
    spaceId,
    new Set([...credentialKeys, ...slots.map((slot) => slot.credentialKey)]),
  );
  const missingCredentialKeys = credentialKeys.filter((key) => !presentCredentialKeys.has(key));
  if (row === undefined) return { missingCredentialKeys, setupChecklist: [] };
  const task = deriveMcpBindingSetupTask({
    bindingId,
    serverId,
    name,
    authType: authKind,
    credentialSlots: [...slots],
    authJson: row.auth_json,
    pinnedOrigin: row.pinned_origin,
    enabled: Boolean(row.enabled),
    presentCredentialKeys,
  });
  return { missingCredentialKeys, setupChecklist: task !== null ? [task] : [] };
}

export async function installMcpConnectorEntry(opts: {
  entry: unknown;
  context: ConnectorInstallContext;
}): Promise<McpConnectorInstallResult> {
  const { entry, context } = opts;
  const { db, redis, tenantId, spaceId } = context;

  const parsed = McpConnectorCatalogEntrySchema.safeParse(JSON.parse(JSON.stringify(entry)));
  if (!parsed.success) {
    const catalogId = (entry as { catalogId?: string } | null)?.catalogId ?? '<unknown>';
    throw new Error(
      `Connector '${catalogId}' failed re-validation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const { serverId, ...definition } = parsed.data.definition;

  const tenantContext = createTenantContext(tenantId);

  const conflictResult: McpConnectorInstallResult = {
    outcome: 'conflict',
    conflictingServerId: serverId,
    error: `An MCP server definition '${serverId}' already exists in this space.`,
  };
  const existing = await withTenantSchema(db, tenantContext, async (tx) =>
    tx.execute<{ server_id: string }>(sql`
      SELECT server_id FROM mcp_server_definitions
      WHERE server_id = ${serverId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `),
  );
  if (existing.length > 0) return conflictResult;

  const bindingId = connectorDefaultBindingId(serverId);
  const authKind = parsed.data.authKind;
  const isConsentConnector = CONSENT_AUTH_KINDS.has(authKind);
  const { authJson, slots } = buildPlaceholderMcpAuth(
    authKind,
    bindingId,
    parsed.data.credentialPrompts,
  );

  // Consent-based bindings carry the tenant policy's ownership defaults on the
  // binding row — the same defaults the API OAuth install stamps into its auth
  // profile. Static kinds keep the column defaults.
  const consentScopes = isConsentConnector ? await readTenantOAuthDefaults(db, tenantId) : null;

  let setupState: McpConnectorSetupState;
  try {
    setupState = await withTenantSchema(db, tenantContext, async (tx) => {
      await writeMcpServerDefinition({
        serverId,
        definition,
        source: 'platform',
        spaceId: spaceId as string,
        conflictPolicy: 'fail',
        tx,
      });
      await writePlaceholderMcpBinding({
        bindingId,
        serverId,
        spaceId: spaceId as string,
        name: definition.name,
        description: 'Default binding (credentials pending — add at /integrations).',
        scope: { tenantId: tenantId as string, spaceId: spaceId as string },
        authJson,
        subscribeListChanged: true,
        samplingPolicy: 'off',
        ...(consentScopes !== null ? consentScopes : {}),
        conflictPolicy: 'skip',
        tx,
      });

      // Same derived-from-state semantics as the bundle manifest: read the
      // just-written row so an idempotent reinstall reflects what is still
      // outstanding, not what this install attempted.
      return deriveMcpConnectorSetupState({
        tx,
        spaceId: spaceId as string,
        bindingId,
        serverId,
        name: definition.name,
        authKind,
        slots,
      });
    });
  } catch (err) {
    if (err instanceof McpBundleWriteConflictError) return conflictResult;
    throw err;
  }

  if (redis) {
    publishMcpConnectorInstallInvalidations(redis, tenantId, spaceId, serverId, bindingId);
  }

  return {
    outcome: 'installed',
    serverId,
    bindingId,
    status: connectorStatus(isConsentConnector, setupState.missingCredentialKeys),
    missingCredentialKeys: setupState.missingCredentialKeys,
    setupChecklist: setupState.setupChecklist,
    ...(isConsentConnector ? { consentPath: mcpConnectorConsentPath(bindingId) } : {}),
  };
}
