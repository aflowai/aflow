import { eq, and } from 'drizzle-orm';
import {
  getDatabase,
  withTenantSchema,
  createTenantContext,
  mcpServerBindings,
  mcpServerDefinitions,
} from '@aflow/database';
import {
  McpServerBindingSchema,
  McpServerDefinitionSchema,
  type McpServerBinding,
  type McpServerDefinition,
} from '@aflow/schemas';
import {
  startConsent,
  resolveOAuthCallbackUrl,
  resolveOAuthOwner,
  buildMcpOAuthDescriptor,
  type OAuthBindingTarget,
} from '@aflow/oauth';
import type { InlineHandlerArgs } from './types.js';
import { emitStepSuccess, emitStepError } from './helpers.js';
import { requireSpaceId } from './spaceScope.js';
import { getOrchestratorLogger } from '../../../../lib/orchestratorLogger.js';

export async function handleMcpBindingConsentInline(args: InlineHandlerArgs): Promise<void> {
  const startTime = Date.now();
  const log = getOrchestratorLogger();

  let input: { bindingId?: unknown } = {};
  try {
    const data = await args.payloadStore.retrieve(args.resolvedInputRef);
    if (data && typeof data === 'object') {
      input = data as { bindingId?: unknown };
    }
  } catch {
    /* empty input — handled by validation below */
  }

  if (typeof input.bindingId !== 'string' || input.bindingId.length === 0) {
    await emitStepError(
      args,
      'MCP_CONSENT_INVALID_INPUT',
      'mcp.binding.consent requires a non-empty bindingId.',
      startTime,
      'validation',
    );
    return;
  }
  const bindingId = input.bindingId;

  let spaceId: string;
  try {
    spaceId = requireSpaceId(args.context);
  } catch (err) {
    await emitStepError(
      args,
      'MCP_CONSENT_NO_SPACE',
      err instanceof Error ? err.message : String(err),
      startTime,
      'validation',
    );
    return;
  }

  const db = getDatabase();

  const tenantContext = createTenantContext(args.context.tenantId);

  const bindingRows = (await withTenantSchema(db, tenantContext, async (tx) => {
    return tx
      .select()
      .from(mcpServerBindings)
      .where(
        and(eq(mcpServerBindings.bindingId, bindingId), eq(mcpServerBindings.spaceId, spaceId)),
      )
      .limit(1);
  })) as Array<Record<string, unknown>>;

  if (bindingRows.length === 0) {
    await emitStepError(
      args,
      'MCP_CONSENT_BINDING_NOT_FOUND',
      `MCP binding "${bindingId}" not found in space "${spaceId}".`,
      startTime,
      'validation',
    );
    return;
  }
  const binding = parseBindingRow(bindingRows[0]!);
  if (!binding) {
    await emitStepError(
      args,
      'MCP_CONSENT_BINDING_INVALID',
      `MCP binding "${bindingId}" failed schema validation.`,
      startTime,
      'internal',
    );
    return;
  }

  if (binding.auth.type !== 'oauth2_pkce' && binding.auth.type !== 'oauth2_cimd') {
    await emitStepError(
      args,
      'MCP_CONSENT_UNSUPPORTED_AUTH_TYPE',
      `MCP binding "${bindingId}" has auth.type="${binding.auth.type}". Use mcp.binding.consent only for oauth2_pkce or oauth2_cimd bindings.`,
      startTime,
      'validation',
    );
    return;
  }

  const definitionRows = (await withTenantSchema(db, tenantContext, async (tx) => {
    return tx
      .select()
      .from(mcpServerDefinitions)
      .where(
        and(
          eq(mcpServerDefinitions.serverId, binding.serverId),
          eq(mcpServerDefinitions.spaceId, spaceId),
        ),
      )
      .limit(1);
  })) as Array<{ definitionJson?: unknown }>;

  if (definitionRows.length === 0) {
    await emitStepError(
      args,
      'MCP_CONSENT_DEFINITION_NOT_FOUND',
      `MCP server definition "${binding.serverId}" not found in space "${spaceId}" for binding "${bindingId}".`,
      startTime,
      'validation',
    );
    return;
  }
  const definition = parseDefinitionRow(definitionRows[0]!);
  if (!definition) {
    await emitStepError(
      args,
      'MCP_CONSENT_DEFINITION_INVALID',
      `MCP server definition "${binding.serverId}" failed schema validation.`,
      startTime,
      'internal',
    );
    return;
  }

  // The orchestrator inline op carries no user identity, so only `space`/
  // `tenant`-scoped bindings can self-connect here. A `user`-scoped binding
  // returns `needsConsent` and must be connected by a signed-in human via the
  // REST consent route / account UI instead.
  const ownerResult = resolveOAuthOwner(binding.ownerScope, {
    spaceId,
    tenantId: args.context.tenantId,
  });
  if ('needsConsent' in ownerResult) {
    await emitStepError(
      args,
      'MCP_CONSENT_REQUIRES_USER',
      `MCP binding "${bindingId}" is user-scoped — each user must connect their own account from their Connected Accounts page; an agent run cannot consent on their behalf.`,
      startTime,
      'validation',
    );
    return;
  }

  const descriptor = buildMcpOAuthDescriptor(binding, definition);
  const target: OAuthBindingTarget = {
    integrationKind: 'mcp',
    resourceKey: binding.serverId,
    bindingId: binding.bindingId,
    ownerScope: binding.ownerScope,
    ownerId: ownerResult.ownerId,
    clientScope: binding.clientScope,
    issuerKey: descriptor.issuerKey,
    ...(binding.clientScope === 'platform'
      ? { platformClientId: descriptor.platformClientId }
      : {}),
  };

  try {
    const result = await startConsent({
      tenantId: args.context.tenantId,
      spaceId,
      target,
      discovery: descriptor.discovery,
      redirectUri: resolveOAuthCallbackUrl(),
      db,
    });
    await emitStepSuccess(
      args,
      {
        bindingId: binding.bindingId,
        authorizationUrl: result.authorizationUrl,
        state: result.state,
        expiresAt: result.expiresAt.toISOString(),
      },
      startTime,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[mcp-consent] startConsent failed for binding="${bindingId}": ${msg}`, {
      tenantId: args.context.tenantId,
      spaceId,
      bindingId,
    });
    // Classification 'internal' (not 'validation'): everything past the
    // input-shape + auth-type checks is an upstream failure — PRM/AS
    // discovery 5xx, token endpoint timeout, network unreachable, DB write
    // failure. Marking these 'validation' tells the orchestrator's retry/
    // observability layer they're terminal user errors; they're not. The
    // operator's input is fine — the world is uncooperative.
    await emitStepError(
      args,
      'MCP_CONSENT_FAILED',
      `MCP consent start failed: ${msg}`,
      startTime,
      'internal',
    );
  }
}

// ----------------------------------------------------------------------------
// Row parsers — mirror tenantLoader.ts in the MCP executor + the server route.
// ----------------------------------------------------------------------------

function parseBindingRow(row: Record<string, unknown>): McpServerBinding | null {
  const rowSpaceId =
    typeof row['spaceId'] === 'string'
      ? row['spaceId']
      : typeof row['space_id'] === 'string'
        ? row['space_id']
        : undefined;
  const rawScope = (row['scopeJson'] ?? row['scope_json'] ?? {}) as Record<string, unknown>;
  const scope = { ...rawScope, ...(rowSpaceId ? { spaceId: rowSpaceId } : {}) };

  const raw: Record<string, unknown> = {
    bindingId: row['bindingId'] ?? row['binding_id'],
    serverId: row['serverId'] ?? row['server_id'],
    name: row['name'],
    ...(row['description'] ? { description: row['description'] } : {}),
    scope,
    auth: row['authJson'] ?? row['auth_json'],
    connectionPolicy: row['connectionPolicyJson'] ?? row['connection_policy_json'] ?? {},
    ...((row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'])
      ? { toolAccessPolicy: row['toolAccessPolicyJson'] ?? row['tool_access_policy_json'] }
      : {}),
    subscribeListChanged: (row['subscribeListChanged'] ?? row['subscribe_list_changed']) === 1,
    samplingPolicy:
      ((row['samplingPolicy'] ?? row['sampling_policy']) as string | undefined) ?? 'off',
    ownerScope: (row['ownerScope'] ?? row['owner_scope']) as string | undefined,
    clientScope: (row['clientScope'] ?? row['client_scope']) as string | undefined,
    ...((row['pinnedOrigin'] ?? row['pinned_origin'])
      ? { pinnedOrigin: row['pinnedOrigin'] ?? row['pinned_origin'] }
      : {}),
    enabled: (row['enabled'] ?? 1) === 1,
  };
  const result = McpServerBindingSchema.safeParse(raw);
  return result.success ? result.data : null;
}

function parseDefinitionRow(row: { definitionJson?: unknown }): McpServerDefinition | null {
  const result = McpServerDefinitionSchema.safeParse(row.definitionJson ?? {});
  return result.success ? result.data : null;
}
