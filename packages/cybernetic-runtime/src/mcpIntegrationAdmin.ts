import { and, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { Redis } from 'ioredis';
import {
  McpServerBindingSchema,
  McpServerDefinitionSchema,
  type McpConnectionPolicy,
  type McpServerBinding,
  type McpServerDefinition,
  type McpToolFilter,
  type TenantId,
} from '@aflow/schemas';
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
import type { PrivateNetworkAuditActor } from './mcpPrivateNetwork.js';

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

/** Written by the server, never by a caller: timestamps, and the cache and pin `mcp.binding.test` stores. */
const BINDING_SERVER_FIELDS = [
  'createdAt',
  'updatedAt',
  'cachedTools',
  'cachedToolsAt',
  'pinnedOrigin',
  'sessionMetadata',
] as const;

/** The scope is stamped from the run (or the request) and written apart from the binding. */
export type McpServerBindingWrite = Omit<
  McpServerBinding,
  (typeof BINDING_SERVER_FIELDS)[number] | 'scope'
>;

/**
 * Which fields an update writes. Absent, an update replaces every field — the
 * Integrations form sends the whole object. Present, an existing row keeps
 * every field not named here, so a caller that states one setting does not
 * reset the others to their schema defaults; a field named here that the
 * written value leaves out is cleared. A new row is written whole either way.
 */
export type StatedFields<T> = ReadonlySet<keyof T>;

/** The binding fields an update writes, and the connection-policy keys it merges over the stored ones. */
export interface McpBindingStatedFields {
  fields: StatedFields<McpServerBindingWrite>;
  connectionPolicy: Partial<McpConnectionPolicy>;
}

function pickStated<T extends object>(value: T, stated: StatedFields<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => stated.has(key as keyof T)),
  ) as Partial<T>;
}

/** The stated fields the value leaves out — the ones an update clears. */
function clearedOf<T extends object>(value: T, stated: StatedFields<T>): string[] {
  return [...stated]
    .map(String)
    .filter((key) => (value as Record<string, unknown>)[key] === undefined);
}

function updateColumns<T>(
  columns: Partial<Record<keyof T, string>>,
  stated: StatedFields<T> | undefined,
): SQL[] {
  return (Object.entries(columns) as Array<[keyof T, string]>)
    .filter(([field]) => stated === undefined || stated.has(field))
    .map(([, column]) => sql.raw(`${column} = EXCLUDED.${column}`));
}

/** The SQL column a schema field is stored in: the table property of its name, or of its name + `Json`. */
function columnOf(columns: Record<string, { name: string }>, field: string): string | undefined {
  return (columns[field] ?? columns[`${field}Json`])?.name;
}

type UpdateColumns<T> = Readonly<Partial<Record<keyof T, string>>>;

// Derived on first use rather than at import, so a module that imports this
// one without the tables (a test mocking @aflow/database) still loads.
let definitionUpdateColumns: UpdateColumns<McpServerDefinitionWrite> | undefined;
let bindingUpdateColumns: UpdateColumns<McpServerBindingWrite> | undefined;

/**
 * The definition fields an update writes to a column of their own, derived
 * from the Zod and drizzle shapes. A definition field with no column is stored
 * in `definition_json`, which every update merges.
 */
export function mcpDefinitionUpdateColumns(): UpdateColumns<McpServerDefinitionWrite> {
  definitionUpdateColumns ??= Object.fromEntries(
    Object.keys(McpServerDefinitionSchema.shape)
      // serverId is the conflict key; the timestamps are the server's.
      .filter((field) => !['serverId', 'createdAt', 'updatedAt'].includes(field))
      .flatMap((field) => {
        const column = columnOf(getTableColumns(mcpServerDefinitions), field);
        return column === undefined ? [] : [[field, column] as const];
      }),
  );
  return definitionUpdateColumns;
}

/**
 * Every binding field an update writes as `column = EXCLUDED.column`, derived
 * from the Zod and drizzle shapes. A binding has no JSON catch-all, so a field
 * without a column would be dropped from every write — that throws here
 * instead.
 */
