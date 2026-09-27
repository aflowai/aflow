/**
 * Connector-catalog update cores — definition replace + credential-preserving
 * binding merge, one per definition substrate. The definition row is registry
 * content and is overwritten; the default binding is user state and is only
 * touched where the new definition forces it: an incompatible auth shape
 * placeholder-resets the credential slots (the setup checklist reappears),
 * and a changed MCP server origin drops the origin pin so the connect test
 * must re-run. Filled credential references and variable values otherwise
 * survive verbatim.
 */
import { sql } from 'drizzle-orm';
import { createTenantContext, withTenantSchema } from '@aflow/database';
import {
  ConnectorCatalogEntrySchema,
  McpConnectorCatalogEntrySchema,
  type ApiDefinition,
  type PostInstallTask,
} from '@aflow/schemas';
import {
  extractCredentialKeys,
  writeApiDefinition,
  writePlaceholderBinding,
} from '../stagedChange/apiWriteHelpers.js';
import {
  extractMcpCredentialKeys,
  writeMcpServerDefinition,
  writePlaceholderMcpBinding,
} from '../stagedChange/mcpWriteHelpers.js';
import { fetchPresentCredentialKeys } from '../stagedChange/bundleInstallManifest.js';
import { mergeBindingAuth } from './bindingMerge.js';
import {
  apiConnectorConsentPath,
  buildApiConnectorPlaceholderAuth,
  buildPlaceholderMcpAuth,
  connectorDefaultBindingId,
  connectorStatus,
  deriveApiConnectorInitialEgress,
  deriveMcpConnectorSetupState,
  mcpConnectorConsentPath,
  readTenantOAuthDefaults,
  CONSENT_AUTH_KINDS,
  type ConnectorInstallContext,
  type ConnectorInstallStatus,
} from './connectorInstall.js';
import { deriveApiConnectorSetupChecklist } from './storeDerivations.js';

export type ApiConnectorUpdateResult =
  | {
      outcome: 'updated';
      apiId: string;
      bindingId: string;
      status: ConnectorInstallStatus;
      missingVariables: string[];
      missingCredentialKeys: string[];
      credentialsReset: boolean;
      setupChecklist: PostInstallTask[];
      consentPath?: string;
    }
  | { outcome: 'invalid_entry'; error: string };

export type McpConnectorUpdateResult =
  | {
      outcome: 'updated';
      serverId: string;
      bindingId: string;
      status: ConnectorInstallStatus;
      missingCredentialKeys: string[];
      credentialsReset: boolean;
      setupChecklist: PostInstallTask[];
      consentPath?: string;
    }
  | { outcome: 'invalid_entry'; error: string };

type ApiBindingRow = {
  auth_json: Record<string, unknown>;
  egress_policy_json: Record<string, unknown> | null;
  variable_values_json: Record<string, string> | null;
} & Record<string, unknown>;

function unionAllowedHosts(
  existing: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  const existingHosts = Array.isArray(existing['allowedHosts'])
    ? (existing['allowedHosts'] as string[])
    : [];
  const baselineHosts = Array.isArray(baseline['allowedHosts'])
    ? (baseline['allowedHosts'] as string[])
    : [];
  return { ...existing, allowedHosts: [...new Set([...existingHosts, ...baselineHosts])] };
}

function missingRequiredVariables(
  definition: ApiDefinition,
  variableValues: Record<string, string> | null,
): string[] {
  return (definition.variables ?? [])
    .filter((variable) => variable.required)
    .map((variable) => variable.name)
    .filter((name) => {
      const value = variableValues?.[name];
      return typeof value !== 'string' || value.length === 0;
    });
}

export async function updateApiConnectorEntry(opts: {
  entry: unknown;
  context: ConnectorInstallContext;
}): Promise<ApiConnectorUpdateResult> {
  const { entry, context } = opts;
  const { db, tenantId, spaceId } = context;

  const parsed = ConnectorCatalogEntrySchema.safeParse(JSON.parse(JSON.stringify(entry)));
  if (!parsed.success) {
    return {
      outcome: 'invalid_entry',
      error: `Connector failed re-validation: ${parsed.error.message}`,
    };
  }
  const definition = parsed.data.definition;
  const apiId = definition.apiId;
  const bindingId = connectorDefaultBindingId(apiId);

  const placeholder = await buildApiConnectorPlaceholderAuth({
    db,
    tenantId,
    spaceId,
    entry: parsed.data,
    bindingId,
    enforceOAuthClientRegistered: false,
  });
  if (!placeholder.ok) {
    return { outcome: 'invalid_entry', error: placeholder.error };
  }
  const isOAuth = placeholder.isOAuth;

  const tenantCtx = createTenantContext(tenantId);
  const outcome = await withTenantSchema(db, tenantCtx, async (tx) => {
    await writeApiDefinition({
      definition,
      spaceId: spaceId as string,
      conflictPolicy: 'overwrite',
      tx,
    });

    const rows = await tx.execute<ApiBindingRow>(sql`
      SELECT auth_json, egress_policy_json, variable_values_json FROM api_bindings
      WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `);
    const row = rows[0];
    const baselineEgress = deriveApiConnectorInitialEgress(definition);

    if (row === undefined) {
      await writePlaceholderBinding({
        bindingId,
        apiId,
        spaceId: spaceId as string,
        name: definition.name,
        description: 'Default binding (credentials + variables pending — add at /integrations).',
        scope: { tenantId: tenantId as string, spaceId: spaceId as string },
        authJson: placeholder.authJson,
        egressPolicy: baselineEgress,
        conflictPolicy: 'skip',
        tx,
      });
      return { authJson: placeholder.authJson, reset: true, variableValues: null };
    }

    const merged = mergeBindingAuth({
      existingAuthJson: row.auth_json,
      placeholderAuthJson: placeholder.authJson,
      extractCredentialKeys,
    });
    const mergedEgress = unionAllowedHosts(
      row.egress_policy_json ?? {},
      baselineEgress as Record<string, unknown>,
    );
    await tx.execute(sql`
      UPDATE api_bindings SET
        auth_json = ${JSON.stringify(merged.authJson)}::jsonb,
        egress_policy_json = ${JSON.stringify(mergedEgress)}::jsonb,
        updated_at = NOW()
      WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
    `);
    return {
      authJson: merged.authJson,
      reset: merged.reset,
      variableValues: row.variable_values_json,
    };
  });

  const credentialKeys = isOAuth ? [] : extractCredentialKeys(outcome.authJson);
  const present = await withTenantSchema(db, tenantCtx, async (tx) =>
    fetchPresentCredentialKeys(tx, spaceId as string, new Set(credentialKeys)),
  );
  const missingCredentialKeys = credentialKeys.filter((key) => !present.has(key));

  return {
    outcome: 'updated',
    apiId,
    bindingId,
    status: connectorStatus(isOAuth, missingCredentialKeys),
    missingVariables: missingRequiredVariables(definition, outcome.variableValues),
    missingCredentialKeys,
    credentialsReset: outcome.reset,
    setupChecklist: deriveApiConnectorSetupChecklist(parsed.data, missingCredentialKeys),
    ...(isOAuth ? { consentPath: apiConnectorConsentPath(bindingId) } : {}),
  };
}

