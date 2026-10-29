import { and, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import type { McpServerBinding, McpServerDefinition, TenantId } from '@aflow/schemas';
import {
  createTenantContext,
  mcpServerBindings,
  mcpServerDefinitions,
  withTenantSchema,
  type McpServerDefinitionRow,
} from '@aflow/database';
import { publishMcpCatalogInvalidation } from '@aflow/redis';
import {
  collectMcpBindingHosts,
  collectMcpServerHosts,
  enforceIntegrationHostPolicy,
} from './integrationPolicy/index.js';
import { deleteMcpIntegration } from './store/connectorUninstall.js';

/**
 * The MCP server and binding admin reads and writes, shared by the
 * Integrations REST routes and the orchestrator's inline `mcp.server.*` /
 * `mcp.binding.*` handlers so both reach the same rows through the same host
 * policy.
 */
export interface McpIntegrationAdminScope {
  db: PostgresJsDatabase;
  tenantId: string;
  spaceId: string;
  /** Absent: no catalog invalidation is published (the TTL cache is the fallback). */
  redis?: Redis | null;
}

export type McpServerDefinitionWrite = Omit<McpServerDefinition, 'createdAt' | 'updatedAt'>;

export type McpServerBindingWrite = Pick<
  McpServerBinding,
  | 'bindingId'
  | 'serverId'
  | 'name'
  | 'description'
  | 'auth'
  | 'connectionPolicy'
  | 'subscribeListChanged'
  | 'samplingPolicy'
  | 'ownerScope'
  | 'clientScope'
  | 'enabled'
>;

/** A credentialed binding asked to be enabled before `mcp.binding.test` pinned its origin. */
export class McpBindingOriginNotPinnedError extends Error {
  constructor(
    readonly bindingId: string,
    readonly authType: string,
  ) {
    super(
      `Binding "${bindingId}" has auth.type="${authType}" and cannot be ` +
        `enabled without a pinned origin. Upsert with enabled: false first, then run ` +
        `mcp.binding.test to populate pinnedOrigin, then upsert again with enabled: true.`,
    );
    this.name = 'McpBindingOriginNotPinnedError';
  }
}

function tenantContextOf(tenantId: string) {
  return createTenantContext(tenantId as TenantId);
}

export async function listMcpServerDefinitionRows(
  opts: McpIntegrationAdminScope & {
    source?: McpServerDefinition['source'];
    enabled?: boolean;
  },
): Promise<McpServerDefinitionRow[]> {
  const conditions = [eq(mcpServerDefinitions.spaceId, opts.spaceId)];
  if (opts.source !== undefined) conditions.push(eq(mcpServerDefinitions.source, opts.source));
  if (opts.enabled !== undefined) {
    conditions.push(eq(mcpServerDefinitions.enabled, opts.enabled ? 1 : 0));
  }
  return (await withTenantSchema(opts.db, tenantContextOf(opts.tenantId), async (tx) =>
    tx
      .select()
      .from(mcpServerDefinitions)
      .where(and(...conditions)),
  )) as McpServerDefinitionRow[];
}

export async function getMcpServerDefinitionRow(
  opts: McpIntegrationAdminScope & { serverId: string },
): Promise<McpServerDefinitionRow | null> {
  const rows = (await withTenantSchema(opts.db, tenantContextOf(opts.tenantId), async (tx) =>
    tx
      .select()
      .from(mcpServerDefinitions)
      .where(
        and(
          eq(mcpServerDefinitions.serverId, opts.serverId),
          eq(mcpServerDefinitions.spaceId, opts.spaceId),
        ),
      )
      .limit(1),
  )) as McpServerDefinitionRow[];
  return rows[0] ?? null;
}

/** A stored definition in the public `McpServerDefinition` shape; the columns win over the JSON. */
export function mcpServerDefinitionFromRow(row: McpServerDefinitionRow): McpServerDefinition {
  const defJson = (row.definitionJson ?? {}) as Partial<McpServerDefinition>;
  return {
    ...(defJson.toolFilter ? { toolFilter: defJson.toolFilter } : {}),
    ...(defJson.protectedResourceMetadataPath
      ? { protectedResourceMetadataPath: defJson.protectedResourceMetadataPath }
      : {}),
    ...(defJson.observedProtocolVersion
      ? { observedProtocolVersion: defJson.observedProtocolVersion }
      : {}),
    ...(defJson.icon ? { icon: defJson.icon } : {}),
    serverId: row.serverId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    serverUrl: row.serverUrl,
    transport: row.transport as McpServerDefinition['transport'],
    tags: row.tags,
    source: row.source as McpServerDefinition['source'],
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function upsertMcpServerDefinition(
  opts: McpIntegrationAdminScope & { definition: McpServerDefinitionWrite },
): Promise<{ created: boolean }> {
  const { db, tenantId, spaceId, definition } = opts;
  await enforceIntegrationHostPolicy({
    db,
    tenantId,
    spaceId,
    kind: 'mcp',
    hosts: collectMcpServerHosts(definition),
    grantRefs: [{ artifactType: 'mcp_definition', artifactKey: definition.serverId }],
  });

  const definitionJson: Record<string, unknown> = { ...definition };
  const rows = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) =>
    tx.execute<{ created: boolean }>(sql`
      INSERT INTO mcp_server_definitions (
        server_id, name, description, server_url, transport,
        definition_json, tags, source, enabled, space_id
      )
      VALUES (
        ${definition.serverId},
        ${definition.name},
        ${definition.description ?? null},
        ${definition.serverUrl},
        ${definition.transport},
        ${JSON.stringify(definitionJson)}::jsonb,
        ${JSON.stringify(definition.tags)}::jsonb,
        ${definition.source},
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
        source = EXCLUDED.source,
        updated_at = NOW()
      RETURNING (xmax = 0) AS created
    `),
  );

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'definition',
      serverId: definition.serverId,
    });
  }
  return { created: rows[0]?.created === true };
}