export function mcpBindingUpdateColumns(): UpdateColumns<McpServerBindingWrite> {
  bindingUpdateColumns ??= Object.fromEntries(
    Object.keys(McpServerBindingSchema.shape)
      .filter(
        (field) =>
          !(BINDING_SERVER_FIELDS as readonly string[]).includes(field) &&
          // bindingId is the conflict key; scope and connectionPolicy are merged on their own.
          !['bindingId', 'scope', 'connectionPolicy'].includes(field),
      )
      .map((field) => {
        const column = columnOf(getTableColumns(mcpServerBindings), field);
        if (column === undefined) {
          throw new Error(
            `McpServerBindingSchema field "${field}" has no mcp_server_bindings column to write`,
          );
        }
        return [field, column] as const;
      }),
  );
  return bindingUpdateColumns;
}

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

/**
 * `cleared` names the fields the write removed a stored value from — a field
 * it was told to clear that held nothing (always so on a create) is not one.
 * `toolFilter` is the filter the row holds after the write, `null` for none.
 */
export interface McpServerDefinitionUpsertResult {
  created: boolean;
  cleared: string[];
  toolFilter: McpToolFilter | null;
}

export async function upsertMcpServerDefinition(
  opts: McpIntegrationAdminScope & {
    definition: McpServerDefinitionWrite;
    statedFields?: StatedFields<McpServerDefinitionWrite>;
  },
): Promise<McpServerDefinitionUpsertResult> {
  const { db, tenantId, spaceId, definition, statedFields } = opts;
  await enforceIntegrationHostPolicy({
    db,
    tenantId,
    spaceId,
    kind: 'mcp',
    hosts: collectMcpServerHosts(definition),
    grantRefs: [{ artifactType: 'mcp_definition', artifactKey: definition.serverId }],
  });

  const definitionJson: Record<string, unknown> = { ...definition };
  const updates = [
    ...updateColumns(mcpDefinitionUpdateColumns(), statedFields),
    statedFields === undefined
      ? sql`definition_json = EXCLUDED.definition_json`
      : sql`definition_json = ${clearedOf(definition, statedFields).reduce<SQL>(
          (stored, key) => sql`(${stored} - ${key}::text)`,
          sql`COALESCE(mcp_server_definitions.definition_json, '{}'::jsonb)`,
        )} || ${JSON.stringify(pickStated(definition, statedFields))}::jsonb`,
    sql`updated_at = NOW()`,
  ];
  const { rows, cleared } = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    const existing = (
      (await tx
        .select()
        .from(mcpServerDefinitions)
        .where(
          and(
            eq(mcpServerDefinitions.serverId, definition.serverId),
            eq(mcpServerDefinitions.spaceId, spaceId),
          ),
        )
        .limit(1)) as McpServerDefinitionRow[]
    )[0];
    const stored: Record<string, unknown> = existing ? mcpServerDefinitionFromRow(existing) : {};
    const cleared =
      statedFields === undefined
        ? []
        : clearedOf(definition, statedFields).filter((field) => stored[field] !== undefined);
    const rows = await tx.execute<{ created: boolean; tool_filter: McpToolFilter | null }>(sql`
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
      ON CONFLICT (server_id, space_id) DO UPDATE SET ${sql.join(updates, sql`, `)}
      RETURNING (xmax = 0) AS created, definition_json -> 'toolFilter' AS tool_filter
    `);
    return { rows, cleared };
  });

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'definition',
      serverId: definition.serverId,
    });
  }
  return {
    created: rows[0]?.created === true,
    cleared,
    toolFilter: rows[0]?.tool_filter ?? null,
  };
}

/**
 * Deletes the definition with its bindings, space-owned tokens and orphaned
 * credentials. `actor` is recorded when the definition held a private network
 * acknowledgment.
 */