export async function updateMcpConnectorEntry(opts: {
  entry: unknown;
  context: ConnectorInstallContext;
}): Promise<McpConnectorUpdateResult> {
  const { entry, context } = opts;
  const { db, tenantId, spaceId } = context;

  const parseResult = McpConnectorCatalogEntrySchema.safeParse(JSON.parse(JSON.stringify(entry)));
  if (!parseResult.success) {
    return {
      outcome: 'invalid_entry',
      error: `Connector failed re-validation: ${parseResult.error.message}`,
    };
  }
  const parsed = parseResult.data;
  const { serverId, ...definition } = parsed.definition;
  const bindingId = connectorDefaultBindingId(serverId);
  const authKind = parsed.authKind;
  const isConsent = CONSENT_AUTH_KINDS.has(authKind);
  const { authJson: placeholderAuth, slots } = buildPlaceholderMcpAuth(
    authKind,
    bindingId,
    parsed.credentialPrompts,
  );
  const consentScopes = isConsent ? await readTenantOAuthDefaults(db, tenantId) : null;
  const newOrigin = (() => {
    try {
      return new URL(definition.serverUrl).origin;
    } catch {
      return null;
    }
  })();

  const tenantCtx = createTenantContext(tenantId);
  const result = await withTenantSchema(db, tenantCtx, async (tx) => {
    await writeMcpServerDefinition({
      serverId,
      definition,
      source: 'platform',
      spaceId: spaceId as string,
      conflictPolicy: 'overwrite',
      tx,
    });

    const rows = await tx.execute<{
      auth_json: Record<string, unknown>;
      pinned_origin: string | null;
      enabled: number | boolean;
    }>(sql`
      SELECT auth_json, pinned_origin, enabled FROM mcp_server_bindings
      WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
      LIMIT 1
    `);
    const row = rows[0];

    let reset: boolean;
    if (row === undefined) {
      await writePlaceholderMcpBinding({
        bindingId,
        serverId,
        spaceId: spaceId as string,
        name: definition.name,
        description: 'Default binding (credentials pending — add at /integrations).',
        scope: { tenantId: tenantId as string, spaceId: spaceId as string },
        authJson: placeholderAuth,
        subscribeListChanged: true,
        samplingPolicy: 'off',
        ...(consentScopes !== null ? consentScopes : {}),
        conflictPolicy: 'skip',
        tx,
      });
      reset = true;
    } else {
      const merged = mergeBindingAuth({
        existingAuthJson: row.auth_json,
        placeholderAuthJson: placeholderAuth,
        extractCredentialKeys: extractMcpCredentialKeys,
      });
      // A moved server invalidates the origin pin — drop it and disable so
      // the Save & connect test must re-pin before calls resume.
      const originMoved =
        row.pinned_origin !== null && newOrigin !== null && row.pinned_origin !== newOrigin;
      const nextPinnedOrigin = originMoved ? null : row.pinned_origin;
      const nextEnabled = originMoved ? 0 : Number(Boolean(row.enabled));
      await tx.execute(sql`
        UPDATE mcp_server_bindings SET
          auth_json = ${JSON.stringify(merged.authJson)}::jsonb,
          pinned_origin = ${nextPinnedOrigin},
          enabled = ${nextEnabled},
          updated_at = NOW()
        WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid
      `);
      reset = merged.reset;
    }

    const setupState = await deriveMcpConnectorSetupState({
      tx,
      spaceId: spaceId as string,
      bindingId,
      serverId,
      name: definition.name,
      authKind,
      slots,
    });
    return { reset, setupState };
  });

  return {
    outcome: 'updated',
    serverId,
    bindingId,
    status: connectorStatus(isConsent, result.setupState.missingCredentialKeys),
    missingCredentialKeys: result.setupState.missingCredentialKeys,
    credentialsReset: result.reset,
    setupChecklist: result.setupState.setupChecklist,
    ...(isConsent ? { consentPath: mcpConnectorConsentPath(bindingId) } : {}),
  };
}