/** Deletes the definition with its bindings, space-owned tokens and orphaned credentials. */
export async function deleteMcpServerDefinition(
  opts: McpIntegrationAdminScope & { serverId: string },
): Promise<{ deleted: boolean }> {
  const { db, tenantId, spaceId, serverId } = opts;
  const deleted = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    const existing = await tx
      .select({ serverId: mcpServerDefinitions.serverId })
      .from(mcpServerDefinitions)
      .where(
        and(eq(mcpServerDefinitions.serverId, serverId), eq(mcpServerDefinitions.spaceId, spaceId)),
      )
      .limit(1);
    await deleteMcpIntegration(tx, spaceId, serverId);
    return existing.length > 0;
  });

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'definition',
      serverId,
    });
  }
  return { deleted };
}

/**
 * `scope` is what a new row is created with; `scopeOnUpdate` is what an
 * existing row's scope becomes, `null` keeping the stored one.
 */
export async function upsertMcpServerBinding(
  opts: McpIntegrationAdminScope & {
    binding: McpServerBindingWrite;
    scope: Record<string, unknown>;
    scopeOnUpdate: Record<string, unknown> | null;
  },
): Promise<{ created: boolean }> {
  const { db, tenantId, spaceId, binding, scope, scopeOnUpdate } = opts;
  await enforceIntegrationHostPolicy({
    db,
    tenantId,
    spaceId,
    kind: 'mcp',
    hosts: collectMcpBindingHosts(binding.auth as unknown as Record<string, unknown>),
    grantRefs: [
      { artifactType: 'mcp_binding', artifactKey: binding.bindingId },
      { artifactType: 'mcp_definition', artifactKey: binding.serverId },
    ],
  });

  const rows = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    if (binding.enabled && binding.auth.type !== 'none') {
      const existing = await tx
        .select({ pinnedOrigin: mcpServerBindings.pinnedOrigin })
        .from(mcpServerBindings)
        .where(
          and(
            eq(mcpServerBindings.bindingId, binding.bindingId),
            eq(mcpServerBindings.spaceId, spaceId),
          ),
        )
        .limit(1);
      if (!existing[0]?.pinnedOrigin) {
        throw new McpBindingOriginNotPinnedError(binding.bindingId, binding.auth.type);
      }
    }

    return tx.execute<{ created: boolean }>(sql`
      INSERT INTO mcp_server_bindings (
        binding_id, server_id, name, description, space_id,
        scope_json, auth_json, connection_policy_json,
        subscribe_list_changed, sampling_policy,
        owner_scope, client_scope,
        enabled
      )
      VALUES (
        ${binding.bindingId},
        ${binding.serverId},
        ${binding.name},
        ${binding.description ?? null},
        ${spaceId}::uuid,
        ${JSON.stringify(scope)}::jsonb,
        ${JSON.stringify(binding.auth)}::jsonb,
        ${JSON.stringify(binding.connectionPolicy)}::jsonb,
        ${!binding.subscribeListChanged ? 0 : 1},
        ${binding.samplingPolicy},
        ${binding.ownerScope},
        ${binding.clientScope},
        ${!binding.enabled ? 0 : 1}
      )
      ON CONFLICT (binding_id, space_id) DO UPDATE SET
        server_id = EXCLUDED.server_id,
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        scope_json = COALESCE(${scopeOnUpdate === null ? null : JSON.stringify(scopeOnUpdate)}::jsonb, mcp_server_bindings.scope_json),
        auth_json = EXCLUDED.auth_json,
        connection_policy_json = EXCLUDED.connection_policy_json,
        subscribe_list_changed = EXCLUDED.subscribe_list_changed,
        sampling_policy = EXCLUDED.sampling_policy,
        owner_scope = EXCLUDED.owner_scope,
        client_scope = EXCLUDED.client_scope,
        enabled = EXCLUDED.enabled,
        updated_at = NOW()
      RETURNING (xmax = 0) AS created
    `);
  });

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'binding',
      serverId: binding.serverId,
      bindingId: binding.bindingId,
    });
  }
  return { created: rows[0]?.created === true };
}

/**
 * Deletes one binding in this space; `null` when there is none. OAuth tokens
 * are owner-keyed per server and shared across its bindings (Plan 185 §3.3),
 * so they stay — deleting the server is what tears them down.
 */
export async function deleteMcpServerBinding(
  opts: McpIntegrationAdminScope & { bindingId: string },
): Promise<{ serverId: string } | null> {
  const { db, tenantId, spaceId, bindingId } = opts;
  const serverId = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    const existing = await tx
      .select({ serverId: mcpServerBindings.serverId })
      .from(mcpServerBindings)
      .where(
        and(eq(mcpServerBindings.bindingId, bindingId), eq(mcpServerBindings.spaceId, spaceId)),
      )
      .limit(1);
    const found = existing[0]?.serverId;
    if (found === undefined) return null;
    await tx.execute(
      sql`DELETE FROM mcp_server_bindings WHERE binding_id = ${bindingId} AND space_id = ${spaceId}::uuid`,
    );
    return found;
  });
  if (serverId === null) return null;

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'binding',
      serverId,
      bindingId,
    });
  }
  return { serverId };
}
