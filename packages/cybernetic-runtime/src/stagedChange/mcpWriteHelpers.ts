import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type {
  CredentialSlot,
  McpAuthShape,
  McpServerBinding,
  McpServerDefinition,
} from '@aflow/schemas';

export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

export type WriteOutcome =
  { status: 'inserted' } | { status: 'updated' } | { status: 'skipped'; reason: 'already-exists' };

export class McpBundleWriteConflictError extends Error {
  constructor(
    message: string,
    readonly conflict: { kind: 'mcp_definition' | 'mcp_binding'; id: string; spaceId: string },
  ) {
    super(message);
    this.name = 'McpBundleWriteConflictError';
  }
}

// ============================================================================
// MCP server definition write
// ============================================================================

/**
 * Write one `mcp_server_definitions` row at `(server_id, space_id)`.
 * The caller stamps `source` — a draft's own `source` field never survives
 * install, so provenance always reflects the installing path.
 */
export async function writeMcpServerDefinition(opts: {
  serverId: string;
  /** Definition shape WITHOUT `serverId` / `source` / timestamps — those are stamped here. */
  definition: Omit<McpServerDefinition, 'serverId' | 'source' | 'createdAt' | 'updatedAt'>;
  source: Extract<McpServerDefinition['source'], 'platform' | 'bundle'>;
  spaceId: string;
  conflictPolicy: ConflictPolicy;
  tx: PostgresJsDatabase;
}): Promise<WriteOutcome> {
  const { serverId, definition, source, spaceId, conflictPolicy, tx } = opts;
  // Mirror `definition_json` to the row's columns the runtime reads
  // directly; the JSONB carries the full shape for the resolver.
  const definitionJson: Record<string, unknown> = { serverId, source, ...definition };

  if (conflictPolicy === 'fail') {
    const inserted = await tx.execute<{ server_id: string }>(sql`
      INSERT INTO mcp_server_definitions (
        server_id, name, description, server_url, transport,
        definition_json, tags, source, enabled, space_id
      )
      VALUES (
        ${serverId},
        ${definition.name},
        ${definition.description ?? null},
        ${definition.serverUrl},
        ${definition.transport ?? 'streamable_http'},
        ${JSON.stringify(definitionJson)}::jsonb,
        ${JSON.stringify(definition.tags ?? [])}::jsonb,
        ${source},
        1,
        ${spaceId}::uuid
      )
      ON CONFLICT (server_id, space_id) DO NOTHING
      RETURNING server_id
    `);
    if (inserted.length === 0) {
      throw new McpBundleWriteConflictError(
        `MCP server definition '${serverId}' already exists in space ${spaceId} and conflictPolicy is 'fail'.`,
        { kind: 'mcp_definition', id: serverId, spaceId },
      );
    }
    return { status: 'inserted' };
  }

  if (conflictPolicy === 'skip') {
    const inserted = await tx.execute<{ server_id: string }>(sql`
      INSERT INTO mcp_server_definitions (
        server_id, name, description, server_url, transport,
        definition_json, tags, source, enabled, space_id
      )
      VALUES (
        ${serverId},
        ${definition.name},
        ${definition.description ?? null},
        ${definition.serverUrl},
        ${definition.transport ?? 'streamable_http'},
        ${JSON.stringify(definitionJson)}::jsonb,
        ${JSON.stringify(definition.tags ?? [])}::jsonb,
        ${source},
        1,
        ${spaceId}::uuid
      )
      ON CONFLICT (server_id, space_id) DO NOTHING
      RETURNING server_id
    `);
    return inserted.length > 0
      ? { status: 'inserted' }
      : { status: 'skipped', reason: 'already-exists' };
  }

  // overwrite
  await tx.execute(sql`
    INSERT INTO mcp_server_definitions (
      server_id, name, description, server_url, transport,
      definition_json, tags, source, enabled, space_id
    )
    VALUES (
      ${serverId},
      ${definition.name},
      ${definition.description ?? null},
      ${definition.serverUrl},
      ${definition.transport ?? 'streamable_http'},
      ${JSON.stringify(definitionJson)}::jsonb,
      ${JSON.stringify(definition.tags ?? [])}::jsonb,
      ${source},
      1,
      ${spaceId}::uuid
    )
    ON CONFLICT (server_id, space_id) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      server_url = EXCLUDED.server_url,
      transport = EXCLUDED.transport,
      definition_json = EXCLUDED.definition_json,
      tags = EXCLUDED.tags,
      updated_at = NOW()
  `);
  return { status: 'updated' };
}

// ============================================================================
// MCP placeholder binding write
// ============================================================================