export async function deleteMcpServerDefinition(
  opts: McpIntegrationAdminScope & { serverId: string; actor: PrivateNetworkAuditActor },
): Promise<{ deleted: boolean }> {
  const { db, tenantId, spaceId, serverId, actor } = opts;
  const deleted = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    const existing = await tx
      .select({ serverId: mcpServerDefinitions.serverId })
      .from(mcpServerDefinitions)
      .where(
        and(eq(mcpServerDefinitions.serverId, serverId), eq(mcpServerDefinitions.spaceId, spaceId)),
      )
      .limit(1);
    await deleteMcpIntegration(tx, spaceId, serverId, actor);
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
 * existing row's scope becomes, `null` keeping the stored one. The returned
 * `scope` and `enabled` are the row's after the write.
 */
export async function upsertMcpServerBinding(
  opts: McpIntegrationAdminScope & {
    binding: McpServerBindingWrite;
    scope: Record<string, unknown>;
    scopeOnUpdate: Record<string, unknown> | null;
    stated?: McpBindingStatedFields;
  },
): Promise<{
  created: boolean;
  scope: Record<string, unknown>;
  enabled: boolean;
  /** The fields the write removed a stored value from; one that held nothing is not named. */
  cleared: string[];
}> {
  const { db, tenantId, spaceId, binding, scope, scopeOnUpdate, stated } = opts;
  const statedFields = stated?.fields;
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

  const updates = [
    ...updateColumns(mcpBindingUpdateColumns(), statedFields),
    sql`scope_json = COALESCE(${scopeOnUpdate === null ? null : JSON.stringify(scopeOnUpdate)}::jsonb, mcp_server_bindings.scope_json)`,
    ...(statedFields === undefined
      ? [sql`connection_policy_json = EXCLUDED.connection_policy_json`]
      : statedFields.has('connectionPolicy')
        ? [
            sql`connection_policy_json = COALESCE(mcp_server_bindings.connection_policy_json, '{}'::jsonb) || ${JSON.stringify(stated?.connectionPolicy ?? {})}::jsonb`,
          ]
        : []),
    sql`updated_at = NOW()`,
  ];

  const { rows, cleared } = await withTenantSchema(db, tenantContextOf(tenantId), async (tx) => {
    const existing = (
      await tx
        .select({
          pinnedOrigin: mcpServerBindings.pinnedOrigin,
          enabled: mcpServerBindings.enabled,
          authJson: mcpServerBindings.authJson,
          description: mcpServerBindings.description,
        })
        .from(mcpServerBindings)
        .where(
          and(
            eq(mcpServerBindings.bindingId, binding.bindingId),
            eq(mcpServerBindings.spaceId, spaceId),
          ),
        )
        .limit(1)
    )[0];
    // The pin rule is checked against what the row will hold, and an existing
    // row keeps the fields this write does not state.
    const kept = (field: keyof McpServerBindingWrite): boolean =>
      existing !== undefined && statedFields !== undefined && !statedFields.has(field);
    const enabled = kept('enabled') ? existing?.enabled === 1 : binding.enabled;
    const storedAuthType = (existing?.authJson as { type?: unknown } | null)?.type;
    const authType = kept('auth')
      ? typeof storedAuthType === 'string'
        ? storedAuthType
        : 'none'
      : binding.auth.type;
    if (enabled && authType !== 'none' && !existing?.pinnedOrigin) {
      throw new McpBindingOriginNotPinnedError(binding.bindingId, authType);
    }

    const stored: Record<string, unknown> = existing?.description
      ? { description: existing.description }
      : {};
    const cleared =
      statedFields === undefined
        ? []
        : clearedOf(binding, statedFields).filter((field) => stored[field] !== undefined);

    const rows = await tx.execute<{
      created: boolean;
      scope: Record<string, unknown>;
      enabled: number;
    }>(sql`
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
      ON CONFLICT (binding_id, space_id) DO UPDATE SET ${sql.join(updates, sql`, `)}
      RETURNING (xmax = 0) AS created, scope_json AS scope, enabled
    `);
    return { rows, cleared };
  });

  if (opts.redis) {
    publishMcpCatalogInvalidation(opts.redis, tenantId, spaceId, {
      kind: 'binding',
      serverId: binding.serverId,
      bindingId: binding.bindingId,
    });
  }
  const row = rows[0];
  return {
    created: row?.created === true,
    scope: row?.scope ?? scope,
    enabled: row ? row.enabled === 1 : binding.enabled,
    cleared,
  };
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