export async function writePlaceholderMcpBinding(opts: {
  bindingId: string;
  serverId: string;
  spaceId: string;
  name: string;
  description?: string;
  scope: { tenantId: string; spaceId: string; flowId?: string };
  /** Caller-built placeholder auth shape — MUST NOT contain credential values. */
  authJson: Record<string, unknown>;
  subscribeListChanged: boolean;
  samplingPolicy: 'off' | 'no_tools' | 'full';
  /** Consent-flow ownership axes; omitted callers get the column defaults. */
  ownerScope?: McpServerBinding['ownerScope'];
  clientScope?: McpServerBinding['clientScope'];
  conflictPolicy: ConflictPolicy;
  tx: PostgresJsDatabase;
}): Promise<WriteOutcome> {
  const {
    bindingId,
    serverId,
    spaceId,
    name,
    description,
    scope,
    authJson,
    subscribeListChanged,
    samplingPolicy,
    conflictPolicy,
    tx,
  } = opts;
  const ownerScope = opts.ownerScope ?? 'space';
  const clientScope = opts.clientScope ?? 'platform';

  if (conflictPolicy === 'fail') {
    const inserted = await tx.execute<{ binding_id: string }>(sql`
      INSERT INTO mcp_server_bindings (
        binding_id, server_id, name, description, space_id,
        scope_json, auth_json, connection_policy_json,
        subscribe_list_changed, sampling_policy,
        owner_scope, client_scope,
        enabled
      )
      VALUES (
        ${bindingId},
        ${serverId},
        ${name},
        ${description ?? null},
        ${spaceId}::uuid,
        ${JSON.stringify(scope)}::jsonb,
        ${JSON.stringify(authJson)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${subscribeListChanged ? 1 : 0},
        ${samplingPolicy},
        ${ownerScope},
        ${clientScope},
        0
      )
      ON CONFLICT (binding_id, space_id) DO NOTHING
      RETURNING binding_id
    `);
    if (inserted.length === 0) {
      throw new McpBundleWriteConflictError(
        `MCP binding '${bindingId}' already exists in space ${spaceId} and conflictPolicy is 'fail'.`,
        { kind: 'mcp_binding', id: bindingId, spaceId },
      );
    }
    return { status: 'inserted' };
  }

  if (conflictPolicy === 'skip') {
    const inserted = await tx.execute<{ binding_id: string }>(sql`
      INSERT INTO mcp_server_bindings (
        binding_id, server_id, name, description, space_id,
        scope_json, auth_json, connection_policy_json,
        subscribe_list_changed, sampling_policy,
        owner_scope, client_scope,
        enabled
      )
      VALUES (
        ${bindingId},
        ${serverId},
        ${name},
        ${description ?? null},
        ${spaceId}::uuid,
        ${JSON.stringify(scope)}::jsonb,
        ${JSON.stringify(authJson)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        ${subscribeListChanged ? 1 : 0},
        ${samplingPolicy},
        ${ownerScope},
        ${clientScope},
        0
      )
      ON CONFLICT (binding_id, space_id) DO NOTHING
      RETURNING binding_id
    `);
    return inserted.length > 0
      ? { status: 'inserted' }
      : { status: 'skipped', reason: 'already-exists' };
  }

  // overwrite — preserves enabled/pinned_origin/cached_tools/ownership scopes
  // if already set so re-installing a bundle over a working binding doesn't
  // downgrade it.
  await tx.execute(sql`
    INSERT INTO mcp_server_bindings (
      binding_id, server_id, name, description, space_id,
      scope_json, auth_json, connection_policy_json,
      subscribe_list_changed, sampling_policy,
      owner_scope, client_scope,
      enabled
    )
    VALUES (
      ${bindingId},
      ${serverId},
      ${name},
      ${description ?? null},
      ${spaceId}::uuid,
      ${JSON.stringify(scope)}::jsonb,
      ${JSON.stringify(authJson)}::jsonb,
      ${JSON.stringify({})}::jsonb,
      ${subscribeListChanged ? 1 : 0},
      ${samplingPolicy},
      ${ownerScope},
      ${clientScope},
      0
    )
    ON CONFLICT (binding_id, space_id) DO UPDATE SET
      server_id = EXCLUDED.server_id,
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      scope_json = EXCLUDED.scope_json,
      auth_json = EXCLUDED.auth_json,
      subscribe_list_changed = EXCLUDED.subscribe_list_changed,
      sampling_policy = EXCLUDED.sampling_policy,
      updated_at = NOW()
  `);
  return { status: 'updated' };
}

// ============================================================================
// Slot-based placeholder auth_json builder
// ============================================================================

/**
 * Build the placeholder `auth_json` for a bundle's `McpBindingTemplate`.
 * Each slot maps an `authField` (on the resulting auth_json) to a
 * tenant-scoped `credentialKey`; the operator fills the actual credential
 * VALUE via /integrations after install.
 *
 * Mirrors `buildPlaceholderAuthJsonFromSlots` for the API mesh. The
 * `superRefine` on `McpBindingTemplateSchema` has already validated that
 * `credentialSlots` contains the right authFields with the right roles
 * for `authShape.type`.
 */
export function buildPlaceholderMcpAuthJsonFromSlots(
  authShape: McpAuthShape,
  credentialSlots: readonly CredentialSlot[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: authShape.type };
  switch (authShape.type) {
    case 'none':
      break;
    case 'bearer':
      break;
    case 'header':
      out['headerName'] = authShape.headerName;
      break;
    case 'oauth2_client_credentials':
      out['tokenEndpoint'] = authShape.tokenEndpoint;
      if (authShape.scopes !== undefined) out['scopes'] = authShape.scopes;
      break;
  }
  for (const slot of credentialSlots) {
    out[slot.authField] = slot.credentialKey;
  }
  return out;
}

/** Credential-slot NAMES referenced by an MCP binding's auth JSON (never values). */
export function extractMcpCredentialKeys(authJson: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const add = (key: unknown): void => {
    if (typeof key === 'string' && key.length > 0) keys.push(key);
  };
  add(authJson['credentialKey']);
  add(authJson['clientIdCredentialKey']);
  add(authJson['clientSecretCredentialKey']);
  return keys;
}
